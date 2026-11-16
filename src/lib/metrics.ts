import type { NextFunction, Request, Response } from "express";
import { monitorEventLoopDelay } from "perf_hooks";

/**
 * How well the API is running, kept in memory for the Super Admin's System health page: requests,
 * response times, server errors and slow requests over the last 24 hours, plus how busy the server is.
 * Nothing personal is kept: only the route pattern (e.g. /api/orders/:id), never ids or query strings.
 */

const MINUTE = 60_000;
const KEEP_MINUTES = 24 * 60;
const SLOW_MS = 1_000;

interface Bucket { minute: number; requests: number; errors: number; totalMs: number; slow: number }
interface RouteStat { route: string; requests: number; errors: number; totalMs: number; maxMs: number; recent: number[] }

const buckets: Bucket[] = [];
const routes = new Map<string, RouteStat>();
const slowRequests: { at: string; route: string; status: number; ms: number }[] = [];
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const startedAt = Date.now();

function bucketFor(now: number) {
    const minute = Math.floor(now / MINUTE);
    let last = buckets[buckets.length - 1];
    if (!last || last.minute !== minute) {
        last = { minute, requests: 0, errors: 0, totalMs: 0, slow: 0 };
        buckets.push(last);
        while (buckets.length && buckets[0]!.minute <= minute - KEEP_MINUTES) buckets.shift();
    }
    return last;
}

/** The route pattern, so /api/orders/42 and /api/orders/43 count together. */
function routeOf(req: Request) {
    const pattern = req.route?.path;
    if (typeof pattern === "string") return `${req.method} ${req.baseUrl}${pattern === "/" ? "" : pattern}`;
    const path = req.originalUrl.split("?")[0]!.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:token");
    return `${req.method} ${path.startsWith("/api") ? path : "(website)"}`;
}

export function trackRequests(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const failed = res.statusCode >= 500;
        const b = bucketFor(Date.now());
        b.requests++;
        b.totalMs += ms;
        if (failed) b.errors++;
        if (ms >= SLOW_MS) b.slow++;
        const key = routeOf(req);
        if (!key.includes("/api/health")) {
            const r = routes.get(key) ?? { route: key, requests: 0, errors: 0, totalMs: 0, maxMs: 0, recent: [] };
            r.requests++;
            r.totalMs += ms;
            r.maxMs = Math.max(r.maxMs, ms);
            if (failed) r.errors++;
            r.recent.push(ms);
            if (r.recent.length > 200) r.recent.shift();
            routes.set(key, r);
            if (routes.size > 400) routes.delete(routes.keys().next().value!);
        }
        if (ms >= SLOW_MS) {
            slowRequests.unshift({ at: new Date().toISOString(), route: key, status: res.statusCode, ms: Math.round(ms) });
            if (slowRequests.length > 50) slowRequests.length = 50;
        }
    });
    next();
}

const p95 = (list: number[]) => {
    if (!list.length) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

export function metricsSnapshot() {
    const now = Math.floor(Date.now() / MINUTE);
    const since = (mins: number) => buckets.filter((b) => b.minute > now - mins);
    const sum = (list: Bucket[]) => {
        const requests = list.reduce((s, b) => s + b.requests, 0);
        const errors = list.reduce((s, b) => s + b.errors, 0);
        return {
            requests,
            errors,
            slow: list.reduce((s, b) => s + b.slow, 0),
            averageMs: requests ? r1(list.reduce((s, b) => s + b.totalMs, 0) / requests) : 0,
            errorRate: requests ? r1((errors / requests) * 100) : 0,
        };
    };
    // One point per hour for the last 24 hours, oldest first.
    const hourly = Array.from({ length: 24 }, (_, i) => {
        const end = now - (23 - i) * 60;
        const list = buckets.filter((b) => b.minute > end - 60 && b.minute <= end);
        return { hour: new Date(end * MINUTE).toISOString(), ...sum(list) };
    });
    const mem = process.memoryUsage();
    const routeList = [...routes.values()].map((r) => ({
        route: r.route,
        requests: r.requests,
        errors: r.errors,
        averageMs: r1(r.totalMs / r.requests),
        p95Ms: r1(p95(r.recent)),
        maxMs: r1(r.maxMs),
    }));
    return {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        memoryMb: { used: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
        eventLoopDelayMs: { mean: r1(loopDelay.mean / 1e6), p99: r1(loopDelay.percentile(99) / 1e6), max: r1(loopDelay.max / 1e6) },
        lastHour: sum(since(60)),
        last24Hours: sum(since(KEEP_MINUTES)),
        hourly,
        slowestRoutes: routeList.filter((r) => r.requests >= 3).sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 10),
        busiestRoutes: routeList.sort((a, b) => b.requests - a.requests).slice(0, 10),
        failingRoutes: routeList.filter((r) => r.errors).sort((a, b) => b.errors - a.errors).slice(0, 10),
        slowRequests,
    };
}

/** Clears the busiest-moment figures, so the next reading shows how the server is doing now. */
export const resetLoopDelay = () => loopDelay.reset();
