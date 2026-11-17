import crypto from "crypto";
import { Router } from "express";
import { db } from "../db";
import { orders, orderItems, products, chefProducts, chefs, users } from "../db/schema";
import { and, eq, desc, inArray, notInArray } from "drizzle-orm";
import { announceNewOrder, refreshPayment } from "../lib/orderPlaced";
import { adminSetOrderStatus, cancelOrder, confirmDelivery, progressForOrder, progressForOrders } from "../lib/orderProgress";
import { rateLimit } from "../lib/rateLimit";
import { paymentConfig, startCheckout } from "../lib/payments";
import { availableSlots, MAX_DAYS_AHEAD, problemWith, type BasketChef } from "../lib/availability";
import { chefTimes, sellingChefs } from "../lib/selling";
import { listThreads, postMessage } from "../lib/orderMessages";

type AreaBasketChef = BasketChef & { row: typeof chefs.$inferSelect };

/** The chefs behind a basket, each with the longest notice any of their dishes needs. */
async function basketChefs(itemIds: string[]) {
    const ids = [...new Set(itemIds.filter((id) => typeof id === "string"))].slice(0, 100);
    if (!ids.length) return { basket: [] as AreaBasketChef[], unavailable: [] as string[] };
    const menu = await db.select({ id: products.id, chefId: products.chefId }).from(products).where(inArray(products.id, ids));
    const chefDishes = await db.select({ id: chefProducts.id, chefId: chefProducts.chefId, noticeHours: chefProducts.noticeHours }).from(chefProducts).where(inArray(chefProducts.id, ids));
    const lines = [...menu.map((m) => ({ ...m, noticeHours: null as number | null })), ...chefDishes].filter((l) => l.chefId !== null) as { id: string; chefId: number; noticeHours: number | null }[];
    const sellers = await sellingChefs([...new Set(lines.map((l) => l.chefId))]);
    const byChef = new Map<number, AreaBasketChef>();
    const unavailable: string[] = [];
    for (const line of lines) {
        const chef = sellers.get(line.chefId);
        if (!chef) { unavailable.push(line.id); continue; }
        const current = byChef.get(chef.id) ?? { chef: chefTimes(chef), noticeHours: chef.noticeHours, row: chef };
        current.noticeHours = Math.max(current.noticeHours, line.noticeHours ?? 0);
        byChef.set(chef.id, current);
    }
    return { basket: [...byChef.values()], unavailable };
}
import { getUserId, isAdmin, requireAdmin } from "../lib/auth";
import { geocode, milesBetween, parseCoordinates } from "../lib/geo";
import { codeForNewOrder, waiveDeliveryCode } from "../lib/deliveryCode";
import { linkSpendToOrder, returnEntry, returnForOrder, takeForOrder } from "../lib/wallet";
import { badRequest, calculateTotals, getOrderSettings, validateDiscount } from "../lib/pricing";
import { areaFor, farAwayEntry, farWaitNeeded, type FarAway } from "../lib/serviceArea";

/**
 * Checks every chef in a delivery basket delivers to this point. Chefs further out who take far-away
 * orders add their extra wait to the notice they need. Returns those chefs; throws for chefs who don't deliver there.
 */
function applyArea(basket: Awaited<ReturnType<typeof basketChefs>>["basket"], point: { lat: number; lng: number } | null, where: string) {
    const far: FarAway[] = [];
    for (const b of basket) {
        const area = areaFor(b.row, point);
        if (area.status === "outside") throw badRequest(`${b.row.displayName} doesn't deliver to ${where || "your address"} (${area.miles} miles away). Choose collection, or a chef nearer to you.`);
        if (area.status === "far") { far.push(farAwayEntry(b.row, area)); b.noticeHours += area.extraHours; }
    }
    return far;
}

const router = Router();
const messageLimit = rateLimit(30, 60_000);

// Pages read item.product whichever table the dish came from.
const withDish = <T extends { product: unknown; chefProduct: unknown }>({ chefProduct, ...item }: T) => ({
    ...item,
    product: item.product ?? chefProduct,
});
const withDishes = <T extends { items: { product: unknown; chefProduct: unknown }[] }>(order: T) => ({
    ...order,
    items: order.items.map(withDish),
});

// Chef invoices and payouts live under /api/payouts.

// POST /orders/:id/confirm-delivery { received, issue?, t? }: the customer confirms, or reports a problem
router.post("/:id/confirm-delivery", async (req, res, next) => {
    try {
        res.json(await confirmDelivery(Number(req.params.id), { userId: getUserId(req), token: req.body?.t }, req.body?.received !== false, req.body?.issue));
    } catch (error) { next(error); }
});

// POST /orders/slots { itemIds, postcode?, lat?, lng?, method? }: the delivery times that suit every chef
// in the basket. With a delivery address, chefs outside their usual area add their extra wait, and are
// listed so the customer can agree to it (or see who doesn't deliver there).
router.post("/slots", async (req, res, next) => {
    try {
        const { basket } = await basketChefs(Array.isArray(req.body?.itemIds) ? req.body.itemIds : []);
        const delivery = req.body?.method !== "pickup";
        const postcode = typeof req.body?.postcode === "string" ? req.body.postcode.trim().slice(0, 12) : "";
        const point = !delivery ? null : parseCoordinates(req.body?.lat, req.body?.lng) ?? (postcode.length >= 2 ? await geocode(postcode).catch(() => null) : null);
        const farAway: FarAway[] = [];
        const outside: { chefId: number; name: string; miles: number | null; radiusMiles: number }[] = [];
        for (const b of basket) {
            const area = areaFor(b.row, point);
            if (area.status === "far") { farAway.push(farAwayEntry(b.row, area)); b.noticeHours += area.extraHours; }
            if (area.status === "outside") outside.push({ chefId: b.row.id, name: b.row.displayName, miles: area.miles, radiusMiles: b.row.serviceRadiusMiles });
        }
        const { slots, reason } = availableSlots(basket);
        res.json({ slots, earliest: slots[0] ?? null, reason, noticeHours: Math.max(0, ...basket.map((b) => b.noticeHours)), farAway, outside });
    } catch (error) { next(error); }
});

// POST /orders/:id/cancel { t? }: the customer changes their mind before cooking starts
router.post("/:id/cancel", async (req, res, next) => {
    try {
        const [order] = await db.select().from(orders).where(eq(orders.id, Number(req.params.id))).limit(1);
        if (!order) return res.status(404).json({ error: "Order not found" });
        const viewerId = getUserId(req);
        const owns = (!!order.trackingToken && req.body?.t === order.trackingToken) || (!!viewerId && order.userId === viewerId);
        if (!owns) return res.status(403).json({ error: "Open this order from your account or your order email." });
        res.json(await cancelOrder(order, "customer"));
    } catch (error) { next(error); }
});

// GET /orders/:id/messages?t=  and  POST /orders/:id/messages { chefId, body, t? }
router.get("/:id/messages", async (req, res, next) => {
    try { res.json(await listThreads(Number(req.params.id), { userId: getUserId(req), token: req.query.t })); } catch (error) { next(error); }
});
router.post("/:id/messages", messageLimit, async (req, res, next) => {
    try { res.status(201).json(await postMessage(Number(req.params.id), { userId: getUserId(req), token: req.body?.t }, req.body?.chefId, req.body?.body)); } catch (error) { next(error); }
});

// GET /orders/payment-config: whether checkout takes card payments
router.get("/payment-config", async (_req, res, next) => {
    try { res.json(await paymentConfig()); } catch (error) { next(error); }
});

/** The customer (signed in, or holding the tracking link) or a Super Admin. */
async function canManageOrder(req: Parameters<typeof getUserId>[0], order: typeof orders.$inferSelect, token: unknown) {
    const viewerId = getUserId(req);
    return (!!order.trackingToken && token === order.trackingToken) || (!!viewerId && order.userId === viewerId) || (await isAdmin(viewerId));
}

// POST /orders/:id/pay { t? }: sends the customer back to Stripe for an order they haven't paid yet
router.post("/:id/pay", async (req, res, next) => {
    try {
        const [order] = await db.select().from(orders).where(eq(orders.id, Number(req.params.id))).limit(1);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (!(await canManageOrder(req, order, req.body?.t))) return res.status(403).json({ error: "Forbidden" });
        const address = (order.deliveryAddress ?? {}) as { email?: string };
        res.json({ checkoutUrl: await startCheckout(order, address.email) });
    } catch (error) { next(error); }
});

// POST /orders/:id/payment-status { t? }: checks with Stripe when the customer comes back from paying
router.post("/:id/payment-status", async (req, res, next) => {
    try {
        const [order] = await db.select().from(orders).where(eq(orders.id, Number(req.params.id))).limit(1);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (!(await canManageOrder(req, order, req.body?.t))) return res.status(403).json({ error: "Forbidden" });
        res.json(await refreshPayment(order.id));
    } catch (error) { next(error); }
});

// GET /orders/my-orders
router.get("/my-orders", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const userOrders = await db.query.orders.findMany({
            where: eq(orders.userId, userId),
            with: {
                items: {
                    with: {
                        product: true,
                        chefProduct: true
                    }
                }
            },
            orderBy: [desc(orders.createdAt)],
        });
        res.json(userOrders.map(withDishes));
    } catch (error) {
        console.error("Get my orders error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /stats (Dashboard Metrics)
router.get("/stats", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        // Unpaid and cancelled orders aren't sales.
        const allOrders = await db.select().from(orders).where(notInArray(orders.status, ["awaiting_payment", "cancelled"]));
        const totalRevenue = allOrders.reduce((sum, order) => sum + (order.total || 0), 0);
        const activeOrders = allOrders.filter(o => ['received', 'preparing', 'delivery', 'pending'].includes(o.status)).length;

        const allUsers = await db.select().from(users);
        const customerCount = allUsers.filter(u => u.role === 'customer').length;

        const avgOrderValue = allOrders.length > 0 ? totalRevenue / allOrders.length : 0;

        // Fetch recent 5 orders with items
        const recentOrders = await db.query.orders.findMany({
            with: {
                items: {
                    with: {
                        product: true,
                        chefProduct: true
                    }
                }
            },
            orderBy: [desc(orders.createdAt)],
            limit: 5
        });

        // Top 3 popular products logic
        const allOrderItems = (await db.query.orderItems.findMany({
            with: {
                product: true,
                chefProduct: true
            }
        })).map(withDish);

        const productSalesMap = new Map<string, { name: string; sales: number }>();
        allOrderItems.forEach(item => {
            const dish = item.product as { id: string; name: string } | null;
            if (dish) {
                const current = productSalesMap.get(dish.id) || { name: dish.name, sales: 0 };
                productSalesMap.set(dish.id, { name: current.name, sales: current.sales + item.quantity });
            }
        });

        const popularItems = Array.from(productSalesMap.values())
            .sort((a, b) => b.sales - a.sales)
            .slice(0, 3);

        res.json({
            totalRevenue: `£${totalRevenue.toFixed(2)}`,
            activeOrders: activeOrders.toString(),
            customerCount: customerCount.toString(),
            avgOrderValue: `£${avgOrderValue.toFixed(2)}`,
            recentOrders: recentOrders.map(withDishes),
            popularItems
        });
    } catch (error) {
        console.error("Get dashboard stats error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /orders/:id (Public tracking for now)
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const orderId = Number(id);

        if (isNaN(orderId)) {
            return res.status(400).json({ error: "Invalid order ID" });
        }

        const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

        if (!order) {
            return res.status(404).json({ error: "Order not found" });
        }

        const items = await db.query.orderItems.findMany({
            where: eq(orderItems.orderId, orderId),
            with: {
                product: true,
                chefProduct: true
            }
        });

        // Anyone with an order number sees its status. Addresses and live position are only
        // for the customer, staff, or someone holding the order's private tracking link.
        const viewerId = getUserId(req);
        const hasLink = !!order.trackingToken && req.query.t === order.trackingToken;
        const canSeeDetails = hasLink || (viewerId && order.userId === viewerId) || (await isAdmin(viewerId));
        const { deliveryAddress, deliveryLat, deliveryLng, courierLat, courierLng, courierUpdatedAt, trackingToken: _token, stripeSessionId: _session, stripePaymentIntentId: _intent, deliveryCode, deliveryCodeWaived, ...publicOrder } = order;
        const courierIsLive = order.status === "delivery" && !!courierUpdatedAt && Date.now() - new Date(courierUpdatedAt).getTime() < 30 * 60 * 1000;
        // A rough arrival time from the driver's position: road distance is about 1.3 times the straight
        // line, at about 18 mph in town, plus a couple of minutes to park and hand over.
        const etaMinutes = courierIsLive && deliveryLat !== null && deliveryLng !== null && courierLat !== null && courierLng !== null
            ? Math.max(1, Math.round((milesBetween({ lat: courierLat, lng: courierLng }, { lat: deliveryLat, lng: deliveryLng }) * 1.3 / 18) * 60 + 2))
            : null;

        // Anyone with the order number sees each chef's stage; the evidence is only for the customer and staff.
        const chefProgress = (await progressForOrder(order)).map((p) => ({
            chefName: p.chefName,
            status: p.status,
            updatedAt: p.updatedAt,
            ...(canSeeDetails ? {
                deliveredAt: p.deliveredAt,
                deliveryProof: p.deliveryProof,
                customerConfirmedAt: p.customerConfirmedAt,
                customerIssue: p.customerIssue,
                awaitingConfirmation: p.status === "completed" && !p.customerConfirmedAt && !p.customerIssue,
            } : {}),
        }));
        res.json({
            ...publicOrder,
            chefProgress,
            items: items.map(withDish),
            ...(canSeeDetails ? {
                deliveryAddress,
                destination: deliveryLat !== null && deliveryLng !== null ? { lat: deliveryLat, lng: deliveryLng } : null,
                courier: courierIsLive ? { lat: courierLat, lng: courierLng, updatedAt: courierUpdatedAt } : null,
                etaMinutes,
                // The code is only for the customer (and Super Admins), and only until the food arrives.
                deliveryCode: deliveryCode && !deliveryCodeWaived && order.status !== "completed" && order.status !== "cancelled" ? deliveryCode : null,
            } : { deliveryAddress: null }),
        });
    } catch (error) {
        console.error("Get single order error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /orders (Admin/All)
router.get("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const allOrders = await db.query.orders.findMany({
            with: {
                items: {
                    with: {
                        product: true,
                        chefProduct: true
                    }
                }
            },
            orderBy: [desc(orders.createdAt)],
            limit: 200
        });
        const progress = await progressForOrders(allOrders);
        res.json(allOrders.map((o) => ({ ...withDishes(o), chefProgress: progress.get(o.id) ?? [] })));
    } catch (error) {
        console.error("Get all orders error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PATCH /orders/:id/status: Super Admins can cancel or reopen an order.
// Moving it through the kitchen is each chef's job (PATCH /chef-portal/orders/:id/status).
router.patch("/:id/status", requireAdmin, async (req, res, next) => {
    try {
        res.json(await adminSetOrderStatus(Number(req.params.id), req.body.status));
    } catch (error) { next(error); }
});

// POST /orders
router.post("/", async (req, res) => {
    try {
        const userId = getUserId(req) || null;
        const { items, deliveryAddress, discountCode } = req.body;
        const deliveryMethod = req.body.deliveryMethod === 'pickup' ? 'pickup' : 'delivery';

        if (!items || items.length === 0) {
            return res.status(400).json({ error: "Cart is empty" });
        }

        const orderSettings = await getOrderSettings();
        if (!orderSettings.isOpen) throw badRequest("Sorry, we're not taking orders right now. Please try again later.");

        // 1. Fetch products from DB to verify prices
        const productIds = items.map((i: any) => i.menuItem.id);
        const dbProducts = await db.select().from(products).where(and(inArray(products.id, productIds), eq(products.allergensDeclared, true)));
        // Chef dishes can only be ordered while the dish and its chef are approved.
        const dbChefProducts = await db.select({ id: chefProducts.id, name: chefProducts.name, price: chefProducts.price, isSoldOut: chefProducts.isSoldOut, allergens: chefProducts.allergens, chefId: chefProducts.chefId })
            .from(chefProducts)
            .innerJoin(chefs, eq(chefProducts.chefId, chefs.id))
            .where(and(inArray(chefProducts.id, productIds), eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true), eq(chefProducts.forMenu, true), eq(chefs.status, "approved")));

        // Every chef in the basket must be allowed to sell, taking orders, and able to cook for the chosen time.
        const { basket, unavailable } = await basketChefs(productIds);
        if (unavailable.length) {
            const gone = items.find((i: any) => unavailable.includes(i.menuItem.id));
            throw badRequest(`Sorry, ${gone?.menuItem?.name || "an item in your cart"} is no longer available.`);
        }
        // Where the food is going: used for the delivery area check and the tracking map. A failed
        // lookup never blocks an order (the chef sees the address and decides).
        const destination = deliveryMethod === 'delivery'
            ? await geocode(deliveryAddress?.postcode || [deliveryAddress?.line1, deliveryAddress?.city].filter(Boolean).join(', ')).catch(() => null)
            : null;
        const farAway = deliveryMethod === 'delivery' ? applyArea(basket, destination, String(deliveryAddress?.postcode ?? "").toUpperCase()) : [];
        if (farAway.length && req.body.acceptFarWait !== true) throw farWaitNeeded(farAway);

        let scheduledFor: Date | null = null;
        if (basket.length) {
            if (req.body.scheduledFor) {
                scheduledFor = new Date(req.body.scheduledFor);
                if (Number.isNaN(scheduledFor.getTime())) throw badRequest("Please choose a delivery time.");
                if (scheduledFor.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400_000) throw badRequest(`Orders can be placed up to ${MAX_DAYS_AHEAD} days ahead.`);
                for (const b of basket) {
                    const problem = problemWith(b.chef, scheduledFor, b.noticeHours);
                    if (problem) throw badRequest(problem);
                }
            } else {
                // "As soon as possible": the first time that suits every chef.
                const { slots, reason } = availableSlots(basket, new Date(), 1);
                if (!slots.length) throw badRequest(reason ?? "These chefs aren't taking orders right now.");
                scheduledFor = new Date(slots[0]!);
            }
        }

        const productMap = new Map<string, { id: string; name: string; price: number; isSoldOut: boolean | null; isChefDish: boolean; allergens: string[] | null; chefId: number | null; modifiers?: any[] | null }>([
            ...dbProducts.map(p => [p.id, { ...p, isChefDish: false }] as [string, typeof p & { isChefDish: boolean }]),
            ...dbChefProducts.map(p => [p.id, { ...p, isChefDish: true }] as [string, typeof p & { isChefDish: boolean }]),
        ]);

        // 2. Recalculate Subtotal
        let subtotal = 0;
        const processedItems = items.map((item: any) => {
            const dbProduct = productMap.get(item.menuItem.id);
            if (!dbProduct) throw badRequest(`Sorry, ${item.menuItem.name || "an item in your cart"} is no longer available.`);
            if (dbProduct.isSoldOut) throw badRequest(`Sorry, ${item.menuItem.name || "an item in your cart"} is sold out.`);
            if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw badRequest("Please check the quantities in your cart.");


            // Extras are priced from the database, never from what the browser sends.
            const selectedModifiers = (item.selectedModifiers || []).map((mod: any) => {
                const known = (dbProduct.modifiers || []).find((m: any) => m.id === mod.id);
                if (!known) throw badRequest(`Sorry, an option on ${item.menuItem.name || "an item"} is no longer available.`);
                return known;
            });
            const modifiersPrice = selectedModifiers.reduce((sum: number, mod: any) => sum + Number(mod.price || 0), 0);
            const itemPrice = dbProduct.price + modifiersPrice;
            subtotal += itemPrice * item.quantity;

            return {
                productId: dbProduct.isChefDish ? null : dbProduct.id,
                chefProductId: dbProduct.isChefDish ? dbProduct.id : null,
                quantity: item.quantity,
                price: itemPrice,
                selectedModifiers,
                specialInstructions: item.specialInstructions || null,
            };
        });

        // 3. Calculate fees and discount from the admin's settings
        if (deliveryMethod === 'delivery' && orderSettings.delivery.minOrder > 0 && subtotal < orderSettings.delivery.minOrder) {
            throw badRequest(`The minimum order for delivery is £${orderSettings.delivery.minOrder.toFixed(2)}.`);
        }
        const discount = discountCode ? await validateDiscount(String(discountCode), subtotal, userId ?? 0) : null;
        const { total: beforeTip } = calculateTotals(subtotal, deliveryMethod, orderSettings.delivery, discount);
        // A tip goes to the chefs in full, on top of the total.
        const tip = Math.round(Math.min(Math.max(Number(req.body.tip) || 0, 0), 200) * 100) / 100;
        // 4. Create Order
        const { cardPayments } = await paymentConfig();
        // Wallet credit (signed-in customers who chose to use it) comes off before the tip, which stays as paid.
        const wallet = userId ? await takeForOrder(Number(userId), beforeTip, req.body.useWallet, cardPayments ? 0.3 : 0) : { applied: 0, entryId: null };
        const serverCalculatedTotal = Math.round((beforeTip - wallet.applied + tip) * 100) / 100;
        // Nothing left to pay by card: the wallet (and no tip) covered it all.
        const needsCard = cardPayments && serverCalculatedTotal > 0;
        if (needsCard && serverCalculatedTotal < 0.3) { await returnEntry(wallet.entryId); throw badRequest("Card payments need an order of at least 30p."); }

        // A customer's first order (or any order, if Super Admin asks) gets a delivery code.
        const deliveryCode = await codeForNewOrder({ userId: userId ? Number(userId) : null, email: typeof deliveryAddress?.email === "string" ? deliveryAddress.email : null, total: serverCalculatedTotal });

        const [{ id: newOrderId }] = await db.insert(orders).values({
            walletAmount: wallet.applied,
            farAway: farAway.length ? farAway : null,
            farWaitAcceptedAt: farAway.length ? new Date() : null,
            deliveryCode,
            deliveryLat: destination?.lat ?? null,
            deliveryLng: destination?.lng ?? null,
            trackingToken: crypto.randomBytes(16).toString('hex'),
            userId: userId ? Number(userId) : null,
            total: serverCalculatedTotal,
            tipAmount: tip,
            scheduledFor,
            deliveryAddress: { ...deliveryAddress, method: deliveryMethod, discountCode: discount?.code ?? null },
            // With card payments on, nobody hears about the order until Stripe says it's paid.
            status: needsCard ? "awaiting_payment" : "received",
            paymentStatus: needsCard ? "awaiting" : "not_required",
        }).$returningId().catch(async (e) => { await returnEntry(wallet.entryId); throw e; });
        await linkSpendToOrder(wallet.entryId, newOrderId);
        const [newOrder] = await db.select().from(orders).where(eq(orders.id, newOrderId)).limit(1);

        // 5. Create Order Items
        const orderItemsData = processedItems.map((item: any) => ({
            orderId: newOrder.id,
            productId: item.productId,
            chefProductId: item.chefProductId,
            quantity: item.quantity,
            price: item.price,
            selectedModifiers: item.selectedModifiers,
            specialInstructions: item.specialInstructions,
        }));

        await db.insert(orderItems).values(orderItemsData);

        const [orderUser] = userId ? await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1) : [];
        if (needsCard) {
            let checkoutUrl: string;
            try {
                checkoutUrl = await startCheckout(newOrder, deliveryAddress?.email || orderUser?.email);
            } catch (error) {
                // Without a payment page the order can't go ahead.
                await db.update(orders).set({ status: "cancelled", paymentStatus: "failed" }).where(eq(orders.id, newOrder.id));
                await returnForOrder(newOrder.id);
                console.error("Stripe checkout failed:", (error as Error).message);
                return res.status(502).json({ error: "We couldn't open the payment page. Please try again in a moment." });
            }
            return res.status(201).json({ ...newOrder, checkoutUrl });
        }

        await announceNewOrder(newOrder.id);
        res.status(201).json(newOrder);
    } catch (error: any) {
        if (error.status) return res.status(error.status).json({ error: error.message, ...(error.details ?? {}) });
        console.error("Create order error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PATCH /orders/:id/courier-location: the delivery person's phone reports its position
router.patch("/:id/courier-location", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const point = parseCoordinates(req.body.lat, req.body.lng);
        if (!point) return res.status(400).json({ error: "Invalid location" });
        const id = Number(req.params.id);
        const [order] = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, id)).limit(1);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (!(await isAdmin(userId))) {
            // A chef can share only while their own part of this order is out for delivery.
            const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, userId)).limit(1);
            const mine = chef && (await progressForOrder(order)).find((p) => p.chefId === chef.id);
            if (!mine) return res.status(403).json({ error: "Forbidden" });
            if (mine.status !== "delivery") return res.status(400).json({ error: "Your part of this order isn't out for delivery" });
        } else if (order.status !== "delivery") return res.status(400).json({ error: "This order isn't out for delivery" });
        await db.update(orders).set({ courierLat: point.lat, courierLng: point.lng, courierUpdatedAt: new Date() }).where(eq(orders.id, id));
        res.json({ ok: true });
    } catch (error) { next(error); }
});

// POST /orders/:id/delivery-code/waive { reason }: a Super Admin lets the order finish without the code
router.post("/:id/delivery-code/waive", requireAdmin, async (req, res, next) => {
    try {
        await waiveDeliveryCode(Number(req.params.id), req.body?.reason);
        res.json({ ok: true });
    } catch (error) { next(error); }
});

// DELETE /orders/:id: only cancelled orders, so completed sales stay on record
router.delete("/:id", requireAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (order.status !== "cancelled") return res.status(400).json({ error: "Cancel the order first, then you can delete it." });
        await db.delete(orderItems).where(eq(orderItems.orderId, id));
        await db.delete(orders).where(eq(orders.id, id));
        res.json({ message: "Order deleted" });
    } catch (error) { next(error); }
});

export const ordersRouter = router;
