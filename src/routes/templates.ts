import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { getUserId, requireAdmin } from "../lib/auth";
import { getBrevo } from "../lib/integrations";
import { previewEmail, sendEmail } from "../lib/mail";
import { rateLimit } from "../lib/rateLimit";
import { listTemplates, resetTemplate, saveTemplate, SAMPLE_VARS, TEMPLATE_MAP } from "../lib/templates";

// Super Admins change the wording of every in-app, push, email and text message here.
const router = Router();
router.use(requireAdmin);

const testLimit = rateLimit(10, 60_000);

// GET /admin/templates: every message, its default wording and any saved changes
router.get("/", async (_req, res, next) => {
    try {
        res.json({ templates: await listTemplates(), sampleValues: SAMPLE_VARS });
    } catch (error) { next(error); }
});

// PUT /admin/templates/:key { title, body, pushTitle, pushBody, emailSubject, emailBody, sms, channels }
router.put("/:key", async (req, res, next) => {
    try {
        res.json(await saveTemplate(String(req.params.key), req.body ?? {}, getUserId(req)));
    } catch (error) { next(error); }
});

// DELETE /admin/templates/:key: back to the default wording
router.delete("/:key", async (req, res, next) => {
    try {
        res.json(await resetTemplate(String(req.params.key)));
    } catch (error) { next(error); }
});

// POST /admin/templates/:key/preview { emailSubject?, emailBody? }: the branded email, with example values
router.post("/:key/preview", async (req, res, next) => {
    try {
        if (!TEMPLATE_MAP.has(String(req.params.key))) return res.status(404).json({ error: "Unknown message" });
        res.json(await previewEmail(String(req.params.key), req.body ?? {}));
    } catch (error) { next(error); }
});

// POST /admin/templates/:key/test { emailSubject?, emailBody? }: emails the preview to the signed-in admin
router.post("/:key/test", testLimit, async (req, res, next) => {
    try {
        const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, getUserId(req))).limit(1);
        if (!me?.email) return res.status(400).json({ error: "Your account has no email address." });
        if (!TEMPLATE_MAP.has(String(req.params.key))) return res.status(404).json({ error: "Unknown message" });
        if (!(await getBrevo()).apiKey) return res.status(400).json({ error: "Email isn't set up yet. Add your Brevo key under Settings, Integrations." });
        const { subject, html } = await previewEmail(String(req.params.key), req.body ?? {});
        await sendEmail({ senderName: "MYUKCHEF", to: me.email, subject: `[Test] ${subject}`, html });
        res.json({ sentTo: me.email });
    } catch (error) {
        const e = error as { status?: number; message?: string };
        if (!e.status) return res.status(502).json({ error: `The test email couldn't be sent: ${e.message ?? "unknown error"}. Check Brevo under Settings, Integrations.` });
        next(error);
    }
});

export default router;
