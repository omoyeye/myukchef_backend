import { Router } from "express";
import { getUserId, requireAdmin } from "../lib/auth";
import { adminView, clearSettings, isProvider, saveSettings, testConnection } from "../lib/integrations";
import { rateLimit } from "../lib/rateLimit";

// Super Admins manage the Stripe and Brevo keys here. Secret keys are only ever sent back masked.
const router = Router();
router.use(requireAdmin);

const webhookUrl = (req: Parameters<typeof getUserId>[0]) =>
    `${(process.env.API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "")}/api/payments/stripe/webhook`;

// GET /admin/integrations
router.get("/", async (req, res, next) => {
    try {
        res.json({ stripe: { ...(await adminView("stripe")), webhookUrl: webhookUrl(req) }, brevo: await adminView("brevo") });
    } catch (error) { next(error); }
});

// PUT /admin/integrations/:provider { field: "value" | "" , enabled? }
router.put("/:provider", async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!isProvider(provider)) return res.status(404).json({ error: "Unknown service" });
        const saved = await saveSettings(provider, req.body ?? {}, getUserId(req));
        res.json(provider === "stripe" ? { ...saved, webhookUrl: webhookUrl(req) } : saved);
    } catch (error) { next(error); }
});

// DELETE /admin/integrations/:provider: forget the saved keys; the server's own settings apply again
router.delete("/:provider", async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!isProvider(provider)) return res.status(404).json({ error: "Unknown service" });
        const cleared = await clearSettings(provider);
        res.json(provider === "stripe" ? { ...cleared, webhookUrl: webhookUrl(req) } : cleared);
    } catch (error) { next(error); }
});

// POST /admin/integrations/:provider/test: checks the keys with a read-only call
router.post("/:provider/test", rateLimit(10, 60_000), async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!isProvider(provider)) return res.status(404).json({ error: "Unknown service" });
        res.json(await testConnection(provider));
    } catch (error) { next(error); }
});

export const integrationsRouter = router;
