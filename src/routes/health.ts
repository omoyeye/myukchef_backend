import fs from "fs";
import { withTemplate } from "../lib/templates";
import path from "path";
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireAdmin } from "../lib/auth";
import { notifyAdmins } from "../lib/notify";
import { rateLimit } from "../lib/rateLimit";
import { metricsSnapshot } from "../lib/metrics";

/**
 * Keeping an eye on the service. /api/health is for an uptime monitor to ping. Errors from the server
 * and from people's browsers are kept in a log file, shown to Super Admins, and each new kind of error
 * sends them one notification (not one per occurrence).
 */
const router = Router();
const startedAt = Date.now();

interface ErrorReport { at: string; source: "server" | "browser" | "app"; message: string; where: string; count: number }
const recent: ErrorReport[] = [];
const lastAlert = new Map<string, number>();
const ALERT_GAP_MS = 60 * 60 * 1000;
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(process.cwd(), "logs"));
const LOG_FILE = path.join(LOG_DIR, "errors.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
// Many errors in a short time (an outage, a bad release) sends one extra alert an hour.
const SPIKE_COUNT = 20;
const SPIKE_MINUTES = 10;
const errorTimes: number[] = [];
let lastSpikeAlert = 0;

function record(source: ErrorReport["source"], message: string, where: string) {
    const text = message.replace(/\s+/g, " ").slice(0, 500);
    const place = where.replace(/\s+/g, " ").slice(0, 200);
    const existing = recent.find((r) => r.message === text && r.where === place && r.source === source);
    if (existing) { existing.count += 1; existing.at = new Date().toISOString(); } else {
        recent.unshift({ at: new Date().toISOString(), source, message: text, where: place, count: 1 });
        if (recent.length > 100) recent.length = 100;
    }
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        // One file, started afresh when it gets big, so it can't fill the disk.
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${source}] ${place} :: ${text}\n`);
    } catch { /* logging must never break the request */ }
    const now = Date.now();
    errorTimes.push(now);
    while (errorTimes.length && errorTimes[0]! < now - SPIKE_MINUTES * 60_000) errorTimes.shift();
    if (errorTimes.length >= SPIKE_COUNT && now - lastSpikeAlert > ALERT_GAP_MS) {
        lastSpikeAlert = now;
        withTemplate("admin.error_spike", { count: errorTimes.length, minutes: SPIKE_MINUTES }, () =>
            notifyAdmins("Lots of errors right now", `${errorTimes.length} errors in the last ${SPIKE_MINUTES} minutes. Open System health to see what's failing.`, "/admin/system"))
            .catch(() => undefined);
    }
    const key = `${source}:${text}`;
    if (Date.now() - (lastAlert.get(key) ?? 0) > ALERT_GAP_MS) {
        lastAlert.set(key, Date.now());
        if (lastAlert.size > 500) lastAlert.clear();
        withTemplate("admin.error", { source, message: text.slice(0, 160), where: place }, () => notifyAdmins(source === "server" ? "Something went wrong on the server" : "A customer hit an error", `${text.slice(0, 160)} (${place})`, "/admin/system"))
            .catch(() => undefined);
    }
}

/** Called by the server's own error handler. */
export function reportServerError(error: unknown, where: string) {
    record("server", (error as Error)?.message || String(error), where);
}

// GET /api/health: for uptime monitors. 200 when the API and database are both answering.
router.get("/", async (_req, res) => {
    try {
        await db.execute(sql`select 1`);
        res.json({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
    } catch {
        res.status(503).json({ ok: false, error: "Database not answering" });
    }
});

// POST /api/health/client-error { message, where, source }: the website and app report crashes here
router.post("/client-error", rateLimit(10, 60_000), (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    if (message) record(req.body?.source === "app" ? "app" : "browser", message, typeof req.body?.where === "string" ? req.body.where : "");
    res.status(204).end();
});

// GET /api/health/errors: the most recent errors, for Super Admins
router.get("/errors", requireAdmin, (_req, res) => {
    res.json({ errors: recent, since: new Date(startedAt).toISOString() });
});

/** Lines from the error log file (kept across restarts), newest first. */
export function readLog(limit = 2000) {
    const lines: { at: string; source: string; where: string; message: string }[] = [];
    for (const file of [LOG_FILE, `${LOG_FILE}.old`]) {
        if (lines.length >= limit) break;
        let content = "";
        try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
        const rows = content.split("\n").filter(Boolean).reverse();
        for (const row of rows) {
            const m = row.match(/^(\S+) \[(\w+)\] (.*?) :: (.*)$/);
            if (m) lines.push({ at: m[1]!, source: m[2]!, where: m[3]!, message: m[4]! });
            if (lines.length >= limit) break;
        }
    }
    return lines;
}

/** How many errors were logged between two times. */
export const errorsBetween = (from: Date, to: Date) =>
    readLog(20_000).filter((l) => { const t = Date.parse(l.at); return t >= from.getTime() && t < to.getTime(); }).length;

// GET /api/health/logs?source=server|browser|app&q=text&days=7: the error log, searchable
router.get("/logs", requireAdmin, (req, res) => {
    const source = typeof req.query.source === "string" ? req.query.source : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = Date.now() - days * 86400_000;
    const lines = readLog().filter((l) => Date.parse(l.at) >= since && (!source || l.source === source)
        && (!q || l.message.toLowerCase().includes(q) || l.where.toLowerCase().includes(q)));
    // The same error repeated is shown once, with how often and when it last happened.
    const groups = new Map<string, { message: string; where: string; source: string; count: number; lastAt: string; firstAt: string }>();
    for (const l of lines) {
        const key = `${l.source}|${l.where}|${l.message}`;
        const g = groups.get(key);
        if (g) { g.count++; g.firstAt = l.at; } else groups.set(key, { message: l.message, where: l.where, source: l.source, count: 1, lastAt: l.at, firstAt: l.at });
    }
    const byDay = new Map<string, number>();
    for (const l of lines) byDay.set(l.at.slice(0, 10), (byDay.get(l.at.slice(0, 10)) ?? 0) + 1);
    res.json({
        total: lines.length,
        groups: [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 200),
        recent: lines.slice(0, 100),
        byDay: [...byDay.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    });
});

// GET /api/health/metrics: response times, errors and server load, for the System health page
router.get("/metrics", requireAdmin, async (_req, res) => {
    const t = process.hrtime.bigint();
    let databaseMs: number | null = null;
    try { await db.execute(sql`select 1`); databaseMs = Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10; } catch { /* shown as down */ }
    res.json({ ...metricsSnapshot(), databaseMs, node: process.version, errorsLogged: recent.reduce((s, r) => s + r.count, 0) });
});

export const healthRouter = router;
