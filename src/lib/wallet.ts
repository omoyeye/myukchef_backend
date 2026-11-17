import { and, desc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { chefs, siteSettings, users, walletEntries } from "../db/schema";
import { getStripe } from "./integrations";
import { notify, notifyAdmins } from "./notify";
import { withTemplate } from "./templates";

/**
 * MYUKCHEF wallets: credit in pounds for customers and chefs. Rewards (referral, loyalty) wait as
 * "pending" until a Super Admin releases them (or, if the rules say so, until they release themselves
 * after a few days). Released credit can be spent at checkout; chefs can also withdraw theirs.
 */

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const money = (n: number) => Math.round(n * 100) / 100;
const pounds = (n: number) => `£${money(n).toFixed(2)}`;
const KEY = "wallet_config";

export const CREDIT_TYPES = ["referral", "loyalty", "bonus", "adjustment", "converted"] as const;

export interface WalletRules {
    /** manual: a Super Admin releases every reward. auto: rewards release themselves after autoDays. */
    release: "manual" | "auto";
    autoDays: number;
    referral: { enabled: boolean; newCustomer: number; referrer: number };
    loyalty: { enabled: boolean; percent: number };
    /** How much of an order (food, fees and delivery, before the tip) a wallet can pay for. */
    spend: { maxPercent: number; minOrder: number };
    withdraw: { minAmount: number };
}

const DEFAULTS: WalletRules = {
    release: "manual",
    autoDays: 7,
    referral: { enabled: true, newCustomer: 5, referrer: 5 },
    loyalty: { enabled: true, percent: 2 },
    spend: { maxPercent: 50, minOrder: 10 },
    withdraw: { minAmount: 10 },
};

const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(money(n), min), max) : fallback;
};

function clean(v: Partial<WalletRules> & Record<string, unknown>): WalletRules {
    const r = (v.referral ?? {}) as Partial<WalletRules["referral"]>;
    const l = (v.loyalty ?? {}) as Partial<WalletRules["loyalty"]>;
    const s = (v.spend ?? {}) as Partial<WalletRules["spend"]>;
    const w = (v.withdraw ?? {}) as Partial<WalletRules["withdraw"]>;
    return {
        release: v.release === "auto" ? "auto" : "manual",
        autoDays: Math.round(num(v.autoDays, DEFAULTS.autoDays, 0, 90)),
        referral: { enabled: r.enabled !== false, newCustomer: num(r.newCustomer, DEFAULTS.referral.newCustomer, 0, 100), referrer: num(r.referrer, DEFAULTS.referral.referrer, 0, 100) },
        loyalty: { enabled: l.enabled !== false, percent: num(l.percent, DEFAULTS.loyalty.percent, 0, 25) },
        spend: { maxPercent: Math.round(num(s.maxPercent, DEFAULTS.spend.maxPercent, 1, 100)), minOrder: num(s.minOrder, DEFAULTS.spend.minOrder, 0, 500) },
        withdraw: { minAmount: num(w.minAmount, DEFAULTS.withdraw.minAmount, 1, 1000) },
    };
}

export async function getWalletRules(): Promise<WalletRules> {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, KEY)).limit(1).catch(() => []);
    return clean((row?.value ?? {}) as Partial<WalletRules> & Record<string, unknown>);
}

export async function saveWalletRules(body: unknown) {
    const rules = clean((body ?? {}) as Partial<WalletRules> & Record<string, unknown>);
    await db.insert(siteSettings).values({ key: KEY, value: rules }).onDuplicateKeyUpdate({ set: { value: rules, updatedAt: new Date() } });
    return rules;
}

// === Balances ===

/** What counts towards the balance someone can spend or withdraw. */
const COUNTS = or(
    and(inArray(walletEntries.type, [...CREDIT_TYPES]), eq(walletEntries.status, "released")),
    and(eq(walletEntries.type, "spend"), eq(walletEntries.status, "applied")),
    and(eq(walletEntries.type, "withdrawal"), inArray(walletEntries.status, ["requested", "paid"])),
);

export async function balanceOf(userId: number, tx: typeof db = db) {
    const [row] = await tx.select({
        available: sql<number>`coalesce(sum(case when ${COUNTS} then ${walletEntries.amount} else 0 end), 0)`,
        pending: sql<number>`coalesce(sum(case when ${walletEntries.status} = 'pending' then ${walletEntries.amount} else 0 end), 0)`,
    }).from(walletEntries).where(eq(walletEntries.userId, userId));
    return { available: money(Number(row?.available ?? 0)), pending: money(Number(row?.pending ?? 0)) };
}

/** The wallet page: balance, rewards on their way, history and what can be done with it. */
export async function walletFor(userId: number) {
    const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    const rules = await getWalletRules();
    const entries = await db.select({
        id: walletEntries.id, type: walletEntries.type, amount: walletEntries.amount, status: walletEntries.status,
        orderId: walletEntries.orderId, note: walletEntries.note, createdAt: walletEntries.createdAt, decidedAt: walletEntries.decidedAt,
    }).from(walletEntries).where(eq(walletEntries.userId, userId)).orderBy(desc(walletEntries.createdAt), desc(walletEntries.id)).limit(200);
    const chef = user?.role === "chef" ? (await db.select({ accountId: chefs.stripeAccountId, enabled: chefs.stripePayoutsEnabled }).from(chefs).where(eq(chefs.userId, userId)).limit(1))[0] : undefined;
    return {
        ...(await balanceOf(userId)),
        entries,
        rules: { maxPercent: rules.spend.maxPercent, minOrder: rules.spend.minOrder, referral: rules.referral, loyalty: rules.loyalty },
        withdraw: user?.role === "chef" ? { allowed: true, minAmount: rules.withdraw.minAmount, stripeReady: !!(chef?.accountId && chef.enabled) } : { allowed: false, minAmount: 0, stripeReady: false },
    };
}

// === Earning ===

async function addCredit(input: { userId: number; type: (typeof CREDIT_TYPES)[number]; amount: number; note: string; orderId?: number | null; relatedUserId?: number | null; createdBy?: number | null; release?: boolean }) {
    const amount = money(input.amount);
    if (!(amount > 0) && input.type !== "adjustment") return null;
    const rules = await getWalletRules();
    const releaseNow = input.release === true;
    const [{ id }] = await db.insert(walletEntries).values({
        userId: input.userId,
        type: input.type,
        amount,
        status: releaseNow ? "released" : "pending",
        orderId: input.orderId ?? null,
        relatedUserId: input.relatedUserId ?? null,
        note: input.note.slice(0, 300),
        createdBy: input.createdBy ?? null,
        decidedBy: releaseNow ? input.createdBy ?? null : null,
        decidedAt: releaseNow ? new Date() : null,
        releaseAt: !releaseNow && rules.release === "auto" ? new Date(Date.now() + rules.autoDays * 86400_000) : null,
    }).$returningId();
    if (releaseNow) await tellReleased(input.userId, amount, input.note);
    return id;
}

/** Cashback on a delivered order (or meal plan delivery). Waits for release. The tip doesn't count. */
export async function earnLoyalty(userId: number, spent: number, note: string, orderId: number | null = null) {
    const rules = await getWalletRules();
    if (!rules.loyalty.enabled || rules.loyalty.percent <= 0 || spent <= 0) return;
    // Once per order.
    if (orderId) {
        const [already] = await db.select({ id: walletEntries.id }).from(walletEntries).where(and(eq(walletEntries.orderId, orderId), eq(walletEntries.type, "loyalty"), eq(walletEntries.userId, userId))).limit(1);
        if (already) return;
    }
    await addCredit({ userId, type: "loyalty", amount: spent * (rules.loyalty.percent / 100), note, orderId });
}

/** A referred person's first delivered order: a reward for them and for whoever referred them. Waits for release. */
export async function earnReferral(newUserId: number, referrerId: number, newUserName: string) {
    const rules = await getWalletRules();
    if (!rules.referral.enabled) return;
    const first = newUserName.split(" ")[0] || "your friend";
    await addCredit({ userId: newUserId, type: "referral", amount: rules.referral.newCustomer, note: "Welcome reward for joining through a friend", relatedUserId: referrerId });
    await addCredit({ userId: referrerId, type: "referral", amount: rules.referral.referrer, note: `${first} joined with your code and placed their first order`, relatedUserId: newUserId });
}

async function tellReleased(userId: number, amount: number, note: string) {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    const chef = u?.role === "chef";
    const balance = (await balanceOf(userId)).available;
    await withTemplate("wallet.released", { amount: money(amount).toFixed(2), reason: note, balance: balance.toFixed(2) }, () =>
        notify(userId, `${pounds(amount)} is in your wallet`,
            `${note}. Your wallet now has ${pounds(balance)}${chef ? ". Use it on an order or withdraw it." : ". Use it on your next order."}`,
            chef ? "/chef/dashboard?tab=payouts" : "/wallet", "update")).catch(() => undefined);
}

// === Super Admin decisions ===

/** Releases pending credits into wallets. Each person hears about it. */
export async function releaseCredits(ids: number[], adminId: number | null) {
    if (!ids.length) return 0;
    const rows = await db.select().from(walletEntries).where(and(inArray(walletEntries.id, ids), eq(walletEntries.status, "pending")));
    let released = 0;
    for (const r of rows) {
        const [claim] = await db.update(walletEntries).set({ status: "released", decidedBy: adminId, decidedAt: new Date() }).where(and(eq(walletEntries.id, r.id), eq(walletEntries.status, "pending")));
        if (!(claim as unknown as { affectedRows?: number }).affectedRows) continue;
        released++;
        await tellReleased(r.userId, r.amount, r.note ?? "A reward");
    }
    return released;
}

export async function cancelCredits(ids: number[], reasonInput: unknown, adminId: number) {
    const reason = typeof reasonInput === "string" ? reasonInput.trim().slice(0, 200) : "";
    if (!reason) throw fail(400, "Give a reason, for the record.");
    if (!ids.length) return 0;
    const [res] = await db.update(walletEntries).set({ status: "cancelled", decidedBy: adminId, decidedAt: new Date(), note: sql`left(concat(coalesce(${walletEntries.note}, ''), ' (cancelled: ', ${reason}, ')'), 300)` })
        .where(and(inArray(walletEntries.id, ids), eq(walletEntries.status, "pending")));
    return (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
}

/** A gift or correction from a Super Admin. Takes effect straight away. Corrections can be negative. */
export async function adminCredit(adminId: number, body: Record<string, unknown>) {
    const userId = Number(body.userId);
    const amount = money(Number(body.amount));
    const kind = body.kind === "adjustment" ? "adjustment" : "bonus";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
    if (!userId) throw fail(400, "Choose who this is for.");
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) throw fail(400, "Enter an amount up to £1,000.");
    if (amount < 0 && kind !== "adjustment") throw fail(400, "Use a correction to take money off.");
    if (!note) throw fail(400, "Add a note the person will see, e.g. 'Sorry your order was late'.");
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw fail(404, "Account not found");
    if (amount < 0 && (await balanceOf(userId)).available + amount < 0) throw fail(400, "That would take the wallet below £0.");
    const [{ id }] = await db.insert(walletEntries).values({ userId, type: kind, amount, status: "released", note, createdBy: adminId, decidedBy: adminId, decidedAt: new Date() }).$returningId();
    if (amount > 0) await tellReleased(userId, amount, note);
    return id;
}

// === Spending at checkout ===

/**
 * Takes wallet credit for an order, inside a transaction that locks the person's account so two
 * orders can't spend the same money. Returns how much was used.
 */
export async function takeForOrder(userId: number, orderTotalBeforeTip: number, wanted: unknown, minCardCharge = 0) {
    if (wanted !== true) return { applied: 0, entryId: null as number | null };
    const rules = await getWalletRules();
    if (orderTotalBeforeTip < rules.spend.minOrder) throw fail(400, `Your wallet can be used on orders of ${pounds(rules.spend.minOrder)} or more.`);
    return db.transaction(async (tx) => {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
        const { available } = await balanceOf(userId, tx as unknown as typeof db);
        let applied = money(Math.min(available, orderTotalBeforeTip * (rules.spend.maxPercent / 100), orderTotalBeforeTip));
        // Card payments have a 30p minimum: either the wallet covers it all, or at least 30p is left to pay.
        const left = orderTotalBeforeTip - applied;
        if (left > 0 && left < minCardCharge) applied = money(Math.max(0, orderTotalBeforeTip - minCardCharge));
        if (applied <= 0) return { applied: 0, entryId: null as number | null };
        const [{ id }] = await tx.insert(walletEntries).values({ userId, type: "spend", amount: -applied, status: "applied", note: "Used on an order" }).$returningId();
        return { applied, entryId: id as number | null };
    });
}

export const linkSpendToOrder = (entryId: number | null, orderId: number) =>
    entryId ? db.update(walletEntries).set({ orderId, note: `Used on order #${orderId}` }).where(eq(walletEntries.id, entryId)) : Promise.resolve();

/** A cancelled or unpaid order gives the wallet money back. */
export async function returnForOrder(orderId: number) {
    await db.update(walletEntries).set({ status: "returned", decidedAt: new Date() }).where(and(eq(walletEntries.orderId, orderId), eq(walletEntries.type, "spend"), eq(walletEntries.status, "applied")));
}
export async function returnEntry(entryId: number | null) {
    if (entryId) await db.update(walletEntries).set({ status: "returned", decidedAt: new Date() }).where(and(eq(walletEntries.id, entryId), eq(walletEntries.status, "applied")));
}

// === Chef withdrawals ===

export async function requestWithdrawal(userId: number, amountInput: unknown) {
    const [user] = await db.select({ role: users.role, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (user?.role !== "chef") throw fail(403, "Only chefs can withdraw wallet money. Customers can use theirs on orders.");
    const rules = await getWalletRules();
    const amount = money(Number(amountInput));
    if (!(amount >= rules.withdraw.minAmount)) throw fail(400, `The smallest withdrawal is ${pounds(rules.withdraw.minAmount)}.`);
    const id = await db.transaction(async (tx) => {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
        const open = await tx.select({ id: walletEntries.id }).from(walletEntries).where(and(eq(walletEntries.userId, userId), eq(walletEntries.type, "withdrawal"), eq(walletEntries.status, "requested"))).limit(1);
        if (open.length) throw fail(409, "You already have a withdrawal waiting. You can ask again once it's paid.");
        const { available } = await balanceOf(userId, tx as unknown as typeof db);
        if (amount > available) throw fail(400, `You can withdraw up to ${pounds(available)}.`);
        const [{ id }] = await tx.insert(walletEntries).values({ userId, type: "withdrawal", amount: -amount, status: "requested", note: "Withdrawal" }).$returningId();
        return id;
    });
    await withTemplate("admin.withdrawal_requested", { chefName: user.name, amount: amount.toFixed(2) }, () =>
        notifyAdmins("Chef wallet withdrawal to pay", `${user.name} asked to withdraw ${pounds(amount)} from their wallet.`, "/admin/wallets?tab=withdrawals")).catch(() => undefined);
    return id;
}

/** Pays a withdrawal through Stripe (to the chef's connected account) or records a bank transfer. */
export async function payWithdrawal(entryId: number, adminId: number, body: Record<string, unknown>) {
    if (!Number.isInteger(entryId) || entryId <= 0) throw fail(404, "Withdrawal not found");
    const [w] = await db.select().from(walletEntries).where(and(eq(walletEntries.id, entryId), eq(walletEntries.type, "withdrawal"))).limit(1);
    if (!w) throw fail(404, "Withdrawal not found");
    if (w.status !== "requested") throw fail(400, "This withdrawal has already been dealt with.");
    const amount = -w.amount;
    let method: "stripe" | "bank";
    let reference: string;
    if (body.method === "stripe") {
        const stripe = await getStripe();
        if (!stripe) throw fail(400, "Stripe isn't switched on. Pay by bank transfer and record it instead.");
        const [chef] = await db.select({ accountId: chefs.stripeAccountId, enabled: chefs.stripePayoutsEnabled }).from(chefs).where(eq(chefs.userId, w.userId)).limit(1);
        if (!chef?.accountId || !chef.enabled) throw fail(400, "This chef hasn't connected Stripe for payouts. Pay by bank transfer and record it instead.");
        try {
            const transfer = await stripe.client.transfers.create({ amount: Math.round(amount * 100), currency: "gbp", destination: chef.accountId, description: `MYUKCHEF wallet withdrawal #${w.id}`, metadata: { walletEntry: String(w.id) } }, { idempotencyKey: `wallet-withdrawal-${w.id}` });
            method = "stripe"; reference = transfer.id;
        } catch (error) {
            throw fail(502, `Stripe couldn't send it: ${(error as { message?: string }).message ?? "unknown error"}. Try again, or pay by bank transfer.`);
        }
    } else {
        reference = typeof body.reference === "string" ? body.reference.trim().slice(0, 120) : "";
        if (!reference) throw fail(400, "Add the bank transfer reference, for the record.");
        method = "bank";
    }
    const [claim] = await db.update(walletEntries).set({ status: "paid", payoutMethod: method, payoutReference: reference, decidedBy: adminId, decidedAt: new Date() }).where(and(eq(walletEntries.id, w.id), eq(walletEntries.status, "requested")));
    if (!(claim as unknown as { affectedRows?: number }).affectedRows) throw fail(409, "This withdrawal was just dealt with by someone else.");
    await withTemplate("wallet.withdrawal_paid", { amount: amount.toFixed(2), method: method === "stripe" ? "to your Stripe account" : "by bank transfer" }, () =>
        notify(w.userId, `${pounds(amount)} withdrawal sent`, `We've sent ${pounds(amount)} from your wallet ${method === "stripe" ? "to your Stripe account" : "by bank transfer"}.`, "/chef/dashboard?tab=payouts")).catch(() => undefined);
}

export async function rejectWithdrawal(entryId: number, adminId: number, reasonInput: unknown) {
    if (!Number.isInteger(entryId) || entryId <= 0) throw fail(404, "Withdrawal not found");
    const reason = typeof reasonInput === "string" ? reasonInput.trim().slice(0, 200) : "";
    if (!reason) throw fail(400, "Tell the chef why.");
    const [w] = await db.select().from(walletEntries).where(and(eq(walletEntries.id, entryId), eq(walletEntries.type, "withdrawal"), eq(walletEntries.status, "requested"))).limit(1);
    if (!w) throw fail(404, "Withdrawal not found or already dealt with");
    await db.update(walletEntries).set({ status: "rejected", decidedBy: adminId, decidedAt: new Date(), note: `Withdrawal not paid: ${reason}`.slice(0, 300) }).where(eq(walletEntries.id, w.id));
    await withTemplate("wallet.withdrawal_rejected", { amount: (-w.amount).toFixed(2), reason }, () =>
        notify(w.userId, "Withdrawal not paid", `Your withdrawal of ${pounds(-w.amount)} wasn't paid: ${reason}. The money is back in your wallet.`, "/chef/dashboard?tab=payouts")).catch(() => undefined);
}

// === Super Admin views ===

export async function adminSummary() {
    const [row] = await db.select({
        pending: sql<number>`coalesce(sum(case when ${walletEntries.status} = 'pending' then ${walletEntries.amount} else 0 end), 0)`,
        pendingCount: sql<number>`sum(case when ${walletEntries.status} = 'pending' then 1 else 0 end)`,
        balances: sql<number>`coalesce(sum(case when ${COUNTS} then ${walletEntries.amount} else 0 end), 0)`,
        spent30: sql<number>`coalesce(sum(case when ${walletEntries.type} = 'spend' and ${walletEntries.status} = 'applied' and ${walletEntries.createdAt} > now() - interval 30 day then -${walletEntries.amount} else 0 end), 0)`,
        withdrawals: sql<number>`coalesce(sum(case when ${walletEntries.type} = 'withdrawal' and ${walletEntries.status} = 'requested' then -${walletEntries.amount} else 0 end), 0)`,
        withdrawalCount: sql<number>`sum(case when ${walletEntries.type} = 'withdrawal' and ${walletEntries.status} = 'requested' then 1 else 0 end)`,
    }).from(walletEntries);
    return {
        pending: money(Number(row?.pending ?? 0)), pendingCount: Number(row?.pendingCount ?? 0),
        // Money MYUKCHEF owes in wallets (customers can spend it; chefs can also withdraw it).
        balances: money(Number(row?.balances ?? 0)),
        spentLast30Days: money(Number(row?.spent30 ?? 0)),
        withdrawalsWaiting: money(Number(row?.withdrawals ?? 0)), withdrawalCount: Number(row?.withdrawalCount ?? 0),
        rules: await getWalletRules(),
    };
}

export async function adminEntries(query: { status?: unknown; type?: unknown; userId?: unknown; q?: unknown }) {
    const conditions = [];
    if (typeof query.status === "string" && query.status) conditions.push(eq(walletEntries.status, query.status));
    if (typeof query.type === "string" && query.type) conditions.push(eq(walletEntries.type, query.type));
    if (Number(query.userId)) conditions.push(eq(walletEntries.userId, Number(query.userId)));
    if (typeof query.q === "string" && query.q.trim()) {
        const like = `%${query.q.trim().slice(0, 60)}%`;
        conditions.push(or(sql`${users.name} like ${like}`, sql`${users.email} like ${like}`));
    }
    return db.select({
        id: walletEntries.id, userId: walletEntries.userId, name: users.name, email: users.email, role: users.role,
        type: walletEntries.type, amount: walletEntries.amount, status: walletEntries.status, orderId: walletEntries.orderId,
        note: walletEntries.note, releaseAt: walletEntries.releaseAt, createdAt: walletEntries.createdAt, decidedAt: walletEntries.decidedAt,
        payoutMethod: walletEntries.payoutMethod, payoutReference: walletEntries.payoutReference,
    }).from(walletEntries).innerJoin(users, eq(users.id, walletEntries.userId))
        .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(walletEntries.createdAt), desc(walletEntries.id)).limit(300);
}

/** People with the biggest balances, for the "Wallets" list. */
export async function adminWallets(q: unknown) {
    const like = typeof q === "string" && q.trim() ? `%${q.trim().slice(0, 60)}%` : null;
    const rows = await db.select({
        userId: users.id, name: users.name, email: users.email, role: users.role,
        available: sql<number>`coalesce(sum(case when ${COUNTS} then ${walletEntries.amount} else 0 end), 0)`,
        pending: sql<number>`coalesce(sum(case when ${walletEntries.status} = 'pending' then ${walletEntries.amount} else 0 end), 0)`,
    }).from(users).leftJoin(walletEntries, eq(walletEntries.userId, users.id))
        .where(like ? or(sql`${users.name} like ${like}`, sql`${users.email} like ${like}`) : isNotNull(walletEntries.id))
        .groupBy(users.id, users.name, users.email, users.role)
        .orderBy(desc(sql`coalesce(sum(case when ${COUNTS} then ${walletEntries.amount} else 0 end), 0)`)).limit(100);
    return rows.map((r) => ({ ...r, available: money(Number(r.available)), pending: money(Number(r.pending)) }));
}

// === Background jobs ===

/** Auto-release (if switched on): rewards whose waiting time has passed. */
export async function autoRelease() {
    const rules = await getWalletRules();
    if (rules.release !== "auto") return 0;
    const due = await db.select({ id: walletEntries.id }).from(walletEntries).where(and(eq(walletEntries.status, "pending"), isNotNull(walletEntries.releaseAt), lte(walletEntries.releaseAt, new Date()))).limit(500);
    return releaseCredits(due.map((d) => d.id), null);
}

/**
 * Before wallets, customers collected points that couldn't be spent. Each person's points become
 * pending wallet credit (at the points-for-£1 rate that was set), for a Super Admin to release. Once only.
 */
async function convertPoints() {
    const flag = "wallet_points_converted";
    const [done] = await db.select().from(siteSettings).where(eq(siteSettings.key, flag)).limit(1);
    if (done) return;
    const [loyalty] = await db.select().from(siteSettings).where(eq(siteSettings.key, "loyalty_config")).limit(1);
    const perPound = Math.max(1, Number((loyalty?.value as { redeemRatio?: number } | undefined)?.redeemRatio) || 100);
    await db.insert(siteSettings).values({ key: flag, value: { at: new Date().toISOString(), perPound } });
    const holders = await db.select({ id: users.id, points: users.points }).from(users).where(gt(users.points, 0));
    for (const h of holders) {
        const amount = money(h.points / perPound);
        if (amount >= 0.01) {
            await db.insert(walletEntries).values({ userId: h.id, type: "converted", amount, status: "pending", note: `Your ${h.points} reward points, now wallet credit` });
        }
        await db.update(users).set({ points: 0 }).where(eq(users.id, h.id));
    }
}

export function startWalletJobs() {
    convertPoints().catch((e) => console.error("Converting points failed:", e));
    const run = () => autoRelease().catch((e) => console.error("Wallet auto-release failed:", e));
    setTimeout(run, 120_000).unref();
    setInterval(run, 60 * 60_000).unref();
}

