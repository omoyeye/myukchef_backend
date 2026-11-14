import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { chefProducts, notifications, orderItems, orders, products, siteSettings, users } from "../db/schema";
import { allergenName } from "./allergens";
import { orderPlacedVars, sendAdminOrderAlert, sendOrderConfirmationEmail } from "./mail";
import { resolveContent, withTemplate } from "./templates";
import { notifyAdmins, notifyChef } from "./notify";
import { progressForOrder } from "./orderProgress";
import { checkoutOutcome, type PaymentOutcome } from "./payments";
import { sendPush } from "./push";
import { sendSMS } from "./sms";

type OrderRow = typeof orders.$inferSelect;

/**
 * Tells everyone about an order once it's good to go: straight away when no card payment is
 * needed, or once Stripe confirms the payment. Chefs never hear about unpaid orders.
 */
export async function announceNewOrder(orderId: number) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return;
    await progressForOrder(order);

    const rows = await db.select({
        quantity: orderItems.quantity,
        chefName: chefProducts.name, chefAllergens: chefProducts.allergens, chefDishChef: chefProducts.chefId,
        menuName: products.name, menuAllergens: products.allergens, menuDishChef: products.chefId,
    }).from(orderItems)
        .leftJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
        .leftJoin(products, eq(orderItems.productId, products.id))
        .where(eq(orderItems.orderId, orderId));
    const lines = rows.map((r) => {
        const names = ((r.chefAllergens ?? r.menuAllergens ?? []) as string[]).map(allergenName);
        return {
            name: r.chefName ?? r.menuName ?? "Dish",
            quantity: r.quantity,
            allergens: names.length ? `Contains ${names.join(", ")}` : "No listed allergens",
            chefId: r.chefDishChef ?? r.menuDishChef ?? null,
        };
    });

    // Each chef whose dishes are in the order.
    for (const chefId of new Set(lines.map((l) => l.chefId).filter((id): id is number => id != null))) {
        const mine = lines.filter((l) => l.chefId === chefId);
        await withTemplate("order.new_for_chef", { orderId: order.id, items: mine.map((l) => `${l.quantity} x ${l.name}`).join(", ") }, () => notifyChef(chefId, `New order #${order.id}`, `${mine.map((l) => `${l.quantity} x ${l.name}`).join(", ")}. Move it to "Cooking" when you start, so the customer knows.`, "/chef/dashboard?tab=orders"));
    }

    const address = (order.deliveryAddress ?? {}) as { email?: string; phone?: string };
    const [orderUser] = order.userId ? await db.select().from(users).where(eq(users.id, order.userId)).limit(1) : [];
    const customerEmail = address.email || orderUser?.email;
    const firstName = ((address as { firstName?: string }).firstName || orderUser?.name || "").split(" ")[0] ?? "";
    if (customerEmail) sendOrderConfirmationEmail(customerEmail, order, lines, firstName).catch((err: Error) => console.error("Customer email failed:", err.message));

    const [adminEmailSetting] = await db.select().from(siteSettings).where(eq(siteSettings.key, "admin_alert_email")).limit(1);
    const adminEmail = (adminEmailSetting?.value as string) || process.env.ADMIN_ALERT_EMAIL || "info@myukchef.com";
    sendAdminOrderAlert(adminEmail, order).catch((err: Error) => console.error("Admin alert failed:", err.message));

    const paid = order.paymentStatus === "paid" ? " (paid by card)" : "";
    await withTemplate("admin.new_order", { orderId: order.id, total: order.total.toFixed(2), paid }, () =>
        notifyAdmins("New Order Received!", `Order #${order.id} just came in for £${order.total.toFixed(2)}${paid}`, "/admin/orders"));

    // The text message, worded by the order confirmation template.
    if (address.phone) {
        const sms = await resolveContent("order.placed", orderPlacedVars(order, lines, firstName));
        if (sms.channels.sms) sendSMS(address.phone, sms.sms).catch((err: Error) => console.error("Order placement SMS failed:", err.message));
    }
}

/**
 * Records what Stripe says about an order's payment. Safe to call more than once, from the
 * webhook and from the customer coming back: only the first call changes anything.
 */
export async function settlePayment(order: OrderRow, outcome: PaymentOutcome, paymentIntentId: string | null) {
    if (outcome === "pending" || order.paymentStatus !== "awaiting") return order.paymentStatus;
    if (outcome === "paid") {
        const [result] = await db.update(orders)
            .set({ paymentStatus: "paid", paidAt: new Date(), status: "received", stripePaymentIntentId: paymentIntentId })
            .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "awaiting")));
        // Only the call that actually flipped the order sends the notices.
        if ((result as unknown as { affectedRows?: number }).affectedRows) await announceNewOrder(order.id);
        return "paid";
    }
    await db.update(orders)
        .set({ paymentStatus: "failed", status: "cancelled" })
        .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "awaiting")));
    return "failed";
}

/** Asks Stripe about an unpaid order (when the customer comes back from paying) and records it. */
export async function refreshPayment(orderId: number) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return null;
    if (order.paymentStatus === "awaiting" && order.stripeSessionId) {
        const { outcome, paymentIntentId } = await checkoutOutcome(order.stripeSessionId);
        await settlePayment(order, outcome, paymentIntentId);
    }
    const [fresh] = await db.select({ paymentStatus: orders.paymentStatus, status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
    return fresh;
}

/** Releases unpaid orders whose checkout has run out, in case a webhook never arrived. */
export async function releaseStaleUnpaidOrders() {
    const stale = await db.select().from(orders)
        .where(and(eq(orders.paymentStatus, "awaiting"), sql`${orders.createdAt} < now() - interval 2 hour`))
        .limit(50);
    for (const order of stale) {
        try {
            if (order.stripeSessionId) {
                const { outcome, paymentIntentId } = await checkoutOutcome(order.stripeSessionId);
                await settlePayment(order, outcome === "pending" ? "failed" : outcome, paymentIntentId);
            } else {
                await settlePayment(order, "failed", null);
            }
        } catch (error) {
            console.error(`Couldn't check payment for order #${order.id}:`, (error as Error).message);
        }
    }
}
