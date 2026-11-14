import { and, asc, eq, inArray } from "drizzle-orm";
import { withTemplate } from "./templates";
import { db } from "../db";
import { chefs, orderMessages, orders } from "../db/schema";
import { redactContactDetails } from "./contactGuard";
import { notify, notifyChef } from "./notify";
import { progressForOrder } from "./orderProgress";

/**
 * Messages between a customer and each chef cooking their order ("I'm outside", "no onions please").
 * Phone numbers, emails and links are removed, as everywhere else on MYUKCHEF.
 */

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
/** Chat stays open while the order is live and for a day after it's delivered. */
const OPEN_AFTER_DELIVERY_MS = 24 * 3600_000;

interface Viewer { userId: number | null; token?: unknown }

async function access(orderId: number, viewer: Viewer) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw fail(404, "Order not found");
    const isCustomer = (!!viewer.userId && order.userId === viewer.userId) || (!!order.trackingToken && viewer.token === order.trackingToken);
    const [chef] = viewer.userId ? await db.select({ id: chefs.id, name: chefs.displayName }).from(chefs).where(eq(chefs.userId, viewer.userId)).limit(1) : [];
    const progress = await progressForOrder(order);
    const myPart = chef ? progress.find((p) => p.chefId === chef.id) : undefined;
    if (!isCustomer && !myPart) throw fail(403, "You can't see this order's messages.");
    if (order.status === "awaiting_payment") throw fail(400, "Messages open once the order is paid.");
    const lastUpdate = Math.max(...progress.map((p) => new Date(p.updatedAt).getTime()), 0);
    const open = order.status !== "cancelled" && (order.status !== "completed" || Date.now() - lastUpdate < OPEN_AFTER_DELIVERY_MS);
    return { order, isCustomer, chefId: myPart?.chefId ?? null, progress, open };
}

/** Each chef's conversation on the order. Customers see all of theirs; a chef sees only their own. */
export async function listThreads(orderId: number, viewer: Viewer) {
    const { isCustomer, chefId, progress, open } = await access(orderId, viewer);
    const chefIds = isCustomer ? progress.map((p) => p.chefId) : [chefId!];
    const rows = chefIds.length
        ? await db.select().from(orderMessages).where(and(eq(orderMessages.orderId, orderId), inArray(orderMessages.chefId, chefIds))).orderBy(asc(orderMessages.createdAt), asc(orderMessages.id))
        : [];
    return {
        open,
        role: isCustomer ? "customer" : "chef",
        threads: progress.filter((p) => chefIds.includes(p.chefId)).map((p) => ({
            chefId: p.chefId,
            chefName: p.chefName,
            messages: rows.filter((m) => m.chefId === p.chefId).map((m) => ({ id: m.id, from: m.senderRole, body: m.body, createdAt: m.createdAt })),
        })),
    };
}

export async function postMessage(orderId: number, viewer: Viewer, chefIdInput: unknown, bodyInput: unknown) {
    const { order, isCustomer, chefId, progress, open } = await access(orderId, viewer);
    if (!open) throw fail(400, "This conversation is closed. Email us if you need help with the order.");
    const body = typeof bodyInput === "string" ? redactContactDetails(bodyInput.trim().slice(0, 1000)) : "";
    if (!body) throw fail(400, "Write a message first.");
    // A chef writes in their own thread; a customer picks which chef they're writing to.
    const threadChef = isCustomer ? Number(chefIdInput) || progress[0]?.chefId : chefId;
    if (!threadChef || !progress.some((p) => p.chefId === threadChef)) throw fail(400, "Choose which chef to message.");
    const role = isCustomer ? "customer" : "chef";
    const [{ id }] = await db.insert(orderMessages).values({ orderId, chefId: threadChef, senderId: viewer.userId || null, senderRole: role, body }).$returningId();
    const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body;
    if (role === "customer") {
        await withTemplate("message.order_to_chef", { orderId, preview }, () => notifyChef(threadChef, `Message about order #${orderId}`, preview, `/chef/dashboard?tab=orders&order=${orderId}`, "message"));
    } else if (order.userId) {
        const name = progress.find((p) => p.chefId === threadChef)?.chefName ?? "Your chef";
        await withTemplate("message.order_to_customer", { orderId, chefName: name, preview }, () => notify(order.userId!, `${name} sent a message about order #${orderId}`, preview, `/order-tracker/${orderId}`, "message"));
    }
    return { id, from: role, body, createdAt: new Date(), chefId: threadChef };
}
