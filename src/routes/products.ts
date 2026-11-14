import { chefForMenu, sellingChefs } from "../lib/selling";
import { filterDishes, pageOf } from "../lib/search";
import { Router } from "express";
import { db } from "../db";
import { products, chefProducts, chefs, users } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { getUserId, isAdmin } from "../lib/auth";
import { cleanAllergens } from "../lib/allergens";
import { badRequest } from "../lib/pricing";

const router = Router();

const chefBrief = { id: chefs.id, displayName: chefs.displayName, avatar: chefs.avatar };

/** An empty choice clears the chef. Anything else must be a real chef. */
async function chefIdFrom(value: unknown) {
    if (value === undefined) return undefined;
    if (value === "" || value === null) return null;
    const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.id, Number(value))).limit(1);
    if (!chef) throw badRequest("Please choose a chef");
    return chef.id;
}

// GET /products
router.get("/", async (req, res) => {
    try {
        const rows = await db.select({ product: products }).from(products);
        // Dishes stay off sale until their allergens are confirmed. Admins still see them to fix them.
        const admin = await isAdmin(getUserId(req));
        // A dish cooked by a chef follows that chef's rules: allowed to sell, opening times and notice.
        const sellers = await sellingChefs();
        const everyChef = admin ? new Map((await db.select().from(chefs)).map((c) => [c.id, c])) : sellers;
        const now = new Date();
        let dishes = rows
            .filter((r) => admin || (r.product.allergensDeclared && (r.product.chefId === null || sellers.has(r.product.chefId))))
            .map((r) => {
                const chef = r.product.chefId !== null ? everyChef.get(r.product.chefId) : undefined;
                return { ...r.product, noticeHours: chef?.noticeHours ?? 0, chef: chef ? chefForMenu(chef, now) : null };
            });
        if (!admin) dishes = filterDishes(dishes, req.query);
        res.setHeader("X-Total-Count", String(dishes.length));
        res.json(admin ? dishes : pageOf(dishes, req.query));
    } catch (error) {
        console.error("Get products error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET /products/:id
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const [row] = await db.select({ product: products, chef: chefBrief }).from(products).leftJoin(chefs, eq(products.chefId, chefs.id)).where(eq(products.id, id)).limit(1);

        if (row && (row.product.allergensDeclared || (await isAdmin(getUserId(req))))) {
            const [chef] = row.product.chefId !== null ? await db.select().from(chefs).where(eq(chefs.id, row.product.chefId)).limit(1) : [];
            return res.json({ ...row.product, noticeHours: chef?.noticeHours ?? 0, chef: chef ? chefForMenu(chef) : row.chef });
        }

        // Menu pages link chef dishes here too, but only approved ones are public.
        const [chefDish] = await db.select({ product: chefProducts, chef: chefs })
            .from(chefProducts)
            .innerJoin(chefs, eq(chefProducts.chefId, chefs.id))
            .where(and(eq(chefProducts.id, id), eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true), eq(chefs.status, "approved")))
            .limit(1);

        if (!chefDish || !(await sellingChefs([chefDish.chef.id])).has(chefDish.chef.id)) {
            return res.status(404).json({ error: "Product not found" });
        }

        res.json({
            ...chefDish.product,
            noticeHours: Math.max(chefDish.product.noticeHours ?? 0, chefDish.chef.noticeHours),
            modifiers: [],
            chef: chefForMenu(chefDish.chef),
        });
    } catch (error) {
        console.error("Get product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /products (Create)
router.post("/", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const {
            id, name, description, price, category, image,
            modifiers, allergens, tags, calories,
            isVegetarian, isVegan, isGlutenFree, isHalal, isPopular
        } = req.body;

        // Generate a simple slug ID if none provided
        const slugId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const finalId = id || `${slugId}-${Date.now().toString().slice(-4)}`;

        await db.insert(products).values({
            chefId: await chefIdFrom(req.body.chefId),
            id: finalId,
            name,
            description,
            price,
            category,
            image,
            modifiers: modifiers || [],
            allergens: cleanAllergens(allergens),
            allergensDeclared: !!req.body.allergensDeclared,
            tags: tags || [],
            calories: calories ? Number(calories) : null,
            isVegetarian: !!isVegetarian,
            isVegan: !!isVegan,
            isGlutenFree: !!isGlutenFree,
            isHalal: !!isHalal,
            isPopular: !!isPopular,
        });
        const [newProduct] = await db.select().from(products).where(eq(products.id, finalId)).limit(1);
        res.status(201).json(newProduct);
    } catch (error) {
        if ((error as { status?: number }).status === 400) return res.status(400).json({ error: (error as Error).message });
        console.error("Create product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT /products/:id (Update)
router.put("/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const { id } = req.params;
        const {
            name, description, price, category, image, isSoldOut,
            modifiers, allergens, tags, calories,
            isVegetarian, isVegan, isGlutenFree, isHalal, isPopular
        } = req.body;

        await db.update(products)
            .set({
                chefId: await chefIdFrom(req.body.chefId),
                name, description, price, category, image, isSoldOut,
                modifiers: modifiers || [],
                allergens: cleanAllergens(allergens),
                allergensDeclared: !!req.body.allergensDeclared,
                tags: tags || [],
                calories: calories ? Number(calories) : null,
                isVegetarian: !!isVegetarian,
                isVegan: !!isVegan,
                isGlutenFree: !!isGlutenFree,
                isHalal: !!isHalal,
                isPopular: !!isPopular
            })
            .where(eq(products.id, id));
        const [updatedProduct] = await db.select().from(products).where(eq(products.id, id)).limit(1);

        if (!updatedProduct) {
            return res.status(404).json({ error: "Product not found" });
        }

        res.json(updatedProduct);
    } catch (error) {
        if ((error as { status?: number }).status === 400) return res.status(400).json({ error: (error as Error).message });
        console.error("Update product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE /products/:id (Delete)
router.delete("/:id", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Admins only" });
        }

        const { id } = req.params;
        const [existing] = await db.select().from(products).where(eq(products.id, id)).limit(1);

        if (!existing) {
            return res.status(404).json({ error: "Product not found" });
        }

        await db.delete(products).where(eq(products.id, id));

        res.json({ message: "Product deleted successfully" });
    } catch (error) {
        console.error("Delete product error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export const productsRouter = router;
