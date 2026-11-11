import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { chefProducts, chefs, mealPlans, products, siteSettings } from "../db/schema";

/** The 14 allergens UK food businesses must declare. */
export const ALLERGENS = [
    "celery", "gluten", "crustaceans", "eggs", "fish", "lupin", "milk",
    "molluscs", "mustard", "peanuts", "sesame", "soya", "sulphites", "tree_nuts",
];

// The app used to record 7 broader names. Where one old name covers two allergens, both are kept.
const OLD_NAMES: Record<string, string[]> = {
    nuts: ["peanuts", "tree_nuts"],
    dairy: ["milk"],
    soy: ["soya"],
    shellfish: ["crustaceans", "molluscs"],
};

export function cleanAllergens(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const mapped = value.flatMap((a) => OLD_NAMES[String(a).toLowerCase()] ?? [String(a).toLowerCase()]);
    return [...new Set(mapped.filter((a) => ALLERGENS.includes(a)))];
}

const MIGRATION_KEY = "allergens_14_migrated";

/**
 * Runs once. Old answers only covered 7 allergens, so nobody has yet confirmed the other 7:
 * every dish goes off sale until its chef or an admin has checked the full list.
 */
export async function migrateAllergens() {
    const [done] = await db.select().from(siteSettings).where(eq(siteSettings.key, MIGRATION_KEY)).limit(1);
    if (done) return { chefIds: [] as number[] };

    for (const dish of await db.select({ id: products.id, allergens: products.allergens }).from(products)) {
        await db.update(products).set({ allergens: cleanAllergens(dish.allergens), allergensDeclared: false }).where(eq(products.id, dish.id));
    }
    const chefDishes = await db.select({ id: chefProducts.id, allergens: chefProducts.allergens, chefId: chefProducts.chefId }).from(chefProducts);
    for (const dish of chefDishes) {
        await db.update(chefProducts).set({ allergens: cleanAllergens(dish.allergens), allergensDeclared: false }).where(eq(chefProducts.id, dish.id));
    }
    for (const plan of await db.select({ id: mealPlans.id, avoid: mealPlans.avoidAllergens }).from(mealPlans)) {
        await db.update(mealPlans).set({ avoidAllergens: cleanAllergens(plan.avoid) }).where(eq(mealPlans.id, plan.id));
    }
    await db.insert(siteSettings).values({ key: MIGRATION_KEY, value: { at: new Date().toISOString() } });
    const approved = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.status, "approved"));
    return { chefIds: approved.map((c) => c.id).filter((id) => chefDishes.some((d) => d.chefId === id)) };
}

export const countDishesNeedingAllergenCheck = async () => {
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(products).where(eq(products.allergensDeclared, false));
    return Number(row.n);
};

const NAMES: Record<string, string> = { celery: "celery", gluten: "cereals containing gluten", crustaceans: "crustaceans", eggs: "eggs", fish: "fish", lupin: "lupin", milk: "milk", molluscs: "molluscs", mustard: "mustard", peanuts: "peanuts", sesame: "sesame", soya: "soya", sulphites: "sulphites", tree_nuts: "tree nuts" };
export const allergenName = (id: string) => NAMES[id] ?? id;
