import { and, eq } from "drizzle-orm";
import { withTemplate } from "./templates";
import type Stripe from "stripe";
import { db } from "../db";
import { eventQuotes, events, mealPlanWeeks, mealPlans, users } from "../db/schema";
import { getCommissionPercent, roundMoney } from "./eventQuotes";
import { getStripe } from "./integrations";
import { notify, notifyChef } from "./notify";

/**
 * Card payments for event bookings and meal plan deliveries, through the same Stripe Checkout as
 * one-off orders. Bank transfer (events) and admin-recorded payments (plans) still work as before.
 */

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SITE_URL = () => (process.env.SITE_URL || "https://myukchef.com").replace(/\/$/, "");

async function checkout(opts: { kind: "event" | "plan_week"; id: number; amount: number; name: string; email?: string | null; returnPath: string }) {
    const stripe = await getStripe();
    if (!stripe) throw fail(400, "Card payments aren't switched on.");
    if (!(opts.amount >= 0.3)) throw fail(400, "There's nothing to pay yet.");
    const back = `${SITE_URL()}${opts.returnPath}`;
    const session = await stripe.client.checkout.sessions.create({
        mode: "payment",
        currency: "gbp",
        line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: Math.round(opts.amount * 100), product_data: { name: opts.name } } }],
        metadata: { kind: opts.kind, id: String(opts.id) },
        payment_intent_data: { metadata: { kind: opts.kind, id: String(opts.id) } },
        ...(opts.email ? { customer_email: opts.email } : {}),
        success_url: `${back}${back.includes("?") ? "&" : "?"}paid=1`,
        cancel_url: `${back}${back.includes("?") ? "&" : "?"}payment=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    }, { idempotencyKey: `${opts.kind}-${opts.id}-${Date.now()}` });
    return session;
}

const emailOf = async (userId: number) => (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0]?.email;
const intentOf = (session: Stripe.Checkout.Session) => (typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null);
const isPaid = (session: Stripe.Checkout.Session) => session.payment_status === "paid" || session.payment_status === "no_payment_required";

// === Events ===

/** Confirms a booking once the customer's payment has arrived, by card or by bank transfer. */
export async function markEventPaid(eventId: number, paymentIntentId: string | null = null) {
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw fail(404, "Booking not found");
    if (event.paymentStatus === "paid") return event;
    if (event.status !== "awaiting_payment") throw fail(400, "The customer needs to confirm their quotes first");
    const [claim] = await db.update(events).set({ paymentStatus: "paid", paidAt: new Date(), status: "confirmed", ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}) })
        .where(and(eq(events.id, event.id), eq(events.status, "awaiting_payment")));
    if ((claim as unknown as { affectedRows?: number }).affectedRows) {
        // The split is fixed now, so later changes to the commission setting can't alter this booking.
        const commissionPercent = await getCommissionPercent();
        const accepted = await db.select().from(eventQuotes).where(and(eq(eventQuotes.eventId, event.id), eq(eventQuotes.status, "accepted")));
        for (const quote of accepted) {
            await db.update(eventQuotes).set({ commissionPercent, payoutAmount: roundMoney((quote.total ?? 0) * (1 - commissionPercent / 100)), payoutStatus: "pending" }).where(eq(eventQuotes.id, quote.id));
            await withTemplate("event.paid_chef", { eventName: event.eventName }, () => notifyChef(quote.chefId, "Booking paid: you're confirmed", `${event.eventName} is paid in full. You can now see the venue, date and time. Your payout follows from MYUKCHEF.`, "/chef/dashboard?tab=bookings"));
        }
        await withTemplate("event.paid", { eventName: event.eventName }, () => notify(event.userId, "Payment received", `Thank you. ${event.eventName} is confirmed and your chefs have been told.`, `/my-bookings/${event.id}`, "event"));
    }
    return (await db.select().from(events).where(eq(events.id, event.id)).limit(1))[0]!;
}

export async function startEventCheckout(eventId: number, userId: number) {
    const [event] = await db.select().from(events).where(and(eq(events.id, eventId), eq(events.userId, userId))).limit(1);
    if (!event) throw fail(404, "Booking not found");
    if (event.status !== "awaiting_payment" || event.paymentStatus === "paid") throw fail(400, "This booking isn't waiting for payment.");
    const session = await checkout({ kind: "event", id: event.id, amount: event.finalTotal ?? 0, name: `MYUKCHEF event: ${event.eventName}`.slice(0, 120), email: await emailOf(userId), returnPath: `/my-bookings/${event.id}` });
    await db.update(events).set({ stripeSessionId: session.id }).where(eq(events.id, event.id));
    return { checkoutUrl: session.url! };
}

/** Refunds an event paid by card. Returns false when it was paid another way. */
export async function refundEventCard(event: typeof events.$inferSelect) {
    if (!event.stripePaymentIntentId) return false;
    const stripe = await getStripe();
    if (!stripe) throw fail(400, "This booking was paid by card, but Stripe isn't set up any more. Refund it in your Stripe dashboard first.");
    try {
        await stripe.client.refunds.create({ payment_intent: event.stripePaymentIntentId, metadata: { kind: "event", id: String(event.id) } }, { idempotencyKey: `refund-event-${event.id}` });
    } catch (error) {
        const e = error as { code?: string; message?: string };
        if (e.code !== "charge_already_refunded") throw fail(409, `Stripe couldn't refund this booking: ${e.message ?? "unknown error"}`);
    }
    return true;
}

// === Meal plan deliveries ===

const PAYABLE_WEEK = ["scheduled", "preparing", "out_for_delivery", "delivered"];

export async function startWeekCheckout(planId: number, weekId: number, userId: number) {
    const [plan] = await db.select().from(mealPlans).where(and(eq(mealPlans.id, planId), eq(mealPlans.userId, userId))).limit(1);
    const [week] = plan ? await db.select().from(mealPlanWeeks).where(and(eq(mealPlanWeeks.id, weekId), eq(mealPlanWeeks.planId, plan.id))).limit(1) : [];
    if (!plan || !week) throw fail(404, "Delivery not found");
    if (week.isPaid) throw fail(400, "This delivery is already paid.");
    if (!PAYABLE_WEEK.includes(week.status)) throw fail(400, "This delivery isn't going ahead, so there's nothing to pay.");
    const session = await checkout({ kind: "plan_week", id: week.id, amount: week.total, name: `MYUKCHEF meal plan: week ${week.weekNumber}`, email: await emailOf(userId), returnPath: `/my-plans/${plan.id}` });
    await db.update(mealPlanWeeks).set({ stripeSessionId: session.id }).where(eq(mealPlanWeeks.id, week.id));
    return { checkoutUrl: session.url! };
}

async function markWeekPaid(weekId: number, paymentIntentId: string | null) {
    const [claim] = await db.update(mealPlanWeeks).set({ isPaid: true, paidAt: new Date(), stripePaymentIntentId: paymentIntentId })
        .where(and(eq(mealPlanWeeks.id, weekId), eq(mealPlanWeeks.isPaid, false)));
    if (!(claim as unknown as { affectedRows?: number }).affectedRows) return;
    const [week] = await db.select().from(mealPlanWeeks).where(eq(mealPlanWeeks.id, weekId)).limit(1);
    const [plan] = week ? await db.select().from(mealPlans).where(eq(mealPlans.id, week.planId)).limit(1) : [];
    if (!week || !plan) return;
    await withTemplate("plan.week_paid", { week: week.weekNumber, amount: week.total.toFixed(2) }, () => notify(plan.userId, `Week ${week.weekNumber} paid`, `Thank you. We've received £${week.total.toFixed(2)} for this delivery.`, `/my-plans/${plan.id}`));
    await withTemplate("plan.week_paid_chef", { week: week.weekNumber }, () => notifyChef(plan.chefId, `Week ${week.weekNumber} paid`, "The customer has paid for this delivery by card.", `/chef/dashboard?tab=plans&plan=${plan.id}`));
}

// === Shared: what Stripe says ===

/** Records a paid checkout for an event or plan delivery. Returns false if the session is for something else (an order). */
export async function settleBookingSession(session: Stripe.Checkout.Session) {
    const kind = session.metadata?.kind;
    const id = Number(session.metadata?.id);
    if ((kind !== "event" && kind !== "plan_week") || !id) return false;
    if (isPaid(session)) {
        if (kind === "event") await markEventPaid(id, intentOf(session)).catch((e) => console.error("Event payment failed to settle:", e));
        else await markWeekPaid(id, intentOf(session));
    }
    return true;
}

/** Asks Stripe about the latest checkout when the customer comes back from paying. */
export async function refreshBookingPayment(kind: "event" | "plan_week", id: number, userId: number) {
    const stripe = await getStripe();
    if (kind === "event") {
        const [event] = await db.select().from(events).where(and(eq(events.id, id), eq(events.userId, userId))).limit(1);
        if (!event) throw fail(404, "Booking not found");
        if (stripe && event.paymentStatus !== "paid" && event.stripeSessionId) await settleBookingSession(await stripe.client.checkout.sessions.retrieve(event.stripeSessionId));
        const [fresh] = await db.select({ paymentStatus: events.paymentStatus, status: events.status }).from(events).where(eq(events.id, id)).limit(1);
        return fresh;
    }
    const [row] = await db.select({ week: mealPlanWeeks, userId: mealPlans.userId }).from(mealPlanWeeks).innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id)).where(eq(mealPlanWeeks.id, id)).limit(1);
    if (!row || row.userId !== userId) throw fail(404, "Delivery not found");
    if (stripe && !row.week.isPaid && row.week.stripeSessionId) await settleBookingSession(await stripe.client.checkout.sessions.retrieve(row.week.stripeSessionId));
    const [fresh] = await db.select({ isPaid: mealPlanWeeks.isPaid }).from(mealPlanWeeks).where(eq(mealPlanWeeks.id, id)).limit(1);
    return fresh;
}
