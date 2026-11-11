import { Router } from "express";
import { db } from "../db";
import { orderItems, orders, reviews, users, products } from "../db/schema";
import { eq, desc, gte, and } from "drizzle-orm";
import { getUserId } from "../lib/auth";
import { CONTACT_BLOCKED_MESSAGE, hasContactDetails } from "../lib/contactGuard";

const router = Router();

// GET /api/reviews/featured
router.get("/featured", async (req, res) => {
    try {
        const featuredReviews = await db.select({
            id: reviews.id,
            rating: reviews.rating,
            comment: reviews.comment,
            createdAt: reviews.createdAt,
            userName: users.name,
            productName: products.name
        })
            .from(reviews)
            .leftJoin(users, eq(reviews.userId, users.id))
            .leftJoin(products, eq(reviews.productId, products.id))
            .where(and(gte(reviews.rating, 4), eq(reviews.status, 'approved')))
            .orderBy(desc(reviews.createdAt))
            .limit(10);

        res.json(featuredReviews);
    } catch (error) {
        console.error("Get featured reviews error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/** Reviews must come from a genuine experience, so only someone who received this dish can post one. */
async function hasReceivedDish(userId: number, productId: string) {
    const [row] = await db.select({ id: orders.id }).from(orders)
        .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(and(eq(orders.userId, userId), eq(orders.status, "completed"), eq(orderItems.productId, productId)))
        .limit(1);
    return !!row;
}

// GET /api/reviews/eligibility/:productId
router.get("/eligibility/:productId", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.json({ canReview: false, alreadyReviewed: false });
    const [existing] = await db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.productId, req.params.productId))).limit(1);
    res.json({ canReview: !existing && (await hasReceivedDish(userId, req.params.productId)), alreadyReviewed: !!existing });
});

// GET /api/reviews/:productId
router.get("/:productId", async (req, res) => {
    try {
        const { productId } = req.params;
        const productReviews = await db.select({
            id: reviews.id,
            rating: reviews.rating,
            comment: reviews.comment,
            status: reviews.status,
            createdAt: reviews.createdAt,
            userName: users.name
        })
            .from(reviews)
            .leftJoin(users, eq(reviews.userId, users.id))
            .where(and(eq(reviews.productId, productId), eq(reviews.status, 'approved')));

        res.json(productReviews);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// POST /api/reviews
router.post("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const { productId, comment } = req.body;
        if (hasContactDetails(comment)) return res.status(400).json({ error: CONTACT_BLOCKED_MESSAGE });
        const rating = Number(req.body.rating);
        if (!productId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ error: "A rating from 1 to 5 is required" });
        }
        if (!(await hasReceivedDish(userId, String(productId)))) {
            return res.status(403).json({ error: "You can review a dish once you've received it" });
        }
        const [existing] = await db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.productId, String(productId)))).limit(1);
        if (existing) return res.status(409).json({ error: "You've already reviewed this dish" });

        const [{ id: newReviewId }] = await db.insert(reviews).values({
            userId,
            productId,
            rating,
            comment,
            status: 'approved' // Verified customers publish straight away. Admins only hide abuse or non-genuine reviews.
        }).$returningId();
        const [newReview] = await db.select().from(reviews).where(eq(reviews.id, newReviewId)).limit(1);

        res.status(201).json(newReview);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ADMIN ROUTES

// GET /api/reviews/admin/all
router.get("/admin/all", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

        const allReviews = await db.select({
            id: reviews.id,
            rating: reviews.rating,
            comment: reviews.comment,
            status: reviews.status,
            createdAt: reviews.createdAt,
            userName: users.name,
            productName: products.name
        })
            .from(reviews)
            .leftJoin(users, eq(reviews.userId, users.id))
            .leftJoin(products, eq(reviews.productId, products.id))
            .orderBy(desc(reviews.createdAt));

        res.json(allReviews);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// PATCH /api/reviews/:id/status
router.patch("/:id/status", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

        const { id } = req.params;
        const { status } = req.body;

        await db.update(reviews)
            .set({ status })
            .where(eq(reviews.id, Number(id)));
        const [updatedReview] = await db.select().from(reviews).where(eq(reviews.id, Number(id))).limit(1);

        res.json(updatedReview);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// DELETE /api/reviews/:id
router.delete("/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

        const { id } = req.params;

        await db.delete(reviews).where(eq(reviews.id, Number(id)));

        res.status(204).end();
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export const reviewsRouter = router;
