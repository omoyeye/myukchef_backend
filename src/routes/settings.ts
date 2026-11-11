import { Router } from "express";
import { db } from "../db";
import { siteSettings, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { getUserId, isAdmin, requireAdmin } from "../lib/auth";

const router = Router();

// Staff-only settings are left out of what the public site receives.
const PRIVATE_KEYS = new Set(["admin_alert_email", "sms_sender", "event_commission", "company_bank_details", "allergens_14_migrated"]);

// GET /api/settings
router.get("/", async (req, res) => {
    try {
        const allSettings = await db.select().from(siteSettings);
        const admin = await isAdmin(getUserId(req));
        // Convert array to object for easier consumption on frontend
        const settingsMap = allSettings.reduce((acc: any, curr) => {
            if (admin || !PRIVATE_KEYS.has(curr.key)) acc[curr.key] = curr.value;
            return acc;
        }, {});
        res.json(settingsMap);
    } catch (error) {
        console.error("Get settings error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/settings
router.post("/", requireAdmin, async (req, res) => {
    const { key, value } = req.body;

    if (!key || value === undefined) {
        return res.status(400).json({ error: "Key and value are required" });
    }

    try {
        const existing = await db.query.siteSettings.findFirst({
            where: eq(siteSettings.key, key)
        });

        if (existing) {
            await db.update(siteSettings)
                .set({ value, updatedAt: new Date() })
                .where(eq(siteSettings.key, key));
        } else {
            await db.insert(siteSettings).values({
                key,
                value,
                updatedAt: new Date()
            });
        }

        res.json({ success: true, key, value });
    } catch (error) {
        console.error("Update settings error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export const settingsRouter = router;
