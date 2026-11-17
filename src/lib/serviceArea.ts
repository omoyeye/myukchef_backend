import type { chefs } from "../db/schema";
import { milesBetween } from "./geo";

/**
 * Where a chef delivers. Each chef picks how far they normally deliver, and can also take orders from
 * further away: those customers agree up front to wait the extra time the chef sets, and not to
 * complain about it.
 */

export const RADIUS_MILES = { min: 1, max: 200 };
export const FAR_EXTRA_HOURS = { min: 1, max: 168 };
export const FAR_MAX_MILES = { min: 0, max: 600 }; // 0 means anywhere

type Chef = Pick<typeof chefs.$inferSelect, "id" | "displayName" | "latitude" | "longitude" | "serviceRadiusMiles" | "acceptsFarOrders" | "farExtraHours" | "farMaxMiles">;
type Point = { lat: number; lng: number };

/** One chef the customer chose from outside that chef's usual area, and the wait they agreed to. */
export interface FarAway { chefId: number; name: string; miles: number; radiusMiles: number; extraHours: number }

export type AreaStatus = "inside" | "far" | "outside" | "unknown";

/** Whether the chef delivers to this point, and the extra wait if it's beyond their usual area. */
export function areaFor(chef: Chef, point: Point | null): { status: AreaStatus; miles: number | null; extraHours: number } {
    // Without both locations the chef decides when they see the order, as before.
    if (!point || chef.latitude === null || chef.longitude === null) return { status: "unknown", miles: null, extraHours: 0 };
    const miles = Math.round(milesBetween(point, { lat: chef.latitude, lng: chef.longitude }) * 10) / 10;
    if (miles <= chef.serviceRadiusMiles) return { status: "inside", miles, extraHours: 0 };
    if (chef.acceptsFarOrders && (chef.farMaxMiles === 0 || miles <= chef.farMaxMiles)) return { status: "far", miles, extraHours: chef.farExtraHours };
    return { status: "outside", miles, extraHours: 0 };
}

export const farAwayEntry = (chef: Chef, area: { miles: number | null; extraHours: number }): FarAway =>
    ({ chefId: chef.id, name: chef.displayName, miles: area.miles ?? 0, radiusMiles: chef.serviceRadiusMiles, extraHours: area.extraHours });

/** "24 hours", "2 days", "1 day and 6 hours". */
export function waitLabel(hours: number) {
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return `${days} day${days === 1 ? "" : "s"}${rest ? ` and ${rest} hour${rest === 1 ? "" : "s"}` : ""}`;
}

/** The error a customer sees until they agree to the longer wait. The page shows the details and asks. */
export function farWaitNeeded(far: FarAway[]) {
    const list = far.map((f) => `${f.name} (${f.miles} miles away, about ${waitLabel(f.extraHours)} longer)`).join(", ");
    return Object.assign(new Error(`You're outside the usual delivery area for ${list}. Please agree to the longer wait to go ahead.`), {
        status: 409,
        details: { code: "far_wait", farAway: far },
    });
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Tidies the area settings a chef (or Super Admin) sends. Only fields that were sent are returned. */
export function areaSettings(body: Record<string, unknown>) {
    const out: Partial<Pick<typeof chefs.$inferSelect, "serviceRadiusMiles" | "acceptsFarOrders" | "farExtraHours" | "farMaxMiles">> = {};
    const whole = (v: unknown, range: { min: number; max: number }, message: string) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < range.min || n > range.max) throw bad(message);
        return n;
    };
    if (body.serviceRadiusMiles !== undefined) out.serviceRadiusMiles = whole(body.serviceRadiusMiles, RADIUS_MILES, `Please choose a delivery area from ${RADIUS_MILES.min} to ${RADIUS_MILES.max} miles.`);
    if (body.acceptsFarOrders !== undefined) out.acceptsFarOrders = !!body.acceptsFarOrders;
    if (body.farExtraHours !== undefined) out.farExtraHours = whole(body.farExtraHours, FAR_EXTRA_HOURS, "The extra wait must be between 1 hour and 7 days.");
    if (body.farMaxMiles !== undefined) out.farMaxMiles = whole(body.farMaxMiles, FAR_MAX_MILES, `The furthest distance must be up to ${FAR_MAX_MILES.max} miles (0 for anywhere).`);
    return out;
}
