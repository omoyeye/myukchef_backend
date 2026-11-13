import bcrypt from "bcrypt";
import crypto from "crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import {
    addresses, chefCredentials, chefInvoices, chefReviews, chefs, eventQuoteMessages, eventQuotes, events, favouriteChefs, mealPlanMessages, mealPlans, notificationPreferences,
    notifications, orderChefProgress, orderItems, orders, passwordResetTokens, pushSubscriptions, mobilePushTokens, reviews, supportMessages, users,
} from "../db/schema";

/** Everything held about a person, for "download my data". */
export async function exportUserData(userId: number) {
    const [{ password: _password, ...account }] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const ownOrders = await db.select().from(orders).where(eq(orders.userId, userId));
    const items = ownOrders.length ? await db.select().from(orderItems).where(inArray(orderItems.orderId, ownOrders.map((o) => o.id))) : [];
    const plans = await db.select().from(mealPlans).where(eq(mealPlans.userId, userId));
    const bookings = await db.select().from(events).where(eq(events.userId, userId));
    const [chefProfile] = await db.select().from(chefs).where(eq(chefs.userId, userId)).limit(1);
    return {
        exportedAt: new Date().toISOString(),
        account,
        addresses: await db.select().from(addresses).where(eq(addresses.userId, userId)),
        orders: ownOrders.map(({ trackingToken: _t, courierLat: _a, courierLng: _b, ...o }) => ({ ...o, items: items.filter((i) => i.orderId === o.id) })),
        mealPlans: plans.map(({ adminNotes: _n, ...p }) => p),
        planMessagesSent: await db.select().from(mealPlanMessages).where(eq(mealPlanMessages.senderId, userId)),
        eventBookings: bookings.map(({ adminNotes: _n, ...b }) => b),
        eventMessagesSent: await db.select().from(eventQuoteMessages).where(eq(eventQuoteMessages.senderId, userId)),
        dishReviews: await db.select().from(reviews).where(eq(reviews.userId, userId)),
        chefReviews: await db.select().from(chefReviews).where(eq(chefReviews.userId, userId)),
        savedChefs: await db.select().from(favouriteChefs).where(eq(favouriteChefs.userId, userId)),
        notifications: await db.select().from(notifications).where(eq(notifications.userId, userId)),
        notificationPreferences: await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)),
        chefProfile: chefProfile ? (({ stripeAccountId: _s, ...p }) => p)(chefProfile) : null,
        chefCertificates: chefProfile ? (await db.select().from(chefCredentials).where(eq(chefCredentials.chefId, chefProfile.id))).map(({ document, ...c }) => ({ ...c, copyOnFile: !!document })) : [],
        chefInvoices: chefProfile ? await db.select().from(chefInvoices).where(eq(chefInvoices.chefId, chefProfile.id)) : [],
    };
}

/** Bookings still in progress must finish or be cancelled first, so nobody is left cooking for a blank name. */
export async function openCommitments(userId: number) {
    const plans = await db.select({ id: mealPlans.id }).from(mealPlans).where(and(eq(mealPlans.userId, userId), inArray(mealPlans.status, ["requested", "active", "paused"]))).limit(1);
    const bookings = await db.select({ id: events.id }).from(events).where(and(eq(events.userId, userId), inArray(events.status, ["quoting", "pending", "quotes_ready", "awaiting_payment", "confirmed", "in_progress"]))).limit(1);
    return { hasOpenPlan: plans.length > 0, hasOpenBooking: bookings.length > 0 };
}

/**
 * Removes a person's details but keeps anonymous order, plan and booking totals for the accounts.
 */
export async function erasePersonalData(userId: number) {
    const REMOVED = "[Removed]";
    const scrambled = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
    await db.transaction(async (tx) => {
        const [person] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        // Problem reports are the customer's own words, so they go too. Delivery photos stay as evidence of payment.
        const orderIds = (await tx.select({ id: orders.id }).from(orders).where(eq(orders.userId, userId))).map((o) => o.id);
        if (orderIds.length) await tx.update(orderChefProgress).set({ customerIssue: null }).where(inArray(orderChefProgress.orderId, orderIds));
        await tx.update(orders).set({ userId: null, deliveryAddress: {}, deliveryLat: null, deliveryLng: null, courierLat: null, courierLng: null, trackingToken: null }).where(eq(orders.userId, userId));
        await tx.update(mealPlans).set({ deliveryAddress: { street: "", city: "", postcode: "", phone: "" }, requests: null, dietary: [], avoidAllergens: [], cancelReason: null }).where(eq(mealPlans.userId, userId));
        await tx.update(mealPlanMessages).set({ body: REMOVED }).where(eq(mealPlanMessages.senderId, userId));
        const bookings = await tx.select({ id: events.id }).from(events).where(eq(events.userId, userId));
        if (bookings.length > 0) {
            await tx.update(events).set({ venue: REMOVED, contactPhone: "", contactEmail: "", specialRequests: null }).where(eq(events.userId, userId));
            await tx.update(eventQuotes).set({ preferences: null }).where(inArray(eventQuotes.eventId, bookings.map((b) => b.id)));
        }
        await tx.update(eventQuoteMessages).set({ body: REMOVED }).where(eq(eventQuoteMessages.senderId, userId));
        if (person) await tx.delete(supportMessages).where(eq(supportMessages.email, person.email));
        await tx.delete(addresses).where(eq(addresses.userId, userId));
        await tx.delete(reviews).where(eq(reviews.userId, userId));
        await tx.delete(chefReviews).where(eq(chefReviews.userId, userId));
        await tx.delete(favouriteChefs).where(eq(favouriteChefs.userId, userId));
        await tx.delete(notifications).where(eq(notifications.userId, userId));
        await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
        await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
        await tx.delete(mobilePushTokens).where(eq(mobilePushTokens.userId, userId));
        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
        // The row stays so anonymous plans and bookings keep their history, but nothing identifies the person.
        await tx.update(users).set({ name: "Deleted customer", email: `deleted-${userId}@deleted.invalid`, password: scrambled, role: "customer", points: 0, termsAcceptedAt: null }).where(eq(users.id, userId));
    });
}

const months = (n: number) => new Date(Date.now() - n * 30 * 24 * 60 * 60 * 1000);

/** Daily tidying, matching the periods stated in the Privacy Policy. */
export async function runRetentionJobs() {
    await db.delete(notifications).where(lt(notifications.createdAt, months(12)));
    await db.delete(passwordResetTokens).where(lt(passwordResetTokens.expiresAt, new Date()));
    await db.delete(supportMessages).where(and(eq(supportMessages.status, "closed"), lt(supportMessages.createdAt, months(24))));
    await db.delete(mealPlanMessages).where(lt(mealPlanMessages.createdAt, months(24)));
    await db.delete(eventQuoteMessages).where(lt(eventQuoteMessages.createdAt, months(24)));
    // Addresses aren't needed once an order is long finished. Totals stay for the accounts.
    await db.update(orders).set({ deliveryAddress: {}, deliveryLat: null, deliveryLng: null, trackingToken: null }).where(and(inArray(orders.status, ["completed", "cancelled"]), lt(orders.createdAt, months(24))));
}

export function startRetentionJobs() {
    const run = () => runRetentionJobs().catch((e) => console.error("Retention jobs failed:", e));
    run();
    setInterval(run, 24 * 60 * 60 * 1000).unref();
}
