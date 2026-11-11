import { Router } from "express";
import { geocode } from "../lib/geo";
import { rateLimit } from "../lib/rateLimit";

const router = Router();

// GET /api/location/geocode?q=E1 6AN
router.get("/geocode", rateLimit(20, 60_000), async (req, res, next) => {
    try {
        const query = String(req.query.q ?? "").slice(0, 120);
        if (!query.trim()) return res.status(400).json({ error: "Enter a postcode or town" });
        const point = await geocode(query);
        if (!point) return res.status(404).json({ error: "We couldn't find that location. Try a UK postcode." });
        res.json(point);
    } catch (error) { next(error); }
});

export const locationRouter = router;
