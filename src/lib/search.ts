/**
 * Search, filters and paging for dish lists. Everything is optional: with no query the full list
 * comes back, as it always has.
 *
 *   ?q=jollof          words in the dish name, description, category, tags or chef's name
 *   ?diet=vegan,halal  vegetarian | vegan | glutenfree | halal (all must match)
 *   ?category=mains    ?chef=12    ?maxPrice=15    ?openNow=1
 *   ?sort=price | price_desc | name | popular
 *   ?page=1&limit=24   (the total is in the X-Total-Count header)
 */

interface Dish {
    name: string;
    description: string;
    category: string;
    price: number;
    tags?: string[] | null;
    isVegetarian?: boolean | null;
    isVegan?: boolean | null;
    isGlutenFree?: boolean | null;
    isHalal?: boolean | null;
    isPopular?: boolean | null;
    chef?: { id: number; displayName: string; openNow?: boolean } | null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const DIETS: Record<string, (d: Dish) => boolean> = {
    vegetarian: (d) => !!d.isVegetarian || !!d.isVegan,
    vegan: (d) => !!d.isVegan,
    glutenfree: (d) => !!d.isGlutenFree,
    halal: (d) => !!d.isHalal,
};

export function filterDishes<T extends Dish>(dishes: T[], query: Record<string, unknown>): T[] {
    const words = text(query.q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const diets = text(query.diet).toLowerCase().split(",").map((d) => d.replace(/[^a-z]/g, "")).filter((d) => d in DIETS);
    const category = text(query.category).toLowerCase();
    const chefId = Number(query.chef) || null;
    const maxPrice = Number(query.maxPrice) || null;
    const openNow = query.openNow === "1" || query.openNow === "true";

    let out = dishes.filter((d) => {
        if (category && d.category.toLowerCase() !== category) return false;
        if (chefId && d.chef?.id !== chefId) return false;
        if (maxPrice && d.price > maxPrice) return false;
        if (openNow && d.chef && d.chef.openNow === false) return false;
        if (!diets.every((diet) => DIETS[diet]!(d))) return false;
        if (words.length) {
            const haystack = [d.name, d.description, d.category, ...(d.tags ?? []), d.chef?.displayName ?? ""].join(" ").toLowerCase();
            if (!words.every((w) => haystack.includes(w))) return false;
        }
        return true;
    });

    const sort = text(query.sort);
    if (sort === "price") out = [...out].sort((a, b) => a.price - b.price);
    else if (sort === "price_desc") out = [...out].sort((a, b) => b.price - a.price);
    else if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "popular") out = [...out].sort((a, b) => Number(!!b.isPopular) - Number(!!a.isPopular));
    return out;
}

/** One page of a list when ?page is given; otherwise the whole list. */
export function pageOf<T>(items: T[], query: Record<string, unknown>): T[] {
    const page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) return items;
    const limit = Math.min(Math.max(Number(query.limit) || 24, 1), 100);
    return items.slice((page - 1) * limit, page * limit);
}
