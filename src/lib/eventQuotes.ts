import { and, eq, inArray, lt } from "drizzle-orm";
import { withTemplate } from "./templates";
import { db } from "../db";
import { eventQuotes, events, siteSettings } from "../db/schema";
import { notify } from "./notify";

export const roundMoney = (n: number) => Math.round(n * 100) / 100;
export const DEFAULT_COMMISSION_PERCENT = 10;

export const paymentReference = (eventId: number) => `MYUK-E${eventId}`;

/** The share MYUKCHEF keeps from each chef's quote. Staff-only setting, shown to chefs on their own quotes. */
export async function getCommissionPercent() {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, "event_commission")).limit(1);
    const value = Number((row?.value as { percent?: unknown } | undefined)?.percent ?? DEFAULT_COMMISSION_PERCENT);
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : DEFAULT_COMMISSION_PERCENT;
}

export async function getBankDetails() {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, "company_bank_details")).limit(1);
    const value = (row?.value ?? {}) as { accountName?: string; sortCode?: string; accountNumber?: string; instructions?: string };
    return value.accountName && value.accountNumber ? value : null;
}

export { notifyAdmins } from "./notify";

/** Moves a booking on once every chef has answered. */
export async function refreshQuoteStage(eventId: number) {
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event || !["quoting", "pending"].includes(event.status)) return;
    const waiting = await db.select({ id: eventQuotes.id }).from(eventQuotes)
        .where(and(eq(eventQuotes.eventId, eventId), eq(eventQuotes.status, "requested"))).limit(1);
    if (waiting.length > 0) return;
    await db.update(events).set({ status: "quotes_ready" }).where(eq(events.id, eventId));
    await withTemplate("event.quotes_ready", { eventName: event.eventName }, () => notify(event.userId, "All your quotes are in", `Every chef has replied about ${event.eventName}. Compare them and confirm the ones you want.`, `/my-bookings/${eventId}`, "event"));
}

/** Daily tidying: bookings that passed their date unpaid close, and paid ones finish so customers can rate. */
export async function runEventJobs() {
    const now = new Date();
    const unpaid = await db.select().from(events).where(and(inArray(events.status, ["quoting", "pending", "quotes_ready", "awaiting_payment"]), lt(events.eventDate, now)));
    for (const event of unpaid) {
        await db.update(events).set({ status: "cancelled" }).where(eq(events.id, event.id));
        await withTemplate("event.closed_unpaid", { eventName: event.eventName }, () => notify(event.userId, "Your booking has closed", `The date for ${event.eventName} has passed without payment, so the booking has closed. Nothing is owed.`, `/my-bookings/${event.id}`, "event"));
    }
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const finished = await db.select().from(events).where(and(inArray(events.status, ["confirmed", "in_progress"]), lt(events.eventDate, twoDaysAgo)));
    for (const event of finished) {
        await db.update(events).set({ status: "completed" }).where(eq(events.id, event.id));
        await withTemplate("event.review_request", { eventName: event.eventName }, () => notify(event.userId, "How was your event?", `We hope ${event.eventName} was wonderful. You can now rate your chefs.`, `/my-bookings/${event.id}`, "event"));
    }
}

export function startEventJobs() {
    const run = () => runEventJobs().catch((e) => console.error("Event jobs failed:", e));
    run();
    setInterval(run, 60 * 60 * 1000).unref();
}
