import crypto from "crypto";
import { allergenName } from "../lib/allergens";
import { getPreferences, notifyChef } from "../lib/notify";
import { sendPush } from "../lib/push";
import { Router } from "express";
import { db } from "../db";
import { orders, orderItems, products, chefProducts, chefs, users, notifications, siteSettings } from "../db/schema";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { sendOrderConfirmationEmail, sendAdminOrderAlert } from "../lib/mail";
import { adminSetOrderStatus, confirmDelivery, payoutQueue, progressForOrder, progressForOrders, setPayout } from "../lib/orderProgress";
import { sendSMS } from "../lib/sms";
import { getUserId, isAdmin, requireAdmin } from "../lib/auth";
import { geocode, parseCoordinates } from "../lib/geo";
import { badRequest, calculateTotals, getOrderSettings, validateDiscount } from "../lib/pricing";

const router = Router();

// Pages read item.product whichever table the dish came from.
const withDish = <T extends { product: unknown; chefProduct: unknown }>({ chefProduct, ...item }: T) => ({
    ...item,
    product: item.product ?? chefProduct,
});
const withDishes = <T extends { items: { product: unknown; chefProduct: unknown }[] }>(order: T) => ({
    ...order,
    items: order.items.map(withDish),
});

// GET /orders/admin/payouts: delivered orders with their evidence, waiting for the chef to be paid
router.get("/admin/payouts", requireAdmin, async (_req, res, next) => {
    try { res.json(await payoutQueue()); } catch (error) { next(error); }
});

// PATCH /orders/admin/payouts/:id { paid }: the Super Admin pays a chef after checking the evidence
router.patch("/admin/payouts/:id", requireAdmin, async (req, res, next) => {
    try { res.json(await setPayout(Number(req.params.id), req.body?.paid !== false)); } catch (error) { next(error); }
});

// POST /orders/:id/confirm-delivery { received, issue?, t? }: the customer confirms, or reports a problem
router.post("/:id/confirm-delivery", async (req, res, next) => {
    try {
        res.json(await confirmDelivery(Number(req.params.id), { userId: getUserId(req), token: req.body?.t }, req.body?.received !== false, req.body?.issue));
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

        const allOrders = await db.select().from(orders);
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
        const { deliveryAddress, deliveryLat, deliveryLng, courierLat, courierLng, courierUpdatedAt, trackingToken: _token, ...publicOrder } = order;
        const courierIsLive = order.status === "delivery" && !!courierUpdatedAt && Date.now() - new Date(courierUpdatedAt).getTime() < 30 * 60 * 1000;

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
            .where(and(inArray(chefProducts.id, productIds), eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true), eq(chefs.status, "approved")));

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
        const { total: serverCalculatedTotal } = calculateTotals(subtotal, deliveryMethod, orderSettings.delivery, discount);

        // 4. Create Order
        // Used for the tracking map. A failed lookup never blocks an order.
        const destination = deliveryMethod === 'delivery'
            ? await geocode(deliveryAddress?.postcode || [deliveryAddress?.line1, deliveryAddress?.city].filter(Boolean).join(', '))
            : null;

        const [{ id: newOrderId }] = await db.insert(orders).values({
            deliveryLat: destination?.lat ?? null,
            deliveryLng: destination?.lng ?? null,
            trackingToken: crypto.randomBytes(16).toString('hex'),
            userId: userId ? Number(userId) : null,
            total: serverCalculatedTotal,
            deliveryAddress: { ...deliveryAddress, method: deliveryMethod, discountCode: discount?.code ?? null },
            status: "received",
        }).$returningId();
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
        await progressForOrder(newOrder);

        // Allergen details go with the order, and each chef whose dishes are in it is told.
        const orderLines = items.map((item: any) => {
            const dish = productMap.get(item.menuItem.id)!;
            const names = (dish.allergens ?? []).map(allergenName);
            return { name: dish.name, quantity: item.quantity, allergens: names.length ? `Contains ${names.join(", ")}` : "No listed allergens", chefId: dish.chefId };
        });
        for (const chefId of new Set(orderLines.map((l: { chefId: number | null }) => l.chefId).filter(Boolean))) {
            const mine = orderLines.filter((l: { chefId: number | null }) => l.chefId === chefId);
            await notifyChef(chefId as number, `New order #${newOrder.id}`, `${mine.map((l: { quantity: number; name: string }) => `${l.quantity} x ${l.name}`).join(", ")}. Move it to "Cooking" when you start, so the customer knows.`, "/chef/dashboard?tab=orders");
        }

        // --- Notifications ---
        // 1. Email to Customer (guests give their email at checkout)
        const [orderUser] = userId ? await db.select().from(users).where(eq(users.id, userId)).limit(1) : [];
        const customerEmail = deliveryAddress?.email || orderUser?.email;
        if (customerEmail) {
            sendOrderConfirmationEmail(customerEmail, newOrder, orderLines).catch((err: any) => console.error("Customer email failed:", err));
        }

        // 2. Alert to Admin (Fetch admin email from settings)
        const [adminEmailSetting] = await db.select().from(siteSettings).where(eq(siteSettings.key, 'admin_alert_email')).limit(1);
        const adminEmail = (adminEmailSetting?.value as string) || process.env.ADMIN_ALERT_EMAIL || 'info@myukchef.com';

        sendAdminOrderAlert(adminEmail, newOrder).catch((err: any) => console.error("Admin alert failed:", err));

        // 3. In-App Notification for Admin (userId null or special admin room)
        const admins = await db.select().from(users).where(eq(users.role, 'admin'));
        for (const admin of admins) {
            await db.insert(notifications).values({
                userId: admin.id,
                type: 'admin_alert',
                title: 'New Order Received!',
                message: `Order #${newOrder.id} just came in for £${newOrder.total.toFixed(2)}`,
                link: `/admin/orders`
            }).catch((err: any) => console.error("Admin notification failed:", err));
        }

        for (const admin of admins) sendPush(admin.id, { title: 'New order', body: `Order #${newOrder.id}: £${newOrder.total.toFixed(2)}`, url: '/admin/orders' }).catch(() => {});

        // 4. SMS to Customer
        const [smsSenderSetting] = await db.select().from(siteSettings).where(eq(siteSettings.key, 'sms_sender')).limit(1);
        const smsSender = smsSenderSetting?.value || 'MYUKCHEF';

        if (deliveryAddress.phone) {
            const smsMessage = `${smsSender}: Order #${newOrder.id} received! Sum: £${newOrder.total.toFixed(2)}. We'll start preparing it shortly.`;
            sendSMS(deliveryAddress.phone, smsMessage).catch((err: any) => console.error("Order placement SMS failed:", err));
        }

        res.status(201).json(newOrder);
    } catch (error: any) {
        if (error.status) return res.status(error.status).json({ error: error.message });
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
