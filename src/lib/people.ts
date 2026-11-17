/**
 * Who the food is for. Customers say how many adults and how many children, so the chef can plan
 * portions and spice. Older app versions send one total, which counts as adults.
 */

export const MAX_PEOPLE = { plan: 12, event: 2000 };

const count = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));

export function readPeople(body: Record<string, unknown>, totalField: "servings" | "headcount", max: number) {
    let adults = count(body.adults);
    let kids = count(body.kids) ?? 0;
    if (adults === null) {
        // An older app: one number for everyone.
        adults = count(body[totalField]);
        kids = 0;
    }
    const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
    if (!Number.isInteger(adults) || !Number.isInteger(kids) || (adults as number) < 0 || kids < 0) throw bad("Please say how many adults and children you're feeding");
    const total = (adults as number) + kids;
    if (total < 1) throw bad("Please say how many adults and children you're feeding");
    if (total > max) throw bad(`Please choose up to ${max} people`);
    return { adults: adults as number, kids, total };
}

/** "2 adults and 1 child", "4 adults", "3 children". Rows saved before the split show the total. */
export function peopleLabel(row: { adults?: number | null; kids?: number | null }, total: number) {
    if (row.adults === null || row.adults === undefined) return `${total} ${total === 1 ? "person" : "people"}`;
    const kids = row.kids ?? 0;
    const a = row.adults ? `${row.adults} adult${row.adults === 1 ? "" : "s"}` : "";
    const k = kids ? `${kids} child${kids === 1 ? "" : "ren"}` : "";
    return [a, k].filter(Boolean).join(" and ");
}
