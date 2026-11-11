import crypto from "crypto";
import bcrypt from "bcrypt";
import { eq, ne } from "drizzle-orm";
import { db } from "./db";
import { chefProducts, chefs, products, users } from "./db/schema";
import { demoChefs, demoDishChefs, demoDishes } from "./demo-dishes";
import { migrateAllergens } from "./lib/allergens";

/**
 * npm run db:seed                 creates or updates the admin account
 * npm run db:seed -- --demo       also adds sample dishes for local testing
 * npm run db:seed -- --reset      removes every dish and every other admin first
 *
 * Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD. Without a password, a strong one
 * is generated and printed once.
 */
const args = process.argv.slice(2);

async function seed() {
    await migrateAllergens();
    const email = (process.env.SEED_ADMIN_EMAIL || "info@myukchef.com").trim().toLowerCase();
    const generated = !process.env.SEED_ADMIN_PASSWORD;
    const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(15).toString("base64url");
    if (password.length < 12) throw new Error("SEED_ADMIN_PASSWORD must be at least 12 characters");

    if (args.includes("--reset")) {
        await db.delete(products);
        await db.update(users).set({ role: "customer" }).where(eq(users.role, "admin"));
        await db.delete(users).where(ne(users.role, "chef")).catch(() => {
            console.warn("Some accounts have orders or bookings, so they were kept as customers.");
        });
        console.log("Removed dishes and old admin access.");
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.insert(users).values({ name: "MYUKCHEF Admin", email, password: hashed, role: "admin" })
        .onDuplicateKeyUpdate({ set: { password: hashed, role: "admin" } });
    console.log(`Admin account ready: ${email}`);
    if (generated) console.log(`Generated password (shown once, change it after signing in): ${password}`);

    if (args.includes("--demo")) {
        // Sample chefs share one printed password, so the chef dashboard can be tried locally.
        const chefPassword = crypto.randomBytes(9).toString("base64url");
        const chefHash = await bcrypt.hash(chefPassword, 10);
        for (const { email: chefEmail, dishes, ...profile } of demoChefs) {
            await db.insert(users).values({ name: profile.displayName, email: chefEmail, password: chefHash, role: "chef" })
                .onDuplicateKeyUpdate({ set: { password: chefHash, role: "chef" } });
            const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, chefEmail)).limit(1);
            await db.insert(chefs).values({ ...profile, userId: account.id, status: "approved", approvedAt: new Date() })
                .onDuplicateKeyUpdate({ set: { displayName: profile.displayName, status: "approved" } });
            const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, account.id)).limit(1);
            for (const dish of dishes) {
                await db.insert(chefProducts).values({ ...dish, chefId: chef.id }).onDuplicateKeyUpdate({ set: { name: dish.name, price: dish.price, status: "approved", allergens: dish.allergens, allergensDeclared: true } });
            }
        }
        for (const dish of demoDishes) {
            const [owner] = await db.select({ id: chefs.id }).from(chefs).innerJoin(users, eq(chefs.userId, users.id)).where(eq(users.email, demoDishChefs[dish.id])).limit(1);
            await db.insert(products).values({ ...dish, chefId: owner?.id ?? null }).onDuplicateKeyUpdate({ set: { name: dish.name, price: dish.price, chefId: owner?.id ?? null, allergens: dish.allergens, allergensDeclared: true } });
        }
        console.log(`Added ${demoDishes.length} sample dishes.`);
        console.log(`Added ${demoChefs.length} sample chefs: ${demoChefs.map((c) => c.email).join(", ")}`);
        console.log(`Sample chef password: ${chefPassword}`);
    }
    process.exit(0);
}

seed().catch((err) => {
    console.error("Seeding failed:", err);
    process.exit(1);
});
