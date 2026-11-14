import { Request, Router } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chefCompliance, chefInvoices, chefProducts, chefs, eventQuoteMessages, eventQuotes, events, products, QuoteItem, users } from "../db/schema";
import { markInvoicePaid, raiseEventInvoice } from "../lib/chefPayouts";
import { markEventPaid, refreshBookingPayment, refundEventCard, startEventCheckout } from "../lib/bookingPayments";
import { getUserId, isAdmin, requireAdmin, requireAuth } from "../lib/auth";
import { assertNoContactDetails } from "../lib/contactGuard";
import { getBankDetails, getCommissionPercent, notifyAdmins, paymentReference, refreshQuoteStage, roundMoney } from "../lib/eventQuotes";
import { notify, notifyChef } from "../lib/mealPlans";
import { badRequest } from "../lib/pricing";
import { rateLimit } from "../lib/rateLimit";
import { reviewSource } from "./chefReviews";

const router = Router();
type Event = typeof events.$inferSelect;
type Quote = typeof eventQuotes.$inferSelect;

const STATUSES = ["quoting", "quotes_ready", "awaiting_payment", "confirmed", "in_progress", "completed", "cancelled", "pending"];
const PAID_STAGES = ["confirmed", "in_progress", "completed"];
const notFound = () => Object.assign(new Error("Booking not found"), { status: 404 });
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

/** The customer never sees what MYUKCHEF keeps or pays out, and neither side sees the other's contact details. */
const quoteForCustomer = ({ commissionPercent: _c, payoutAmount: _a, payoutStatus: _s, payoutPaidAt: _p, ...quote }: Quote) => quote;

async function quotesWithChefs(eventIds: number[]) {
    if (eventIds.length === 0) return [];
    return db.select({ quote: eventQuotes, chef: { id: chefs.id, displayName: chefs.displayName, avatar: chefs.avatar, specialty: chefs.specialty } })
        .from(eventQuotes)
        .innerJoin(chefs, eq(eventQuotes.chefId, chefs.id))
        .where(inArray(eventQuotes.eventId, eventIds))
        .orderBy(asc(eventQuotes.id));
}

async function messagesByQuote(quoteIds: number[]) {
    const byQuote = new Map<number, (typeof eventQuoteMessages.$inferSelect)[]>();
    if (quoteIds.length === 0) return byQuote;
    const rows = await db.select().from(eventQuoteMessages).where(inArray(eventQuoteMessages.quoteId, quoteIds)).orderBy(asc(eventQuoteMessages.createdAt));
    for (const row of rows) byQuote.set(row.quoteId, [...(byQuote.get(row.quoteId) ?? []), row]);
    return byQuote;
}

async function ownEvent(req: Request) {
    const [event] = await db.select().from(events).where(and(eq(events.id, Number(req.params.id)), eq(events.userId, getUserId(req)))).limit(1);
    if (!event) throw notFound();
    return event;
}

/** Works out what a chef was asked for, using today's menu as the guide price. */
async function buildChefRequest(chefId: number, items: unknown) {
    const wanted = (Array.isArray(items) ? items : [])
        .map((item) => ({ id: String(item?.id ?? ""), quantity: Math.floor(Number(item?.quantity)) }))
        .filter((item) => item.id && item.quantity > 0 && item.quantity <= 100000);
    if (wanted.length === 0) return [];
    const ids = wanted.map((item) => item.id);
    const chefDishes = await db.select().from(chefProducts).where(and(inArray(chefProducts.id, ids), eq(chefProducts.chefId, chefId), eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true)));
    const menuDishes = await db.select().from(products).where(and(inArray(products.id, ids), eq(products.chefId, chefId), eq(products.allergensDeclared, true)));
    const dishes = [...chefDishes, ...menuDishes];
    return wanted.map((item): QuoteItem => {
        const dish = dishes.find((d) => d.id === item.id);
        if (!dish) throw badRequest("One of those dishes isn't available from that chef");
        return { id: dish.id, name: dish.name, image: dish.image, quantity: item.quantity, allergens: dish.allergens ?? [], guidePrice: dish.price, unitPrice: null };
    });
}

// === CUSTOMER ===

// POST /events: ask several chefs to quote for one event
router.post("/", requireAuth, rateLimit(30, 60_000), async (req, res) => {
    const userId = getUserId(req);
    const [account] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (account?.role !== "customer") throw badRequest("Please sign in with a customer account to request quotes");

    const eventName = text(req.body.eventName, 150);
    const venue = text(req.body.venue, 300);
    const eventTime = text(req.body.eventTime, 10);
    const contactPhone = text(req.body.contactPhone, 30);
    const specialRequests = text(req.body.specialRequests, 2000) || null;
    const headcount = Math.floor(Number(req.body.headcount));
    const eventDate = new Date(req.body.eventDate);
    if (!eventName || !venue || !eventTime || !contactPhone || !(headcount > 0)) throw badRequest("Please complete all the event details");
    if (Number.isNaN(eventDate.getTime()) || eventDate.getTime() < Date.now()) throw badRequest("Please choose a date in the future");
    assertNoContactDetails(eventName, venue, specialRequests);

    const asked = Array.isArray(req.body.chefRequests) ? req.body.chefRequests : [];
    const chefIds = [...new Set<number>(asked.map((r: { chefId?: unknown }) => Number(r?.chefId)))];
    if (chefIds.length === 0) throw badRequest("Please choose at least one chef");
    if (chefIds.length > 15) throw badRequest("Please choose up to 15 chefs for one event");
    const available = await db.select().from(chefs).where(and(inArray(chefs.id, chefIds), eq(chefs.status, "approved"), eq(chefs.isAvailableForEvents, true)));
    if (available.length !== chefIds.length) throw badRequest("One of those chefs isn't taking event bookings right now");

    const requests: { chefId: number; preferences: string | null; items: QuoteItem[] }[] = [];
    for (const chefId of chefIds) {
        const entry = asked.find((r: { chefId?: unknown }) => Number(r?.chefId) === chefId);
        const preferences = text(entry?.preferences, 1000) || null;
        assertNoContactDetails(preferences);
        const items = await buildChefRequest(chefId, entry?.items);
        if (items.length === 0 && !preferences) throw badRequest("Please choose dishes or tell each chef what you'd like");
        requests.push({ chefId, preferences, items });
    }

    const id = await db.transaction(async (tx) => {
        const [{ id: eventId }] = await tx.insert(events).values({
            userId, chefId: chefIds.length === 1 ? chefIds[0] : null, packageType: "multi_chef",
            eventName, eventDate, eventTime, headcount, venue, contactPhone,
            contactEmail: account.email,
            selectedItems: [],
            specialRequests,
            estimatedTotal: roundMoney(requests.flatMap((r) => r.items).reduce((sum, i) => sum + i.guidePrice * i.quantity, 0)),
            status: "quoting",
        }).$returningId();
        await tx.insert(eventQuotes).values(requests.map((r) => ({ eventId, chefId: r.chefId, preferences: r.preferences, items: r.items })));
        return eventId;
    });
    await Promise.all(requests.map((r) => notifyChef(r.chefId, "New event quote request", `${eventName}: ${headcount} guests on ${eventDate.toLocaleDateString("en-GB")}. Please send your quote.`, "/chef/dashboard?tab=bookings")));
    await notify(userId, "We've sent your request", `${requests.length} chef${requests.length === 1 ? " has" : "s have"} been asked to quote for ${eventName}. We'll tell you when quotes arrive.`, `/my-bookings/${id}`, "event");
    await notifyAdmins("New event booking", `${eventName} needs quotes from ${requests.length} chef${requests.length === 1 ? "" : "s"}.`, "/admin/events");
    const [created] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    res.status(201).json(created);
});

// GET /events/me: my bookings, with how far along the quotes are
router.get("/me", requireAuth, async (req, res) => {
    const rows = await db.select().from(events).where(eq(events.userId, getUserId(req))).orderBy(desc(events.createdAt));
    const quotes = await quotesWithChefs(rows.map((e) => e.id));
    res.json(rows.map((event) => {
        const own = quotes.filter((q) => q.quote.eventId === event.id);
        return {
            ...event,
            quoteCount: own.length,
            quotesIn: own.filter((q) => q.quote.status !== "requested").length,
            chefNames: own.map((q) => q.chef.displayName),
        };
    }));
});

// === ADMIN (before "/:id") ===

const summarise = async (rows: { event: Event; user: { name: string; email: string } | null }[]) => {
    const quotes = await quotesWithChefs(rows.map((r) => r.event.id));
    return rows.map(({ event, user }) => {
        const own = quotes.filter((q) => q.quote.eventId === event.id);
        return {
            ...event,
            customerName: user?.name,
            customerEmail: user?.email,
            chefNames: own.map((q) => q.chef.displayName),
            quoteCount: own.length,
            quotesIn: own.filter((q) => q.quote.status !== "requested").length,
            payoutsDue: own.filter((q) => q.quote.status === "accepted" && q.quote.payoutStatus === "pending").length,
        };
    });
};

router.get("/admin/all", requireAdmin, async (_req, res) => {
    const rows = await db.select({ event: events, user: { name: users.name, email: users.email } }).from(events).leftJoin(users, eq(events.userId, users.id)).orderBy(desc(events.createdAt));
    res.json(await summarise(rows));
});

router.get("/admin/:id", requireAdmin, async (req, res) => {
    const [row] = await db.select({ event: events, user: { name: users.name, email: users.email } }).from(events).leftJoin(users, eq(events.userId, users.id)).where(eq(events.id, Number(req.params.id))).limit(1);
    if (!row) throw notFound();
    const quotes = await quotesWithChefs([row.event.id]);
    const messages = await messagesByQuote(quotes.map((q) => q.quote.id));
    const bankDetails = await db.select().from(chefCompliance);
    res.json({
        ...row.event,
        customerName: row.user?.name,
        customerEmail: row.user?.email,
        reference: paymentReference(row.event.id),
        commissionPercent: await getCommissionPercent(),
        quotes: quotes.map(({ quote, chef }) => {
            const bank = bankDetails.find((b) => b.chefId === quote.chefId);
            return { ...quote, chef, messages: messages.get(quote.id) ?? [], payoutBank: bank?.bankAccountNumber ? { name: bank.bankAccountName, sortCode: bank.bankSortCode, accountNumber: bank.bankAccountNumber } : null };
        }),
    });
});

const eventFields = (b: Record<string, any>) => ({
    eventName: text(b.eventName, 150),
    eventDate: new Date(b.eventDate),
    eventTime: text(b.eventTime, 10),
    headcount: Math.floor(Number(b.headcount)),
    venue: text(b.venue, 300),
    contactPhone: text(b.contactPhone, 30),
    contactEmail: text(b.contactEmail, 200),
    specialRequests: text(b.specialRequests, 2000) || null,
    adminNotes: text(b.adminNotes, 2000) || null,
});
const missingEventField = (b: Record<string, any>) =>
    !b.eventName || !b.eventDate || Number.isNaN(new Date(b.eventDate).getTime()) || !b.eventTime || !(Number(b.headcount) > 0) || !b.venue || !b.contactPhone || !b.contactEmail;

// POST /events/admin: record a booking taken outside the app, then invite chefs to quote
router.post("/admin", requireAdmin, async (req, res) => {
    if (missingEventField(req.body)) throw badRequest("Please complete all the required fields");
    const [{ id }] = await db.insert(events).values({ userId: getUserId(req), packageType: "multi_chef", ...eventFields(req.body), estimatedTotal: 0, status: "quoting" }).$returningId();
    const [created] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    res.status(201).json(created);
});

// PUT /events/admin/:id
router.put("/admin/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (missingEventField(req.body)) throw badRequest("Please complete all the required fields");
    const [existing] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!existing) throw notFound();
    const status = req.body.status ?? existing.status;
    if (!STATUSES.includes(status)) throw badRequest("Invalid status");
    await db.update(events).set({ ...eventFields(req.body), status }).where(eq(events.id, id));
    if (status === "completed" && existing.status !== "completed") {
        await notify(existing.userId, "How was your event?", `We hope ${existing.eventName} was wonderful. You can now rate your chefs.`, `/my-bookings/${id}`, "event");
    } else if (status !== existing.status) {
        await notify(existing.userId, "Your booking was updated", `${existing.eventName} is now: ${status.replace("_", " ")}.`, `/my-bookings/${id}`, "event");
    }
    // A cancelled booking closes every chef's part and tells them not to prepare.
    if (status === "cancelled" && existing.status !== "cancelled") {
        const quotes = await db.select().from(eventQuotes).where(eq(eventQuotes.eventId, id));
        for (const quote of quotes) {
            if (["requested", "submitted", "accepted"].includes(quote.status)) {
                await notifyChef(quote.chefId, "Event cancelled", `MYUKCHEF has cancelled ${existing.eventName}. You no longer need to prepare for it.`, "/chef/dashboard?tab=bookings");
            }
        }
        await db.update(eventQuotes).set({ status: "not_selected" }).where(and(eq(eventQuotes.eventId, id), inArray(eventQuotes.status, ["requested", "submitted"])));
        await db.update(eventQuotes).set({ payoutStatus: "cancelled" }).where(and(eq(eventQuotes.eventId, id), eq(eventQuotes.payoutStatus, "pending")));
    }
    const [updated] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    res.json(updated);
});

// DELETE /events/admin/:id
router.delete("/admin/:id", requireAdmin, async (req, res) => {
    const [existing] = await db.select().from(events).where(eq(events.id, Number(req.params.id))).limit(1);
    if (!existing) throw notFound();
    if (existing.paymentStatus === "paid") throw badRequest("This booking has been paid, so it must stay on record. Cancel and refund it instead.");
    await db.delete(events).where(eq(events.id, existing.id));
    res.json({ message: "Booking deleted" });
});

// POST /events/admin/:id/quotes: ask another chef to quote
router.post("/admin/:id/quotes", requireAdmin, async (req, res) => {
    const [event] = await db.select().from(events).where(eq(events.id, Number(req.params.id))).limit(1);
    if (!event) throw notFound();
    if (!["quoting", "pending", "quotes_ready"].includes(event.status)) throw badRequest("Chefs can only be added before the customer confirms");
    const chefId = Number(req.body.chefId);
    const [chef] = await db.select({ id: chefs.id }).from(chefs).where(and(eq(chefs.id, chefId), eq(chefs.status, "approved"))).limit(1);
    if (!chef) throw badRequest("Please choose a chef");
    const already = await db.select({ id: eventQuotes.id }).from(eventQuotes).where(and(eq(eventQuotes.eventId, event.id), eq(eventQuotes.chefId, chefId))).limit(1);
    if (already.length > 0) throw badRequest("This chef has already been asked");
    const preferences = text(req.body.preferences, 1000) || null;
    await db.insert(eventQuotes).values({ eventId: event.id, chefId, preferences, items: [] });
    await db.update(events).set({ status: "quoting" }).where(eq(events.id, event.id));
    await notifyChef(chefId, "New event quote request", `${event.eventName}: ${event.headcount} guests. Please send your quote.`, "/chef/dashboard?tab=bookings");
    res.status(201).json({ ok: true });
});

// POST /events/admin/:id/payment { status: "paid" | "refunded" | "unpaid" }
router.post("/admin/:id/payment", requireAdmin, async (req, res) => {
    const [event] = await db.select().from(events).where(eq(events.id, Number(req.params.id))).limit(1);
    if (!event) throw notFound();
    const status = req.body.status;
    if (status === "paid") {
        await markEventPaid(event.id);
    } else if (status === "refunded") {
        if (event.paymentStatus !== "paid") throw badRequest("Only a paid booking can be refunded");
        const paidOut = await db.select({ id: eventQuotes.id }).from(eventQuotes).where(and(eq(eventQuotes.eventId, event.id), eq(eventQuotes.payoutStatus, "paid"))).limit(1);
        if (paidOut.length > 0) throw badRequest("A chef has already been paid for this booking. Reverse that payout first.");
        // A card payment goes back to the card automatically; a bank transfer you send back yourself.
        await refundEventCard(event);
        await db.update(eventQuotes).set({ payoutStatus: "cancelled" }).where(eq(eventQuotes.eventId, event.id));
        await db.update(events).set({ paymentStatus: "refunded", status: "cancelled" }).where(eq(events.id, event.id));
        await notify(event.userId, "Your booking was refunded", `${event.eventName} has been cancelled and refunded.`, `/my-bookings/${event.id}`, "event");
    } else if (status === "unpaid") {
        // Clears a customer's "I've paid" when the money hasn't arrived.
        if (event.paymentStatus !== "submitted") throw badRequest("Only a payment waiting to be checked can be reset");
        await db.update(events).set({ paymentStatus: "unpaid" }).where(eq(events.id, event.id));
        await notify(event.userId, "We couldn't find your payment", `We haven't received your payment for ${event.eventName} yet. Please check the reference and try again.`, `/my-bookings/${event.id}`, "event");
    } else {
        throw badRequest("Invalid payment status");
    }
    const [updated] = await db.select().from(events).where(eq(events.id, event.id)).limit(1);
    res.json(updated);
});

// PATCH /events/admin/quotes/:quoteId { payoutStatus?, attended? }: recording what MYUKCHEF paid each chef
router.patch("/admin/quotes/:quoteId", requireAdmin, async (req, res) => {
    const [quote] = await db.select().from(eventQuotes).where(eq(eventQuotes.id, Number(req.params.quoteId))).limit(1);
    if (!quote) return res.status(404).json({ error: "Quote not found" });
    const [event] = await db.select().from(events).where(eq(events.id, quote.eventId)).limit(1);
    const payoutStatus = req.body.payoutStatus;
    if (payoutStatus !== undefined) {
        if (!["pending", "paid"].includes(payoutStatus)) throw badRequest("Invalid payout status");
        if (quote.status !== "accepted" || event?.paymentStatus !== "paid") throw badRequest("A chef can only be paid after the customer's payment is received");
        // Once a chef has an invoice, they're paid through it (so a receipt is issued).
        const [invoice] = await db.select().from(chefInvoices).where(eq(chefInvoices.sourceKey, `event:${quote.id}`)).limit(1);
        if (invoice && payoutStatus === "paid") {
            if (invoice.status !== "paid") await markInvoicePaid(invoice.id, { method: "bank", by: getUserId(req) });
        } else if (invoice && invoice.status === "paid") {
            throw badRequest("This payout has a receipt, so it can't be undone here.");
        } else {
            await db.update(eventQuotes).set({ payoutStatus, payoutPaidAt: payoutStatus === "paid" ? new Date() : null }).where(eq(eventQuotes.id, quote.id));
            if (payoutStatus === "paid" && quote.payoutStatus !== "paid") {
                await notifyChef(quote.chefId, "Your payout has been sent", `MYUKCHEF has paid you £${(quote.payoutAmount ?? 0).toFixed(2)} for ${event?.eventName}.`, "/chef/dashboard?tab=bookings");
            }
        }
    }
    if (req.body.attended !== undefined) {
        await db.update(eventQuotes).set({ attended: req.body.attended === null ? null : !!req.body.attended }).where(eq(eventQuotes.id, quote.id));
        // The chef turned up: their invoice is raised for them to check and submit.
        if (req.body.attended === true) await raiseEventInvoice(quote.id).catch((e) => console.error("Event invoice failed:", e));
    }
    const [updated] = await db.select().from(eventQuotes).where(eq(eventQuotes.id, quote.id)).limit(1);
    res.json(updated);
});

// POST /events/:id/pay-by-card: Stripe's payment page for a booking that's waiting for payment
router.post("/:id/pay-by-card", requireAuth, async (req, res) => {
    res.json(await startEventCheckout(Number(req.params.id), getUserId(req)));
});

// POST /events/:id/payment-status: checks with Stripe when the customer comes back from paying
router.post("/:id/payment-status", requireAuth, async (req, res) => {
    res.json(await refreshBookingPayment("event", Number(req.params.id), getUserId(req)));
});

// === CUSTOMER, ONE BOOKING ===

// GET /events/:id
router.get("/:id", requireAuth, async (req, res) => {
    const event = await ownEvent(req);
    const quotes = await quotesWithChefs([event.id]);
    const messages = await messagesByQuote(quotes.map((q) => q.quote.id));
    const withReviews = await Promise.all(quotes.map(async ({ quote, chef }) => ({
        ...quoteForCustomer(quote),
        chef,
        messages: messages.get(quote.id) ?? [],
        canReview: !!(await reviewSource(event.userId, chef.id)),
    })));
    const { adminNotes: _notes, ...visible } = event;
    res.json({
        ...visible,
        reference: paymentReference(event.id),
        bankDetails: event.status === "awaiting_payment" ? await getBankDetails() : null,
        quotes: withReviews,
    });
});

// POST /events/:id/confirm { acceptedQuoteIds }: the customer chooses which quotes to go ahead with
router.post("/:id/confirm", requireAuth, async (req, res) => {
    const event = await ownEvent(req);
    if (!["quoting", "pending", "quotes_ready", "awaiting_payment"].includes(event.status) || event.paymentStatus === "paid") throw badRequest("This booking can no longer be changed");
    if (event.paymentStatus === "submitted") throw badRequest("We're checking your payment, so this can't be changed right now");
    const quotes = await db.select().from(eventQuotes).where(eq(eventQuotes.eventId, event.id));
    const chosen = Array.isArray(req.body.acceptedQuoteIds) ? req.body.acceptedQuoteIds.map(Number) : [];
    const accepted = quotes.filter((q) => chosen.includes(q.id) && ["submitted", "accepted"].includes(q.status));
    if (accepted.length === 0) throw badRequest("Please choose at least one quote");
    if (accepted.length !== chosen.length) throw badRequest("One of those quotes isn't available any more");

    for (const quote of quotes) {
        if (accepted.includes(quote)) {
            await db.update(eventQuotes).set({ status: "accepted" }).where(eq(eventQuotes.id, quote.id));
            if (quote.status !== "accepted") await notifyChef(quote.chefId, "Your quote was chosen", `The customer chose your quote for ${event.eventName}. You'll get the venue details once they've paid.`, "/chef/dashboard?tab=bookings");
        } else if (["submitted", "requested", "accepted"].includes(quote.status)) {
            await db.update(eventQuotes).set({ status: "not_selected" }).where(eq(eventQuotes.id, quote.id));
            await notifyChef(quote.chefId, "Quote not selected", `The customer went with other options for ${event.eventName}. Thanks for replying.`, "/chef/dashboard?tab=bookings");
        }
    }
    const finalTotal = roundMoney(accepted.reduce((sum, q) => sum + (q.total ?? 0), 0));
    await db.update(events).set({ status: "awaiting_payment", finalTotal }).where(eq(events.id, event.id));
    await notify(event.userId, "Your quotes are confirmed", `Next, please pay £${finalTotal.toFixed(2)} in full to confirm ${event.eventName}.`, `/my-bookings/${event.id}`, "event");
    await notifyAdmins("Quotes confirmed", `${event.eventName} is confirmed at £${finalTotal.toFixed(2)} and awaiting payment.`, "/admin/events");
    res.json({ status: "awaiting_payment", finalTotal });
});

// POST /events/:id/paid: the customer says they've sent the full payment. An admin checks it arrived.
router.post("/:id/paid", requireAuth, async (req, res) => {
    const event = await ownEvent(req);
    if (event.status !== "awaiting_payment") throw badRequest("This booking isn't awaiting payment");
    await db.update(events).set({ paymentStatus: "submitted" }).where(eq(events.id, event.id));
    await notifyAdmins("Payment to check", `The customer says they've paid £${(event.finalTotal ?? 0).toFixed(2)} for ${event.eventName} (reference ${paymentReference(event.id)}).`, "/admin/events");
    res.json({ paymentStatus: "submitted" });
});

// PATCH /events/:id/cancel: free until the booking has been paid
router.patch("/:id/cancel", requireAuth, async (req, res) => {
    const event = await ownEvent(req);
    if (PAID_STAGES.includes(event.status) || event.paymentStatus === "paid") throw badRequest("This booking has been paid. Please message MYUKCHEF support to change it.");
    if (event.status === "cancelled") throw badRequest("This booking is already cancelled");
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, event.id));
    const quotes = await db.select().from(eventQuotes).where(eq(eventQuotes.eventId, event.id));
    for (const quote of quotes) {
        if (["requested", "submitted", "accepted"].includes(quote.status)) {
            await db.update(eventQuotes).set({ status: "not_selected" }).where(eq(eventQuotes.id, quote.id));
            await notifyChef(quote.chefId, "Event cancelled", `The customer cancelled ${event.eventName}. Nothing further is needed.`, "/chef/dashboard?tab=bookings");
        }
    }
    res.json({ message: "Booking cancelled" });
});

// POST /events/quotes/:quoteId/messages: chat about one quote, checked for contact details
router.post("/quotes/:quoteId/messages", requireAuth, rateLimit(30, 60_000), async (req, res) => {
    const [quote] = await db.select().from(eventQuotes).where(eq(eventQuotes.id, Number(req.params.quoteId))).limit(1);
    if (!quote) return res.status(404).json({ error: "Quote not found" });
    const [event] = await db.select().from(events).where(eq(events.id, quote.eventId)).limit(1);
    const userId = getUserId(req);
    const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, userId)).limit(1);
    const role = event?.userId === userId ? "customer" : chef?.id === quote.chefId ? "chef" : (await isAdmin(userId)) ? "admin" : null;
    if (!role) return res.status(404).json({ error: "Quote not found" });
    const body = text(req.body.body, 1000);
    if (!body) throw badRequest("Please write a message");
    if (role !== "admin") assertNoContactDetails(body);
    const [{ id }] = await db.insert(eventQuoteMessages).values({ quoteId: quote.id, senderId: userId, senderRole: role, body }).$returningId();
    const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body;
    if (role !== "customer" && event) await notify(event.userId, `New message about ${event.eventName}`, preview, `/my-bookings/${event.id}`, "message");
    if (role !== "chef") await notifyChef(quote.chefId, `New message about ${event?.eventName}`, preview, `/chef/dashboard?tab=bookings&quote=${quote.id}`, "message");
    const [message] = await db.select().from(eventQuoteMessages).where(eq(eventQuoteMessages.id, id)).limit(1);
    res.status(201).json(message);
});

export const eventsRouter = router;
