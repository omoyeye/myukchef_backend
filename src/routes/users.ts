import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { and, count, desc, eq, like, ne, or } from "drizzle-orm";
import { db } from "../db";
import { chefs, users } from "../db/schema";
import { erasePersonalData, openCommitments } from "../lib/accountData";
import { getUserId, isValidEmail, MIN_PASSWORD_LENGTH, normaliseEmail, requireAdmin } from "../lib/auth";

const router = Router();
router.use(requireAdmin);

const ROLES = ["customer", "chef", "admin"];
const SAFE_COLUMNS = {
    id: users.id, name: users.name, email: users.email, role: users.role, points: users.points, createdAt: users.createdAt,
};

async function adminCount() {
    const [row] = await db.select({ n: count() }).from(users).where(eq(users.role, "admin"));
    return row.n;
}

// GET /api/users?search=&role=
router.get("/", async (req, res, next) => {
    try {
        const search = String(req.query.search ?? "").trim();
        const role = String(req.query.role ?? "");
        const conditions = [
            search ? or(like(users.name, `%${search}%`), like(users.email, `%${search}%`)) : undefined,
            ROLES.includes(role) ? eq(users.role, role) : undefined,
        ].filter(Boolean);
        const rows = await db.select(SAFE_COLUMNS).from(users).where(and(...conditions)).orderBy(desc(users.createdAt)).limit(200);
        res.json(rows);
    } catch (error) { next(error); }
});

// POST /api/users
router.post("/", async (req, res, next) => {
    try {
        const { name, password, role = "customer", points = 0 } = req.body;
        const email = normaliseEmail(String(req.body.email ?? ""));
        if (!name || !isValidEmail(email)) return res.status(400).json({ error: "A name and valid email are required" });
        if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
        if (password && String(password).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (existing.length > 0) return res.status(400).json({ error: "Email already in use" });

        // With no password set, the person uses "forgot password" to choose their own.
        const hashed = await bcrypt.hash(password || crypto.randomBytes(24).toString("hex"), 10);
        const [{ id }] = await db.insert(users).values({ name, email, role, points: Number(points) || 0, password: hashed }).$returningId();
        const [created] = await db.select(SAFE_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
        res.status(201).json(created);
    } catch (error) { next(error); }
});

// PUT /api/users/:id
router.put("/:id", async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: "User not found" });

        const { name, role, points, password } = req.body;
        const email = req.body.email !== undefined ? normaliseEmail(String(req.body.email)) : existing.email;
        if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email format" });
        if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
        if (password && String(password).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        if (existing.role === "admin" && role && role !== "admin" && (await adminCount()) <= 1) {
            return res.status(400).json({ error: "You can't remove the last admin" });
        }
        if (email !== existing.email) {
            const taken = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, id))).limit(1);
            if (taken.length > 0) return res.status(400).json({ error: "Email already in use" });
        }

        await db.update(users).set({
            name: name ?? existing.name,
            email,
            role: role ?? existing.role,
            points: points !== undefined ? Number(points) || 0 : existing.points,
            ...(password ? { password: await bcrypt.hash(password, 10) } : {}),
        }).where(eq(users.id, id));

        const [updated] = await db.select(SAFE_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
        res.json(updated);
    } catch (error) { next(error); }
});

// DELETE /api/users/:id: removes personal data but keeps anonymised order records for accounts.
router.delete("/:id", async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (id === getUserId(req)) return res.status(400).json({ error: "You can't delete your own account" });

        const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: "User not found" });
        if (existing.role === "admin" && (await adminCount()) <= 1) {
            return res.status(400).json({ error: "You can't remove the last admin" });
        }

        const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, id)).limit(1);
        if (chef) return res.status(409).json({ error: "This person has a chef profile. Delete it under Chefs first." });
        const open = await openCommitments(id);
        if (open.hasOpenPlan) return res.status(409).json({ error: "This person has active meal plans. Cancel those under Meal Plans first." });
        if (open.hasOpenBooking) return res.status(409).json({ error: "This person has an event booking in progress. Finish or cancel it under Events first." });
        await erasePersonalData(id);
        res.json({ message: "User deleted" });
    } catch (error) { next(error); }
});

export const usersRouter = router;
