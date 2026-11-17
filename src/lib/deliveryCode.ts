import crypto from "crypto";
import { and, eq, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { orderChefProgress, orders, siteSettings } from "../db/schema";
import { notifyAdmins } from "./notify";
import { withTemplate } from "./templates";

/**
 * Delivery codes, like Uber Eats: the customer gets a 4-digit code and gives it to whoever hands the
 * food over. The chef can't mark the order delivered (or collected) without it. By default only a
 * customer's first order needs one; Super Admins can ask for it on every order, or on bigger ones.
 */

export const MAX_ATTEMPTS = 5;
const KEY = "delivery_code_config";
const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

/** first: a customer's first order. all: every order. over: orders at or over an amount (plus first orders). off: never. */
export interface CodeRules { mode: "first" | "all" | "over" | "off"; overAmount: number }
const DEFAULTS: CodeRules = { mode: "first", overAmount: 50 };

export async function getCodeRules(): Promise<CodeRules> {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, KEY)).limit(1).catch(() => []);
    const v = (row?.value ?? {}) as Partial<CodeRules>;
    const mode = v.mode === "all" || v.mode === "over" || v.mode === "off" ? v.mode : "first";
    const overAmount = Number(v.overAmount);
    return { mode, overAmount: Number.isFinite(overAmount) && overAmount > 0 ? Math.min(Math.round(overAmount * 100) / 100, 10_000) : DEFAULTS.overAmount };
}

/** Tidies the rules before they're saved from Settings. */
export function cleanCodeRules(value: unknown): CodeRules {
    const v = (value ?? {}) as Partial<CodeRules>;
    const mode = v.mode === "all" || v.mode === "over" || v.mode === "off" ? v.mode : "first";
    const overAmount = Number(v.overAmount);
    if (mode === "over" && !(overAmount > 0)) throw fail(400, "Enter the order amount that needs a delivery code.");
    return { mode, overAmount: overAmount > 0 ? Math.min(Math.round(overAmount * 100) / 100, 10_000) : DEFAULTS.overAmount };
}

/** A customer's first order: no earlier order of theirs that wasn't cancelled. Guests match on email. */
async function isFirstOrder(userId: number | null, email: string | null) {
    const conditions = [
        userId ? eq(orders.userId, userId) : undefined,
        email ? sql`lower(json_unquote(json_extract(${orders.deliveryAddress}, '$.email'))) = ${email.toLowerCase()}` : undefined,
    ].filter(Boolean);
    if (!conditions.length) return true;
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(orders)
        .where(and(or(...conditions), notInArray(orders.status, ["cancelled", "awaiting_payment"])));
    return Number(row?.n ?? 0) === 0;
}

/** A new code for this order if the rules ask for one, else null. */
export async function codeForNewOrder(input: { userId: number | null; email: string | null; total: number }) {
    const rules = await getCodeRules();
    if (rules.mode === "off") return null;
    const needed = rules.mode === "all" || (rules.mode === "over" && input.total >= rules.overAmount) || (await isFirstOrder(input.userId, input.email));
    return needed ? String(crypto.randomInt(0, 10_000)).padStart(4, "0") : null;
}

const sameCode = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checked before a chef marks their part delivered or collected. Wrong codes count; after five the
 * order locks until a Super Admin looks at it, so the code can't be guessed.
 */
export async function checkDeliveryCode(order: typeof orders.$inferSelect, chefId: number, entered: unknown) {
    if (!order.deliveryCode || order.deliveryCodeWaived) return;
    const [part] = await db.select().from(orderChefProgress).where(and(eq(orderChefProgress.orderId, order.id), eq(orderChefProgress.chefId, chefId))).limit(1);
    if (!part || part.codeVerifiedAt) return;
    if (part.codeAttempts >= MAX_ATTEMPTS) throw fail(423, "Too many wrong codes. MYUKCHEF has been told and will contact you.", { codeLocked: true });
    const code = typeof entered === "string" ? entered.replace(/\D/g, "") : "";
    if (!code) throw fail(400, "Ask the customer for their 4-digit delivery code.", { needsCode: true });
    if (sameCode(code, order.deliveryCode)) {
        await db.update(orderChefProgress).set({ codeVerifiedAt: new Date() }).where(eq(orderChefProgress.id, part.id));
        return;
    }
    const attempts = part.codeAttempts + 1;
    await db.update(orderChefProgress).set({ codeAttempts: attempts }).where(and(eq(orderChefProgress.id, part.id), ne(orderChefProgress.codeAttempts, MAX_ATTEMPTS)));
    if (attempts >= MAX_ATTEMPTS) {
        await withTemplate("admin.delivery_code_locked", { orderId: order.id }, () =>
            notifyAdmins(`Order #${order.id}: delivery code locked`, "Five wrong delivery codes were entered. Check with the customer, then let the order be completed without the code.", `/admin/orders?order=${order.id}`)).catch(() => undefined);
        throw fail(423, "Too many wrong codes. MYUKCHEF has been told and will contact you.", { codeLocked: true });
    }
    const left = MAX_ATTEMPTS - attempts;
    throw fail(400, `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`, { needsCode: true, triesLeft: left });
}

/** A Super Admin lets an order be completed without the code, with a reason that's kept on record. */
export async function waiveDeliveryCode(orderId: number, reasonInput: unknown) {
    const reason = typeof reasonInput === "string" ? reasonInput.trim().slice(0, 300) : "";
    if (!reason) throw fail(400, "Say why the code isn't needed, for the record.");
    const [order] = await db.select({ id: orders.id, deliveryCode: orders.deliveryCode }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw fail(404, "Order not found");
    if (!order.deliveryCode) throw fail(400, "This order doesn't need a delivery code.");
    await db.update(orders).set({ deliveryCodeWaived: reason }).where(eq(orders.id, orderId));
}

/** What a chef may know about the code on their part: never the code itself. */
export function codeStatusForChef(order: { deliveryCode: string | null; deliveryCodeWaived: string | null }, part?: { codeAttempts: number; codeVerifiedAt: Date | null } | null) {
    const required = !!order.deliveryCode && !order.deliveryCodeWaived;
    return {
        codeRequired: required && !part?.codeVerifiedAt,
        codeLocked: required && !part?.codeVerifiedAt && (part?.codeAttempts ?? 0) >= MAX_ATTEMPTS,
    };
}

/** The line added to "on its way" / "ready to collect" messages and the confirmation email. */
export function codeNote(order: { deliveryCode: string | null; deliveryCodeWaived: string | null; deliveryAddress: unknown }) {
    if (!order.deliveryCode || order.deliveryCodeWaived) return "";
    const pickup = (order.deliveryAddress as { method?: string } | null)?.method === "pickup";
    return ` Your delivery code is ${order.deliveryCode}. Give it to ${pickup ? "the chef when you collect" : "the person who delivers your food"}.`;
}
