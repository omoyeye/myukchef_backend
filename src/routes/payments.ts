import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { orders } from "../db/schema";
import { settlePayment } from "../lib/orderPlaced";
import { checkoutOutcome, verifyWebhook } from "../lib/payments";

/**
 * POST /api/payments/stripe/webhook. Stripe tells us when a checkout is paid or runs out.
 * Needs the raw request body to check Stripe's signature, so it's mounted before express.json().
 */
export async function stripeWebhook(req: Request, res: Response) {
    let event: Stripe.Event;
    try {
        event = await verifyWebhook(req.body as Buffer, req.get("stripe-signature"));
    } catch (error) {
        return res.status(400).json({ error: (error as Error).message });
    }
    try {
        if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded"
            || event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
            const session = event.data.object as Stripe.Checkout.Session;
            const { outcome, paymentIntentId, orderId } = await checkoutOutcome(session);
            const failed = event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed";
            if (orderId) {
                const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
                // A payment always counts. Running out only cancels the order if it's the latest
                // checkout, so an older abandoned one can't cancel an order being paid now.
                if (order && !failed && outcome === "paid") await settlePayment(order, "paid", paymentIntentId);
                else if (order && failed && order.stripeSessionId === session.id) await settlePayment(order, "failed", paymentIntentId);
            }
        }
        res.json({ received: true });
    } catch (error) {
        console.error("Stripe webhook failed:", error);
        // Stripe retries on errors, which is what we want if the database was briefly away.
        res.status(500).json({ error: "Webhook handling failed" });
    }
}
