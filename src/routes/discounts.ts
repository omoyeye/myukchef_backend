import { Router } from "express";
import { db } from "../db";
import { discounts, users } from "../db/schema";
import { eq, and, gt, isNull, or } from "drizzle-orm";
import { getUserId, requireAdmin } from "../lib/auth";
import { validateDiscount } from "../lib/pricing";

const router = Router();

// GET /api/discounts (Admin only)
router.get("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const allDiscounts = await db.select().from(discounts);
        res.json(allDiscounts);
    } catch (error) {
        console.error("Get discounts error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /api/discounts/public (Publicly visible active discounts)
router.get("/public", async (req, res) => {
    try {
        const activeDiscounts = await db.select()
            .from(discounts)
            .where(and(eq(discounts.isActive, true), or(isNull(discounts.expiryDate), gt(discounts.expiryDate, new Date()))));
        res.json(activeDiscounts);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch public discounts" });
    }
});

// POST /api/discounts (Admin only)
router.post("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const { code, type, value, minOrderAmount, isFirstOrderOnly, expiryDate } = req.body;
        const [{ id: newDiscountId }] = await db.insert(discounts).values({
            code: code.toUpperCase(),
            type,
            value,
            minOrderAmount: minOrderAmount || 0,
            isFirstOrderOnly: !!isFirstOrderOnly,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
        }).$returningId();
        const [newDiscount] = await db.select().from(discounts).where(eq(discounts.id, newDiscountId)).limit(1);

        res.status(201).json(newDiscount);
    } catch (error: any) {
        console.error("Create discount error:", error);
        res.status(500).json({ error: error.message || "Internal server error" });
    }
});

// PATCH /api/discounts/:id/toggle (Admin only)
router.patch("/:id/toggle", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const { id } = req.params;
        const { isActive } = req.body;
        await db.update(discounts)
            .set({ isActive })
            .where(eq(discounts.id, Number(id)));
        const [updated] = await db.select().from(discounts).where(eq(discounts.id, Number(id))).limit(1);
        res.json(updated);
    } catch (error) {
        console.error("Toggle discount error:", error);
        res.status(500).json({ error: "Failed to toggle discount" });
    }
});

// PUT /api/discounts/:id (Admin only)
router.put("/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const { id } = req.params;
        const { code, type, value, minOrderAmount, isFirstOrderOnly, expiryDate } = req.body;

        await db.update(discounts)
            .set({
                code: code?.toUpperCase(),
                type,
                value,
                minOrderAmount,
                isFirstOrderOnly,
                expiryDate: expiryDate ? new Date(expiryDate) : null,
            })
            .where(eq(discounts.id, Number(id)));
        const [updated] = await db.select().from(discounts).where(eq(discounts.id, Number(id))).limit(1);
        if (!updated) return res.status(404).json({ error: "Discount not found" });

        res.json(updated);
    } catch (error: any) {
        console.error("Update discount error:", error);
        res.status(500).json({ error: error.message || "Internal server error" });
    }
});

// GET /api/discounts/validate/:code?amount=
router.get("/validate/:code", async (req, res) => {
    try {
        const discount = await validateDiscount(req.params.code, Number(req.query.amount) || 0, getUserId(req));
        res.json({ code: discount.code, type: discount.type, value: discount.value });
    } catch (error: any) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        console.error("Validate discount error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE /api/discounts/:id
router.delete("/:id", requireAdmin, async (req, res, next) => {
    try {
        await db.delete(discounts).where(eq(discounts.id, Number(req.params.id)));
        res.json({ message: "Discount deleted" });
    } catch (error) { next(error); }
});

export const discountsRouter = router;
