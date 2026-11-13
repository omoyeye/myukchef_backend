import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { chefCompliance, chefProducts, chefs, orderChefProgress, orderItems, orders, products, users } from "../db/schema";
import { redactContactDetails } from "./contactGuard";
import { sendNotificationEmail } from "./mail";
import { notify, notifyAdmins, notifyChef } from "./notify";
import { refundOrder } from "./payments";
import { getOrderSettings } from "./pricing";
import { sendSMS } from "./sms";

/**
 * How a one-off order moves through each chef's kitchen. Chefs move their own part forward one
 * step at a time; the order as a whole is only as far along as its slowest chef.
 */
export const STAGES = ["received", "preparing", "delivery", "completed"] as const;
export type Stage = (typeof STAGES)[number];
const rank = (stage: string) => STAGES.indexOf(stage as Stage);
export const isStage = (value: unknown): value is Stage => typeof value === "string" && rank(value) >= 0;

export interface ChefProgress {
    chefId: number;
    chefName: string;
    status: Stage;
    updatedAt: Date;
    progressId: number | null;
    deliveryProof: string | null;
    deliveredAt: Date | null;
    customerConfirmedAt: Date | null;
    customerIssue: string | null;
    payoutAmount: number | null;
    payoutStatus: string;
    paidAt: Date | null;
}
const EMPTY_EVIDENCE = { progressId: null, deliveryProof: null, deliveredAt: null, customerConfirmedAt: null, customerIssue: null, payoutAmount: null, payoutStatus: "pending", paidAt: null };
const PROOF_PHOTO = /^\/uploads\/[\w-]+\.(jpg|jpeg|png|webp|gif)$/;
type OrderRow = typeof orders.$inferSelect;

/** Each chef's stage for these orders. Chefs without a row yet start where the order is. */
export async function progressForOrders(list: { id: number; status: string }[]) {
    const result = new Map<number, ChefProgress[]>();
    if (list.length === 0) return result;
    const ids = list.map((o) => o.id);

    const lines = await db.select({
        orderId: orderItems.orderId,
        chefId: sql<number | null>`coalesce(${chefProducts.chefId}, ${products.chefId})`,
    }).from(orderItems)
        .leftJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
        .leftJoin(products, eq(orderItems.productId, products.id))
        .where(inArray(orderItems.orderId, ids));
    const rows = await db.select().from(orderChefProgress).where(inArray(orderChefProgress.orderId, ids));

    const chefIds = [...new Set(lines.map((l) => l.chefId).filter((id): id is number => id != null).map(Number))];
    const names = new Map(chefIds.length
        ? (await db.select({ id: chefs.id, name: chefs.displayName }).from(chefs).where(inArray(chefs.id, chefIds))).map((c) => [c.id, c.name])
        : []);

    const missing: { orderId: number; chefId: number; status: Stage }[] = [];
    for (const order of list) {
        const mine = [...new Set(lines.filter((l) => l.orderId === order.id && l.chefId != null).map((l) => Number(l.chefId)))];
        result.set(order.id, mine.map((chefId) => {
            const row = rows.find((r) => r.orderId === order.id && r.chefId === chefId);
            if (row) {
                return {
                    chefId,
                    chefName: names.get(chefId) ?? "Chef",
                    status: (isStage(row.status) ? row.status : "received") as Stage,
                    updatedAt: row.updatedAt,
                    progressId: row.id,
                    deliveryProof: row.deliveryProof,
                    deliveredAt: row.deliveredAt,
                    customerConfirmedAt: row.customerConfirmedAt,
                    customerIssue: row.customerIssue,
                    payoutAmount: row.payoutAmount,
                    payoutStatus: row.payoutStatus,
                    paidAt: row.paidAt,
                };
            }
            const status: Stage = isStage(order.status) ? order.status : "received";
            missing.push({ orderId: order.id, chefId, status });
            return { chefId, chefName: names.get(chefId) ?? "Chef", status, updatedAt: new Date(), ...EMPTY_EVIDENCE };
        }));
    }
    if (missing.length) {
        await db.insert(orderChefProgress).values(missing).onDuplicateKeyUpdate({ set: { orderId: sql`order_id` } }).catch((e) => console.error("Progress rows failed:", e));
    }
    return result;
}

export async function progressForOrder(order: { id: number; status: string }) {
    return (await progressForOrders([order])).get(order.id) ?? [];
}

/** The order's own stage: as far as the chef furthest behind. */
export const overallStage = (progress: ChefProgress[], fallback: string): string =>
    progress.length ? STAGES[Math.min(...progress.map((p) => rank(p.status)))]! : fallback;

/** Tells the customer, signed in or not, by every channel they have. */
export async function notifyCustomer(order: OrderRow, title: string, message: string, extraQuery = "") {
    const address = (order.deliveryAddress ?? {}) as { email?: string; phone?: string };
    if (order.userId) {
        await notify(order.userId, title, message, `/order-tracker/${order.id}${extraQuery ? `?${extraQuery}` : ""}`, "status_update");
    } else if (address.email) {
        // Guests have no bell or app, so their email carries the private tracking link.
        const query = [order.trackingToken ? `t=${order.trackingToken}` : "", extraQuery].filter(Boolean).join("&");
        const link = `/order-tracker/${order.id}${query ? `?${query}` : ""}`;
        sendNotificationEmail(address.email, title, message, link).catch((e: Error) => console.error("Guest status email failed:", e.message));
    }
    if (address.phone) sendSMS(address.phone, `MYUKCHEF: ${message}`).catch((e: Error) => console.error("Status SMS failed:", e.message));
}

/** What changes for the whole order when its stage changes. */
async function orderStageChanged(order: OrderRow, next: string) {
    await db.update(orders)
        // The courier's position is cleared as soon as the delivery stage ends.
        .set({ status: next, ...(next === "delivery" ? {} : { courierLat: null, courierLng: null, courierUpdatedAt: null }) })
        .where(eq(orders.id, order.id));
    // Loyalty points are earned once, when an order is first completed.
    if (next === "completed" && order.status !== "completed" && order.userId) {
        const { loyalty } = await getOrderSettings();
        if (loyalty.enabled) {
            const earned = Math.floor(order.total * loyalty.earnRatio);
            await db.update(users).set({ points: sql`${users.points} + ${earned}` }).where(eq(users.id, order.userId));
        }
    }
}

const MOVE_COPY: Record<Exclude<Stage, "received">, (chef: string, id: number, pickup: boolean) => { title: string; message: string }> = {
    preparing: (chef, id) => ({ title: `${chef} is cooking your order`, message: `${chef} has started cooking your order #${id}.` }),
    delivery: (chef, id, pickup) => pickup
        ? { title: `Your order from ${chef} is ready`, message: `Your order #${id} from ${chef} is ready to collect.` }
        : { title: `Your order from ${chef} is on its way`, message: `${chef} has sent your order #${id} out for delivery.` },
    completed: (chef, id, pickup) => pickup
        ? { title: `Order #${id} collected`, message: `You've collected your order from ${chef}. Enjoy your meal!` }
        : { title: `Order #${id} delivered`, message: `Your order from ${chef} has been delivered. Enjoy your meal!` },
};

/** What the chef earns for their dishes in an order, at the prices they set. */
async function chefShare(orderId: number, chefId: number) {
    const [row] = await db.select({
        total: sql<number>`coalesce(sum(${orderItems.price} * ${orderItems.quantity}), 0)`,
    }).from(orderItems)
        .leftJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
        .leftJoin(products, eq(orderItems.productId, products.id))
        .where(and(eq(orderItems.orderId, orderId), sql`coalesce(${chefProducts.chefId}, ${products.chefId}) = ${chefId}`));
    return Math.round(Number(row?.total ?? 0) * 100) / 100;
}

/** A chef moves their part of an order one step on, and the customer hears about it straight away. */
export async function moveChefStage(orderId: number, chefId: number, next: unknown, proof?: unknown) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (order.status === "cancelled") throw Object.assign(new Error("This order was cancelled."), { status: 400 });
    if (order.status === "awaiting_payment") throw Object.assign(new Error("This order hasn't been paid yet."), { status: 400 });
    if (!isStage(next) || next === "received") throw Object.assign(new Error("Invalid stage"), { status: 400 });

    const progress = await progressForOrder(order);
    const mine = progress.find((p) => p.chefId === chefId);
    if (!mine) throw Object.assign(new Error("This order has none of your dishes."), { status: 404 });
    if (rank(next) !== rank(mine.status) + 1) {
        throw Object.assign(new Error(rank(next) <= rank(mine.status) ? "This order is already past that step." : "Move the order one step at a time."), { status: 400 });
    }

    // Handing the food over needs evidence: a photo the Super Admin checks before paying the chef.
    const delivered = next === "completed";
    if (delivered && (typeof proof !== "string" || !PROOF_PHOTO.test(proof))) {
        throw Object.assign(new Error("Add a photo of the food being handed over, so we can pay you."), { status: 400 });
    }
    const payoutAmount = delivered ? await chefShare(orderId, chefId) : null;
    await db.update(orderChefProgress).set({
        status: next,
        updatedAt: new Date(),
        ...(delivered ? { deliveryProof: proof as string, deliveredAt: new Date(), payoutAmount, payoutStatus: "pending" } : {}),
    }).where(and(eq(orderChefProgress.orderId, orderId), eq(orderChefProgress.chefId, chefId)));
    mine.status = next;

    const overall = overallStage(progress, order.status);
    if (overall !== order.status) await orderStageChanged(order, overall);

    const pickup = (order.deliveryAddress as { method?: string } | null)?.method === "pickup";
    const copy = MOVE_COPY[next](mine.chefName, order.id, pickup);
    const othersBehind = progress.some((p) => p.chefId !== chefId && rank(p.status) < rank(next));
    if (delivered) {
        // The customer is asked to confirm, and the Super Admin is told so the chef can be paid.
        await notifyCustomer(
            order,
            copy.title,
            `${copy.message} Please confirm you received it, or tell us if something's wrong.`,
            "confirm=1",
        );
        await notifyAdmins(
            `${mine.chefName} delivered order #${order.id}`,
            `Check the delivery photo and pay ${mine.chefName} £${(payoutAmount ?? 0).toFixed(2)}.`,
            "/admin/orders?tab=payouts",
        );
    } else {
        await notifyCustomer(order, copy.title, othersBehind ? `${copy.message} The rest of your order is still with its other chefs.` : copy.message);
    }

    return { status: next, orderStatus: overall, progress };
}

/**
 * The customer confirms they received their food, or says something went wrong.
 * Either way the Super Admin and the chefs hear about it.
 */
export async function confirmDelivery(orderId: number, viewer: { userId: number | null; token?: unknown }, received: boolean, issue?: unknown) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
    const owns = (viewer.userId && order.userId === viewer.userId) || (!!order.trackingToken && viewer.token === order.trackingToken);
    if (!owns) throw Object.assign(new Error("Open this order from your account or your order email."), { status: 403 });

    const note = typeof issue === "string" ? issue.trim().slice(0, 1000) : "";
    if (!received && !note) throw Object.assign(new Error("Tell us what went wrong, so we can put it right."), { status: 400 });

    const delivered = (await progressForOrder(order)).filter((p) => p.status === "completed" && !p.customerConfirmedAt && !p.customerIssue);
    if (delivered.length === 0) throw Object.assign(new Error("There's nothing waiting for your confirmation on this order."), { status: 400 });

    for (const part of delivered) {
        await db.update(orderChefProgress)
            .set(received ? { customerConfirmedAt: new Date() } : { customerIssue: redactContactDetails(note) })
            .where(and(eq(orderChefProgress.orderId, order.id), eq(orderChefProgress.chefId, part.chefId)));
        await notifyChef(
            part.chefId,
            received ? `Order #${order.id} confirmed` : `Problem reported on order #${order.id}`,
            received ? "The customer confirmed they received your food." : "The customer reported a problem. Our team will be in touch.",
            "/chef/dashboard?tab=orders",
        );
    }
    const chefsNamed = delivered.map((p) => p.chefName).join(", ");
    await notifyAdmins(
        received ? `Order #${order.id} delivery confirmed` : `Problem reported on order #${order.id}`,
        received ? `The customer confirmed they received their food from ${chefsNamed}.` : `From ${chefsNamed}: ${redactContactDetails(note)}`,
        "/admin/orders?tab=payouts",
    );
    return { confirmed: delivered.length };
}

/** Delivered parts of orders, with their evidence, for the Super Admin to check and pay. */
export async function payoutQueue() {
    const rows = await db.select({ progress: orderChefProgress, order: orders, chefName: chefs.displayName })
        .from(orderChefProgress)
        .innerJoin(orders, eq(orderChefProgress.orderId, orders.id))
        .innerJoin(chefs, eq(orderChefProgress.chefId, chefs.id))
        .where(eq(orderChefProgress.status, "completed"))
        .orderBy(sql`${orderChefProgress.payoutStatus} = 'paid'`, sql`${orderChefProgress.deliveredAt} desc`)
        .limit(300);
    const chefIds = [...new Set(rows.map((r) => r.progress.chefId))];
    const banks = new Map(chefIds.length
        ? (await db.select({ chefId: chefCompliance.chefId, name: chefCompliance.bankAccountName, sortCode: chefCompliance.bankSortCode, accountNumber: chefCompliance.bankAccountNumber })
            .from(chefCompliance).where(inArray(chefCompliance.chefId, chefIds))).map((b) => [b.chefId, b])
        : []);
    return rows.map(({ progress, order, chefName }) => {
        const bank = banks.get(progress.chefId);
        return {
            id: progress.id,
            orderId: order.id,
            orderTotal: order.total,
            chefId: progress.chefId,
            chefName,
            deliveryProof: progress.deliveryProof,
            deliveredAt: progress.deliveredAt,
            customerConfirmedAt: progress.customerConfirmedAt,
            customerIssue: progress.customerIssue,
            payoutAmount: progress.payoutAmount ?? 0,
            payoutStatus: progress.payoutStatus,
            paidAt: progress.paidAt,
            bank: bank?.accountNumber ? { name: bank.name, sortCode: bank.sortCode, accountNumber: bank.accountNumber } : null,
        };
    });
}

/** The Super Admin pays a chef after checking the evidence (or takes it back if marked by mistake). */
export async function setPayout(progressId: number, paid: boolean) {
    const [part] = await db.select().from(orderChefProgress).where(eq(orderChefProgress.id, progressId)).limit(1);
    if (!part) throw Object.assign(new Error("Payout not found"), { status: 404 });
    if (part.status !== "completed" || !part.deliveryProof) throw Object.assign(new Error("This part of the order hasn't been delivered with evidence yet."), { status: 400 });
    if (paid === (part.payoutStatus === "paid")) return part;
    await db.update(orderChefProgress).set({ payoutStatus: paid ? "paid" : "pending", paidAt: paid ? new Date() : null }).where(eq(orderChefProgress.id, progressId));
    if (paid) {
        await notifyChef(part.chefId, `You've been paid for order #${part.orderId}`, `MYUKCHEF has sent you £${(part.payoutAmount ?? 0).toFixed(2)}. Thank you!`, "/chef/dashboard?tab=orders");
    }
    const [updated] = await db.select().from(orderChefProgress).where(eq(orderChefProgress.id, progressId)).limit(1);
    return updated;
}

/** Super Admins don't move orders through kitchens, but they can cancel one or reopen it. */
export async function adminSetOrderStatus(orderId: number, status: unknown) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (status === "cancelled") {
        if (order.status === "cancelled") return order;
        // A card payment is refunded first; if Stripe refuses, the order stays as it is.
        const refunded = await refundOrder(order);
        await orderStageChanged(order, "cancelled");
        if (order.paymentStatus === "awaiting") await db.update(orders).set({ paymentStatus: "failed" }).where(eq(orders.id, order.id));
        // Chefs never saw an unpaid order, so there's nothing to tell them.
        if (order.status !== "awaiting_payment") {
            for (const p of await progressForOrder(order)) {
                await notifyChef(p.chefId, `Order #${order.id} was cancelled`, "You no longer need to prepare this order.", "/chef/dashboard?tab=orders");
            }
        }
        await notifyCustomer(order, `Order #${order.id} cancelled`, refunded
            ? `Your order #${order.id} has been cancelled and your payment of £${order.total.toFixed(2)} refunded to your card. It can take 5 to 10 days to show.`
            : `Your order #${order.id} has been cancelled. Contact us if you have any questions.`);
    } else if (status === "received") {
        if (order.status !== "cancelled") throw Object.assign(new Error("Only a cancelled order can be reopened."), { status: 400 });
        if (["refunded", "failed", "awaiting"].includes(order.paymentStatus)) {
            throw Object.assign(new Error(order.paymentStatus === "refunded" ? "This order was refunded, so it can't be reopened. The customer can order again." : "This order was never paid for, so it can't be reopened."), { status: 400 });
        }
        await db.update(orderChefProgress).set({ status: "received", updatedAt: new Date() }).where(eq(orderChefProgress.orderId, order.id));
        await orderStageChanged(order, "received");
        for (const p of await progressForOrder({ ...order, status: "received" })) {
            await notifyChef(p.chefId, `Order #${order.id} is back on`, "This order was reopened. Please prepare it again.", "/chef/dashboard?tab=orders");
        }
        await notifyCustomer(order, `Order #${order.id} reopened`, `Your order #${order.id} is back on. Your chef will start it soon.`);
    } else {
        throw Object.assign(new Error("Chefs move orders through their kitchens. Super Admins can cancel or reopen an order."), { status: 400 });
    }
    const [updated] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return updated;
}
