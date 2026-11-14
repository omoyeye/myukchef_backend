import type { DayHours, OpeningHours } from "../db/schema";

/**
 * When chefs cook one-off orders. Each chef sets their opening days and times, how much notice they
 * need, and can pause orders. An order's delivery time has to suit every chef whose dishes are in it.
 * All times are UK time, whatever the server's own clock is set to.
 */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type Day = (typeof DAYS)[number];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SLOT_MINUTES = 30;
export const MAX_DAYS_AHEAD = 14;

const ukParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23" });

/** The UK weekday, minutes past midnight and calendar date for a moment in time. */
export function ukTime(date: Date) {
    const parts = Object.fromEntries(ukParts.formatToParts(date).map((p) => [p.type, p.value]));
    return {
        day: parts.weekday!.toLowerCase().slice(0, 3) as Day,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
        date: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Tidies opening hours a chef sends. Returns null when nothing is set, meaning "any time". */
export function cleanOpeningHours(raw: unknown): OpeningHours | null {
    if (!raw || typeof raw !== "object") return null;
    const out: OpeningHours = {};
    for (const day of DAYS) {
        const value = (raw as Record<string, Partial<DayHours> | undefined>)[day];
        if (!value) continue;
        const from = typeof value.from === "string" && TIME.test(value.from) ? value.from : "09:00";
        const to = typeof value.to === "string" && TIME.test(value.to) ? value.to : "21:00";
        if (value.open && toMinutes(to) <= toMinutes(from)) {
            throw Object.assign(new Error(`On ${day}, the closing time must be after the opening time.`), { status: 400 });
        }
        out[day] = { open: !!value.open, from, to };
    }
    return Object.keys(out).length ? out : null;
}

export interface ChefTimes { id: number; displayName: string; openingHours: OpeningHours | null; ordersPaused: boolean; noticeHours: number }

/** Whether a chef cooks at this moment. No hours set means they're always open. */
export function isOpenAt(chef: Pick<ChefTimes, "openingHours">, when: Date) {
    const hours = chef.openingHours;
    if (!hours || Object.keys(hours).length === 0) return true;
    const { day, minutes } = ukTime(when);
    const today = hours[day];
    return !!today?.open && minutes >= toMinutes(today.from) && minutes <= toMinutes(today.to);
}

/** Why a delivery time doesn't work for a chef, or null if it does. `noticeHours` is the longest any of their dishes needs. */
export function problemWith(chef: ChefTimes, when: Date, noticeHours: number, now = new Date()): string | null {
    if (chef.ordersPaused) return `${chef.displayName} isn't taking orders at the moment.`;
    if (when.getTime() < now.getTime() + noticeHours * 3600_000 - 60_000) {
        return `${chef.displayName} needs ${noticeHours === 1 ? "an hour's" : `${noticeHours} hours'`} notice. Please choose a later time.`;
    }
    if (!isOpenAt(chef, when)) return `${chef.displayName} doesn't cook at that time. Please choose another time.`;
    return null;
}

export interface BasketChef { chef: ChefTimes; noticeHours: number }

/** The times, over the next two weeks, when every chef in the basket can have the food ready. */
export function availableSlots(basket: BasketChef[], now = new Date(), limit = 400) {
    const paused = basket.find((b) => b.chef.ordersPaused);
    if (paused) return { slots: [] as string[], reason: `${paused.chef.displayName} isn't taking orders at the moment.` };
    const notice = Math.max(0, ...basket.map((b) => b.noticeHours));
    const step = SLOT_MINUTES * 60_000;
    // The first slot is the next half hour after the notice period.
    let t = Math.ceil((now.getTime() + notice * 3600_000) / step) * step;
    const end = now.getTime() + MAX_DAYS_AHEAD * 86400_000;
    const slots: string[] = [];
    for (; t <= end && slots.length < limit; t += step) {
        const when = new Date(t);
        if (basket.every((b) => isOpenAt(b.chef, when) && t >= now.getTime() + b.noticeHours * 3600_000 - 60_000)) slots.push(when.toISOString());
    }
    return { slots, reason: slots.length ? null : "These chefs don't have a time that suits them all in the next two weeks. Try ordering from them separately." };
}

/** A short line for menus: open now, or when the chef next cooks. */
export function availabilitySummary(chef: ChefTimes, now = new Date()) {
    if (chef.ordersPaused) return { openNow: false, paused: true, nextOpen: null as string | null };
    if (isOpenAt(chef, now)) return { openNow: true, paused: false, nextOpen: null };
    const step = SLOT_MINUTES * 60_000;
    for (let t = Math.ceil(now.getTime() / step) * step; t <= now.getTime() + 8 * 86400_000; t += step) {
        if (isOpenAt(chef, new Date(t))) return { openNow: false, paused: false, nextOpen: new Date(t).toISOString() };
    }
    return { openNow: false, paused: false, nextOpen: null };
}
