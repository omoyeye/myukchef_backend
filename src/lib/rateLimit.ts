import { NextFunction, Request, Response } from "express";

/** Small in-memory limiter per client and route. Counts reset if the server restarts. */
export function rateLimit(maxRequests: number, windowMs: number, message = "Too many requests. Please wait a moment and try again.") {
    const hits = new Map<string, number[]>();
    return (req: Request, res: Response, next: NextFunction) => {
        const key = req.ip ?? "unknown";
        const now = Date.now();
        const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
        if (recent.length >= maxRequests) {
            hits.set(key, recent);
            return res.status(429).json({ error: message });
        }
        recent.push(now);
        hits.set(key, recent);
        if (hits.size > 10_000) hits.clear();
        next();
    };
}
