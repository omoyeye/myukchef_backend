import fs from "fs";
import path from "path";
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireAdmin } from "../lib/auth";
import { notifyAdmins } from "../lib/notify";
import { rateLimit } from "../lib/rateLimit";

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
    const key = `${source}:${text}`;
    if (Date.now() - (lastAlert.get(key) ?? 0) > ALERT_GAP_MS) {
        lastAlert.set(key, Date.now());
        if (lastAlert.size > 500) lastAlert.clear();
        notifyAdmins(source === "server" ? "Something went wrong on the server" : "A customer hit an error", `${text.slice(0, 160)} (${place})`, "/admin/reports#health")
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

export const healthRouter = router;
