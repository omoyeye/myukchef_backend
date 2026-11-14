import { Request, Router } from "express";
import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "../db";
import { chefProducts, chefs, eventQuoteMessages, eventQuotes, events, orderItems, orders, products, users } from "../db/schema";
import { getUserId, requireAuth } from "../lib/auth";
import { assertNoContactDetails, redactContactDetails } from "../lib/contactGuard";
import { getCommissionPercent, refreshQuoteStage, roundMoney } from "../lib/eventQuotes";
import { publicArea } from "../lib/geo";
import { notify } from "../lib/mealPlans";
import { moveChefStage, progressForOrders } from "../lib/orderProgress";
import { badRequest } from "../lib/pricing";

const router = Router();
router.use(requireAuth);

const ATTENDANCE = ["yes", "if_possible", "no"];

async function currentChef(req: Request) {
    const [chef] = await db.select().from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1);
    if (!chef) throw Object.assign(new Error("Chef account required"), { status: 403 });
    return chef;
}

async function ownQuote(req: Request) {
    const chef = await currentChef(req);
    const [quote] = await db.select().from(eventQuotes).where(and(eq(eventQuotes.id, Number(req.params.id)), eq(eventQuotes.chefId, chef.id))).limit(1);
    if (!quote) throw Object.assign(new Error("Quote not found"), { status: 404 });
    const [event] = await db.select().from(events).where(eq(events.id, quote.eventId)).limit(1);
    return { chef, quote, event };
}

// GET /chef-portal/orders: only this chef's dishes from each order, never other chefs' items or prices
router.get("/orders", async (req, res) => {
    const chef = await currentChef(req);
    const rows = await db.select({
        order: orders,
        item: orderItems,
        chefDishName: chefProducts.name,
        menuDishName: products.name,
        chefDishAllergens: chefProducts.allergens,
        menuDishAllergens: products.allergens,
    }).from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .leftJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
        .leftJoin(products, eq(orderItems.productId, products.id))
        // Unpaid orders stay hidden until the customer has paid.
        .where(and(or(eq(chefProducts.chefId, chef.id), eq(products.chefId, chef.id)), ne(orders.status, "awaiting_payment")))
        .orderBy(desc(orders.createdAt))
        .limit(300);

    type Line = { name: string; quantity: number; price: number; notes: string | null; allergens: string[] };
    type ChefOrder = {
        id: number; status: string; myStatus: string; createdAt: Date; area: string | null; method: string;
        /** When the customer wants it, and this chef's share of any tip (once delivered). */
        scheduledFor: Date | null; tipAmount: number;
        customerName: string | null; deliveryAddress: { line1?: string; city?: string; postcode?: string; notes?: string } | null;
        otherChefs: number; items: Line[];
        payoutAmount: number | null; payoutStatus: string | null; deliveryProof: string | null;
        customerConfirmedAt: Date | null; customerIssue: string | null;
    };
    const byOrder = new Map<number, ChefOrder>();
    for (const { order, item, chefDishName, menuDishName, chefDishAllergens, menuDishAllergens } of rows) {
        if (!byOrder.has(order.id)) {
            const address = (order.deliveryAddress ?? {}) as { postcode?: string; line1?: string; city?: string; notes?: string; firstName?: string; method?: string };
            // The chef delivers, so while the order is open they see where to take it and who it's for.
            // Phone numbers and emails stay with MYUKCHEF.
            const open = !["completed", "cancelled"].includes(order.status);
            byOrder.set(order.id, {
                id: order.id,
                status: order.status,
                myStatus: order.status,
                createdAt: order.createdAt,
                scheduledFor: order.scheduledFor,
                tipAmount: 0,
                area: publicArea(address.postcode ?? null),
                method: address.method === "pickup" ? "pickup" : "delivery",
                customerName: address.firstName ?? null,
                deliveryAddress: open && address.method !== "pickup"
                    ? { line1: address.line1, city: address.city, postcode: address.postcode, notes: redactContactDetails(address.notes ?? null) ?? undefined }
                    : null,
                otherChefs: 0,
                items: [],
                payoutAmount: null,
                payoutStatus: null,
                deliveryProof: null,
                customerConfirmedAt: null,
                customerIssue: null,
            });
        }
        byOrder.get(order.id)!.items.push({ name: chefDishName ?? menuDishName ?? "Dish", quantity: item.quantity, price: item.price, notes: redactContactDetails(item.specialInstructions), allergens: chefDishAllergens ?? menuDishAllergens ?? [] });
    }
    const list = [...byOrder.values()];
    const progress = await progressForOrders(list);
    for (const o of list) {
        const all = progress.get(o.id) ?? [];
        const mine = all.find((p) => p.chefId === chef.id);
        o.myStatus = o.status === "cancelled" ? "cancelled" : mine?.status ?? o.status;
        if (mine?.status === "completed") {
            o.payoutAmount = mine.payoutAmount;
            o.tipAmount = mine.tipAmount ?? 0;
            o.payoutStatus = mine.payoutStatus;
            o.deliveryProof = mine.deliveryProof;
            o.customerConfirmedAt = mine.customerConfirmedAt;
            o.customerIssue = mine.customerIssue;
        }
        o.otherChefs = all.filter((p) => p.chefId !== chef.id).length;
    }
    res.json(list);
});

// PATCH /chef-portal/orders/:id/status { status }: move this chef's part of an order on one step.
// The customer is told by in-app notice, push and email straight away.
router.patch("/orders/:id/status", async (req, res) => {
    const chef = await currentChef(req);
    const result = await moveChefStage(Number(req.params.id), chef.id, req.body?.status, req.body?.proof);
    res.json({ status: result.status, orderStatus: result.orderStatus });
});

// GET /chef-portal/quotes: every event this chef has been asked about.
// The venue appears once the customer has paid. Phone numbers and emails never do.
router.get("/quotes", async (req, res) => {
    const chef = await currentChef(req);
    const rows = await db.select({ quote: eventQuotes, event: events, customerName: users.name }).from(eventQuotes)
        .innerJoin(events, eq(eventQuotes.eventId, events.id))
        .innerJoin(users, eq(events.userId, users.id))
        .where(eq(eventQuotes.chefId, chef.id))
        .orderBy(desc(events.eventDate));
    const ids = rows.map((r) => r.quote.id);
    const messages = ids.length ? await db.select().from(eventQuoteMessages).where(inArray(eventQuoteMessages.quoteId, ids)).orderBy(asc(eventQuoteMessages.createdAt)) : [];
    res.json({
        commissionPercent: await getCommissionPercent(),
        quotes: rows.map(({ quote, event, customerName }) => {
            const paid = event.paymentStatus === "paid";
            return {
                ...quote,
                preferences: redactContactDetails(quote.preferences),
                customerFirstName: customerName.split(" ")[0],
                messages: messages.filter((m) => m.quoteId === quote.id),
                event: {
                    id: event.id,
                    name: event.eventName,
                    date: event.eventDate,
                    time: paid ? event.eventTime : null,
                    headcount: event.headcount,
                    status: event.status,
                    paid,
                    venue: paid ? event.venue : null,
                    specialRequests: redactContactDetails(event.specialRequests),
                },
            };
        }),
    });
});

// POST /chef-portal/quotes/:id/submit: send or update a quote until the customer has confirmed
router.post("/quotes/:id/submit", async (req, res) => {
    const { quote, event } = await ownQuote(req);
    if (!event || !["quoting", "pending", "quotes_ready"].includes(event.status)) throw badRequest("This booking is no longer open for quotes");
    if (!["requested", "submitted", "declined"].includes(quote.status)) throw badRequest("This quote can no longer be changed");

    const prices = new Map<string, number>((Array.isArray(req.body.items) ? req.body.items : []).map((i: { id?: unknown; unitPrice?: unknown }) => [String(i?.id), Number(i?.unitPrice)]));
    const items = (quote.items ?? []).map((item) => {
        const unitPrice = prices.get(item.id);
        if (unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100000) throw badRequest(`Please enter a price for ${item.name}`);
        return { ...item, unitPrice: roundMoney(unitPrice) };
    });
    const serviceFee = roundMoney(Number(req.body.serviceFee) || 0);
    if (serviceFee < 0 || serviceFee > 1000000) throw badRequest("Please enter a valid service fee");
    const willAttend = req.body.willAttend;
    if (!ATTENDANCE.includes(willAttend)) throw badRequest("Please say whether you can attend the event");
    const note = String(req.body.note ?? "").trim().slice(0, 1000) || null;
    assertNoContactDetails(note);
    const total = roundMoney(items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0) + serviceFee);
    if (total <= 0) throw badRequest("Please enter your price");

    await db.update(eventQuotes).set({ items, serviceFee, total, willAttend, note, status: "submitted", submittedAt: new Date() }).where(eq(eventQuotes.id, quote.id));
    await notify(event.userId, `${quote.status === "submitted" ? "Updated quote" : "New quote"} for ${event.eventName}`, `A chef has sent a quote of £${total.toFixed(2)}.`, `/my-bookings/${event.id}`, "event");
    await refreshQuoteStage(event.id);
    const [updated] = await db.select().from(eventQuotes).where(eq(eventQuotes.id, quote.id)).limit(1);
    res.json(updated);
});

// POST /chef-portal/quotes/:id/decline
router.post("/quotes/:id/decline", async (req, res) => {
    const { quote, event } = await ownQuote(req);
    if (!event || !["quoting", "pending", "quotes_ready"].includes(event.status)) throw badRequest("This booking is no longer open for quotes");
    if (!["requested", "submitted"].includes(quote.status)) throw badRequest("This quote can no longer be changed");
    const note = String(req.body.note ?? "").trim().slice(0, 500) || null;
    assertNoContactDetails(note);
    await db.update(eventQuotes).set({ status: "declined", note, total: null }).where(eq(eventQuotes.id, quote.id));
    await notify(event.userId, `A chef can't quote for ${event.eventName}`, note || "They aren't able to take this one. Your other quotes aren't affected.", `/my-bookings/${event.id}`, "event");
    await refreshQuoteStage(event.id);
    res.json({ status: "declined" });
});

// PATCH /chef-portal/quotes/:id/attendance: a chosen chef can update whether they'll be there on the day
router.patch("/quotes/:id/attendance", async (req, res) => {
    const { quote, event } = await ownQuote(req);
    if (quote.status !== "accepted") throw badRequest("Only a chosen quote can be updated");
    if (!ATTENDANCE.includes(req.body.willAttend)) throw badRequest("Please say whether you can attend");
    await db.update(eventQuotes).set({ willAttend: req.body.willAttend }).where(eq(eventQuotes.id, quote.id));
    if (event && req.body.willAttend !== quote.willAttend) {
        const words: Record<string, string> = { yes: "will attend", if_possible: "will attend if possible", no: "can't attend in person" };
        await notify(event.userId, `Update for ${event.eventName}`, `One of your chefs ${words[req.body.willAttend]}.`, `/my-bookings/${event.id}`, "event");
    }
    res.json({ willAttend: req.body.willAttend });
});

export const chefPortalRouter = router;
