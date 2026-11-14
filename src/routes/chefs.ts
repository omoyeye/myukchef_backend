import { Router } from "express";
import { withTemplate } from "../lib/templates";
import fs from "fs";
import path from "path";
import { addCredential, CREDENTIAL_TYPES, deleteCredential, hasVerifiedHygiene, listForChef, publicCredentials, reviewCredential, updateCredential } from "../lib/credentials";
import { privateFilePath } from "./upload";
import { availabilitySummary, cleanOpeningHours } from "../lib/availability";
import { chefForMenu, chefTimes, sellingChefs } from "../lib/selling";
import { filterDishes, pageOf } from "../lib/search";
import { afterSignUp } from "../lib/accounts";
import { db } from "../db";
import { chefCompliance, chefCredentials, chefInvoices, chefReviews, chefs, chefProducts, eventQuotes, events, favouriteChefs, mealPlans, mealPlanWeeks, orderItems, orders, products, users } from "../db/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { getUserId, isAdmin, isValidEmail, MIN_PASSWORD_LENGTH, normaliseEmail, requireAdmin, signToken } from "../lib/auth";
import { assertNoContactDetails } from "../lib/contactGuard";
import { rateLimit } from "../lib/rateLimit";
import { cleanAllergens } from "../lib/allergens";
import { notify, notifyAdmins, notifyChef } from "../lib/notify";
import { blurCoordinate, geocode, milesBetween, parseCoordinates, publicArea } from "../lib/geo";

const router = Router();

// The public site never receives contact details, moderation notes or an exact position.
const publicChef = <T extends { phone: unknown; userId: unknown; rejectionReason: unknown; location: string | null; latitude: number | null; longitude: number | null }>(chef: T) => {
    // Payout account details are private too.
    const { phone: _p, userId: _u, rejectionReason: _r, latitude, longitude, stripeAccountId: _s, stripePayoutsEnabled: _e, ...rest } = chef as T & { stripeAccountId?: unknown; stripePayoutsEnabled?: unknown };
    return { ...rest, location: publicArea(chef.location), approxLat: blurCoordinate(latitude), approxLng: blurCoordinate(longitude) };
};

/** Extra warning a dish needs, in hours. Empty means the chef's usual notice. */
const dishNotice = (value: unknown) => {
    if (value === undefined || value === null || value === "") return null;
    const hours = Number(value);
    if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw Object.assign(new Error("Notice must be between 0 hours and 7 days."), { status: 400 });
    return hours;
};

/** Only videos uploaded through MYUKCHEF can be shown on a chef's page. */
const KITCHEN_VIDEO = /^\/uploads\/[\w-]+\.(mp4|mov)$/;

/** The chef's own story and kitchen video. An empty value removes either one. */
function storyAndVideo(body: { story?: unknown; kitchenVideo?: unknown }, chef: { story: string | null; kitchenVideo: string | null }) {
    const changes: { story?: string | null; kitchenVideo?: string | null; kitchenVideoUpdatedAt?: Date | null } = {};
    if (typeof body.story === "string") {
        if (body.story.length > 4000) throw Object.assign(new Error("Please keep your story under 4,000 characters."), { status: 400 });
        changes.story = body.story.trim() || null;
    }
    if (body.kitchenVideo !== undefined && body.kitchenVideo !== chef.kitchenVideo) {
        const video = typeof body.kitchenVideo === "string" ? body.kitchenVideo.trim() : "";
        if (video && !KITCHEN_VIDEO.test(video)) throw Object.assign(new Error("Please upload your kitchen video through MYUKCHEF."), { status: 400 });
        changes.kitchenVideo = video || null;
        changes.kitchenVideoUpdatedAt = video ? new Date() : null;
    }
    return changes;
}

/** Looks up coordinates when a chef's location text is new or has changed. */
async function locationFields(location: string | null | undefined, current?: { location: string | null; latitude: number | null; longitude: number | null }) {
    if (location === undefined || location === current?.location) return {};
    const point = await geocode(location);
    return { latitude: point?.lat ?? null, longitude: point?.lng ?? null };
}

const dishFields = (body: any) => ({
    name: body.name,
    description: body.description,
    price: Number(body.price),
    category: body.category,
    image: body.image,
    tags: body.tags || [],
    allergens: cleanAllergens(body.allergens),
    allergensDeclared: !!body.allergensDeclared,
    isVegetarian: !!body.isVegetarian,
    isVegan: !!body.isVegan,
    isGlutenFree: !!body.isGlutenFree,
    isHalal: !!body.isHalal,
    isPopular: !!body.isPopular,
    isSoldOut: !!body.isSoldOut,
    calories: body.calories ? Number(body.calories) : null,
});
const hygieneValue = (value: unknown) => {
    const n = value === "" || value === null || value === undefined ? NaN : Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
};
const slugId = (chefId: number, name: string) =>
    `chef${chefId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString().slice(-5)}`;

// Helper: get chef profile by userId
async function getChefByUserId(userId: number) {
    const [c] = await db.select().from(chefs).where(eq(chefs.userId, userId)).limit(1);
    return c;
}

// POST /chefs/register — public chef signup (creates user + chef profile, status=pending)
router.post("/register", rateLimit(5, 60_000), async (req, res) => {
    try {
        const { name, password, displayName, bio, specialty, phone, location, yearsExperience } = req.body;
        assertNoContactDetails(displayName, bio, specialty);
        const email = normaliseEmail(String(req.body.email ?? ""));
        if (!name || !email || !password || !displayName) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        if (req.body.acceptTerms !== true) return res.status(400).json({ error: "Please agree to the Chef Agreement, Terms and Privacy Policy" });
        if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email format" });
        if (String(password).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existing.length > 0) return res.status(400).json({ error: "Email already in use" });

        const hashed = await bcrypt.hash(password, 10);
        const [{ id: newUserId }] = await db.insert(users).values({ name, email, password: hashed, role: "chef", termsAcceptedAt: new Date() }).$returningId();
        const [newUser] = await db.select().from(users).where(eq(users.id, newUserId)).limit(1);
        await afterSignUp(newUser, req.body.referralCode);

        const [{ id: newChefId }] = await db.insert(chefs).values({
            userId: newUser.id,
            displayName,
            bio: bio || null,
            specialty: specialty || null,
            phone: phone || null,
            location: location || null,
            ...(await locationFields(location)),
            yearsExperience: yearsExperience ? Number(yearsExperience) : null,
            status: "pending",
            agreementAcceptedAt: new Date(),
        }).$returningId();
        const [newChef] = await db.select().from(chefs).where(eq(chefs.id, newChefId)).limit(1);
        await withTemplate("chef.application_received", {}, () => notify(newUser.id, "We've got your application", "Our team will review it soon. In the meantime, add your food safety and payout details in the Chef Portal.", "/chef/dashboard?tab=compliance"));
        await withTemplate("admin.chef_applied", { chefName: displayName }, () => notifyAdmins("New chef application", `${displayName} has applied to join.`, "/admin/chefs"));

        const { password: _, ...userSafe } = newUser;
        res.status(201).json({ user: userSafe, chef: newChef, token: signToken(newUser.id) });
    } catch (error) {
        if ((error as { status?: number }).status === 400) return res.status(400).json({ error: (error as Error).message });
        console.error("Chef register error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

/** Average rating, review count and households cooked for, keyed by chef. */
async function chefStats(ids: number[]) {
    if (ids.length === 0) return new Map<number, { rating: number | null; reviewCount: number; planHouseholds: number }>();
    const ratings = await db.select({ chefId: chefReviews.chefId, rating: sql<string>`avg(${chefReviews.rating})`, count: sql<number>`count(*)` })
        .from(chefReviews)
        .where(and(inArray(chefReviews.chefId, ids), eq(chefReviews.status, "published")))
        .groupBy(chefReviews.chefId);
    const plans = await db.select({ chefId: mealPlans.chefId, count: sql<number>`count(distinct ${mealPlans.userId})` })
        .from(mealPlans)
        .where(and(inArray(mealPlans.chefId, ids), inArray(mealPlans.status, ["active", "paused", "completed"])))
        .groupBy(mealPlans.chefId);
    const stats = new Map(ids.map((id) => [id, { rating: null as number | null, reviewCount: 0, planHouseholds: 0 }]));
    for (const r of ratings) Object.assign(stats.get(r.chefId)!, { rating: Math.round(Number(r.rating) * 10) / 10, reviewCount: Number(r.count) });
    for (const p of plans) stats.get(p.chefId)!.planHouseholds = Number(p.count);
    return stats;
}

// GET /chefs/favourites — the signed-in customer's saved chefs
router.get("/favourites", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Please sign in" });
        const rows = await db.select({ chef: chefs }).from(favouriteChefs)
            .innerJoin(chefs, eq(favouriteChefs.chefId, chefs.id))
            .where(and(eq(favouriteChefs.userId, userId), eq(chefs.status, "approved")));
        const stats = await chefStats(rows.map((r) => r.chef.id));
        res.json(rows.map((r) => ({ ...publicChef(r.chef), ...stats.get(r.chef.id) })));
    } catch (error) { next(error); }
});

// PUT and DELETE /chefs/:id/favourite
router.put("/:id/favourite", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Please sign in" });
        const chefId = Number(req.params.id);
        const [chef] = await db.select({ id: chefs.id }).from(chefs).where(and(eq(chefs.id, chefId), eq(chefs.status, "approved"))).limit(1);
        if (!chef) return res.status(404).json({ error: "Chef not found" });
        await db.insert(favouriteChefs).values({ userId, chefId }).onDuplicateKeyUpdate({ set: { chefId } });
        res.json({ favourite: true });
    } catch (error) { next(error); }
});
router.delete("/:id/favourite", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Please sign in" });
        await db.delete(favouriteChefs).where(and(eq(favouriteChefs.userId, userId), eq(favouriteChefs.chefId, Number(req.params.id))));
        res.json({ favourite: false });
    } catch (error) { next(error); }
});

// GET /chefs — public: only approved chefs
router.get("/", async (req, res) => {
    try {
        const approved = await db.select().from(chefs).where(eq(chefs.status, "approved")).orderBy(desc(chefs.approvedAt));
        // ?q= searches the chef's name, cuisine, area and bio.
        const words = (typeof req.query.q === "string" ? req.query.q : "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
        const all = words.length
            ? approved.filter((c) => { const hay = [c.displayName, c.specialty, c.location, c.bio].join(" ").toLowerCase(); return words.every((w) => hay.includes(w)); })
            : approved;
        const stats = await chefStats(all.map((c) => c.id));
        const creds = await publicCredentials(all.map((c) => c.id));
        const byId = new Map(all.map((c) => [c.id, c]));
        const badges = (id: number) => ({ hygieneVerified: (creds.get(id) ?? []).some((c) => c.type === "food_hygiene"), verifiedCredentials: (creds.get(id) ?? []).length, ...availabilitySummary(chefTimes(byId.get(id)!)) });
        const origin = parseCoordinates(req.query.lat, req.query.lng);
        res.setHeader("X-Total-Count", String(all.length));
        if (!origin) return res.json(pageOf(all.map((chef) => ({ ...publicChef(chef), ...stats.get(chef.id), ...badges(chef.id) })), req.query));

        const withDistance = all.map((chef) => {
            const distanceMiles = chef.latitude !== null && chef.longitude !== null
                ? Math.round(milesBetween(origin, { lat: chef.latitude, lng: chef.longitude }) * 10) / 10
                : null;
            return { ...publicChef(chef), ...stats.get(chef.id), ...badges(chef.id), distanceMiles, inServiceArea: distanceMiles !== null && distanceMiles <= chef.serviceRadiusMiles };
        });
        // Chefs who serve this area first, then by distance. Chefs with no known location go last.
        withDistance.sort((a, b) =>
            Number(b.inServiceArea) - Number(a.inServiceArea) ||
            (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
        res.json(pageOf(withDistance, req.query));
    } catch (error) {
        console.error("Get chefs error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /chefs/admin/all — admin: all chefs (any status)
router.get("/admin/all", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId || !(await isAdmin(userId))) return res.status(403).json({ error: "Forbidden" });
        const all = await db.select().from(chefs).orderBy(desc(chefs.createdAt));
        const details = await db.select().from(chefCompliance);
        res.json(all.map((chef) => {
            const row = details.find((d) => d.chefId === chef.id);
            return { ...chef, complianceComplete: complianceComplete(row), complianceVerified: !!row?.verifiedAt };
        }));
    } catch (error) {
        console.error("Admin get chefs error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /chefs/me — authenticated chef's own profile
router.get("/me", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const chef = await getChefByUserId(userId);
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        res.json(chef);
    } catch (error) {
        console.error("Get me chef error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT /chefs/me — update own profile
router.put("/me", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const chef = await getChefByUserId(userId);
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        assertNoContactDetails(req.body.displayName, req.body.bio, req.body.specialty, req.body.story);

        const { displayName, bio, specialty, avatar, coverImage, phone, location, yearsExperience, isAvailableForEvents, eventRate, serviceRadiusMiles, acceptsMealPlans } = req.body;
        const notice = req.body.noticeHours !== undefined ? Number(req.body.noticeHours) : chef.noticeHours;
        if (!Number.isInteger(notice) || notice < 0 || notice > 168) return res.status(400).json({ error: "Notice must be between 0 hours and 7 days." });
        await db.update(chefs).set({
            // When the chef cooks one-off orders.
            ...(req.body.openingHours !== undefined ? { openingHours: cleanOpeningHours(req.body.openingHours) } : {}),
            ...(req.body.ordersPaused !== undefined ? { ordersPaused: !!req.body.ordersPaused } : {}),
            noticeHours: notice,
            displayName: displayName ?? chef.displayName,
            bio: bio ?? chef.bio,
            ...storyAndVideo(req.body, chef),
            specialty: specialty ?? chef.specialty,
            avatar: avatar ?? chef.avatar,
            coverImage: coverImage ?? chef.coverImage,
            phone: phone ?? chef.phone,
            location: location ?? chef.location,
            ...(await locationFields(location, chef)),
            serviceRadiusMiles: serviceRadiusMiles !== undefined ? Number(serviceRadiusMiles) || chef.serviceRadiusMiles : chef.serviceRadiusMiles,
            yearsExperience: yearsExperience !== undefined ? Number(yearsExperience) : chef.yearsExperience,
            isAvailableForEvents: isAvailableForEvents !== undefined ? !!isAvailableForEvents : chef.isAvailableForEvents,
            eventRate: eventRate !== undefined ? Number(eventRate) : chef.eventRate,
            acceptsMealPlans: acceptsMealPlans !== undefined ? !!acceptsMealPlans : chef.acceptsMealPlans,
        }).where(eq(chefs.id, chef.id));
        const [updated] = await db.select().from(chefs).where(eq(chefs.id, chef.id)).limit(1);
        res.json(updated);
    } catch (error) {
        if ((error as { status?: number }).status === 400) return res.status(400).json({ error: (error as Error).message });
        console.error("Update chef error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PATCH /chefs/:id/status — admin moderation
router.patch("/:id/status", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId || !(await isAdmin(userId))) return res.status(403).json({ error: "Forbidden" });
        const chefId = Number(req.params.id);
        const { status, rejectionReason } = req.body;
        if (!["pending", "approved", "suspended", "rejected"].includes(status)) {
            return res.status(400).json({ error: "Invalid status" });
        }
        await db.update(chefs).set({
            status,
            rejectionReason: rejectionReason || null,
            approvedAt: status === "approved" ? new Date() : null,
        }).where(eq(chefs.id, chefId));
        const [updated] = await db.select().from(chefs).where(eq(chefs.id, chefId)).limit(1);
        const words: Record<string, [string, string]> = {
            approved: ["You're approved", "Welcome to MYUKCHEF. You can now add dishes and take bookings."],
            suspended: ["Your chef account is suspended", rejectionReason || "Please contact support for details."],
            rejected: ["About your chef application", rejectionReason || "We can't approve your application at the moment. Please contact support for details."],
        };
        if (updated && words[status]) await withTemplate(`chef.account_${status}`, { reason: rejectionReason ?? "" }, () => notify(updated.userId, words[status][0], words[status][1], "/chef/dashboard"));
        res.json(updated);
    } catch (error) {
        console.error("Chef status error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE /chefs/:id — admin delete chef
router.delete("/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId || !(await isAdmin(userId))) return res.status(403).json({ error: "Forbidden" });
        const chefId = Number(req.params.id);
        const [chef] = await db.select().from(chefs).where(eq(chefs.id, chefId)).limit(1);
        if (!chef) return res.status(404).json({ error: "Chef not found" });
        // Past bookings stay on record without the chef, and the login becomes a customer account.
        const plans = await db.select({ id: mealPlans.id }).from(mealPlans).where(eq(mealPlans.chefId, chefId)).limit(1);
        const quotes = await db.select({ id: eventQuotes.id }).from(eventQuotes).where(eq(eventQuotes.chefId, chefId)).limit(1);
        const invoices = await db.select({ id: chefInvoices.id }).from(chefInvoices).where(eq(chefInvoices.chefId, chefId)).limit(1);
        if (plans.length > 0 || quotes.length > 0 || invoices.length > 0) return res.status(400).json({ error: "This chef has meal plans, event quotes or invoices on record. Suspend them instead, so the records are kept." });
        await db.update(events).set({ chefId: null }).where(eq(events.chefId, chefId));
        await db.delete(chefs).where(eq(chefs.id, chefId));
        await db.update(users).set({ role: "customer" }).where(eq(users.id, chef.userId));
        res.json({ message: "Chef deleted" });
    } catch (error) {
        console.error("Delete chef error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// === CHEF PRODUCTS ===

// GET /chefs/products/public — all approved products from approved chefs
router.get("/products/public", async (req, res) => {
    try {
        const rows = await db.select({ product: chefProducts })
            .from(chefProducts)
            .where(and(eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true)));
        // Only chefs allowed to sell: approved, and hygiene-verified when that rule is on.
        const sellers = await sellingChefs();
        const now = new Date();
        let dishes = rows.filter((r) => sellers.has(r.product.chefId)).map((r) => {
            const chef = sellers.get(r.product.chefId)!;
            return { ...r.product, noticeHours: Math.max(r.product.noticeHours ?? 0, chef.noticeHours), chef: chefForMenu(chef, now) };
        });
        dishes = filterDishes(dishes, req.query);
        res.setHeader("X-Total-Count", String(dishes.length));
        res.json(pageOf(dishes, req.query));
    } catch (error) {
        console.error("Public chef products error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /chefs/me/products — chef's own products (any status)
router.get("/me/products", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const chef = await getChefByUserId(userId);
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        const rows = await db.select().from(chefProducts).where(eq(chefProducts.chefId, chef.id)).orderBy(desc(chefProducts.createdAt));
        res.json(rows);
    } catch (error) {
        console.error("My chef products error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /chefs/me/products — create product (status=pending until admin approves)
router.post("/me/products", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const chef = await getChefByUserId(userId);
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        if (chef.status !== "approved") return res.status(403).json({ error: "Your chef account must be approved before posting products" });

        const { name, description, price, category, image, tags, allergens, allergensDeclared, isVegetarian, isVegan, isGlutenFree, isHalal, isPopular, calories } = req.body;
        if (!name || !description || !price || !image || !category) return res.status(400).json({ error: "Missing fields" });
        assertNoContactDetails(name, description);
        if (!allergensDeclared) return res.status(400).json({ error: "Please check the full allergen list and confirm it" });

        const id = slugId(chef.id, name);

        await db.insert(chefProducts).values({
            id,
            chefId: chef.id,
            name, description, price: Number(price), category, image,
            tags: tags || [],
            allergens: cleanAllergens(allergens),
            allergensDeclared: !!allergensDeclared,
            isVegetarian: !!isVegetarian, isVegan: !!isVegan, isGlutenFree: !!isGlutenFree, isHalal: !!isHalal, isPopular: !!isPopular,
            calories: calories ? Number(calories) : null,
            noticeHours: dishNotice(req.body.noticeHours),
            status: "pending",
        });
        const [created] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        await withTemplate("admin.dish_to_review", { chefName: chef.displayName, dishName: name }, () => notifyAdmins("New dish to review", `${chef.displayName} added ${name}.`, "/admin/chefs"));
        res.status(201).json(created);
    } catch (error) {
        if ((error as { status?: number }).status === 400) return res.status(400).json({ error: (error as Error).message });
        console.error("Create chef product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT /chefs/me/products/:id — update own product (resets to pending)
router.put("/me/products/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const chef = await getChefByUserId(userId);
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        const { id } = req.params;
        const [existing] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        if (!existing || existing.chefId !== chef.id) return res.status(404).json({ error: "Product not found" });

        const { name, description, price, category, image, tags, allergens, allergensDeclared, isVegetarian, isVegan, isGlutenFree, isHalal, isPopular, calories, isSoldOut } = req.body;
        assertNoContactDetails(name, description);
        await db.update(chefProducts).set({
            name, description, price: Number(price), category, image,
            tags: tags || [], allergens: cleanAllergens(allergens), allergensDeclared: !!allergensDeclared,
            isVegetarian: !!isVegetarian, isVegan: !!isVegan, isGlutenFree: !!isGlutenFree, isHalal: !!isHalal, isPopular: !!isPopular,
            calories: calories ? Number(calories) : null,
            isSoldOut: !!isSoldOut,
            noticeHours: dishNotice(req.body.noticeHours),
            status: "pending", // re-moderate after edits
        }).where(eq(chefProducts.id, id));
        const [updated] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        res.json(updated);
    } catch (error) {
        if ((error as { status?: number }).status === 400) return res.status(400).json({ error: (error as Error).message });
        console.error("Update chef product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE /chefs/me/products/:id
router.delete("/me/products/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const chef = await getChefByUserId(userId);
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        const { id } = req.params;
        const [existing] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        if (!existing || existing.chefId !== chef.id) return res.status(404).json({ error: "Product not found" });
        await db.delete(chefProducts).where(eq(chefProducts.id, id));
        res.json({ message: "Deleted" });
    } catch (error) {
        console.error("Delete chef product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PATCH /chefs/me/products/:id/allergens: confirming allergens doesn't need the dish reviewing again
router.patch("/me/products/:id/allergens", async (req, res) => {
    const chef = await getChefByUserId(getUserId(req));
    if (!chef) return res.status(404).json({ error: "Chef profile not found" });
    const id = String(req.params.id);
    const [dish] = await db.select({ chefId: chefProducts.chefId }).from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
    if (!dish || dish.chefId !== chef.id) return res.status(404).json({ error: "Dish not found" });
    if (req.body.confirmed !== true) return res.status(400).json({ error: "Please confirm the allergen list is complete and correct" });
    await db.update(chefProducts).set({ allergens: cleanAllergens(req.body.allergens), allergensDeclared: true }).where(eq(chefProducts.id, id));
    const [updated] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
    res.json(updated);
});

// === Certificates and checks (food hygiene, council registration, insurance, DBS) ===

// GET /chefs/me/credentials
router.get("/me/credentials", async (req, res, next) => {
    try {
        const chef = await getChefByUserId(getUserId(req));
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        res.json({ credentials: await listForChef(chef.id), types: CREDENTIAL_TYPES });
    } catch (error) { next(error); }
});
// POST /chefs/me/credentials
router.post("/me/credentials", async (req, res, next) => {
    try {
        const chef = await getChefByUserId(getUserId(req));
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        res.status(201).json(await addCredential(chef.id, chef.displayName, req.body ?? {}));
    } catch (error) { next(error); }
});
// PUT /chefs/me/credentials/:id
router.put("/me/credentials/:id", async (req, res, next) => {
    try {
        const chef = await getChefByUserId(getUserId(req));
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        res.json(await updateCredential(chef.id, chef.displayName, Number(req.params.id), req.body ?? {}));
    } catch (error) { next(error); }
});
// DELETE /chefs/me/credentials/:id
router.delete("/me/credentials/:id", async (req, res, next) => {
    try {
        const chef = await getChefByUserId(getUserId(req));
        if (!chef) return res.status(404).json({ error: "Chef profile not found" });
        await deleteCredential(chef.id, Number(req.params.id));
        res.json({ message: "Removed" });
    } catch (error) { next(error); }
});
// GET /chefs/credentials/:id/document: the private copy, for its chef or a Super Admin only
router.get("/credentials/:id/document", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Please sign in" });
        const [row] = await db.select().from(chefCredentials).where(eq(chefCredentials.id, Number(req.params.id))).limit(1);
        const chef = await getChefByUserId(userId);
        if (!row || !(chef?.id === row.chefId || (await isAdmin(userId)))) return res.status(404).json({ error: "Not found" });
        const file = privateFilePath(row.document);
        if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "No copy on file" });
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Content-Disposition", `inline; filename="certificate-${row.id}${path.extname(file)}"`);
        res.sendFile(file);
    } catch (error) { next(error); }
});
// GET /chefs/admin/credentials?status=pending: every chef's certificates, for checking
router.get("/admin/credentials", requireAdmin, async (req, res, next) => {
    try {
        const status = typeof req.query.status === "string" ? req.query.status : null;
        const rows = await db.select({ credential: chefCredentials, chefName: chefs.displayName }).from(chefCredentials)
            .innerJoin(chefs, eq(chefCredentials.chefId, chefs.id))
            .where(status ? eq(chefCredentials.status, status) : undefined)
            .orderBy(desc(chefCredentials.updatedAt)).limit(500);
        res.json(rows.map((r) => ({ ...r.credential, chefName: r.chefName, hasDocument: !!r.credential.document })));
    } catch (error) { next(error); }
});
// PATCH /chefs/admin/credentials/:id { status: verified | rejected, note }
router.patch("/admin/credentials/:id", requireAdmin, async (req, res, next) => {
    try { res.json(await reviewCredential(Number(req.params.id), req.body?.status, req.body?.note)); } catch (error) { next(error); }
});

const COMPLIANCE_FIELDS = ["legalName", "dateOfBirth", "addressLine", "city", "postcode", "taxReference", "localAuthority", "registeredOn", "hygieneCertificate", "insurance", "bankAccountName", "bankSortCode", "bankAccountNumber"] as const;
const COMPLIANCE_LIMITS: Record<string, number> = { dateOfBirth: 10, registeredOn: 10, postcode: 12, taxReference: 40, bankSortCode: 10, bankAccountNumber: 12, bankAccountName: 150, localAuthority: 150, city: 120 };
const complianceValues = (body: Record<string, unknown>) => Object.fromEntries(COMPLIANCE_FIELDS.map((key) => [key, String(body[key] ?? "").trim().slice(0, COMPLIANCE_LIMITS[key] ?? 200) || null]));
const complianceComplete = (row?: typeof chefCompliance.$inferSelect | null) => !!row && COMPLIANCE_FIELDS.filter((k) => k !== "insurance").every((k) => !!row[k]);

// GET and PUT /chefs/me/compliance: a chef's private food safety, tax and payout details
router.get("/me/compliance", async (req, res) => {
    const chef = await getChefByUserId(getUserId(req));
    if (!chef) return res.status(404).json({ error: "Chef profile not found" });
    const [row] = await db.select().from(chefCompliance).where(eq(chefCompliance.chefId, chef.id)).limit(1);
    res.json({ ...(row ?? {}), complete: complianceComplete(row), verified: !!row?.verifiedAt });
});
router.put("/me/compliance", async (req, res) => {
    const chef = await getChefByUserId(getUserId(req));
    if (!chef) return res.status(404).json({ error: "Chef profile not found" });
    // Any change needs checking again.
    const values = { ...complianceValues(req.body), verifiedAt: null, updatedAt: new Date() };
    await db.insert(chefCompliance).values({ chefId: chef.id, ...values }).onDuplicateKeyUpdate({ set: values });
    const [row] = await db.select().from(chefCompliance).where(eq(chefCompliance.chefId, chef.id)).limit(1);
    if (complianceComplete(row)) await withTemplate("admin.chef_details_updated", { chefName: chef.displayName }, () => notifyAdmins("Chef details to check", `${chef.displayName} has updated their food safety and payout details.`, "/admin/chefs"));
    res.json({ ...row, complete: complianceComplete(row), verified: false });
});

// Staff views of the same record
router.get("/admin/:id/compliance", requireAdmin, async (req, res) => {
    const [row] = await db.select().from(chefCompliance).where(eq(chefCompliance.chefId, Number(req.params.id))).limit(1);
    res.json({ ...(row ?? {}), complete: complianceComplete(row), verified: !!row?.verifiedAt });
});
router.patch("/admin/:id/compliance", requireAdmin, async (req, res) => {
    const chefId = Number(req.params.id);
    const [row] = await db.select().from(chefCompliance).where(eq(chefCompliance.chefId, chefId)).limit(1);
    if (req.body.verified && !complianceComplete(row)) return res.status(400).json({ error: "These details aren't complete yet" });
    if (req.body.verified && !(await hasVerifiedHygiene(chefId))) return res.status(400).json({ error: "Verify the chef's food hygiene certificate first. It's a requirement before they can be verified." });
    if (row) await db.update(chefCompliance).set({ verifiedAt: req.body.verified ? new Date() : null }).where(eq(chefCompliance.chefId, chefId));
    if (req.body.verified) await withTemplate("chef.details_verified", {}, () => notifyChef(chefId, "Your details are verified", "Thanks. We've checked your food safety and payout details.", "/chef/dashboard?tab=compliance"));
    res.json({ verified: !!req.body.verified });
});

const csvCell = (value: unknown) => {
    const text = String(value ?? "");
    // A leading = + - or @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
};

// GET /chefs/admin/seller-report?year=2026: yearly seller figures to help with HMRC platform reporting
router.get("/admin/seller-report", requireAdmin, async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const inYear = (d: Date | string | null) => !!d && new Date(d).getFullYear() === year;
    const allChefs = await db.select().from(chefs);
    const details = await db.select().from(chefCompliance);
    const quotes = await db.select().from(eventQuotes).where(eq(eventQuotes.payoutStatus, "paid"));
    const weeks = await db.select({ chefId: mealPlans.chefId, total: mealPlanWeeks.total, date: mealPlanWeeks.deliveryDate }).from(mealPlanWeeks).innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id)).where(eq(mealPlanWeeks.status, "delivered"));
    const items = await db.select({ quantity: orderItems.quantity, price: orderItems.price, date: orders.createdAt, chefA: chefProducts.chefId, chefB: products.chefId }).from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .leftJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
        .leftJoin(products, eq(orderItems.productId, products.id))
        .where(eq(orders.status, "completed"));
    const header = ["Chef ID", "Display name", "Legal name", "Date of birth", "Address", "City", "Postcode", "Tax reference", "Bank account name", "Event payouts paid (GBP)", "Meal plan deliveries (GBP)", "Order items (GBP)", "Number of sales"];
    const rows = allChefs.map((chef) => {
        const d = details.find((x) => x.chefId === chef.id);
        const eventRows = quotes.filter((q) => q.chefId === chef.id && inYear(q.payoutPaidAt));
        const planRows = weeks.filter((w) => w.chefId === chef.id && inYear(w.date));
        const orderRows = items.filter((i) => (i.chefA ?? i.chefB) === chef.id && inYear(i.date));
        const sum = (list: number[]) => list.reduce((a, b) => a + b, 0).toFixed(2);
        return [chef.id, chef.displayName, d?.legalName, d?.dateOfBirth, d?.addressLine, d?.city, d?.postcode, d?.taxReference, d?.bankAccountName,
            sum(eventRows.map((q) => q.payoutAmount ?? 0)), sum(planRows.map((w) => w.total)), sum(orderRows.map((i) => i.price * i.quantity)), eventRows.length + planRows.length + orderRows.length];
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="myukchef-sellers-${year}.csv"`);
    res.send([header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n"));
});

// PATCH /chefs/admin/products/:id/status — admin moderates a product
router.patch("/admin/products/:id/status", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId || !(await isAdmin(userId))) return res.status(403).json({ error: "Forbidden" });
        const { id } = req.params;
        const { status } = req.body;
        if (!["pending", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });
        await db.update(chefProducts).set({ status }).where(eq(chefProducts.id, id));
        const [updated] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        if (updated && status !== "pending") {
            await withTemplate(status === "approved" ? "chef.dish_approved" : "chef.dish_rejected", { dishName: updated.name }, () => notifyChef(updated.chefId, status === "approved" ? "Your dish is live" : "Your dish wasn't approved", status === "approved" ? `${updated.name} is now on sale.` : `${updated.name} needs changes. Please check it and try again.`, "/chef/dashboard?tab=products"));
        }
        res.json(updated);
    } catch (error) {
        console.error("Moderate product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /chefs/admin/products — admin: all chef products
router.get("/admin/products", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId || !(await isAdmin(userId))) return res.status(403).json({ error: "Forbidden" });
        const rows = await db.select({ product: chefProducts, chef: chefs })
            .from(chefProducts)
            .innerJoin(chefs, eq(chefProducts.chefId, chefs.id))
            .orderBy(desc(chefProducts.createdAt));
        res.json(rows.map((r) => ({ ...r.product, chefName: r.chef.displayName, chefStatus: r.chef.status })));
    } catch (error) {
        console.error("Admin chef products error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// === ADMIN: FULL CHEF AND DISH MANAGEMENT ===

// POST /chefs/admin: create a chef and their login. With no password, they use "forgot password".
router.post("/admin", requireAdmin, async (req, res, next) => {
    try {
        const { name, displayName, password, bio, specialty, phone, location, yearsExperience, isAvailableForEvents, eventRate, avatar, coverImage, status, serviceRadiusMiles } = req.body;
        const email = normaliseEmail(String(req.body.email ?? ""));
        if (!displayName || !isValidEmail(email)) return res.status(400).json({ error: "A display name and valid email are required" });
        if (password && String(password).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (existing.length > 0) return res.status(400).json({ error: "Email already in use" });

        const hashed = await bcrypt.hash(password || crypto.randomBytes(24).toString("hex"), 10);
        const [{ id: userId }] = await db.insert(users).values({ name: name || displayName, email, password: hashed, role: "chef" }).$returningId();
        const finalStatus = ["pending", "approved", "suspended", "rejected"].includes(status) ? status : "approved";
        const [{ id }] = await db.insert(chefs).values({
            userId, displayName, bio: bio || null, specialty: specialty || null, phone: phone || null, location: location || null,
            ...(await locationFields(location)),
            serviceRadiusMiles: Number(serviceRadiusMiles) || 15,
            avatar: avatar || null, coverImage: coverImage || null,
            yearsExperience: yearsExperience ? Number(yearsExperience) : null,
            isAvailableForEvents: isAvailableForEvents ?? true,
            eventRate: eventRate ? Number(eventRate) : null,
            hygieneRating: hygieneValue(req.body.hygieneRating),
            status: finalStatus,
            approvedAt: finalStatus === "approved" ? new Date() : null,
        }).$returningId();
        const [created] = await db.select().from(chefs).where(eq(chefs.id, id)).limit(1);
        res.status(201).json(created);
    } catch (error) { next(error); }
});

// PUT /chefs/admin/:id
router.put("/admin/:id", requireAdmin, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [chef] = await db.select().from(chefs).where(eq(chefs.id, id)).limit(1);
        if (!chef) return res.status(404).json({ error: "Chef not found" });
        const b = req.body;
        await db.update(chefs).set({
            displayName: b.displayName ?? chef.displayName,
            bio: b.bio ?? chef.bio,
            ...storyAndVideo(b, chef),
            specialty: b.specialty ?? chef.specialty,
            avatar: b.avatar ?? chef.avatar,
            coverImage: b.coverImage ?? chef.coverImage,
            phone: b.phone ?? chef.phone,
            location: b.location ?? chef.location,
            ...(await locationFields(b.location, chef)),
            serviceRadiusMiles: b.serviceRadiusMiles !== undefined ? Number(b.serviceRadiusMiles) || chef.serviceRadiusMiles : chef.serviceRadiusMiles,
            yearsExperience: b.yearsExperience !== undefined ? Number(b.yearsExperience) || null : chef.yearsExperience,
            isAvailableForEvents: b.isAvailableForEvents !== undefined ? !!b.isAvailableForEvents : chef.isAvailableForEvents,
            eventRate: b.eventRate !== undefined ? Number(b.eventRate) || null : chef.eventRate,
            acceptsMealPlans: b.acceptsMealPlans !== undefined ? !!b.acceptsMealPlans : chef.acceptsMealPlans,
            hygieneRating: b.hygieneRating === undefined ? chef.hygieneRating : hygieneValue(b.hygieneRating),
        }).where(eq(chefs.id, id));
        const [updated] = await db.select().from(chefs).where(eq(chefs.id, id)).limit(1);
        res.json(updated);
    } catch (error) { next(error); }
});

// POST /chefs/admin/products: admin-created dishes go live straight away
router.post("/admin/products", requireAdmin, async (req, res, next) => {
    try {
        const chefId = Number(req.body.chefId);
        const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.id, chefId)).limit(1);
        if (!chef) return res.status(400).json({ error: "Please choose a chef" });
        const { name, description, price, category, image } = req.body;
        if (!name || !description || !price || !image || !category) return res.status(400).json({ error: "Name, description, price, category and image are required" });
        const id = slugId(chefId, name);
        await db.insert(chefProducts).values({ id, chefId, ...dishFields(req.body), status: "approved" });
        const [created] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        res.status(201).json(created);
    } catch (error) { next(error); }
});

// PUT /chefs/admin/products/:id: admin edits keep the dish's current review status
router.put("/admin/products/:id", requireAdmin, async (req, res, next) => {
    try {
        const id = String(req.params.id);
        const [dish] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        if (!dish) return res.status(404).json({ error: "Dish not found" });
        await db.update(chefProducts).set(dishFields(req.body)).where(eq(chefProducts.id, id));
        const [updated] = await db.select().from(chefProducts).where(eq(chefProducts.id, id)).limit(1);
        res.json(updated);
    } catch (error) { next(error); }
});

// DELETE /chefs/admin/products/:id
router.delete("/admin/products/:id", requireAdmin, async (req, res, next) => {
    try {
        await db.delete(chefProducts).where(eq(chefProducts.id, String(req.params.id)));
        res.json({ message: "Dish deleted" });
    } catch (error) { next(error); }
});

// Keep this last among the GET routes: ":chefId" would otherwise also match "me" and "admin".
// GET /chefs/:chefId/products — products for a specific chef (approved only, public)
router.get("/:chefId/products", async (req, res) => {
    try {
        const chefId = Number(req.params.chefId);
        const rows = await db.select().from(chefProducts).where(and(eq(chefProducts.chefId, chefId), eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true)));
        const menuDishes = await db.select().from(products).where(and(eq(products.chefId, chefId), eq(products.allergensDeclared, true)));
        res.json([...menuDishes, ...rows]);
    } catch (error) {
        console.error("Chef products error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /chefs/:id: public profile of an approved chef
router.get("/:id", async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(404).json({ error: "Chef not found" });
        const [chef] = await db.select().from(chefs).where(and(eq(chefs.id, id), eq(chefs.status, "approved"))).limit(1);
        if (!chef) return res.status(404).json({ error: "Chef not found" });
        const stats = await chefStats([id]);
        const selling = (await sellingChefs([id])).has(id);
        const userId = getUserId(req);
        const favourite = userId
            ? (await db.select({ id: favouriteChefs.chefId }).from(favouriteChefs).where(and(eq(favouriteChefs.userId, userId), eq(favouriteChefs.chefId, id))).limit(1)).length > 0
            : false;
        const credentials = (await publicCredentials([id])).get(id) ?? [];
        res.json({ ...publicChef(chef), ...stats.get(id), favourite, credentials, hygieneVerified: credentials.some((c) => c.type === "food_hygiene"), selling, ...availabilitySummary(chefTimes(chef)) });
    } catch (error) { next(error); }
});

export const chefsRouter = router;
