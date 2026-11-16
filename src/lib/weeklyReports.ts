import { and, avg, count, countDistinct, desc, eq, gte, inArray, lt, notInArray, sql, sum } from "drizzle-orm";
import { db } from "../db";
import { chefInvoices, chefPosts, chefReviews, chefs, events, mealPlanWeeks, orderChefProgress, orders, siteSettings, users } from "../db/schema";
import { postStats } from "./chefPosts";
import { sendTemplateEmail } from "./mail";
import { errorsBetween } from "../routes/health";

/**
 * Every Monday morning (UK time) Super Admins get a summary of the week before, and each approved chef
 * gets their own: orders, money, reviews and followers, each compared with the week before that.
 */

const SITE_URL = () => (process.env.SITE_URL || "https://myukchef.com").replace(/\/$/, "");
const SENT_KEY = "weekly_report_sent";
const SEND_HOUR_UK = 8;
const round = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round(n).toFixed(2);

// === UK weeks ===

const ukParts = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" })
        .formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), hour: Number(get("hour")), weekday: get("weekday") };
};
/** The moment it's midnight in the UK on a given calendar day. */
function ukMidnight(y: number, m: number, d: number) {
    const guess = new Date(Date.UTC(y, m - 1, d));
    const offsetHours = ukParts(guess).hour; // 0 in winter (GMT), 1 in summer (BST)
    return new Date(guess.getTime() - offsetHours * 3600_000);
}
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday to Monday, UK time. weeksAgo 1 is last week; 0 is the week so far. */
export function weekRange(weeksAgo = 1, now = new Date()) {
    const p = ukParts(now);
    const mondayThisWeek = new Date(Date.UTC(p.y, p.m - 1, p.d - DAYS.indexOf(p.weekday)));
    const start = new Date(mondayThisWeek.getTime() - weeksAgo * 7 * 86400_000);
    const end = new Date(start.getTime() + 7 * 86400_000);
    const from = ukMidnight(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
    const to = ukMidnight(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
    const label = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    const lastDay = new Date(end.getTime() - 86400_000);
    return { from, to, key: start.toISOString().slice(0, 10), label: `${label(start)} to ${label(lastDay)}` };
}

const change = (now: number, before: number) => ({ value: now, previous: before, change: before ? Math.round(((now - before) / before) * 100) : null });
const realSale = notInArray(orders.status, ["awaiting_payment", "cancelled"]);

// === Super Admin ===

async function adminFigures(from: Date, to: Date) {
    const inRange = and(gte(orders.createdAt, from), lt(orders.createdAt, to));
    const [sales] = await db.select({ n: count(), total: sum(orders.total) }).from(orders).where(and(realSale, inRange));
    const [cancelled] = await db.select({ n: count() }).from(orders).where(and(eq(orders.status, "cancelled"), inRange));
    const [customers] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "customer"), gte(users.createdAt, from), lt(users.createdAt, to)));
    const [newChefs] = await db.select({ n: count() }).from(chefs).where(and(gte(chefs.createdAt, from), lt(chefs.createdAt, to)));
    const [activeChefs] = await db.select({ n: countDistinct(orderChefProgress.chefId) }).from(orderChefProgress)
        .innerJoin(orders, eq(orders.id, orderChefProgress.orderId)).where(and(realSale, inRange));
    const [commission] = await db.select({ total: sum(chefInvoices.commissionAmount) }).from(chefInvoices)
        .where(and(notInArray(chefInvoices.status, ["void"]), gte(chefInvoices.createdAt, from), lt(chefInvoices.createdAt, to)));
    const [eventsPaid] = await db.select({ n: count(), total: sum(events.finalTotal) }).from(events).where(and(eq(events.paymentStatus, "paid"), gte(events.paidAt, from), lt(events.paidAt, to)));
    const [weeksPaid] = await db.select({ n: count(), total: sum(mealPlanWeeks.total) }).from(mealPlanWeeks).where(and(eq(mealPlanWeeks.isPaid, true), gte(mealPlanWeeks.paidAt, from), lt(mealPlanWeeks.paidAt, to)));
    const orderCount = sales?.n ?? 0;
    const revenue = Number(sales?.total ?? 0);
    return {
        orders: orderCount,
        revenue: round(revenue),
        averageOrder: orderCount ? round(revenue / orderCount) : 0,
        cancelled: cancelled?.n ?? 0,
        newCustomers: customers?.n ?? 0,
        newChefs: newChefs?.n ?? 0,
        activeChefs: activeChefs?.n ?? 0,
        commission: round(Number(commission?.total ?? 0)),
        eventsPaid: eventsPaid?.n ?? 0,
        eventsRevenue: round(Number(eventsPaid?.total ?? 0)),
        planWeeksPaid: weeksPaid?.n ?? 0,
        planRevenue: round(Number(weeksPaid?.total ?? 0)),
        errors: errorsBetween(from, to),
    };
}

export async function adminWeeklyReport(weeksAgo = 1) {
    const week = weekRange(weeksAgo);
    const before = weekRange(weeksAgo + 1);
    const [now, prev] = await Promise.all([adminFigures(week.from, week.to), adminFigures(before.from, before.to)]);
    const topChefs = await db.select({ chefId: chefInvoices.chefId, name: chefs.displayName, sales: sum(chefInvoices.grossAmount), orders: count() })
        .from(chefInvoices).innerJoin(chefs, eq(chefs.id, chefInvoices.chefId))
        .where(and(notInArray(chefInvoices.status, ["void"]), gte(chefInvoices.createdAt, week.from), lt(chefInvoices.createdAt, week.to)))
        .groupBy(chefInvoices.chefId, chefs.displayName).orderBy(desc(sum(chefInvoices.grossAmount))).limit(5);
    const [videosWaiting] = await db.select({ n: count() }).from(chefPosts).where(and(eq(chefPosts.status, "live"), eq(chefPosts.review, "unchecked")));
    const [chefsWaiting] = await db.select({ n: count() }).from(chefs).where(eq(chefs.status, "pending"));
    const figures = Object.fromEntries(Object.keys(now).map((k) => [k, change(now[k as keyof typeof now], prev[k as keyof typeof prev])])) as Record<keyof typeof now, ReturnType<typeof change>>;
    return {
        week: { from: week.from, to: week.to, label: week.label },
        figures,
        topChefs: topChefs.map((c) => ({ id: c.chefId, name: c.name, sales: round(Number(c.sales ?? 0)), orders: c.orders })),
        toDo: { videosToCheck: videosWaiting?.n ?? 0, chefApplications: chefsWaiting?.n ?? 0 },
    };
}

// === Chefs ===

async function chefFigures(chefId: number, from: Date, to: Date) {
    const [cooked] = await db.select({ n: count() }).from(orderChefProgress).innerJoin(orders, eq(orders.id, orderChefProgress.orderId))
        .where(and(eq(orderChefProgress.chefId, chefId), realSale, gte(orders.createdAt, from), lt(orders.createdAt, to)));
    const [cancelled] = await db.select({ n: count() }).from(orderChefProgress).innerJoin(orders, eq(orders.id, orderChefProgress.orderId))
        .where(and(eq(orderChefProgress.chefId, chefId), eq(orders.status, "cancelled"), gte(orders.createdAt, from), lt(orders.createdAt, to)));
    const [money_] = await db.select({ sales: sum(chefInvoices.grossAmount), earned: sum(chefInvoices.netAmount), tips: sum(chefInvoices.tipAmount) }).from(chefInvoices)
        .where(and(eq(chefInvoices.chefId, chefId), notInArray(chefInvoices.status, ["void"]), gte(chefInvoices.createdAt, from), lt(chefInvoices.createdAt, to)));
    const [reviews] = await db.select({ n: count(), rating: avg(chefReviews.rating) }).from(chefReviews)
        .where(and(eq(chefReviews.chefId, chefId), gte(chefReviews.createdAt, from), lt(chefReviews.createdAt, to)));
    const posts = await postStats(chefId, from, to);
    return {
        orders: cooked?.n ?? 0,
        cancelled: cancelled?.n ?? 0,
        sales: round(Number(money_?.sales ?? 0)),
        earned: round(Number(money_?.earned ?? 0)),
        tips: round(Number(money_?.tips ?? 0)),
        newReviews: reviews?.n ?? 0,
        weekRating: reviews?.rating ? round(Number(reviews.rating)) : 0,
        newFollowers: posts.newFollowers,
        videoComments: posts.comments,
        videosShared: posts.videos,
    };
}

export async function chefWeeklyReport(chefId: number, weeksAgo = 1) {
    const week = weekRange(weeksAgo);
    const before = weekRange(weeksAgo + 1);
    const [now, prev] = await Promise.all([chefFigures(chefId, week.from, week.to), chefFigures(chefId, before.from, before.to)]);
    const [overall] = await db.select({ rating: avg(chefReviews.rating), n: count() }).from(chefReviews).where(eq(chefReviews.chefId, chefId));
    const { followers } = await postStats(chefId, week.from, week.to);
    const [unpaid] = await db.select({ total: sum(chefInvoices.netAmount) }).from(chefInvoices)
        .where(and(eq(chefInvoices.chefId, chefId), inArray(chefInvoices.status, ["awaiting_chef"])));
    const figures = Object.fromEntries(Object.keys(now).map((k) => [k, change(now[k as keyof typeof now], prev[k as keyof typeof prev])])) as Record<keyof typeof now, ReturnType<typeof change>>;
    return {
        week: { from: week.from, to: week.to, label: week.label },
        figures,
        overallRating: overall?.rating ? round(Number(overall.rating)) : null,
        totalReviews: overall?.n ?? 0,
        followers,
        invoicesToSubmit: round(Number(unpaid?.total ?? 0)),
    };
}

// === The emails ===

const escape = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function table(rows: { label: string; value: string; change?: number | null }[]) {
    const cell = "padding:10px 12px;border-bottom:1px solid #f1ede9;font-size:15px;";
    const arrow = (c: number | null | undefined) => c === null || c === undefined ? "" : c === 0
        ? `<span style="color:#6b7280;">no change</span>`
        : `<span style="color:${c > 0 ? "#15803d" : "#b91c1c"};">${c > 0 ? "▲" : "▼"} ${Math.abs(c)}%</span>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 18px;border:1px solid #f1ede9;border-radius:8px;">${rows.map((r) =>
        `<tr><td style="${cell}color:#374151;">${escape(r.label)}</td><td style="${cell}font-weight:700;color:#111827;text-align:right;">${escape(r.value)}</td><td style="${cell}text-align:right;font-size:13px;white-space:nowrap;">${arrow(r.change)}</td></tr>`).join("")}</table>`;
}
const heading = (text: string) => `<p style="margin:18px 0 4px;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#9a3412;">${escape(text)}</p>`;

export async function adminReportEmail(report: Awaited<ReturnType<typeof adminWeeklyReport>>) {
    const f = report.figures;
    const html = heading("Sales") + table([
        { label: "Orders", value: String(f.orders.value), change: f.orders.change },
        { label: "Order sales", value: `£${money(f.revenue.value)}`, change: f.revenue.change },
        { label: "Average order", value: `£${money(f.averageOrder.value)}`, change: f.averageOrder.change },
        { label: "MYUKCHEF commission", value: `£${money(f.commission.value)}`, change: f.commission.change },
        { label: "Events paid", value: `${f.eventsPaid.value} (£${money(f.eventsRevenue.value)})`, change: f.eventsRevenue.change },
        { label: "Meal plan deliveries paid", value: `${f.planWeeksPaid.value} (£${money(f.planRevenue.value)})`, change: f.planRevenue.change },
        { label: "Cancelled orders", value: String(f.cancelled.value), change: f.cancelled.change },
    ]) + heading("People") + table([
        { label: "New customers", value: String(f.newCustomers.value), change: f.newCustomers.change },
        { label: "New chef sign-ups", value: String(f.newChefs.value), change: f.newChefs.change },
        { label: "Chefs who cooked", value: String(f.activeChefs.value), change: f.activeChefs.change },
    ]) + (report.topChefs.length ? heading("Top chefs") + table(report.topChefs.map((c) => ({ label: c.name, value: `£${money(c.sales)} · ${c.orders} orders` }))) : "")
        + heading("System and to-do") + table([
            { label: "Errors logged", value: String(f.errors.value), change: f.errors.change },
            { label: "Chef videos to check", value: String(report.toDo.videosToCheck) },
            { label: "Chef applications waiting", value: String(report.toDo.chefApplications) },
        ]);
    return {
        vars: { weekLabel: report.week.label, orders: f.orders.value, revenue: money(f.revenue.value), newCustomers: f.newCustomers.value, errors: f.errors.value },
        extraHtml: html,
    };
}

export async function chefReportEmail(report: Awaited<ReturnType<typeof chefWeeklyReport>>, firstName: string) {
    const f = report.figures;
    const html = heading("Orders and money") + table([
        { label: "Orders cooked", value: String(f.orders.value), change: f.orders.change },
        { label: "Sales", value: `£${money(f.sales.value)}`, change: f.sales.change },
        { label: "You earned (after commission, with tips)", value: `£${money(f.earned.value)}`, change: f.earned.change },
        { label: "Tips", value: `£${money(f.tips.value)}`, change: f.tips.change },
        { label: "Cancelled orders", value: String(f.cancelled.value), change: f.cancelled.change },
    ]) + heading("Reviews and followers") + table([
        { label: "New reviews", value: String(f.newReviews.value), change: f.newReviews.change },
        { label: "Your overall rating", value: report.overallRating ? `${report.overallRating} / 5 (${report.totalReviews} reviews)` : "No reviews yet" },
        { label: "New followers", value: String(f.newFollowers.value), change: f.newFollowers.change },
        { label: "Followers in total", value: String(report.followers) },
        { label: "Comments on your videos", value: String(f.videoComments.value), change: f.videoComments.change },
    ]) + (report.invoicesToSubmit > 0
        ? `<p style="margin:0 0 14px;font-size:15px;color:#9a3412;">You have £${money(report.invoicesToSubmit)} in invoices waiting for you to submit. Submit them to get paid.</p>`
        : "")
        + (f.videosShared.value === 0 ? `<p style="margin:0 0 14px;font-size:15px;color:#374151;">Tip: share a short video of your cooking this week. Your followers get a notification when you do.</p>` : "");
    return {
        vars: { firstName, weekLabel: report.week.label, orders: f.orders.value, earnings: money(f.earned.value), rating: report.overallRating ? `${report.overallRating} out of 5` : "not set yet", newFollowers: f.newFollowers.value },
        extraHtml: html,
    };
}

export async function sendAdminReport(to: string[], weeksAgo = 1) {
    const { vars, extraHtml } = await adminReportEmail(await adminWeeklyReport(weeksAgo));
    for (const email of to) {
        await sendTemplateEmail("report.weekly_admin", email, vars, { extraHtml, button: { label: "Open the dashboard", url: `${SITE_URL()}/admin/reports` } })
            .catch((e: Error) => console.error("Weekly report email failed:", e.message));
    }
}

export async function sendChefReport(chefId: number, to: string, name: string, weeksAgo = 1) {
    const { vars, extraHtml } = await chefReportEmail(await chefWeeklyReport(chefId, weeksAgo), name.split(" ")[0] || name);
    await sendTemplateEmail("report.weekly_chef", to, vars, { extraHtml, button: { label: "Open my dashboard", url: `${SITE_URL()}/chef/dashboard` } });
}

/** Sends last week's reports once, on Monday from 8am UK time. Safe to call often. */
export async function sendWeeklyReportsIfDue(now = new Date()) {
    const p = ukParts(now);
    if (p.weekday !== "Mon" || p.hour < SEND_HOUR_UK) return false;
    const { key } = weekRange(1, now);
    // Claim the week first, in one update, so a restart or a second server can't send it twice.
    await db.insert(siteSettings).values({ key: SENT_KEY, value: { week: "" } }).onDuplicateKeyUpdate({ set: { key: SENT_KEY } });
    const [claim] = await db.update(siteSettings).set({ value: { week: key, at: now.toISOString() }, updatedAt: new Date() })
        .where(and(eq(siteSettings.key, SENT_KEY), sql`coalesce(json_unquote(json_extract(${siteSettings.value}, '$.week')), '') <> ${key}`));
    if (!(claim as unknown as { affectedRows?: number }).affectedRows) return false;

    const admins = await db.select({ email: users.email }).from(users).where(eq(users.role, "admin"));
    await sendAdminReport(admins.map((a) => a.email));
    const chefList = await db.select({ id: chefs.id, email: users.email, name: users.name }).from(chefs).innerJoin(users, eq(users.id, chefs.userId)).where(eq(chefs.status, "approved"));
    for (const c of chefList) await sendChefReport(c.id, c.email, c.name).catch((e: Error) => console.error(`Weekly report for chef ${c.id} failed:`, e.message));
    return true;
}

export function startWeeklyReports() {
    const run = () => sendWeeklyReportsIfDue().catch((e) => console.error("Weekly reports failed:", e));
    setTimeout(run, 90_000).unref();
    setInterval(run, 30 * 60_000).unref();
}
