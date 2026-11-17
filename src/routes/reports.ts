import { Router } from "express";
import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { chefInvoices, chefProducts, chefs, orderChefProgress, orderItems, orders, products, users } from "../db/schema";
import { getUserId, requireAdmin, requireAuth } from "../lib/auth";
import { adminWeeklyReport, chefWeeklyReport, sendAdminReport, sendChefReport } from "../lib/weeklyReports";
import { getBrevo } from "../lib/integrations";
import { rateLimit } from "../lib/rateLimit";

/** Sales reports for the Super Admin, and each chef's own earnings. */
const router = Router();
const round = (n: number) => Math.round(n * 100) / 100;
const dayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

function range(query: Record<string, unknown>, defaultDays = 30) {
    const to = typeof query.to === "string" && !Number.isNaN(Date.parse(query.to)) ? new Date(`${query.to.slice(0, 10)}T23:59:59.999Z`) : new Date();
    const from = typeof query.from === "string" && !Number.isNaN(Date.parse(query.from)) ? new Date(`${query.from.slice(0, 10)}T00:00:00.000Z`) : new Date(to.getTime() - (defaultDays - 1) * 86400_000);
    from.setUTCHours(0, 0, 0, 0);
    // Never more than two years in one report.
    if (to.getTime() - from.getTime() > 731 * 86400_000) from.setTime(to.getTime() - 731 * 86400_000);
    return { from, to };
}

/** Every day in the range, so charts have no gaps. */
function days(from: Date, to: Date) {
    const out: string[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 86400_000) out.push(dayOf(new Date(t)));
    return out;
}

const csvCell = (value: unknown) => {
    const text = value instanceof Date ? value.toISOString() : String(value ?? "");
    // A leading = + - or @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
};
const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

// Real sales only: not unpaid, cancelled or refunded orders.
const realSale = notInArray(orders.status, ["awaiting_payment", "cancelled"]);

// GET /reports/admin?from=2026-10-01&to=2026-10-31
router.get("/admin", requireAdmin, async (req, res, next) => {
    try {
        const { from, to } = range(req.query);
        const sales = await db.select({ id: orders.id, userId: orders.userId, total: orders.total, tip: orders.tipAmount, createdAt: orders.createdAt, status: orders.status })
            .from(orders).where(and(realSale, gte(orders.createdAt, from), lte(orders.createdAt, to)));
        const invoices = await db.select().from(chefInvoices).where(and(gte(chefInvoices.createdAt, from), lte(chefInvoices.createdAt, to), notInArray(chefInvoices.status, ["void"])));
        const names = new Map((await db.select({ id: chefs.id, name: chefs.displayName }).from(chefs)).map((c) => [c.id, c.name]));

        const byDay = new Map(days(from, to).map((d) => [d, { date: d, revenue: 0, orders: 0, commission: 0 }]));
        for (const s of sales) { const d = byDay.get(dayOf(s.createdAt)); if (d) { d.revenue += s.total; d.orders += 1; } }
        for (const i of invoices) { const d = byDay.get(dayOf(i.createdAt)); if (d) d.commission += i.commissionAmount; }

        const chefTotals = new Map<number, { chefId: number; name: string; sales: number; commission: number; paid: number; invoices: number }>();
        for (const i of invoices) {
            const row = chefTotals.get(i.chefId) ?? { chefId: i.chefId, name: names.get(i.chefId) ?? "Chef", sales: 0, commission: 0, paid: 0, invoices: 0 };
            row.sales += i.grossAmount; row.commission += i.commissionAmount; row.invoices += 1;
            if (i.status === "paid") row.paid += i.netAmount;
            chefTotals.set(i.chefId, row);
        }

        // Repeat customers: people in this period who have ordered more than once, ever.
        const buyers = [...new Set(sales.map((s) => s.userId).filter((id): id is number => id !== null))];
        const lifetime = buyers.length
            ? await db.select({ userId: orders.userId, n: sql<number>`count(*)` }).from(orders).where(and(realSale, inArray(orders.userId, buyers))).groupBy(orders.userId)
            : [];
        const repeat = lifetime.filter((l) => Number(l.n) > 1).length;
        const newCustomers = await db.select({ n: sql<number>`count(*)` }).from(users).where(and(eq(users.role, "customer"), gte(users.createdAt, from), lte(users.createdAt, to)));

        const revenue = sales.reduce((sum, s) => sum + s.total, 0);
        res.json({
            from: dayOf(from),
            to: dayOf(to),
            totals: {
                revenue: round(revenue),
                orders: sales.length,
                averageOrder: sales.length ? round(revenue / sales.length) : 0,
                tips: round(sales.reduce((sum, s) => sum + (s.tip ?? 0), 0)),
                commission: round(invoices.reduce((sum, i) => sum + i.commissionAmount, 0)),
                paidToChefs: round(invoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.netAmount, 0)),
                owedToChefs: round(invoices.filter((i) => i.status !== "paid").reduce((sum, i) => sum + i.netAmount, 0)),
                customers: buyers.length,
                guestOrders: sales.filter((s) => s.userId === null).length,
                repeatCustomers: repeat,
                repeatRate: buyers.length ? Math.round((repeat / buyers.length) * 100) : 0,
                newCustomers: Number(newCustomers[0]?.n ?? 0),
            },
            byDay: [...byDay.values()].map((d) => ({ ...d, revenue: round(d.revenue), commission: round(d.commission) })),
            topChefs: [...chefTotals.values()].map((c) => ({ ...c, sales: round(c.sales), commission: round(c.commission), paid: round(c.paid) })).sort((a, b) => b.sales - a.sales).slice(0, 10),
        });
    } catch (error) { next(error); }
});

// GET /reports/admin/export?type=orders|invoices&from=&to=: a spreadsheet for the accountant
router.get("/admin/export", requireAdmin, async (req, res, next) => {
    try {
        const { from, to } = range(req.query, 90);
        const type = req.query.type === "invoices" ? "invoices" : "orders";
        let csv: string;
        if (type === "orders") {
            const rows = await db.select().from(orders).where(and(gte(orders.createdAt, from), lte(orders.createdAt, to))).orderBy(orders.createdAt);
            csv = toCsv(
                ["Order", "Placed", "Status", "Payment", "Total (£)", "Tip (£)", "Method", "Wanted for", "Refunded"],
                rows.map((o) => [o.id, o.createdAt, o.status, o.paymentStatus, o.total.toFixed(2), (o.tipAmount ?? 0).toFixed(2), (o.deliveryAddress as { method?: string } | null)?.method ?? "", o.scheduledFor ?? "", o.refundedAt ?? ""]),
            );
        } else {
            const rows = await db.select({ invoice: chefInvoices, chef: chefs.displayName }).from(chefInvoices).innerJoin(chefs, eq(chefInvoices.chefId, chefs.id))
                .where(and(gte(chefInvoices.createdAt, from), lte(chefInvoices.createdAt, to))).orderBy(chefInvoices.createdAt);
            csv = toCsv(
                ["Invoice", "Receipt", "Chef", "For", "Raised", "Status", "Sales (£)", "Commission %", "Commission (£)", "VAT in commission (£)", "Tip (£)", "Paid to chef (£)", "Paid on", "Paid by"],
                rows.map(({ invoice: i, chef }) => [i.number, i.receiptNumber ?? "", chef, i.description, i.createdAt, i.status, i.grossAmount.toFixed(2), i.commissionPercent, i.commissionAmount.toFixed(2), (i.commissionVat ?? 0).toFixed(2), (i.tipAmount ?? 0).toFixed(2), i.netAmount.toFixed(2), i.paidAt ?? "", i.payMethod ?? ""]),
            );
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="myukchef-${type}-${dayOf(from)}-to-${dayOf(to)}.csv"`);
        // The BOM makes Excel read the pound sign correctly.
        res.send(`﻿${csv}`);
    } catch (error) { next(error); }
});

// GET /reports/chef?from=&to=: the signed-in chef's own earnings
router.get("/chef", requireAuth, async (req, res, next) => {
    try {
        const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1);
        if (!chef) return res.status(403).json({ error: "Chef account required" });
        const { from, to } = range(req.query);
        const all = await db.select().from(chefInvoices).where(and(eq(chefInvoices.chefId, chef.id), notInArray(chefInvoices.status, ["void"])));
        const inRange = all.filter((i) => i.createdAt >= from && i.createdAt <= to);
        const sum = (list: typeof all, key: "grossAmount" | "commissionAmount" | "netAmount" | "tipAmount") => round(list.reduce((s, i) => s + (i[key] ?? 0), 0));
        const since = (daysAgo: number) => all.filter((i) => i.createdAt.getTime() >= Date.now() - daysAgo * 86400_000);

        const byDay = new Map(days(from, to).map((d) => [d, { date: d, sales: 0, earned: 0 }]));
        for (const i of inRange) { const d = byDay.get(dayOf(i.createdAt)); if (d) { d.sales += i.grossAmount; d.earned += i.netAmount; } }

        // Best sellers: this chef's dishes in delivered orders in the period.
        const sold = await db.select({
            name: sql<string>`coalesce(${chefProducts.name}, ${products.name})`,
            quantity: sql<number>`sum(${orderItems.quantity})`,
            sales: sql<number>`sum(${orderItems.price} * ${orderItems.quantity})`,
        }).from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .innerJoin(orderChefProgress, and(eq(orderChefProgress.orderId, orders.id), eq(orderChefProgress.chefId, chef.id)))
            .leftJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
            .leftJoin(products, eq(orderItems.productId, products.id))
            .where(and(
                realSale, gte(orders.createdAt, from), lte(orders.createdAt, to),
                sql`coalesce(${chefProducts.chefId}, ${products.chefId}) = ${chef.id}`,
            ))
            .groupBy(sql`coalesce(${chefProducts.name}, ${products.name})`);

        res.json({
            from: dayOf(from),
            to: dayOf(to),
            totals: {
                sales: sum(inRange, "grossAmount"),
                commission: sum(inRange, "commissionAmount"),
                tips: sum(inRange, "tipAmount"),
                earned: sum(inRange, "netAmount"),
                orders: inRange.length,
                paid: sum(inRange.filter((i) => i.status === "paid"), "netAmount"),
                waiting: sum(inRange.filter((i) => i.status !== "paid"), "netAmount"),
            },
            last7Days: sum(since(7), "netAmount"),
            last30Days: sum(since(30), "netAmount"),
            allTime: sum(all, "netAmount"),
            byDay: [...byDay.values()].map((d) => ({ ...d, sales: round(d.sales), earned: round(d.earned) })),
            bestSellers: sold.map((s) => ({ name: s.name, quantity: Number(s.quantity), sales: round(Number(s.sales)) })).sort((a, b) => b.quantity - a.quantity).slice(0, 8),
        });
    } catch (error) { next(error); }
});

// === Weekly reports (emailed every Monday morning) ===
const weeksAgo = (v: unknown) => Math.min(52, Math.max(0, Number(v ?? 1) || 0));
const emailLimit = rateLimit(5, 60_000);
const meOf = async (req: Parameters<typeof getUserId>[0]) => (await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, getUserId(req))).limit(1))[0];
const chefOf = async (req: Parameters<typeof getUserId>[0]) => (await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1))[0];
const needsEmail = async () => !(await getBrevo()).apiKey;

// GET /reports/weekly/admin?weeksAgo=1
router.get("/weekly/admin", requireAdmin, async (req, res, next) => {
    try { res.json(await adminWeeklyReport(weeksAgo(req.query.weeksAgo))); } catch (error) { next(error); }
});
// POST /reports/weekly/admin/email: sends the report to the signed-in Super Admin now
router.post("/weekly/admin/email", requireAdmin, emailLimit, async (req, res, next) => {
    try {
        if (await needsEmail()) return res.status(400).json({ error: "Email isn't set up yet. Add your Brevo key under Payments & keys." });
        const me = await meOf(req);
        await sendAdminReport([me!.email], weeksAgo(req.body?.weeksAgo));
        res.json({ sentTo: me!.email });
    } catch (error) { next(error); }
});
// GET /reports/weekly/chef?weeksAgo=1
router.get("/weekly/chef", requireAuth, async (req, res, next) => {
    try {
        const chef = await chefOf(req);
        if (!chef) return res.status(403).json({ error: "Chef account required" });
        res.json(await chefWeeklyReport(chef.id, weeksAgo(req.query.weeksAgo)));
    } catch (error) { next(error); }
});
// POST /reports/weekly/chef/email: emails the chef their report now
router.post("/weekly/chef/email", requireAuth, emailLimit, async (req, res, next) => {
    try {
        const chef = await chefOf(req);
        if (!chef) return res.status(403).json({ error: "Chef account required" });
        if (await needsEmail()) return res.status(400).json({ error: "Email isn't available right now. Please try later." });
        const me = await meOf(req);
        try {
            await sendChefReport(chef.id, me!.email, me!.name, weeksAgo(req.body?.weeksAgo));
        } catch (error) {
            console.error("Chef report email failed:", (error as Error).message);
            return res.status(502).json({ error: "We couldn't send the email just now. Please try again later." });
        }
        res.json({ sentTo: me!.email });
    } catch (error) { next(error); }
});

export const reportsRouter = router;
