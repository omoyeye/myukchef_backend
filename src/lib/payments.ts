import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { orders } from "../db/schema";
import { getStripe, getStripeSettings } from "./integrations";

// Card payments for one-off orders, through Stripe Checkout. While Stripe isn't set up in the
// admin area, orders are placed without payment, as before.

type OrderRow = typeof orders.$inferSelect;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Whether checkout takes card payments right now, and the key the browser may see. */
export async function paymentConfig() {
    const s = await getStripeSettings();
    return { cardPayments: s.enabled, publishableKey: s.enabled ? s.publishableKey || null : null, testMode: s.enabled && s.testMode };
}

const SITE_URL = () => (process.env.SITE_URL || "https://myukchef.com").replace(/\/$/, "");

/** Starts (or restarts) Stripe Checkout for an unpaid order and returns the page to send the customer to. */
export async function startCheckout(order: OrderRow, customerEmail?: string | null) {
    const stripe = await getStripe();
    if (!stripe) throw fail(400, "Card payments aren't switched on.");
    if (order.paymentStatus !== "awaiting") throw fail(400, order.paymentStatus === "paid" ? "This order is already paid." : "This order can't be paid for.");

    const track = `${SITE_URL()}/order-tracker/${order.id}?t=${order.trackingToken}`;
    const session = await stripe.client.checkout.sessions.create({
        mode: "payment",
        currency: "gbp",
        line_items: [{
            quantity: 1,
            // One line for the whole order, so delivery, fees and discounts always match what we charge.
            price_data: { currency: "gbp", unit_amount: Math.round(order.total * 100), product_data: { name: `MYUKCHEF order #${order.id}` } },
        }],
        client_reference_id: String(order.id),
        metadata: { orderId: String(order.id) },
        payment_intent_data: { metadata: { orderId: String(order.id) } },
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        success_url: `${track}&paid=1`,
        cancel_url: `${track}&payment=cancelled`,
        // Unpaid orders are released after an hour.
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    }, { idempotencyKey: `order-${order.id}-${Date.now()}` });

    await db.update(orders).set({ stripeSessionId: session.id }).where(eq(orders.id, order.id));
    return session.url!;
}

export type PaymentOutcome = "paid" | "failed" | "pending";

/** Reads what Stripe says about an order's checkout. */
export async function checkoutOutcome(sessionOrId: Stripe.Checkout.Session | string): Promise<{ outcome: PaymentOutcome; paymentIntentId: string | null; orderId: number | null }> {
    let session = typeof sessionOrId === "string" ? null : sessionOrId;
    if (!session) {
        const stripe = await getStripe();
        if (!stripe) return { outcome: "pending", paymentIntentId: null, orderId: null };
        session = await stripe.client.checkout.sessions.retrieve(sessionOrId as string);
    }
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
    const orderId = Number(session.metadata?.orderId ?? session.client_reference_id) || null;
    const outcome: PaymentOutcome = session.payment_status === "paid" || session.payment_status === "no_payment_required" ? "paid" : session.status === "expired" ? "failed" : "pending";
    return { outcome, paymentIntentId, orderId };
}

/** Checks a webhook really came from Stripe and returns the event. */
export async function verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    const stripe = await getStripe();
    const { webhookSecret } = await getStripeSettings();
    if (!stripe || !webhookSecret) throw fail(400, "Stripe webhooks aren't set up.");
    if (!signature) throw fail(400, "Missing Stripe signature.");
    try {
        return stripe.client.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
        throw fail(400, "Stripe signature didn't match.");
    }
}

/** Gives the customer their money back in full. Used when a paid order is cancelled. */
export async function refundOrder(order: OrderRow) {
    if (order.paymentStatus !== "paid") return false;
    const stripe = await getStripe();
    if (!stripe) throw fail(400, "This order was paid by card, but Stripe isn't set up any more, so it can't be refunded here. Refund it in your Stripe dashboard, then cancel it.");
    let intent = order.stripePaymentIntentId;
    if (!intent && order.stripeSessionId) intent = (await checkoutOutcome(order.stripeSessionId)).paymentIntentId;
    if (!intent) throw fail(400, "Couldn't find this order's payment in Stripe. Refund it in your Stripe dashboard, then cancel it.");
    try {
        await stripe.client.refunds.create({ payment_intent: intent, metadata: { orderId: String(order.id) } }, { idempotencyKey: `refund-order-${order.id}` });
    } catch (error) {
        const e = error as { code?: string; message?: string };
        if (e.code !== "charge_already_refunded") throw fail(409, `Stripe couldn't refund this order: ${e.message ?? "unknown error"}`);
    }
    await db.update(orders).set({ paymentStatus: "refunded", refundedAt: new Date() }).where(eq(orders.id, order.id));
    return true;
}
