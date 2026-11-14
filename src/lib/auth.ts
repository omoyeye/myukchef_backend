import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            userId?: number;
        }
    }
}

const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 14; // 14 days

function resolveSecret() {
    const secret = process.env.AUTH_SECRET;
    if (secret && secret.length >= 32) return secret;
    if (process.env.NODE_ENV === "production") {
        throw new Error("AUTH_SECRET must be set to at least 32 characters in production");
    }
    console.warn("AUTH_SECRET is not set. Using a temporary secret, so logins reset when the server restarts.");
    return crypto.randomBytes(48).toString("hex");
}
const SECRET = resolveSecret();

const sign = (payload: string) => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

export function signToken(userId: number) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS;
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp })).toString("base64url");
    return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): number | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
        const { sub, exp, purpose } = JSON.parse(Buffer.from(payload, "base64url").toString());
        // Links sent by email (purpose tokens) must never work as a sign-in.
        if (purpose !== undefined) return null;
        if (typeof sub !== "number" || typeof exp !== "number" || exp < Date.now() / 1000) return null;
        return sub;
    } catch {
        return null;
    }
}

/** A signed link for one job only, such as confirming an email address. */
export function signPurposeToken(userId: number, purpose: string, lifetimeSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + lifetimeSeconds;
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp, purpose })).toString("base64url");
    return `${payload}.${sign(payload)}`;
}

export function verifyPurposeToken(token: string, purpose: string): number | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (data.purpose !== purpose || typeof data.sub !== "number" || typeof data.exp !== "number" || data.exp < Date.now() / 1000) return null;
        return data.sub;
    } catch {
        return null;
    }
}

/** Runs on every request. Identity only ever comes from a verified signed token. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
        req.userId = verifyToken(header.slice(7)) ?? undefined;
    }
    next();
}

export const getUserId = (req: Request) => req.userId ?? 0;

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.userId) return res.status(401).json({ error: "Please sign in" });
    next();
}

export async function isAdmin(userId: number) {
    if (!userId) return false;
    const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return user?.role === "admin";
}

/** The role is read from the database each time, so a demoted admin loses access at once. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.userId) return res.status(401).json({ error: "Please sign in" });
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: "Forbidden: Admins only" });
        next();
    } catch (error) {
        next(error);
    }
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const MIN_PASSWORD_LENGTH = 8;
