import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "../lib/rateLimit";
import { getRecommendations, recommendationRequestSchema } from "../lib/recommendations";

const router = Router();

// Each request can spend model tokens and the route is open to guests.
const limit = rateLimit(6, 60_000, "Too many requests. Please wait a minute and try again.");

// POST /api/recommendations
router.post("/", limit, async (req, res) => {
    try {
        const input = recommendationRequestSchema.parse(req.body);
        res.json(await getRecommendations(input));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error("Recommendations error:", error);
        res.status(500).json({ error: "Could not get recommendations. Please try again." });
    }
});

export const recommendationsRouter = router;
