import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { withTemplate } from "./templates";
import { db } from "../db";
import { chefProducts, chefs, mealPlans, mealPlanWeeks, PlanDish, siteSettings, users } from "../db/schema";
import { notify } from "./notify";
import { ALLERGENS as ALL_ALLERGENS } from "./allergens";
import { badRequest, getOrderSettings } from "./pricing";

/** The old fixed lengths, in weekly deliveries. Still accepted from older app versions. */
export const DURATIONS: Record<number, number> = { 1: 4, 3: 13, 6: 26 };
/** Plans can be any length from one week to six months. */
export const MIN_WEEKS = 1;
export const MAX_WEEKS = 26;
/** Quick choices shown in the plan builder. Any length in between can be picked too. */
export const PRESET_WEEKS = [1, 2, 4, 8, 13, 26];

/** "1 week", "6 weeks", "3 months"; or as a describing word ("a 6 week plan"). Whole-month lengths read as months. */
export function planLength(weeks: number, describing = false) {
    const months = weeks === 4 ? 1 : weeks === 8 ? 2 : weeks === 13 ? 3 : weeks === 26 ? 6 : 0;
    if (months) return `${months} month${months === 1 || describing ? "" : "s"}`;
    return `${weeks} week${weeks === 1 || describing ? "" : "s"}`;
}
/** The length in months, rounded, for older app versions that only understand months. */
export const monthsFor = (weeks: number) => Math.max(1, Math.round(weeks / 4.345));
/** How many weekly deliveries a plan has. Plans made before flexible lengths only have months. */
export const planWeeks = (plan: { durationWeeks: number | null; durationMonths: number }) => plan.durationWeeks ?? DURATIONS[plan.durationMonths] ?? plan.durationMonths * 4;
/** Longer plans save more: from 4 weeks, 13 weeks (3 months) and 26 weeks (6 months). */
export function discountFor(weeks: number, discounts: Record<number, number>) {
    if (weeks >= 26) return discounts[6] ?? 0;
    if (weeks >= 13) return discounts[3] ?? 0;
    if (weeks >= 4) return discounts[1] ?? 0;
    return 0;
}
export const MEAL_OPTIONS = [3, 5, 7, 10, 14];
export const SERVING_OPTIONS = [1, 2, 3, 4, 6];
export const DELIVERY_WINDOWS = ["morning", "afternoon", "evening"];
export const DIETARY = ["vegetarian", "vegan", "gluten_free", "halal"];
export const ALLERGENS = ALL_ALLERGENS;

const PLAN_DEFAULTS = { discount1: 0, discount3: 5, discount6: 10, cutoffHours: 48, leadDays: 3 };
const roundMoney = (n: number) => Math.round(n * 100) / 100;
const percent = (value: unknown, fallback: number) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 50) : fallback;
};

export async function getPlanConfig() {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, "meal_plan_config")).limit(1);
    const c = (row?.value ?? {}) as Record<string, unknown>;
    const { delivery } = await getOrderSettings();
    const fee = Number(c.deliveryFee ?? delivery.fee);
    return {
        discounts: { 1: percent(c.discount1, PLAN_DEFAULTS.discount1), 3: percent(c.discount3, PLAN_DEFAULTS.discount3), 6: percent(c.discount6, PLAN_DEFAULTS.discount6) } as Record<number, number>,
        cutoffHours: Math.max(Number(c.cutoffHours ?? PLAN_DEFAULTS.cutoffHours) || 0, 0),
        leadDays: Math.max(Number(c.leadDays ?? PLAN_DEFAULTS.leadDays) || 0, 0),
        deliveryFee: Number.isFinite(fee) ? Math.max(fee, 0) : delivery.fee,
    };
}

// === Dates: plans store plain UK calendar dates, so no time zone can shift a delivery day ===
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (isoDate: string, days: number) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};
export const isValidDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export const lockTime = (deliveryDate: string, cutoffHours: number) =>
    new Date(new Date(`${deliveryDate}T00:00:00Z`).getTime() - cutoffHours * 3_600_000);
export const isLocked = (deliveryDate: string, cutoffHours: number) => Date.now() >= lockTime(deliveryDate, cutoffHours).getTime();

// === Dishes ===
type Dish = typeof chefProducts.$inferSelect;

export const matchesNeeds = (dish: Dish, dietary: string[], avoid: string[]) => {
    for (const need of dietary) {
        if (need === "vegan" && !dish.isVegan) return false;
        if (need === "vegetarian" && !dish.isVegetarian && !dish.isVegan) return false;
        if (need === "gluten_free" && !dish.isGlutenFree) return false;
        if (need === "halal" && !dish.isHalal) return false;
    }
    // Plans only ever offer dishes whose chef has confirmed the full allergen list.
    return !!dish.allergensDeclared && !(dish.allergens ?? []).some((a) => avoid.includes(a));
};

/** A plan's meals come from the chef's approved mains and meal deals. */
export async function eligibleDishes(chefId: number, dietary: string[], avoid: string[]) {
    const rows = await db.select().from(chefProducts).where(and(
        eq(chefProducts.chefId, chefId),
        eq(chefProducts.status, "approved"),
        eq(chefProducts.isSoldOut, false),
        inArray(chefProducts.category, ["mains", "deals"]),
    ));
    return rows.filter((dish) => matchesNeeds(dish, dietary, avoid));
}

const toPlanDish = (dish: Dish, meals: number): PlanDish => ({ dishId: dish.id, name: dish.name, image: dish.image, price: dish.price, allergens: dish.allergens ?? [], meals });

/** Spreads the chosen dishes across a week, moving along each week so meals don't repeat in the same order. */
export function weekFromRotation(rotation: Dish[], mealsPerWeek: number, weekIndex: number): PlanDish[] {
    const counts = new Map<string, number>();
    for (let meal = 0; meal < mealsPerWeek; meal++) {
        const dish = rotation[(weekIndex * mealsPerWeek + meal) % rotation.length];
        counts.set(dish.id, (counts.get(dish.id) ?? 0) + 1);
    }
    return rotation.filter((d) => counts.has(d.id)).map((d) => toPlanDish(d, counts.get(d.id)!));
}

export function priceWeek(items: PlanDish[], servings: number, discountPercent: number, deliveryFee: number) {
    const subtotal = roundMoney(items.reduce((sum, item) => sum + item.price * item.meals * servings, 0));
    const discount = roundMoney(subtotal * (discountPercent / 100));
    return { subtotal, discount, deliveryFee, total: roundMoney(subtotal - discount + deliveryFee) };
}

export function strings(value: unknown, allowed: string[]) {
    return Array.isArray(value) ? [...new Set(value.filter((v): v is string => allowed.includes(v)))] : [];
}

export async function menuFromSelection(plan: typeof mealPlans.$inferSelect, selection: unknown, existing: PlanDish[]) {
    if (!Array.isArray(selection)) throw badRequest("Please choose this week's dishes");
    const wanted = selection.map((s) => ({ dishId: String(s?.dishId), meals: Number(s?.meals) })).filter((s) => Number.isInteger(s.meals) && s.meals > 0);
    const total = wanted.reduce((sum, s) => sum + s.meals, 0);
    if (total !== plan.mealsPerWeek) throw badRequest(`Please choose exactly ${plan.mealsPerWeek} meals. You've chosen ${total}.`);

    const dishes = await eligibleDishes(plan.chefId, plan.dietary ?? [], plan.avoidAllergens ?? []);
    return wanted.map(({ dishId, meals }) => {
        const dish = dishes.find((d) => d.id === dishId);
        if (dish) return toPlanDish(dish, meals);
        // A dish already in this week stays at its agreed price, unless it has since become unsuitable.
        const kept = existing.find((item) => item.dishId === dishId);
        if (!kept) throw badRequest("One of those dishes isn't available for this plan");
        return { ...kept, meals };
    });
}

export { notify, notifyChef } from "./notify";

/** Ends a plan when every week has been delivered, skipped or otherwise closed. */
export async function completeIfFinished(planId: number) {
    const open = await db.select({ id: mealPlanWeeks.id }).from(mealPlanWeeks)
        .where(and(eq(mealPlanWeeks.planId, planId), inArray(mealPlanWeeks.status, ["scheduled", "paused", "preparing", "out_for_delivery"])))
        .limit(1);
    if (open.length > 0) return false;
    const [plan] = await db.select().from(mealPlans).where(eq(mealPlans.id, planId)).limit(1);
    if (!plan || !["active", "paused"].includes(plan.status)) return false;
    await db.update(mealPlans).set({ status: "completed", pausedUntil: null }).where(eq(mealPlans.id, planId));
    await withTemplate("plan.finished", {}, () => notify(plan.userId, "Your meal plan has finished", "Hope you enjoyed it. You can renew it with your chef in one tap, and tell others how it went.", `/my-plans/${planId}`));
    return true;
}

/** Restores paused weeks that can still be delivered. Any that have passed their cut-off stay off. */
export async function resumePlan(plan: typeof mealPlans.$inferSelect, cutoffHours: number) {
    const weeks = await db.select().from(mealPlanWeeks).where(and(eq(mealPlanWeeks.planId, plan.id), eq(mealPlanWeeks.status, "paused")));
    for (const week of weeks) {
        const status = isLocked(week.deliveryDate, cutoffHours) ? "skipped" : "scheduled";
        await db.update(mealPlanWeeks).set({ status }).where(eq(mealPlanWeeks.id, week.id));
    }
    await db.update(mealPlans).set({ status: "active", pausedUntil: null }).where(eq(mealPlans.id, plan.id));
    await completeIfFinished(plan.id);
}

// === Hourly housekeeping ===
export async function runMealPlanJobs() {
    const now = today();
    const { cutoffHours } = await getPlanConfig();

    // Requests the chef never answered in time.
    const stale = await db.select().from(mealPlans).where(and(eq(mealPlans.status, "requested"), lte(mealPlans.startDate, now)));
    for (const plan of stale) {
        await db.update(mealPlans).set({ status: "expired" }).where(eq(mealPlans.id, plan.id));
        await db.update(mealPlanWeeks).set({ status: "cancelled" }).where(eq(mealPlanWeeks.planId, plan.id));
        await withTemplate("plan.request_expired", {}, () => notify(plan.userId, "Your meal plan request expired", "The chef didn't reply before your start date, so nothing went ahead. You can try a new date or another chef.", `/my-plans/${plan.id}`));
    }

    // Pauses that have run their course.
    const resuming = await db.select().from(mealPlans).where(and(eq(mealPlans.status, "paused"), lte(mealPlans.pausedUntil, now)));
    for (const plan of resuming) {
        await resumePlan(plan, cutoffHours);
        await withTemplate("plan.resumed", {}, () => notify(plan.userId, "Your meal plan is back on", "Your pause has ended and your deliveries have restarted.", `/my-plans/${plan.id}`));
    }

    // Deliveries nobody closed a week after their date, so a plan can't stay open forever.
    const overdue = await db.select({ id: mealPlanWeeks.id, planId: mealPlanWeeks.planId }).from(mealPlanWeeks)
        .innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id))
        .where(and(
            inArray(mealPlans.status, ["active", "paused"]),
            inArray(mealPlanWeeks.status, ["scheduled", "paused", "preparing", "out_for_delivery"]),
            lt(mealPlanWeeks.deliveryDate, addDays(now, -7)),
        ));
    for (const week of overdue) await db.update(mealPlanWeeks).set({ status: "missed" }).where(eq(mealPlanWeeks.id, week.id));
    for (const planId of new Set(overdue.map((w) => w.planId))) await completeIfFinished(planId);

    // A last chance to change the menu, a day before it closes.
    const closing = await db.select({ week: mealPlanWeeks, userId: mealPlans.userId }).from(mealPlanWeeks)
        .innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id))
        .where(and(
            eq(mealPlans.status, "active"),
            eq(mealPlanWeeks.status, "scheduled"),
            eq(mealPlanWeeks.lockReminderSent, false),
            lte(mealPlanWeeks.deliveryDate, addDays(now, Math.ceil((cutoffHours + 24) / 24))),
        ));
    for (const { week, userId } of closing) {
        await db.update(mealPlanWeeks).set({ lockReminderSent: true }).where(eq(mealPlanWeeks.id, week.id));
        if (isLocked(week.deliveryDate, cutoffHours)) continue;
        await withTemplate("plan.menu_closing", { week: week.weekNumber }, () => notify(userId, `Week ${week.weekNumber}: your menu closes soon`, "Change your dishes or skip this delivery before the chef starts shopping.", `/my-plans/${week.planId}`));
    }

    // Plans never renew on their own, so customers get a clear nudge instead.
    const ending = await db.select().from(mealPlans).where(and(
        eq(mealPlans.status, "active"),
        eq(mealPlans.endingReminderSent, false),
        lte(mealPlans.endDate, addDays(now, 14)),
    ));
    for (const plan of ending) {
        await db.update(mealPlans).set({ endingReminderSent: true }).where(eq(mealPlans.id, plan.id));
        await withTemplate("plan.ending_soon", { endDate: plan.endDate }, () => notify(plan.userId, "Your meal plan ends soon", `Your plan finishes on ${plan.endDate}. It won't renew by itself, so renew it if you'd like to carry on.`, `/my-plans/${plan.id}`));
    }
}

/** Plans made before flexible lengths get their length in weeks filled in, once. */
async function fillPlanWeeks() {
    await db.update(mealPlans).set({ durationWeeks: sql`case ${mealPlans.durationMonths} when 1 then 4 when 3 then 13 when 6 then 26 else ${mealPlans.durationMonths} * 4 end` })
        .where(sql`${mealPlans.durationWeeks} is null`);
}

export function startMealPlanJobs() {
    fillPlanWeeks().catch((e) => console.error("Filling plan lengths failed:", e));
    const run = () => runMealPlanJobs().catch((e) => console.error("Meal plan jobs failed:", e));
    run();
    setInterval(run, 60 * 60 * 1000).unref();
}

/** Cashback on a delivered meal plan week, waiting for a Super Admin to release it. */
export const addPoints = async (userId: number, total: number) => {
    const { earnLoyalty } = await import("./wallet");
    await earnLoyalty(userId, total, "Cashback on a meal plan delivery");
};
