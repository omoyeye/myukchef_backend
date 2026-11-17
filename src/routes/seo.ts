import { Router } from "express";
import { requireAdmin } from "../lib/auth";
import { draftSeo } from "../lib/claude";
import { getClaudeKey } from "../lib/integrations";
import { rateLimit } from "../lib/rateLimit";
import { getSeoConfig, publicSeo, saveSeoConfig, SEO_PAGES } from "../lib/seoSettings";

// Search engine text and tracking tags (Google Tag Manager, GA4, pixels), managed by Super Admins.
const router = Router();

// GET /seo/public: tag IDs and page titles for the website (loaded after cookie consent)
router.get("/public", async (_req, res, next) => {
    try { res.set("Cache-Control", "public, max-age=300").json(await publicSeo()); } catch (e) { next(e); }
});

// GET /seo: everything, for the SEO page
router.get("/", requireAdmin, async (_req, res, next) => {
    try { res.json({ config: await getSeoConfig(), pages: SEO_PAGES, aiReady: !!(await getClaudeKey()) }); } catch (e) { next(e); }
});

// PUT /seo
router.put("/", requireAdmin, async (req, res, next) => {
    try { res.json({ config: await saveSeoConfig(req.body ?? {}) }); } catch (e) { next(e); }
});

// POST /seo/ai { path, focus? }: Claude drafts a title, description and keywords for one page
router.post("/ai", requireAdmin, rateLimit(20, 60_000), async (req, res, next) => {
    try {
        const page = SEO_PAGES.find((p) => p.path === req.body?.path);
        if (!page) return res.status(400).json({ error: "Choose a page." });
        const current = (await getSeoConfig()).pages[page.path] ?? {};
        const focus = typeof req.body?.focus === "string" ? req.body.focus.trim().slice(0, 300) : "";
        res.json(await draftSeo({ path: page.path, name: page.name, purpose: page.purpose, current, focus }));
    } catch (e) { next(e); }
});

export default router;
