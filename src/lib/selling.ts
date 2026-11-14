import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chefCredentials, chefs, siteSettings } from "../db/schema";
import { availabilitySummary, type ChefTimes } from "./availability";

/**
 * Who can sell right now. By default a chef's dishes only go on sale once a Super Admin has verified
 * their food hygiene certificate. The Super Admin can switch that rule off under Settings.
 */
export async function getSellingRules() {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, "selling_rules")).limit(1);
    const value = (row?.value ?? {}) as { requireHygiene?: boolean };
    return { requireHygiene: value.requireHygiene !== false };
}

const today = () => new Date().toISOString().slice(0, 10);

/** The chefs (out of these) allowed to sell: approved, and hygiene-verified when the rule is on. */
export async function sellingChefs(chefIds?: number[]) {
    const rows = await db.select().from(chefs).where(chefIds ? and(eq(chefs.status, "approved"), inArray(chefs.id, chefIds.length ? chefIds : [0])) : eq(chefs.status, "approved"));
    const { requireHygiene } = await getSellingRules();
    if (!requireHygiene || rows.length === 0) return new Map(rows.map((c) => [c.id, c]));
    const verified = await db.select({ chefId: chefCredentials.chefId, expiresOn: chefCredentials.expiresOn }).from(chefCredentials)
        .where(and(eq(chefCredentials.type, "food_hygiene"), eq(chefCredentials.status, "verified"), inArray(chefCredentials.chefId, rows.map((c) => c.id))));
    const ok = new Set(verified.filter((v) => !v.expiresOn || v.expiresOn >= today()).map((v) => v.chefId));
    return new Map(rows.filter((c) => ok.has(c.id)).map((c) => [c.id, c]));
}

export const chefTimes = (c: typeof chefs.$inferSelect): ChefTimes => ({ id: c.id, displayName: c.displayName, openingHours: c.openingHours ?? null, ordersPaused: c.ordersPaused, noticeHours: c.noticeHours });

/** What menus show about the chef behind a dish. */
export function chefForMenu(c: typeof chefs.$inferSelect, now = new Date()) {
    return { id: c.id, displayName: c.displayName, avatar: c.avatar, noticeHours: c.noticeHours, ...availabilitySummary(chefTimes(c), now) };
}
