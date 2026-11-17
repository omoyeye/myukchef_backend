import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chefProducts, chefs, products } from "../db/schema";

/**
 * What chefs offer for events. Every dish can be on the everyday menu, the event menu, or both. Event
 * items can be sold by the tray, platter, dozen and so on (with how many people one feeds), at their own
 * event price and with a minimum order, and include extras like serving staff or chafing dishes.
 */

export const EVENT_UNITS = ["portion", "tray", "platter", "dozen", "bowl", "cooler", "litre", "cake", "hour", "set", "item"] as const;
export const EVENT_CATEGORIES = ["mains", "sides", "small_chops", "platters", "desserts", "drinks", "extras", "deals"];

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Tidies the event fields a chef sends with a dish. Only fields that were sent are returned. */
export function eventDishFields(body: Record<string, unknown>, current?: { forMenu: boolean; forEvents: boolean }) {
    const out: Partial<Pick<typeof chefProducts.$inferSelect, "forMenu" | "forEvents" | "eventUnit" | "eventServes" | "eventPrice" | "eventMinQty">> = {};
    if (body.forMenu !== undefined) out.forMenu = !!body.forMenu;
    if (body.forEvents !== undefined) out.forEvents = !!body.forEvents;
    if (!(out.forMenu ?? current?.forMenu ?? true) && !(out.forEvents ?? current?.forEvents ?? true)) throw bad("Offer this on your everyday menu, for events, or both");
    if (body.eventUnit !== undefined) {
        const unit = String(body.eventUnit || "portion");
        if (!(EVENT_UNITS as readonly string[]).includes(unit)) throw bad("Please choose how this is sold for events");
        out.eventUnit = unit;
    }
    const whole = (v: unknown, min: number, max: number, message: string) => {
        if (v === undefined) return undefined;
        if (v === null || v === "") return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) throw bad(message);
        return n;
    };
    const serves = whole(body.eventServes, 1, 500, "How many people one serves must be between 1 and 500");
    if (serves !== undefined) out.eventServes = serves;
    const min = whole(body.eventMinQty, 1, 10000, "The minimum order must be between 1 and 10,000");
    if (min !== undefined) out.eventMinQty = min;
    if (body.eventPrice !== undefined) {
        if (body.eventPrice === null || body.eventPrice === "") out.eventPrice = null;
        else {
            const price = Math.round(Number(body.eventPrice) * 100) / 100;
            if (!(price > 0 && price <= 100000)) throw bad("Please enter an event price above £0");
            out.eventPrice = price;
        }
    }
    return out;
}

type Dish = typeof chefProducts.$inferSelect;
/** How an event dish looks to customers: price and unit for events, and what it's for. */
export const asEventDish = (d: Pick<Dish, "id" | "chefId" | "name" | "description" | "image" | "category" | "price" | "allergens" | "isVegetarian" | "isVegan" | "isGlutenFree" | "isHalal"> & Partial<Pick<Dish, "forMenu" | "eventUnit" | "eventServes" | "eventPrice" | "eventMinQty">>) => ({
    id: d.id,
    chefId: d.chefId,
    name: d.name,
    description: d.description,
    image: d.image,
    category: d.category,
    allergens: d.allergens ?? [],
    isVegetarian: d.isVegetarian, isVegan: d.isVegan, isGlutenFree: d.isGlutenFree, isHalal: d.isHalal,
    unit: d.eventUnit ?? "portion",
    serves: d.eventServes ?? 1,
    price: d.eventPrice ?? d.price,
    minQty: d.eventMinQty ?? 1,
    // Only for events: not on the everyday menu.
    eventOnly: d.forMenu === false,
});

/** Every chef's event menu (event-only items first), for chefs taking event bookings. */
export async function eventMenu(chefId?: number) {
    const open = await db.select({ id: chefs.id }).from(chefs).where(and(eq(chefs.status, "approved"), eq(chefs.isAvailableForEvents, true), ...(chefId ? [eq(chefs.id, chefId)] : [])));
    const ids = open.map((c) => c.id);
    if (!ids.length) return [];
    const chefDishes = await db.select().from(chefProducts).where(and(inArray(chefProducts.chefId, ids), eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true), eq(chefProducts.forEvents, true), eq(chefProducts.isSoldOut, false)));
    const menuDishes = await db.select().from(products).where(and(inArray(products.chefId, ids), eq(products.allergensDeclared, true)));
    const all = [...chefDishes.map(asEventDish), ...menuDishes.filter((d) => !d.isSoldOut).map((d) => asEventDish({ ...d, chefId: d.chefId! }))];
    return all.sort((a, b) => Number(b.eventOnly) - Number(a.eventOnly) || EVENT_CATEGORIES.indexOf(a.category) - EVENT_CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
}
