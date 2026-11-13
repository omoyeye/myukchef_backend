import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { chefCompliance, chefInvoices, chefs, eventQuotes, events, orderChefProgress, orders, siteSettings, users } from "../db/schema";
import { getStripe } from "./integrations";
import { notifyAdmins, notifyChef } from "./notify";

/**
 * How chefs get paid. Once food is delivered and confirmed (or an event attended), MYUKCHEF raises an
 * invoice: the chef's sales, less MYUKCHEF's commission. The chef checks and submits it, then MYUKCHEF
 * pays them: automatically by Stripe when the chef has connected a Stripe account, otherwise a Super
 * Admin pays by bank transfer and records it. Either way a receipt is issued to both sides.
 */

type Invoice = typeof chefInvoices.$inferSelect;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
export const roundMoney = (n: number) => Math.round(n * 100) / 100;

export const PAYOUT_DEFAULTS = { percent: 10, autoConfirmHours: 48 };

/** The Super Admin's payout rules: MYUKCHEF's commission on orders, and how long customers have to confirm. */
export async function getPayoutRules() {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, "chef_commission")).limit(1);
    const value = (row?.value ?? {}) as { percent?: unknown; autoConfirmHours?: unknown };
    const percent = Number(value.percent ?? PAYOUT_DEFAULTS.percent);
    const hours = Number(value.autoConfirmHours ?? PAYOUT_DEFAULTS.autoConfirmHours);
    return {
        percent: Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : PAYOUT_DEFAULTS.percent,
        autoConfirmHours: Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 14) : PAYOUT_DEFAULTS.autoConfirmHours,
    };
}

export const splitPayout = (gross: number, percent: number) => {
    const commission = roundMoney(gross * (percent / 100));
    return { gross: roundMoney(gross), commission, net: roundMoney(gross - commission) };
};

const year = () => new Date().getFullYear();
const numbered = (prefix: string, id: number) => `${prefix}-${year()}-${String(id).padStart(6, "0")}`;

/** The chef's details as they stand now, kept on the invoice so the record never changes. */
async function chefSnapshot(chefId: number) {
    const [row] = await db.select({ chef: chefs, email: users.email, compliance: chefCompliance })
        .from(chefs)
        .innerJoin(users, eq(chefs.userId, users.id))
        .leftJoin(chefCompliance, eq(chefCompliance.chefId, chefs.id))
        .where(eq(chefs.id, chefId)).limit(1);
    if (!row) throw fail(404, "Chef not found");
    const c = row.compliance;
    return {
        userId: row.chef.userId,
        email: row.email,
        details: {
            displayName: row.chef.displayName,
            legalName: c?.legalName ?? null,
            address: [c?.addressLine, c?.city, c?.postcode].filter(Boolean).join(", ") || null,
            taxReference: c?.taxReference ?? null,
            bankAccountName: c?.bankAccountName ?? null,
            bankAccountEnding: c?.bankAccountNumber ? c.bankAccountNumber.slice(-4) : null,
        },
    };
}

async function createInvoice(input: {
    chefId: number; kind: "order" | "event"; sourceKey: string; description: string;
    gross: number; percent: number; orderId?: number | null; progressId?: number | null; quoteId?: number | null;
}) {
    const [existing] = await db.select().from(chefInvoices).where(eq(chefInvoices.sourceKey, input.sourceKey)).limit(1);
    if (existing) return existing;
    const { gross, commission, net } = splitPayout(input.gross, input.percent);
    const snapshot = await chefSnapshot(input.chefId);
    try {
        const [{ id }] = await db.insert(chefInvoices).values({
            number: `TMP-${input.sourceKey}`,
            chefId: input.chefId,
            kind: input.kind,
            sourceKey: input.sourceKey,
            orderId: input.orderId ?? null,
            progressId: input.progressId ?? null,
            quoteId: input.quoteId ?? null,
            description: input.description.slice(0, 255),
            grossAmount: gross,
            commissionPercent: input.percent,
            commissionAmount: commission,
            netAmount: net,
            chefDetails: snapshot.details,
        }).$returningId();
        await db.update(chefInvoices).set({ number: numbered("INV", id) }).where(eq(chefInvoices.id, id));
    } catch (error) {
        // Raised at the same moment elsewhere: the unique source key keeps it to one.
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code !== "ER_DUP_ENTRY" && e.cause?.code !== "ER_DUP_ENTRY") throw error;
    }
    const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.sourceKey, input.sourceKey)).limit(1);
    if (invoice && invoice.number.startsWith("INV") && invoice.status === "awaiting_chef" && !existing) {
        await notifyChef(
            input.chefId,
            `Invoice ${invoice.number} is ready`,
            `${input.description}: £${net.toFixed(2)} after MYUKCHEF's ${input.percent}% commission. Please check and submit it so we can pay you.`,
            "/chef/dashboard?tab=payouts",
        );
    }
    return invoice;
}

/** Raises the invoice for a chef's delivered part of an order, once the customer has confirmed it. */
export async function raiseOrderInvoice(progressId: number, { force = false } = {}) {
    const [part] = await db.select().from(orderChefProgress).where(eq(orderChefProgress.id, progressId)).limit(1);
    if (!part || part.status !== "completed" || !part.deliveryProof) return null;
    if (!part.customerConfirmedAt && !force) return null;
    if (part.customerIssue && !force) return null;
    const [order] = await db.select().from(orders).where(eq(orders.id, part.orderId)).limit(1);
    if (!order || order.status === "cancelled" || ["refunded", "failed", "awaiting"].includes(order.paymentStatus)) return null;

    const percent = part.commissionPercent ?? (await getPayoutRules()).percent;
    const gross = part.grossAmount ?? part.payoutAmount ?? 0;
    const { net } = splitPayout(gross, percent);
    await db.update(orderChefProgress).set({ commissionPercent: percent, grossAmount: gross, payoutAmount: net }).where(eq(orderChefProgress.id, part.id));
    return createInvoice({
        chefId: part.chefId, kind: "order", sourceKey: `order:${part.id}`,
        description: `Order #${order.id}`, gross, percent, orderId: order.id, progressId: part.id,
    });
}

/** Raises the invoice for a chef's share of an event, once they've attended and the customer has paid. */
export async function raiseEventInvoice(quoteId: number) {
    const [quote] = await db.select().from(eventQuotes).where(eq(eventQuotes.id, quoteId)).limit(1);
    if (!quote || quote.status !== "accepted" || quote.attended !== true || quote.payoutStatus === "cancelled") return null;
    const [event] = await db.select().from(events).where(eq(events.id, quote.eventId)).limit(1);
    if (!event || event.paymentStatus !== "paid") return null;
    const gross = quote.total ?? 0;
    const percent = quote.commissionPercent ?? (await getPayoutRules()).percent;
    return createInvoice({
        chefId: quote.chefId, kind: "event", sourceKey: `event:${quote.id}`,
        description: `Event: ${event.eventName}`, gross, percent, quoteId: quote.id,
    });
}

// === The chef's side ===

/** The chef checks the invoice and submits it with their name. MYUKCHEF then pays straight away where it can. */
export async function submitInvoice(invoiceId: number, chefId: number, body: { confirm?: unknown; name?: unknown }) {
    const [invoice] = await db.select().from(chefInvoices).where(and(eq(chefInvoices.id, invoiceId), eq(chefInvoices.chefId, chefId))).limit(1);
    if (!invoice) throw fail(404, "Invoice not found");
    if (invoice.status !== "awaiting_chef") throw fail(400, invoice.status === "paid" ? "This invoice has already been paid." : "This invoice has already been submitted.");
    if (body.confirm !== true) throw fail(400, "Please confirm the invoice is correct.");
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 150) : "";
    if (name.length < 2) throw fail(400, "Type your full name to submit the invoice.");
    await db.update(chefInvoices).set({ status: "submitted", submittedAt: new Date(), submittedName: name, payoutError: null }).where(eq(chefInvoices.id, invoice.id));
    await notifyAdmins(`Invoice ${invoice.number} submitted`, `${invoice.chefDetails?.displayName ?? "A chef"} submitted ${invoice.number} for £${invoice.netAmount.toFixed(2)}.`, "/admin/orders?tab=payouts");
    return payInvoiceAutomatically(invoice.id);
}

// === Paying ===

/** Pays a submitted invoice through Stripe Connect. If that isn't possible, it waits for a bank transfer. */
export async function payInvoiceAutomatically(invoiceId: number) {
    // Claim the invoice first, so two attempts at once can't both pay it.
    const [claim] = await db.update(chefInvoices).set({ status: "processing" })
        .where(and(eq(chefInvoices.id, invoiceId), eq(chefInvoices.status, "submitted")));
    const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoiceId)).limit(1);
    if (!invoice) throw fail(404, "Invoice not found");
    if (!(claim as unknown as { affectedRows?: number }).affectedRows) return invoice;

    const waitForBank = async (reason: string) => {
        await db.update(chefInvoices).set({ status: "submitted", payoutError: reason }).where(eq(chefInvoices.id, invoice.id));
        await notifyAdmins(`Pay ${invoice.chefDetails?.displayName ?? "a chef"} by bank transfer`, `${invoice.number}, £${invoice.netAmount.toFixed(2)}: ${reason}`, "/admin/orders?tab=payouts");
        const [fresh] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoice.id)).limit(1);
        return fresh;
    };

    const stripe = await getStripe();
    if (!stripe) return waitForBank("Card payments (Stripe) aren't switched on, so this needs paying by bank transfer.");
    const [chef] = await db.select({ accountId: chefs.stripeAccountId, enabled: chefs.stripePayoutsEnabled }).from(chefs).where(eq(chefs.id, invoice.chefId)).limit(1);
    if (!chef?.accountId || !chef.enabled) return waitForBank("The chef hasn't finished connecting a Stripe account for payouts.");

    // Paying from the customer's own card payment means the money is there even before it settles.
    let sourceTransaction: string | undefined;
    if (invoice.orderId) {
        const [order] = await db.select({ intent: orders.stripePaymentIntentId, status: orders.paymentStatus }).from(orders).where(eq(orders.id, invoice.orderId)).limit(1);
        if (order?.status === "paid" && order.intent) {
            const intent = await stripe.client.paymentIntents.retrieve(order.intent).catch(() => null);
            const charge = intent?.latest_charge;
            sourceTransaction = typeof charge === "string" ? charge : charge?.id;
        }
    }
    try {
        const transfer = await stripe.client.transfers.create({
            amount: Math.round(invoice.netAmount * 100),
            currency: "gbp",
            destination: chef.accountId,
            description: `${invoice.number} · ${invoice.description}`,
            metadata: { invoice: invoice.number, chefId: String(invoice.chefId) },
            ...(invoice.orderId ? { transfer_group: `order-${invoice.orderId}` } : {}),
            ...(sourceTransaction ? { source_transaction: sourceTransaction } : {}),
        }, { idempotencyKey: `invoice-${invoice.id}` });
        return markInvoicePaid(invoice.id, { method: "stripe", transferId: transfer.id, by: null, fromStatus: "processing" });
    } catch (error) {
        const message = (error as { message?: string }).message ?? "unknown error";
        console.error(`Automatic payout for ${invoice.number} failed:`, message);
        return waitForBank(`Stripe couldn't send the payout (${message}).`);
    }
}

/** Records a payout and issues the receipt. Used by Stripe payouts and by Super Admins after a bank transfer. */
export async function markInvoicePaid(invoiceId: number, opts: { method: "stripe" | "bank"; transferId?: string; by: number | null; fromStatus?: string }) {
    const from = opts.fromStatus ?? "submitted";
    const [result] = await db.update(chefInvoices)
        .set({ status: "paid", paidAt: new Date(), payMethod: opts.method, stripeTransferId: opts.transferId ?? null, paidBy: opts.by, payoutError: null })
        .where(and(eq(chefInvoices.id, invoiceId), eq(chefInvoices.status, from)));
    const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoiceId)).limit(1);
    if (!invoice) throw fail(404, "Invoice not found");
    if (!(result as unknown as { affectedRows?: number }).affectedRows) {
        if (invoice.status === "paid") return invoice;
        throw fail(400, invoice.status === "awaiting_chef" ? "The chef needs to submit this invoice first." : `This invoice is ${invoice.status.replace("_", " ")}.`);
    }
    await db.update(chefInvoices).set({ receiptNumber: numbered("RCT", invoice.id) }).where(eq(chefInvoices.id, invoice.id));
    if (invoice.progressId) await db.update(orderChefProgress).set({ payoutStatus: "paid", paidAt: new Date() }).where(eq(orderChefProgress.id, invoice.progressId));
    if (invoice.quoteId) await db.update(eventQuotes).set({ payoutStatus: "paid", payoutPaidAt: new Date() }).where(eq(eventQuotes.id, invoice.quoteId));

    const how = opts.method === "stripe" ? "to your Stripe account" : "by bank transfer";
    await notifyChef(invoice.chefId, `You've been paid £${invoice.netAmount.toFixed(2)}`, `MYUKCHEF has paid ${invoice.number} ${how}. Your receipt is ready.`, `/chef/receipts/${invoice.id}`);
    // notifyChef sends it in the app, as a push notification and by email.
    const [paid] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoice.id)).limit(1);
    return paid;
}

// === Super Admin controls ===

export async function holdInvoice(invoiceId: number, reason: unknown) {
    const note = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    if (!note) throw fail(400, "Say why the payout is on hold.");
    const [result] = await db.update(chefInvoices).set({ status: "held", holdReason: note })
        .where(and(eq(chefInvoices.id, invoiceId), inArray(chefInvoices.status, ["awaiting_chef", "submitted"])));
    if (!(result as unknown as { affectedRows?: number }).affectedRows) throw fail(400, "Only unpaid invoices can be put on hold.");
    const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoiceId)).limit(1);
    await notifyChef(invoice!.chefId, `Payout for ${invoice!.number} on hold`, note, "/chef/dashboard?tab=payouts");
    return invoice!;
}

export async function releaseInvoice(invoiceId: number) {
    const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoiceId)).limit(1);
    if (!invoice || invoice.status !== "held") throw fail(400, "Only held invoices can be released.");
    const next = invoice.submittedAt ? "submitted" : "awaiting_chef";
    await db.update(chefInvoices).set({ status: next, holdReason: null }).where(eq(chefInvoices.id, invoice.id));
    await notifyChef(invoice.chefId, `Payout for ${invoice.number} released`, next === "submitted" ? "It's on its way to being paid." : "Please check and submit your invoice.", "/chef/dashboard?tab=payouts");
    return next === "submitted" ? payInvoiceAutomatically(invoice.id) : (await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoice.id)).limit(1))[0];
}

/** Cancels unpaid invoices for an order, for example when it's refunded. */
export async function voidOrderInvoices(orderId: number, reason: string) {
    const open = await db.select().from(chefInvoices).where(and(eq(chefInvoices.orderId, orderId), inArray(chefInvoices.status, ["awaiting_chef", "submitted", "held"])));
    for (const invoice of open) {
        await db.update(chefInvoices).set({ status: "void", holdReason: reason }).where(eq(chefInvoices.id, invoice.id));
        await notifyChef(invoice.chefId, `${invoice.number} cancelled`, reason, "/chef/dashboard?tab=payouts");
    }
    return open.length;
}

// === Lists ===

const withChefName = async (rows: Invoice[]) => {
    const ids = [...new Set(rows.map((r) => r.chefId))];
    const names = new Map(ids.length ? (await db.select({ id: chefs.id, name: chefs.displayName, connected: chefs.stripePayoutsEnabled }).from(chefs).where(inArray(chefs.id, ids))).map((c) => [c.id, c]) : []);
    return rows.map((r) => ({ ...r, chefName: names.get(r.chefId)?.name ?? "Chef", stripeConnected: !!names.get(r.chefId)?.connected }));
};

export async function invoicesForChef(chefId: number) {
    return db.select().from(chefInvoices).where(eq(chefInvoices.chefId, chefId)).orderBy(desc(chefInvoices.createdAt)).limit(300);
}

export async function allInvoices() {
    const rows = await db.select().from(chefInvoices).orderBy(sql`${chefInvoices.status} = 'paid'`, desc(chefInvoices.createdAt)).limit(500);
    return withChefName(rows);
}

/** One invoice or receipt, for the chef it belongs to or a Super Admin. */
export async function invoiceForViewer(invoiceId: number, viewer: { chefId: number | null; admin: boolean }) {
    const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.id, invoiceId)).limit(1);
    if (!invoice || (!viewer.admin && invoice.chefId !== viewer.chefId)) throw fail(404, "Invoice not found");
    const [named] = await withChefName([invoice]);
    const [company] = await db.select().from(siteSettings).where(eq(siteSettings.key, "company_info")).limit(1);
    return { ...named, platform: company?.value ?? null };
}

// === Background jobs ===

/** Customers who don't confirm or report a problem in time are taken to have received their food. */
export async function autoConfirmDeliveries() {
    const { autoConfirmHours } = await getPayoutRules();
    const cutoff = new Date(Date.now() - autoConfirmHours * 3600_000);
    const due = await db.select({ id: orderChefProgress.id, chefId: orderChefProgress.chefId, orderId: orderChefProgress.orderId }).from(orderChefProgress)
        .where(and(eq(orderChefProgress.status, "completed"), isNull(orderChefProgress.customerConfirmedAt), isNull(orderChefProgress.customerIssue), lt(orderChefProgress.deliveredAt, cutoff)))
        .limit(200);
    for (const part of due) {
        await db.update(orderChefProgress).set({ customerConfirmedAt: new Date(), autoConfirmed: true }).where(eq(orderChefProgress.id, part.id));
        await raiseOrderInvoice(part.id).catch((e) => console.error(`Invoice for order part ${part.id} failed:`, e));
    }
    // Catch any confirmed deliveries whose invoice wasn't raised (for example after a restart).
    const missing = await db.execute(sql`
        select p.id from order_chef_progress p
        left join chef_invoices i on i.source_key = concat('order:', p.id)
        where p.status = 'completed' and p.customer_confirmed_at is not null and p.customer_issue is null and i.id is null
        limit 200`);
    const rows = (missing as unknown as [{ id: number }[]])[0] ?? [];
    for (const row of rows) await raiseOrderInvoice(row.id).catch((e) => console.error(`Invoice for order part ${row.id} failed:`, e));
    return due.length;
}

export function startPayoutJobs() {
    const run = () => autoConfirmDeliveries().catch((e) => console.error("Payout job failed:", e));
    setTimeout(run, 30_000).unref();
    setInterval(run, 15 * 60 * 1000).unref();
}
