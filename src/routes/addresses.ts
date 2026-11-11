import { Router } from "express";
import { db } from "../db";
import { addresses } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { getUserId } from "../lib/auth";

const router = Router();

// GET /api/addresses - Get all addresses for logged in user
router.get("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const userAddresses = await db.select().from(addresses).where(eq(addresses.userId, userId));
        res.json(userAddresses);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// POST /api/addresses - Add new address
router.post("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const { name, street, city, postcode, isDefault } = req.body;

        if (isDefault) {
            // Unset other defaults
            await db.update(addresses)
                .set({ isDefault: false })
                .where(eq(addresses.userId, userId));
        }

        const [{ id: newAddressId }] = await db.insert(addresses).values({
            userId,
            name,
            street,
            city,
            postcode,
            isDefault: isDefault || false
        }).$returningId();
        const [newAddress] = await db.select().from(addresses).where(eq(addresses.id, newAddressId)).limit(1);

        res.status(201).json(newAddress);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// DELETE /api/addresses/:id
router.delete("/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const addressId = Number(req.params.id);
        await db.delete(addresses).where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));

        res.json({ message: "Deleted" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export const addressesRouter = router;
