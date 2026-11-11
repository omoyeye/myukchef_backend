import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chefProducts, chefReviews, chefs, eventQuotes, events, mealPlans, mealPlanWeeks, orderItems, orders, products, users } from "../db/schema";
import { getUserId, requireAdmin, requireAuth } from "../lib/auth";
import { notifyChef, notify } from "../lib/mealPlans";
import { assertNoContactDetails } from "../lib/contactGuard";
import { badRequest } from "../lib/pricing";
import { rateLimit } from "../lib/rateLimit";

const router = Router();

export const REVIEW_TAGS = ["Delicious", "Generous portions", "On time", "Great value", "Lovely packaging", "Great with dietary needs", "Friendly", "Would recommend"];

/**
 * UK law bans reviews that aren't based on a genuine experience, so only someone this chef
 * has actually cooked for can rate them. Returns how they know the chef, or null.
 */
export async function reviewSource(userId: number, chefId: number): Promise<"meal_plan" | "order" | "event" | null> {
    const [delivered] = await db.select({ id: mealPlanWeeks.id }).from(mealPlanWeeks)
        .innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id))
        .where(and(eq(mealPlans.userId, userId), eq(mealPlans.chefId, chefId), eq(mealPlanWeeks.status, "delivered")))
        .limit(1);
    if (delivered) return "meal_plan";
    const [ordered] = await db.select({ id: orders.id }).from(orders)
        .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
        .innerJoin(chefProducts, eq(orderItems.chefProductId, chefProducts.id))
        .where(and(eq(orders.userId, userId), eq(orders.status, "completed"), eq(chefProducts.chefId, chefId)))
        .limit(1);
    if (ordered) return "order";
    const [orderedFromMenu] = await db.select({ id: orders.id }).from(orders)
        .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
        .innerJoin(products, eq(orderItems.productId, products.id))
        .where(and(eq(orders.userId, userId), eq(orders.status, "completed"), eq(products.chefId, chefId)))
        .limit(1);
    if (orderedFromMenu) return "order";
    const [booked] = await db.select({ id: events.id }).from(events)
        .where(and(eq(events.userId, userId), eq(events.chefId, chefId), eq(events.status, "completed")))
        .limit(1);
    if (booked) return "event";
    const [quoted] = await db.select({ id: eventQuotes.id }).from(eventQuotes)
        .innerJoin(events, eq(eventQuotes.eventId, events.id))
        .where(and(eq(events.userId, userId), eq(eventQuotes.chefId, chefId), eq(eventQuotes.status, "accepted"), eq(events.status, "completed")))
        .limit(1);
    return quoted ? "event" : null;
}

const stars = (value: unknown) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

// Reviewers appear as "Sam T." so their full name isn't published.
const shortName = (name: string | null) => {
    const [first, last] = (name ?? "Customer").trim().split(/\s+/);
    return last ? `${first} ${last[0].toUpperCase()}.` : first;
};

const average = (values: (number | null)[]) => {
    const known = values.filter((v): v is number => v !== null);
    return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
};

// GET /chef-reviews/chef/:chefId: public reviews and summary
router.get("/chef/:chefId", async (req, res) => {
    const chefId = Number(req.params.chefId);
    const rows = await db.select({ review: chefReviews, name: users.name }).from(chefReviews)
        .innerJoin(users, eq(chefReviews.userId, users.id))
        .where(and(eq(chefReviews.chefId, chefId), eq(chefReviews.status, "published")))
        .orderBy(desc(chefReviews.createdAt));
    const all = rows.map((r) => r.review);
    const tagCounts = new Map<string, number>();
    for (const review of all) for (const tag of review.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    res.json({
        summary: {
            average: average(all.map((r) => r.rating)),
            count: all.length,
            distribution: [5, 4, 3, 2, 1].map((value) => ({ stars: value, count: all.filter((r) => r.rating === value).length })),
            taste: average(all.map((r) => r.tasteRating)),
            reliability: average(all.map((r) => r.reliabilityRating)),
            value: average(all.map((r) => r.valueRating)),
            topTags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, count]) => ({ tag, count })),
        },
        reviews: rows.slice(0, 50).map(({ review, name }) => ({
            id: review.id,
            rating: review.rating,
            comment: review.comment,
            tags: review.tags ?? [],
            source: review.source,
            chefReply: review.chefReply,
            createdAt: review.createdAt,
            updatedAt: review.updatedAt,
            author: shortName(name),
        })),
    });
});

// GET /chef-reviews/chef/:chefId/mine: can this customer rate this chef, and have they already?
router.get("/chef/:chefId/mine", requireAuth, async (req, res) => {
    const chefId = Number(req.params.chefId);
    const userId = getUserId(req);
    const [review] = await db.select().from(chefReviews).where(and(eq(chefReviews.userId, userId), eq(chefReviews.chefId, chefId))).limit(1);
    res.json({ canReview: !!(await reviewSource(userId, chefId)), review: review ?? null, tags: REVIEW_TAGS });
});

// PUT /chef-reviews/chef/:chefId: create or update this customer's single review of a chef
router.put("/chef/:chefId", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    const chefId = Number(req.params.chefId);
    const userId = getUserId(req);
    const [chef] = await db.select({ id: chefs.id, userId: chefs.userId }).from(chefs).where(eq(chefs.id, chefId)).limit(1);
    if (!chef) return res.status(404).json({ error: "Chef not found" });
    if (chef.userId === userId) throw badRequest("You can't rate yourself");
    const source = await reviewSource(userId, chefId);
    if (!source) return res.status(403).json({ error: "You can rate a chef once they've cooked for you" });

    const rating = stars(req.body.rating);
    if (!rating) throw badRequest("Please choose a rating from 1 to 5 stars");
    const values = {
        rating,
        tasteRating: stars(req.body.tasteRating),
        reliabilityRating: stars(req.body.reliabilityRating),
        valueRating: stars(req.body.valueRating),
        comment: String(req.body.comment ?? "").trim().slice(0, 1000) || null,
        tags: Array.isArray(req.body.tags) ? [...new Set<string>(req.body.tags)].filter((t) => REVIEW_TAGS.includes(t)) : [],
        source,
    };
    assertNoContactDetails(values.comment);
    const [existing] = await db.select().from(chefReviews).where(and(eq(chefReviews.userId, userId), eq(chefReviews.chefId, chefId))).limit(1);
    if (existing) {
        // A hidden review stays hidden after an edit, until an admin has looked at it again.
        await db.update(chefReviews).set({ ...values, updatedAt: new Date() }).where(eq(chefReviews.id, existing.id));
    } else {
        await db.insert(chefReviews).values({ ...values, userId, chefId });
        await notifyChef(chefId, "You have a new review", `A customer gave you ${rating} out of 5 stars.`);
    }
    const [saved] = await db.select().from(chefReviews).where(and(eq(chefReviews.userId, userId), eq(chefReviews.chefId, chefId))).limit(1);
    res.status(existing ? 200 : 201).json(saved);
});

// DELETE /chef-reviews/chef/:chefId: customers can remove their own review
router.delete("/chef/:chefId", requireAuth, async (req, res) => {
    await db.delete(chefReviews).where(and(eq(chefReviews.userId, getUserId(req)), eq(chefReviews.chefId, Number(req.params.chefId))));
    res.json({ message: "Review removed" });
});

// GET /chef-reviews/received: what the signed-in chef has been told
router.get("/received", requireAuth, async (req, res) => {
    const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1);
    if (!chef) return res.status(403).json({ error: "Chef account required" });
    const rows = await db.select({ review: chefReviews, name: users.name }).from(chefReviews)
        .innerJoin(users, eq(chefReviews.userId, users.id))
        .where(and(eq(chefReviews.chefId, chef.id), eq(chefReviews.status, "published")))
        .orderBy(desc(chefReviews.createdAt));
    res.json(rows.map(({ review, name }) => ({ ...review, author: shortName(name) })));
});

// POST /chef-reviews/:id/reply: a chef's public reply
router.post("/:id/reply", requireAuth, rateLimit(20, 60_000), async (req, res) => {
    const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1);
    const [review] = await db.select().from(chefReviews).where(eq(chefReviews.id, Number(req.params.id))).limit(1);
    if (!review || !chef || review.chefId !== chef.id) return res.status(404).json({ error: "Review not found" });
    const reply = String(req.body.reply ?? "").trim().slice(0, 500);
    assertNoContactDetails(reply);
    await db.update(chefReviews).set({ chefReply: reply || null, chefRepliedAt: reply ? new Date() : null }).where(eq(chefReviews.id, review.id));
    if (reply) await notify(review.userId, "Your chef replied to your review", reply.slice(0, 120), `/chefs/${chef.id}`);
    res.json({ chefReply: reply || null });
});

// === ADMIN ===

router.get("/admin/all", requireAdmin, async (_req, res) => {
    const rows = await db.select({ review: chefReviews, customerName: users.name, chefName: chefs.displayName }).from(chefReviews)
        .innerJoin(users, eq(chefReviews.userId, users.id))
        .innerJoin(chefs, eq(chefReviews.chefId, chefs.id))
        .orderBy(desc(chefReviews.createdAt));
    res.json(rows.map((r) => ({ ...r.review, customerName: r.customerName, chefName: r.chefName })));
});

router.patch("/admin/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body.status;
    if (status !== undefined && !["published", "hidden"].includes(status)) throw badRequest("Invalid status");
    const [review] = await db.select().from(chefReviews).where(eq(chefReviews.id, id)).limit(1);
    if (!review) return res.status(404).json({ error: "Review not found" });
    await db.update(chefReviews).set({
        status: status ?? review.status,
        ...(req.body.clearReply ? { chefReply: null, chefRepliedAt: null } : {}),
    }).where(eq(chefReviews.id, id));
    const [updated] = await db.select().from(chefReviews).where(eq(chefReviews.id, id)).limit(1);
    res.json(updated);
});

router.delete("/admin/:id", requireAdmin, async (req, res) => {
    await db.delete(chefReviews).where(inArray(chefReviews.id, [Number(req.params.id)]));
    res.json({ message: "Review deleted" });
});

export const chefReviewsRouter = router;
