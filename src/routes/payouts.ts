import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chefInvoices, chefs, siteSettings, users } from "../db/schema";
import { getUserId, isAdmin, requireAdmin, requireAuth } from "../lib/auth";
import {
    allInvoices, getPayoutRules, holdInvoice, invoiceForViewer, invoicesForChef, markInvoicePaid,
    payInvoiceAutomatically, releaseInvoice, submitInvoice,
} from "../lib/chefPayouts";
import { getStripe } from "../lib/integrations";
import { deliveriesToCheck, releaseDisputedDelivery } from "../lib/orderProgress";

// Chef invoices, payouts and receipts. Chefs see only their own; the Super Admin sees everyone's.
const router = Router();
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SITE_URL = () => (process.env.SITE_URL || "https://myukchef.com").replace(/\/$/, "");

async function currentChef(req: Request) {
    const [chef] = await db.select().from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1);
    if (!chef) throw fail(403, "Chef account required");
    return chef;
}

/** Brings the chef's Stripe payout status up to date, and pays anything that was waiting for it. */
async function refreshConnect(chef: typeof chefs.$inferSelect) {
    if (!chef.stripeAccountId) return { connected: false, payoutsEnabled: false, stripeReady: !!(await getStripe()) };
    const stripe = await getStripe();
    if (!stripe) return { connected: true, payoutsEnabled: chef.stripePayoutsEnabled, stripeReady: false };
    const account = await stripe.client.accounts.retrieve(chef.stripeAccountId).catch(() => null);
    const enabled = !!account && account.payouts_enabled === true && account.capabilities?.transfers === "active";
    if (enabled !== chef.stripePayoutsEnabled) {
        await db.update(chefs).set({ stripePayoutsEnabled: enabled }).where(eq(chefs.id, chef.id));
        if (enabled) {
            const waiting = await db.select({ id: chefInvoices.id }).from(chefInvoices).where(and(eq(chefInvoices.chefId, chef.id), eq(chefInvoices.status, "submitted")));
            for (const invoice of waiting) await payInvoiceAutomatically(invoice.id).catch((e) => console.error("Payout retry failed:", e));
        }
    }
    return {
        connected: true,
        payoutsEnabled: enabled,
        stripeReady: true,
        needsMoreInfo: !!account && !enabled && (account.requirements?.currently_due?.length ?? 0) > 0,
    };
}

// === Chef ===

// GET /payouts/me: the chef's invoices, receipts and payout set-up
router.get("/me", requireAuth, async (req, res, next) => {
    try {
        const chef = await currentChef(req);
        res.json({ invoices: await invoicesForChef(chef.id), payoutAccount: await refreshConnect(chef), rules: await getPayoutRules() });
    } catch (error) { next(error); }
});

// POST /payouts/me/invoices/:id/submit { confirm: true, name }
router.post("/me/invoices/:id/submit", requireAuth, async (req, res, next) => {
    try {
        const chef = await currentChef(req);
        res.json(await submitInvoice(Number(req.params.id), chef.id, req.body ?? {}));
    } catch (error) { next(error); }
});

// POST /payouts/me/connect: opens Stripe's sign-up, so MYUKCHEF can pay the chef automatically
router.post("/me/connect", requireAuth, async (req, res, next) => {
    try {
        const chef = await currentChef(req);
        const stripe = await getStripe();
        if (!stripe) throw fail(400, "Automatic payouts aren't available yet. MYUKCHEF will pay you by bank transfer.");
        let accountId = chef.stripeAccountId;
        if (!accountId) {
            const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, chef.userId)).limit(1);
            try {
                const account = await stripe.client.accounts.create({
                    type: "express",
                    country: "GB",
                    email: user?.email,
                    business_type: "individual",
                    capabilities: { transfers: { requested: true } },
                    metadata: { chefId: String(chef.id) },
                });
                accountId = account.id;
            } catch (error) {
                console.error("Stripe Connect account failed:", (error as Error).message);
                throw fail(400, "Stripe payouts aren't set up on MYUKCHEF's side yet. You'll be paid by bank transfer for now.");
            }
            await db.update(chefs).set({ stripeAccountId: accountId, stripePayoutsEnabled: false }).where(eq(chefs.id, chef.id));
        }
        const back = `${SITE_URL()}/chef/dashboard?tab=payouts`;
        const link = await stripe.client.accountLinks.create({ account: accountId, type: "account_onboarding", refresh_url: `${back}&stripe=retry`, return_url: `${back}&stripe=done` });
        res.json({ url: link.url });
    } catch (error) { next(error); }
});

// GET /payouts/invoices/:id: one invoice or receipt, for its chef or a Super Admin
router.get("/invoices/:id", requireAuth, async (req, res, next) => {
    try {
        const admin = await isAdmin(getUserId(req));
        const [chef] = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.userId, getUserId(req))).limit(1);
        res.json(await invoiceForViewer(Number(req.params.id), { chefId: chef?.id ?? null, admin }));
    } catch (error) { next(error); }
});

// === Super Admin ===

// GET /payouts/admin: every invoice, and deliveries still waiting for the customer or with a problem
router.get("/admin", requireAdmin, async (_req, res, next) => {
    try {
        res.json({ invoices: await allInvoices(), deliveries: await deliveriesToCheck(), rules: await getPayoutRules() });
    } catch (error) { next(error); }
});

// PUT /payouts/admin/rules { percent, autoConfirmHours }
router.put("/admin/rules", requireAdmin, async (req, res, next) => {
    try {
        const percent = Number(req.body?.percent);
        const hours = Number(req.body?.autoConfirmHours);
        if (!Number.isFinite(percent) || percent < 0 || percent > 50) throw fail(400, "Commission must be between 0% and 50%.");
        if (!Number.isFinite(hours) || hours < 1 || hours > 336) throw fail(400, "Customers need between 1 hour and 14 days to confirm.");
        const value = { percent: Math.round(percent * 100) / 100, autoConfirmHours: Math.round(hours) };
        const [existing] = await db.select({ id: siteSettings.id }).from(siteSettings).where(eq(siteSettings.key, "chef_commission")).limit(1);
        if (existing) await db.update(siteSettings).set({ value, updatedAt: new Date() }).where(eq(siteSettings.id, existing.id));
        else await db.insert(siteSettings).values({ key: "chef_commission", value });
        res.json(await getPayoutRules());
    } catch (error) { next(error); }
});

// POST /payouts/admin/deliveries/:id/release: a reported problem is sorted, so the chef's invoice goes ahead
router.post("/admin/deliveries/:id/release", requireAdmin, async (req, res, next) => {
    try { res.json(await releaseDisputedDelivery(Number(req.params.id))); } catch (error) { next(error); }
});

// POST /payouts/admin/invoices/:id/pay: recorded after paying the chef by bank transfer
router.post("/admin/invoices/:id/pay", requireAdmin, async (req, res, next) => {
    try { res.json(await markInvoicePaid(Number(req.params.id), { method: "bank", by: getUserId(req) })); } catch (error) { next(error); }
});

// POST /payouts/admin/invoices/:id/retry: tries the automatic Stripe payout again
router.post("/admin/invoices/:id/retry", requireAdmin, async (req, res, next) => {
    try { res.json(await payInvoiceAutomatically(Number(req.params.id))); } catch (error) { next(error); }
});

// POST /payouts/admin/invoices/:id/hold { reason } and /release
router.post("/admin/invoices/:id/hold", requireAdmin, async (req, res, next) => {
    try { res.json(await holdInvoice(Number(req.params.id), req.body?.reason)); } catch (error) { next(error); }
});
router.post("/admin/invoices/:id/release", requireAdmin, async (req, res, next) => {
    try { res.json(await releaseInvoice(Number(req.params.id))); } catch (error) { next(error); }
});

export const payoutsRouter = router;
