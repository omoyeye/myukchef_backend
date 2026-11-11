import { Router } from "express";
import { db } from "../db";
import { mobilePushTokens, notificationPreferences, notifications, pushSubscriptions, users } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import { getUserId, requireAuth } from "../lib/auth";
import { getPreferences } from "../lib/notify";
import { isAllowedEndpoint, isExpoToken, pushEnabled, pushPublicKey } from "../lib/push";

const router = Router();

// GET /notifications
router.get("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const userNotifications = await db.query.notifications.findMany({
            where: eq(notifications.userId, userId),
            orderBy: [desc(notifications.createdAt), desc(notifications.id)],
            limit: 20
        });

        res.json(userNotifications);
    } catch (error) {
        console.error("Get notifications error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PATCH /notifications/:id/read
router.patch("/:id/read", async (req, res) => {
    try {
        const userId = getUserId(req);
        const { id } = req.params;

        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        await db.update(notifications)
            .set({ isRead: true })
            .where(and(eq(notifications.id, Number(id)), eq(notifications.userId, userId)));
        const [updated] = await db.select().from(notifications).where(and(eq(notifications.id, Number(id)), eq(notifications.userId, userId))).limit(1);

        if (!updated) {
            return res.status(404).json({ error: "Notification not found" });
        }

        res.json(updated);
    } catch (error) {
        console.error("Mark notification read error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PATCH /notifications/read-all
router.patch("/read-all", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        await db.update(notifications)
            .set({ isRead: true })
            .where(eq(notifications.userId, userId));

        res.json({ message: "All notifications marked as read" });
    } catch (error) {
        console.error("Mark all read error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET and PUT /notifications/preferences
router.get("/preferences", requireAuth, async (req, res) => {
    res.json(await getPreferences(getUserId(req)));
});
router.put("/preferences", requireAuth, async (req, res) => {
    const userId = getUserId(req);
    const values = { emailUpdates: !!req.body.emailUpdates, emailMessages: !!req.body.emailMessages };
    await db.insert(notificationPreferences).values({ userId, ...values }).onDuplicateKeyUpdate({ set: values });
    res.json(values);
});

// GET /notifications/push/key
router.get("/push/key", (_req, res) => {
    res.json({ enabled: pushEnabled, publicKey: pushPublicKey });
});

// POST /notifications/push: this device agrees to push notifications
router.post("/push", requireAuth, async (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    if (!pushEnabled) return res.status(503).json({ error: "Push notifications aren't set up yet" });
    if (!isAllowedEndpoint(endpoint) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string" || keys.p256dh.length > 255 || keys.auth.length > 255) {
        return res.status(400).json({ error: "This device's push details weren't valid" });
    }
    const userId = getUserId(req);
    await db.insert(pushSubscriptions).values({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
        .onDuplicateKeyUpdate({ set: { userId, p256dh: keys.p256dh, auth: keys.auth } });
    res.status(201).json({ subscribed: true });
});

// DELETE /notifications/push { endpoint }
router.delete("/push", requireAuth, async (req, res) => {
    const endpoint = String(req.body?.endpoint ?? "");
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, getUserId(req)), eq(pushSubscriptions.endpoint, endpoint)));
    res.json({ subscribed: false });
});

// POST /notifications/mobile-push { token, platform }: the MYUKCHEF app on this phone can receive pushes
router.post("/mobile-push", requireAuth, async (req, res) => {
    const { token, platform } = req.body ?? {};
    if (!isExpoToken(token)) return res.status(400).json({ error: "This phone's push token wasn't valid" });
    const userId = getUserId(req);
    const os = ["ios", "android"].includes(platform) ? platform : null;
    await db.insert(mobilePushTokens).values({ userId, token, platform: os })
        .onDuplicateKeyUpdate({ set: { userId, platform: os } });
    res.status(201).json({ subscribed: true });
});

// DELETE /notifications/mobile-push { token }: signing out on the phone stops its pushes
router.delete("/mobile-push", requireAuth, async (req, res) => {
    const token = String(req.body?.token ?? "");
    await db.delete(mobilePushTokens).where(and(eq(mobilePushTokens.userId, getUserId(req)), eq(mobilePushTokens.token, token)));
    res.json({ subscribed: false });
});

export const notificationsRouter = router;
