import { Request, Router } from "express";
import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db } from "../db";
import { chefReviews, chefs, mealPlanMessages, mealPlans, mealPlanWeeks, users } from "../db/schema";
import { getUserId, isAdmin, requireAdmin, requireAuth } from "../lib/auth";
import { refreshBookingPayment, startWeekCheckout } from "../lib/bookingPayments";
import { geocode, milesBetween, publicArea } from "../lib/geo";
import {
    addDays, addPoints, ALLERGENS, completeIfFinished, DELIVERY_WINDOWS, DIETARY, DURATIONS, eligibleDishes, getPlanConfig, isLocked,
    isValidDate, lockTime, MEAL_OPTIONS, menuFromSelection, notify, notifyChef, priceWeek, resumePlan, SERVING_OPTIONS, strings, today, weekFromRotation,
} from "../lib/mealPlans";
import { assertNoContactDetails, redactContactDetails } from "../lib/contactGuard";
import { badRequest } from "../lib/pricing";
import { rateLimit } from "../lib/rateLimit";
import { reviewSource } from "./chefReviews";

const router = Router();
type Plan = typeof mealPlans.$inferSelect;
type Week = typeof mealPlanWeeks.$inferSelect;
type Role = "customer" | "chef" | "admin";

const notFound = () => Object.assign(new Error("Meal plan not found"), { status: 404 });
const forbidden = (message: string) => Object.assign(new Error(message), { status: 403 });
const OPEN = ["requested", "active", "paused"];
const AFTER_ACCEPTANCE = ["active", "paused", "completed"];
const countsTowardsCost = (week: Week) => !["skipped", "paused", "missed", "cancelled"].includes(week.status);

async function chefForUser(userId: number) {
    const [chef] = await db.select().from(chefs).where(eq(chefs.userId, userId)).limit(1);
    return chef ?? null;
}

/** Only the customer, their chef and admins can see a plan. Anyone else gets a plain 404. */
async function loadPlan(req: Request): Promise<{ plan: Plan; role: Role }> {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw notFound();
    const [plan] = await db.select().from(mealPlans).where(eq(mealPlans.id, id)).limit(1);
    if (!plan) throw notFound();
    const userId = getUserId(req);
    if (plan.userId === userId) return { plan, role: "customer" };
    if (await isAdmin(userId)) return { plan, role: "admin" };
    const chef = await chefForUser(userId);
    if (chef && chef.id === plan.chefId) return { plan, role: "chef" };
    throw notFound();
}

const onlyCustomer = (role: Role) => {
    if (role === "chef") throw forbidden("Only the customer can change this");
};

async function loadWeek(plan: Plan, weekId: unknown) {
    const [week] = await db.select().from(mealPlanWeeks).where(and(eq(mealPlanWeeks.id, Number(weekId)), eq(mealPlanWeeks.planId, plan.id))).limit(1);
    if (!week) throw Object.assign(new Error("Delivery not found"), { status: 404 });
    return week;
}

/** Customers can only change a delivery that hasn't reached its cut-off. */
async function assertChangeable(plan: Plan, week: Week, statuses = ["scheduled"]) {
    if (!["active", "requested", "paused"].includes(plan.status)) throw badRequest("This plan can no longer be changed");
    if (!statuses.includes(week.status)) throw badRequest("This delivery can no longer be changed");
    const { cutoffHours } = await getPlanConfig();
    if (isLocked(week.deliveryDate, cutoffHours)) throw badRequest("The cut-off for this delivery has passed, so your chef is already preparing it");
}

/** A chef gets the delivery address after accepting. Phone numbers stay between the customer and MYUKCHEF. */
function planForViewer(plan: Plan, role: Role) {
    const { adminNotes, ...rest } = plan;
    if (role !== "chef") return { ...rest, ...(role === "admin" ? { adminNotes } : {}) };
    const address = plan.deliveryAddress;
    return {
        ...rest,
        requests: redactContactDetails(plan.requests),
        deliveryAddress: AFTER_ACCEPTANCE.includes(plan.status)
            ? { street: address.street, city: address.city, postcode: address.postcode, phone: "" }
            : { street: "", city: "", postcode: publicArea(address.postcode) ?? "", phone: "" },
    };
}

const summarise = (weeks: Week[]) => {
    const live = weeks.filter(countsTowardsCost);
    const date = today();
    return {
        weeksTotal: weeks.length,
        weeksDelivered: weeks.filter((w) => w.status === "delivered").length,
        weeksSkipped: weeks.filter((w) => w.status === "skipped").length,
        estimatedTotal: Math.round(live.reduce((sum, w) => sum + w.total, 0) * 100) / 100,
        nextDelivery: live.find((w) => w.status !== "delivered" && w.deliveryDate >= date) ?? null,
    };
};

async function withSummaries<T extends Plan>(plans: T[]) {
    if (plans.length === 0) return new Map<number, ReturnType<typeof summarise>>();
    const weeks = await db.select().from(mealPlanWeeks).where(inArray(mealPlanWeeks.planId, plans.map((p) => p.id))).orderBy(asc(mealPlanWeeks.weekNumber));
    return new Map(plans.map((p) => [p.id, summarise(weeks.filter((w) => w.planId === p.id))]));
}

/** Validates a request and creates the plan with all of its weeks. Shared by "new plan" and "renew". */
async function createPlan(userId: number, input: Record<string, any>, renewedFrom?: Plan) {
    const config = await getPlanConfig();
    const durationMonths = Number(input.durationMonths);
    const mealsPerWeek = Number(input.mealsPerWeek);
    const servings = Number(input.servings);
    if (!DURATIONS[durationMonths]) throw badRequest("Please choose a 1, 3 or 6 month plan");
    if (!MEAL_OPTIONS.includes(mealsPerWeek)) throw badRequest("Please choose how many meals you'd like each week");
    if (!SERVING_OPTIONS.includes(servings)) throw badRequest("Please choose how many people you're feeding");
    const deliveryWindow = DELIVERY_WINDOWS.includes(input.deliveryWindow) ? input.deliveryWindow : "afternoon";

    const [chef] = await db.select().from(chefs).where(and(eq(chefs.id, Number(input.chefId)), eq(chefs.status, "approved"))).limit(1);
    if (!chef) throw badRequest("Please choose a chef");
    if (!chef.acceptsMealPlans) throw badRequest("This chef isn't taking new meal plans right now");
    if (chef.userId === userId) throw badRequest("You can't start a meal plan with yourself");
    const [account] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (account?.role !== "customer") throw badRequest("Please sign in with a customer account to start a meal plan");

    const earliest = addDays(today(), config.leadDays);
    if (!isValidDate(input.startDate) || input.startDate < earliest) throw badRequest(`Please choose a start date on or after ${earliest}`);
    if (!renewedFrom && input.startDate > addDays(today(), 90)) throw badRequest("Please choose a start date in the next 3 months");

    const open = await db.select({ id: mealPlans.id }).from(mealPlans)
        .where(and(eq(mealPlans.userId, userId), eq(mealPlans.chefId, chef.id), inArray(mealPlans.status, OPEN), ...(renewedFrom ? [ne(mealPlans.id, renewedFrom.id)] : [])))
        .limit(1);
    if (open.length > 0) throw Object.assign(new Error("You already have an open plan with this chef"), { status: 409 });

    const address = {
        street: String(input.address?.street ?? "").trim().slice(0, 200),
        city: String(input.address?.city ?? "").trim().slice(0, 100),
        postcode: String(input.address?.postcode ?? "").trim().toUpperCase().slice(0, 12),
        phone: String(input.address?.phone ?? "").trim().slice(0, 30),
    };
    if (!address.street || !address.city || !address.postcode || !address.phone) throw badRequest("Please add your full delivery address and a phone number");

    // If either location can't be found, the chef decides when they review the request.
    if (chef.latitude !== null && chef.longitude !== null) {
        const point = await geocode(address.postcode).catch(() => null);
        if (point && milesBetween(point, { lat: chef.latitude, lng: chef.longitude }) > chef.serviceRadiusMiles) {
            throw badRequest(`${chef.displayName} doesn't deliver to ${address.postcode} yet. Try a chef closer to you.`);
        }
    }

    assertNoContactDetails(input.requests);
    const dietary = strings(input.dietary, DIETARY);
    const avoidAllergens = strings(input.avoidAllergens, ALLERGENS);
    // Dietary and allergy details can reveal health or beliefs, so they need clear agreement.
    if ((dietary.length > 0 || avoidAllergens.length > 0) && input.healthConsent !== true) throw badRequest("Please agree to us using your dietary and allergy details");
    const available = await eligibleDishes(chef.id, dietary, avoidAllergens);
    const chosenIds = Array.isArray(input.rotation) ? [...new Set(input.rotation.map(String))] : [];
    const rotation = chosenIds.map((id) => available.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => !!d);
    if (rotation.length === 0 || rotation.length !== chosenIds.length) throw badRequest("Please choose dishes that suit your dietary needs and are available from this chef");

    const discountPercent = config.discounts[durationMonths];
    const weekCount = DURATIONS[durationMonths];
    const planId = await db.transaction(async (tx) => {
        const [{ id }] = await tx.insert(mealPlans).values({
            userId, chefId: chef.id, durationMonths, mealsPerWeek, servings, deliveryWindow,
            startDate: input.startDate,
            endDate: addDays(input.startDate, (weekCount - 1) * 7),
            discountPercent, deliveryFee: config.deliveryFee, dietary, avoidAllergens,
            healthConsentAt: dietary.length > 0 || avoidAllergens.length > 0 ? new Date() : null,
            requests: String(input.requests ?? "").trim().slice(0, 1000) || null,
            rotation: rotation.map((d) => d.id),
            deliveryAddress: address,
            renewedFromId: renewedFrom?.id ?? null,
        }).$returningId();
        await tx.insert(mealPlanWeeks).values(Array.from({ length: weekCount }, (_, index) => {
            const items = weekFromRotation(rotation, mealsPerWeek, index);
            return { planId: id, weekNumber: index + 1, deliveryDate: addDays(input.startDate, index * 7), items, ...priceWeek(items, servings, discountPercent, config.deliveryFee) };
        }));
        return id;
    });

    await notifyChef(chef.id, "New meal plan request", `A customer would like a ${durationMonths} month plan: ${mealsPerWeek} meals a week for ${servings}. Please reply before ${input.startDate}.`);
    await notify(userId, "We've sent your request", `${chef.displayName} will confirm your ${durationMonths} month plan. Nothing is charged yet.`, `/my-plans/${planId}`);
    const [plan] = await db.select().from(mealPlans).where(eq(mealPlans.id, planId)).limit(1);
    return plan;
}

// === PUBLIC ===

// GET /meal-plans/config: what the plan builder needs to show prices
router.get("/config", async (_req, res) => {
    const config = await getPlanConfig();
    res.json({
        durations: [1, 3, 6].map((months) => ({ months, weeks: DURATIONS[months], discountPercent: config.discounts[months] })),
        cutoffHours: config.cutoffHours,
        leadDays: config.leadDays,
        deliveryFee: config.deliveryFee,
        mealOptions: MEAL_OPTIONS,
        servingOptions: SERVING_OPTIONS,
    });
});

// GET /meal-plans/chefs/:chefId/dishes?dietary=vegan&avoid=nuts,dairy
router.get("/chefs/:chefId/dishes", async (req, res) => {
    const list = (value: unknown) => String(value ?? "").split(",").filter(Boolean);
    const dishes = await eligibleDishes(Number(req.params.chefId), strings(list(req.query.dietary), DIETARY), strings(list(req.query.avoid), ALLERGENS));
    res.json(dishes);
});

// === ADMIN (before "/:id" so these paths aren't read as a plan id) ===

router.get("/admin/all", requireAdmin, async (_req, res) => {
    const rows = await db.select({ plan: mealPlans, chefName: chefs.displayName, customerName: users.name, customerEmail: users.email })
        .from(mealPlans)
        .innerJoin(chefs, eq(mealPlans.chefId, chefs.id))
        .innerJoin(users, eq(mealPlans.userId, users.id))
        .orderBy(desc(mealPlans.createdAt));
    const summaries = await withSummaries(rows.map((r) => r.plan));
    res.json(rows.map((r) => ({ ...r.plan, chefName: r.chefName, customerName: r.customerName, customerEmail: r.customerEmail, ...summaries.get(r.plan.id) })));
});

router.put("/admin/:id", requireAdmin, async (req, res) => {
    const { plan } = await loadPlan(req);
    const statuses = ["requested", "active", "paused", "completed", "cancelled", "declined", "expired"];
    if (req.body.status !== undefined && !statuses.includes(req.body.status)) throw badRequest("Invalid status");
    const status = req.body.status ?? plan.status;
    await db.update(mealPlans).set({
        status,
        adminNotes: req.body.adminNotes ?? plan.adminNotes,
        chefNote: req.body.chefNote ?? plan.chefNote,
    }).where(eq(mealPlans.id, plan.id));
    // Closing a plan also closes its future deliveries, so a chef never cooks for a cancelled plan.
    if (["cancelled", "declined", "expired"].includes(status) && status !== plan.status) {
        await db.update(mealPlanWeeks).set({ status: "cancelled" }).where(and(eq(mealPlanWeeks.planId, plan.id), inArray(mealPlanWeeks.status, ["scheduled", "paused"])));
    }
    if (status !== plan.status) {
        await notify(plan.userId, "Your meal plan was updated", `Your plan's status is now: ${status}.`, `/my-plans/${plan.id}`);
        await notifyChef(plan.chefId, "A meal plan was updated", `MYUKCHEF changed a plan's status to: ${status}. Check your cook sheet.`);
    }
    const [updated] = await db.select().from(mealPlans).where(eq(mealPlans.id, plan.id)).limit(1);
    res.json(updated);
});

router.delete("/admin/:id", requireAdmin, async (req, res) => {
    const { plan } = await loadPlan(req);
    const paid = await db.select({ id: mealPlanWeeks.id }).from(mealPlanWeeks).where(and(eq(mealPlanWeeks.planId, plan.id), eq(mealPlanWeeks.isPaid, true))).limit(1);
    if (paid.length > 0) throw badRequest("This plan has paid deliveries, so it must stay on record. Cancel it instead.");
    await db.delete(mealPlans).where(eq(mealPlans.id, plan.id));
    res.json({ message: "Meal plan deleted" });
});

// === CHEF ===

// GET /meal-plans/chef: requests and plans for the signed-in chef
router.get("/chef", requireAuth, async (req, res) => {
    const chef = await chefForUser(getUserId(req));
    if (!chef) throw forbidden("Chef account required");
    const rows = await db.select({ plan: mealPlans, customerName: users.name }).from(mealPlans)
        .innerJoin(users, eq(mealPlans.userId, users.id))
        .where(eq(mealPlans.chefId, chef.id))
        .orderBy(desc(mealPlans.createdAt));
    const summaries = await withSummaries(rows.map((r) => r.plan));
    res.json(rows.map((r) => ({ ...planForViewer(r.plan, "chef"), customerName: r.customerName, ...summaries.get(r.plan.id) })));
});

// GET /meal-plans/chef/cook-sheet: what to cook and deliver over the next fortnight
router.get("/chef/cook-sheet", requireAuth, async (req, res) => {
    const chef = await chefForUser(getUserId(req));
    if (!chef) throw forbidden("Chef account required");
    const rows = await db.select({ week: mealPlanWeeks, plan: mealPlans, customerName: users.name }).from(mealPlanWeeks)
        .innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id))
        .innerJoin(users, eq(mealPlans.userId, users.id))
        .where(and(
            eq(mealPlans.chefId, chef.id),
            inArray(mealPlans.status, ["active", "paused"]),
            inArray(mealPlanWeeks.status, ["scheduled", "preparing", "out_for_delivery"]),
            gte(mealPlanWeeks.deliveryDate, addDays(today(), -7)),
            lte(mealPlanWeeks.deliveryDate, addDays(today(), 14)),
        ))
        .orderBy(asc(mealPlanWeeks.deliveryDate));
    const { cutoffHours } = await getPlanConfig();
    res.json(rows.map(({ week, plan, customerName }) => ({
        ...week,
        locked: isLocked(week.deliveryDate, cutoffHours),
        customerName,
        servings: plan.servings,
        deliveryWindow: plan.deliveryWindow,
        deliveryAddress: { street: plan.deliveryAddress.street, city: plan.deliveryAddress.city, postcode: plan.deliveryAddress.postcode },
        dietary: plan.dietary,
        avoidAllergens: plan.avoidAllergens,
        requests: redactContactDetails(plan.requests),
    })));
});

// === CUSTOMER ===

// POST /meal-plans: request a plan
router.post("/", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    res.status(201).json(await createPlan(getUserId(req), req.body));
});

// GET /meal-plans/mine
router.get("/mine", requireAuth, async (req, res) => {
    const rows = await db.select({ plan: mealPlans, chef: { id: chefs.id, displayName: chefs.displayName, avatar: chefs.avatar, specialty: chefs.specialty } })
        .from(mealPlans)
        .innerJoin(chefs, eq(mealPlans.chefId, chefs.id))
        .where(eq(mealPlans.userId, getUserId(req)))
        .orderBy(desc(mealPlans.createdAt));
    const summaries = await withSummaries(rows.map((r) => r.plan));
    res.json(rows.map((r) => ({ ...planForViewer(r.plan, "customer"), chef: r.chef, ...summaries.get(r.plan.id) })));
});

// GET /meal-plans/:id
router.get("/:id", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    const { cutoffHours, leadDays } = await getPlanConfig();
    const [chef] = await db.select({ id: chefs.id, displayName: chefs.displayName, avatar: chefs.avatar, specialty: chefs.specialty, acceptsMealPlans: chefs.acceptsMealPlans })
        .from(chefs).where(eq(chefs.id, plan.chefId)).limit(1);
    const [customer] = await db.select({ name: users.name }).from(users).where(eq(users.id, plan.userId)).limit(1);
    const weeks = await db.select().from(mealPlanWeeks).where(eq(mealPlanWeeks.planId, plan.id)).orderBy(asc(mealPlanWeeks.weekNumber));
    const messages = await db.select().from(mealPlanMessages).where(eq(mealPlanMessages.planId, plan.id)).orderBy(asc(mealPlanMessages.createdAt));
    const [review] = role === "customer"
        ? await db.select().from(chefReviews).where(and(eq(chefReviews.userId, plan.userId), eq(chefReviews.chefId, plan.chefId))).limit(1)
        : [];
    res.json({
        ...planForViewer(plan, role),
        viewerRole: role,
        chef,
        customerName: customer?.name ?? "Customer",
        cutoffHours,
        leadDays,
        ...summarise(weeks),
        weeks: weeks.map((w) => ({ ...w, locked: isLocked(w.deliveryDate, cutoffHours), lockAt: lockTime(w.deliveryDate, cutoffHours).toISOString() })),
        messages,
        canReview: role === "customer" ? !!(await reviewSource(plan.userId, plan.chefId)) : false,
        myReview: review ?? null,
    });
});

// PATCH /meal-plans/:id/respond: the chef accepts or declines a request
router.patch("/:id/respond", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    if (role === "customer") throw forbidden("Only the chef can reply to this request");
    if (plan.status !== "requested") throw badRequest("This request has already been answered");
    const note = String(req.body.note ?? "").trim().slice(0, 500) || null;
    if (role === "chef") assertNoContactDetails(note);
    if (req.body.action === "accept") {
        if (plan.startDate < today()) throw badRequest("The start date has already passed");
        await db.update(mealPlans).set({ status: "active", chefNote: note }).where(eq(mealPlans.id, plan.id));
        await notify(plan.userId, "Your meal plan is confirmed", note || "Your chef has accepted your plan. You can now change, skip or pause any week before its cut-off.", `/my-plans/${plan.id}`);
    } else if (req.body.action === "decline") {
        await db.update(mealPlans).set({ status: "declined", chefNote: note }).where(eq(mealPlans.id, plan.id));
        await db.update(mealPlanWeeks).set({ status: "cancelled" }).where(eq(mealPlanWeeks.planId, plan.id));
        await notify(plan.userId, "Your chef can't take this plan", note || "They aren't able to take this plan right now. Nothing is owed, and you can try another chef.", `/my-plans/${plan.id}`);
    } else {
        throw badRequest("Please accept or decline the request");
    }
    const [updated] = await db.select().from(mealPlans).where(eq(mealPlans.id, plan.id)).limit(1);
    res.json(planForViewer(updated, role));
});

// PUT /meal-plans/:id/weeks/:weekId/menu: choose this week's dishes
router.put("/:id/weeks/:weekId/menu", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    const week = await loadWeek(plan, req.params.weekId);
    await assertChangeable(plan, week);
    assertNoContactDetails(req.body.note);
    const items = await menuFromSelection(plan, req.body.items, week.items ?? []);
    await db.update(mealPlanWeeks).set({
        items,
        note: req.body.note !== undefined ? String(req.body.note).trim().slice(0, 300) || null : week.note,
        ...priceWeek(items, plan.servings, plan.discountPercent, plan.deliveryFee),
    }).where(eq(mealPlanWeeks.id, week.id));
    const [updated] = await db.select().from(mealPlanWeeks).where(eq(mealPlanWeeks.id, week.id)).limit(1);
    res.json(updated);
});

// PUT /meal-plans/:id/rotation: use a new set of dishes for every week that can still change
router.put("/:id/rotation", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    if (!OPEN.includes(plan.status)) throw badRequest("This plan can no longer be changed");
    const available = await eligibleDishes(plan.chefId, plan.dietary ?? [], plan.avoidAllergens ?? []);
    const ids = Array.isArray(req.body.rotation) ? [...new Set(req.body.rotation.map(String))] : [];
    const rotation = ids.map((id) => available.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => !!d);
    if (rotation.length === 0 || rotation.length !== ids.length) throw badRequest("Please choose dishes that are available and suit this plan");

    const { cutoffHours } = await getPlanConfig();
    const weeks = await db.select().from(mealPlanWeeks).where(and(eq(mealPlanWeeks.planId, plan.id), eq(mealPlanWeeks.status, "scheduled")));
    const changing = weeks.filter((w) => !isLocked(w.deliveryDate, cutoffHours));
    for (const [index, week] of changing.entries()) {
        const items = weekFromRotation(rotation, plan.mealsPerWeek, index);
        await db.update(mealPlanWeeks).set({ items, ...priceWeek(items, plan.servings, plan.discountPercent, plan.deliveryFee) }).where(eq(mealPlanWeeks.id, week.id));
    }
    await db.update(mealPlans).set({ rotation: ids as string[] }).where(eq(mealPlans.id, plan.id));
    res.json({ weeksChanged: changing.length });
});

// POST /meal-plans/:id/weeks/:weekId/skip and /unskip
router.post("/:id/weeks/:weekId/skip", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    const week = await loadWeek(plan, req.params.weekId);
    await assertChangeable(plan, week);
    await db.update(mealPlanWeeks).set({ status: "skipped" }).where(eq(mealPlanWeeks.id, week.id));
    await notifyChef(plan.chefId, "A delivery was skipped", `A customer skipped their week ${week.weekNumber} delivery on ${week.deliveryDate}.`);
    await completeIfFinished(plan.id);
    res.json({ status: "skipped" });
});
router.post("/:id/weeks/:weekId/unskip", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    const week = await loadWeek(plan, req.params.weekId);
    await assertChangeable(plan, week, ["skipped"]);
    await db.update(mealPlanWeeks).set({ status: "scheduled" }).where(eq(mealPlanWeeks.id, week.id));
    res.json({ status: "scheduled" });
});

// POST /meal-plans/:id/pause { until }
router.post("/:id/pause", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    if (plan.status !== "active") throw badRequest("Only an active plan can be paused");
    const until = req.body.until;
    if (!isValidDate(until) || until <= today()) throw badRequest("Please choose a date in the future to restart");
    if (until > addDays(today(), 84)) throw badRequest("You can pause for up to 12 weeks at a time");
    const { cutoffHours } = await getPlanConfig();
    const weeks = await db.select().from(mealPlanWeeks).where(and(eq(mealPlanWeeks.planId, plan.id), eq(mealPlanWeeks.status, "scheduled"), lte(mealPlanWeeks.deliveryDate, addDays(until, -1))));
    const pausing = weeks.filter((w) => !isLocked(w.deliveryDate, cutoffHours));
    if (pausing.length > 0) await db.update(mealPlanWeeks).set({ status: "paused" }).where(inArray(mealPlanWeeks.id, pausing.map((w) => w.id)));
    await db.update(mealPlans).set({ status: "paused", pausedUntil: until }).where(eq(mealPlans.id, plan.id));
    await notifyChef(plan.chefId, "A meal plan was paused", `A customer paused their plan until ${until}. ${pausing.length} deliveries are on hold.`);
    res.json({ status: "paused", pausedUntil: until, weeksPaused: pausing.length, stillComing: weeks.length - pausing.length });
});

// POST /meal-plans/:id/resume
router.post("/:id/resume", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    if (plan.status !== "paused") throw badRequest("This plan isn't paused");
    const { cutoffHours } = await getPlanConfig();
    await resumePlan(plan, cutoffHours);
    await notifyChef(plan.chefId, "A meal plan has restarted", "A customer has restarted their plan early. Check your cook sheet.");
    res.json({ status: "active" });
});

// POST /meal-plans/:id/cancel { reason }: deliveries past their cut-off still go ahead
router.post("/:id/cancel", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    onlyCustomer(role);
    if (!OPEN.includes(plan.status)) throw badRequest("This plan has already ended");
    const { cutoffHours } = await getPlanConfig();
    const weeks = await db.select().from(mealPlanWeeks).where(and(eq(mealPlanWeeks.planId, plan.id), inArray(mealPlanWeeks.status, ["scheduled", "paused", "skipped"])));
    const wasRequest = plan.status === "requested";
    const locked = weeks.filter((w) => !wasRequest && w.status === "scheduled" && isLocked(w.deliveryDate, cutoffHours));
    const closing = weeks.filter((w) => !locked.includes(w));
    if (closing.length > 0) await db.update(mealPlanWeeks).set({ status: "cancelled" }).where(inArray(mealPlanWeeks.id, closing.map((w) => w.id)));
    await db.update(mealPlans).set({ status: "cancelled", pausedUntil: null, cancelReason: String(req.body.reason ?? "").trim().slice(0, 300) || null }).where(eq(mealPlans.id, plan.id));
    await notifyChef(plan.chefId, "A meal plan was cancelled", locked.length > 0 ? `A customer cancelled their plan. ${locked.length} delivery past its cut-off still goes ahead.` : "A customer cancelled their plan. No further deliveries are due.");
    res.json({ status: "cancelled", stillComing: locked.map((w) => w.deliveryDate) });
});

// POST /meal-plans/:id/renew { durationMonths, startDate? }: plans only ever renew when the customer asks
router.post("/:id/renew", requireAuth, rateLimit(10, 60_000), async (req, res) => {
    const { plan, role } = await loadPlan(req);
    if (role !== "customer") throw forbidden("Only the customer can renew this plan");
    if (["requested", "declined", "expired"].includes(plan.status)) throw badRequest("Only a plan that has started can be renewed");
    const { leadDays } = await getPlanConfig();
    const next = await db.select({ id: mealPlans.id }).from(mealPlans).where(and(eq(mealPlans.renewedFromId, plan.id), inArray(mealPlans.status, OPEN))).limit(1);
    if (next.length > 0) throw Object.assign(new Error("You've already renewed this plan"), { status: 409 });

    // Keep the same delivery weekday, starting after this plan's last delivery.
    let startDate = addDays(plan.endDate, 7);
    while (startDate < addDays(today(), leadDays)) startDate = addDays(startDate, 7);
    const renewed = await createPlan(plan.userId, {
        chefId: plan.chefId,
        durationMonths: req.body.durationMonths ?? plan.durationMonths,
        mealsPerWeek: plan.mealsPerWeek,
        servings: plan.servings,
        deliveryWindow: plan.deliveryWindow,
        startDate,
        dietary: plan.dietary,
        avoidAllergens: plan.avoidAllergens,
        requests: plan.requests,
        rotation: plan.rotation,
        healthConsent: !!plan.healthConsentAt,
        address: plan.deliveryAddress,
    }, plan);
    res.status(201).json(renewed);
});

// PATCH /meal-plans/:id/weeks/:weekId/status: the chef moves a delivery along, admins can correct it
router.patch("/:id/weeks/:weekId/status", requireAuth, async (req, res) => {
    const { plan, role } = await loadPlan(req);
    if (role === "customer") throw forbidden("Only the chef can update a delivery");
    const week = await loadWeek(plan, req.params.weekId);
    const status = String(req.body.status);
    const allowed = role === "admin"
        ? ["scheduled", "skipped", "preparing", "out_for_delivery", "delivered", "missed", "cancelled"]
        : ["preparing", "out_for_delivery", "delivered", "missed"];
    if (!allowed.includes(status)) throw badRequest("Invalid delivery status");
    if (role === "chef" && !["scheduled", "preparing", "out_for_delivery"].includes(week.status)) throw badRequest("This delivery can no longer be updated");
    if (role === "chef" && !["active", "paused"].includes(plan.status)) throw badRequest("This plan isn't active");
    if (status === "delivered" && week.deliveryDate > today()) throw badRequest("A delivery can't be marked as delivered before its date");

    await db.update(mealPlanWeeks).set({ status }).where(eq(mealPlanWeeks.id, week.id));
    if (status === "delivered" && week.status !== "delivered") {
        await addPoints(plan.userId, week.total);
        await notify(plan.userId, `Week ${week.weekNumber} has arrived`, "Enjoy! How was it? Rating your chef helps other customers choose.", `/my-plans/${plan.id}`);
    } else if (status === "out_for_delivery") {
        await notify(plan.userId, `Week ${week.weekNumber} is on its way`, "Your meals have left the kitchen.", `/my-plans/${plan.id}`);
    } else if (status === "missed") {
        await notify(plan.userId, `Week ${week.weekNumber} wasn't delivered`, "Sorry about that. You won't be charged for this delivery. Message your chef if you need anything.", `/my-plans/${plan.id}`);
    }
    await completeIfFinished(plan.id);
    res.json({ status });
});

// POST /meal-plans/:id/weeks/:weekId/pay: Stripe's payment page for one delivery
router.post("/:id/weeks/:weekId/pay", requireAuth, async (req, res) => {
    res.json(await startWeekCheckout(Number(req.params.id), Number(req.params.weekId), getUserId(req)));
});

// POST /meal-plans/:id/weeks/:weekId/payment-status: checks with Stripe when the customer comes back
router.post("/:id/weeks/:weekId/payment-status", requireAuth, async (req, res) => {
    res.json(await refreshBookingPayment("plan_week", Number(req.params.weekId), getUserId(req)));
});

// PATCH /meal-plans/:id/weeks/:weekId/payment: admins record that a delivery has been paid
router.patch("/:id/weeks/:weekId/payment", requireAdmin, async (req, res) => {
    const { plan } = await loadPlan(req);
    const week = await loadWeek(plan, req.params.weekId);
    await db.update(mealPlanWeeks).set({ isPaid: !!req.body.isPaid }).where(eq(mealPlanWeeks.id, week.id));
    res.json({ isPaid: !!req.body.isPaid });
});

// POST /meal-plans/:id/messages
router.post("/:id/messages", requireAuth, rateLimit(30, 60_000), async (req, res) => {
    const { plan, role } = await loadPlan(req);
    const body = String(req.body.body ?? "").trim().slice(0, 1000);
    if (!body) throw badRequest("Please write a message");
    if (role !== "admin") assertNoContactDetails(body);
    const senderId = getUserId(req);
    const [{ id }] = await db.insert(mealPlanMessages).values({ planId: plan.id, senderId, senderRole: role, body }).$returningId();
    const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body;
    if (role !== "customer") await notify(plan.userId, "New message about your meal plan", preview, `/my-plans/${plan.id}`, "message");
    if (role !== "chef") await notifyChef(plan.chefId, "New message about a meal plan", preview, `/chef/dashboard?tab=plans&plan=${plan.id}`, "message");
    const [message] = await db.select().from(mealPlanMessages).where(eq(mealPlanMessages.id, id)).limit(1);
    res.status(201).json(message);
});

export const mealPlansRouter = router;
