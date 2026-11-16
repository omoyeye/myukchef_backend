import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { banners, users } from "../db/schema";
import { getUserId, requireAdmin } from "../lib/auth";
import { rateLimit } from "../lib/rateLimit";

/**
 * Banner adverts. Super Admins create them here and choose, for each one, whether it shows on the
 * website, in the app or both, on which page, to whom, and between which dates.
 */
const router = Router();

const PLACEMENTS = ["home", "menu", "meal_plans", "everywhere"] as const;
const AUDIENCES = ["everyone", "customers", "chefs", "signed_out"] as const;
const THEMES = ["brand", "dark", "light"] as const;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const when = (v: unknown) => {
    if (v === null || v === "" || v === undefined) return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw fail("Enter the dates as dates.");
    return d;
};

function clean(body: Record<string, unknown>) {
    const title = text(body.title, 120);
    if (!title) throw fail("Give the banner a headline.");
    const link = text(body.link, 500);
    // Links go to a page on MYUKCHEF (/menu) or a secure website (https://...).
    if (link && !/^\/(?!\/)[\w\-./?=&%#]*$/.test(link) && !/^https:\/\/[^\s]+$/.test(link)) throw fail("The link must start with / (a MYUKCHEF page) or https://");
    const image = text(body.image, 255);
    if (image && !/^\/uploads\/[\w-]+\.(jpg|jpeg|png|webp)$/.test(image) && !/^https:\/\/[^\s]+$/.test(image)) throw fail("Upload the banner image again.");
    const startsAt = when(body.startsAt);
    const endsAt = when(body.endsAt);
    if (startsAt && endsAt && endsAt <= startsAt) throw fail("The end date must be after the start date.");
    const showOnWebsite = body.showOnWebsite !== false;
    const showOnApp = body.showOnApp !== false;
    if (!showOnWebsite && !showOnApp) throw fail("Choose the website, the app, or both.");
    return {
        title,
        message: text(body.message, 300),
        image,
        ctaLabel: text(body.ctaLabel, 40),
        link,
        placement: oneOf(body.placement, PLACEMENTS, "home"),
        audience: oneOf(body.audience, AUDIENCES, "everyone"),
        theme: oneOf(body.theme, THEMES, "brand"),
        showOnWebsite,
        showOnApp,
        active: body.active !== false,
        startsAt,
        endsAt,
        sortOrder: Math.max(-999, Math.min(999, Math.round(Number(body.sortOrder) || 0))),
    };
}

const publicFields = {
    id: banners.id, title: banners.title, message: banners.message, image: banners.image, ctaLabel: banners.ctaLabel,
    link: banners.link, theme: banners.theme, placement: banners.placement,
};

// GET /banners?platform=website|app&placement=home: the banners to show this person right now
router.get("/", async (req, res, next) => {
    try {
        const platform = req.query.platform === "app" ? "app" : "website";
        const placement = oneOf(req.query.placement, PLACEMENTS, "home");
        const userId = getUserId(req);
        const [viewer] = userId ? await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1) : [];
        const audiences = !viewer ? ["everyone", "signed_out"] : viewer.role === "chef" ? ["everyone", "chefs"] : viewer.role === "admin" ? [...AUDIENCES] : ["everyone", "customers"];
        const now = new Date();
        const rows = await db.select(publicFields).from(banners).where(and(
            eq(banners.active, true),
            platform === "app" ? eq(banners.showOnApp, true) : eq(banners.showOnWebsite, true),
            inArray(banners.placement, [placement, "everywhere"]),
            inArray(banners.audience, audiences),
            or(isNull(banners.startsAt), lte(banners.startsAt, now)),
            or(isNull(banners.endsAt), gte(banners.endsAt, now)),
        )).orderBy(asc(banners.sortOrder), desc(banners.createdAt)).limit(5);
        res.set("Cache-Control", "no-store").json(rows);
    } catch (e) { next(e); }
});

// POST /banners/:id/seen { clicked?: true }: counts views and clicks, nothing about who
router.post("/:id/seen", rateLimit(60, 60_000), async (req, res, next) => {
    try {
        const id = Number(req.params.id) || 0;
        await db.update(banners).set(req.body?.clicked ? { clicks: sql`${banners.clicks} + 1` } : { views: sql`${banners.views} + 1` }).where(eq(banners.id, id));
        res.status(204).end();
    } catch (e) { next(e); }
});

// === Super Admin ===

router.get("/admin", requireAdmin, async (_req, res, next) => {
    try {
        res.json(await db.select().from(banners).orderBy(desc(banners.active), asc(banners.sortOrder), desc(banners.createdAt)));
    } catch (e) { next(e); }
});

router.post("/admin", requireAdmin, async (req, res, next) => {
    try {
        const [{ id }] = await db.insert(banners).values({ ...clean(req.body ?? {}), createdBy: getUserId(req) }).$returningId();
        res.status(201).json((await db.select().from(banners).where(eq(banners.id, id)).limit(1))[0]);
    } catch (e) { next(e); }
});

router.put("/admin/:id", requireAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id) || 0;
        const [existing] = await db.select().from(banners).where(eq(banners.id, id)).limit(1);
        if (!existing) throw fail("Banner not found", 404);
        // Switching a banner on or off on its own keeps everything else as it is.
        const body = Object.keys(req.body ?? {}).length === 1 && "active" in req.body ? { ...existing, active: req.body.active !== false } : req.body ?? {};
        await db.update(banners).set({ ...clean(body), updatedAt: new Date() }).where(eq(banners.id, id));
        res.json((await db.select().from(banners).where(eq(banners.id, id)).limit(1))[0]);
    } catch (e) { next(e); }
});

router.delete("/admin/:id", requireAdmin, async (req, res, next) => {
    try {
        await db.delete(banners).where(eq(banners.id, Number(req.params.id) || 0));
        res.status(204).end();
    } catch (e) { next(e); }
});

export default router;
