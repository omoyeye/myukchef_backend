import { Router } from "express";
import { db } from "../db";
import { siteSettings, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { getUserId, isAdmin, requireAdmin } from "../lib/auth";
import { cleanTiers } from "../lib/pricing";
import { forgetBrand } from "../lib/mail";

const router = Router();

// Staff-only settings are left out of what the public site receives.
const PRIVATE_KEYS = new Set(["admin_alert_email", "sms_sender", "event_commission", "company_bank_details", "allergens_14_migrated", "selling_rules", "vat_config", "chef_commission"]);

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
    const { key } = req.body;
    let { value } = req.body;
    // Delivery price bands are tidied before saving, so checkout always gets sensible ones.
    if (key === "delivery_config" && value && typeof value === "object") value = { ...value, tiers: cleanTiers(value.tiers) };
    // Payout rules and keys have their own checked endpoints.
    if (key === "chef_commission") return res.status(400).json({ error: "Change the chef commission under Orders, Chef payouts." });

    // Emails carry the logo, phone, address and socials, so they pick up changes straight away.
    if (["store_info", "footer_info", "company_info"].includes(key)) forgetBrand();

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
