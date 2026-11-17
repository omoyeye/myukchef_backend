import { Router } from "express";
import { getUserId, requireAdmin, requireAuth } from "../lib/auth";
import { rateLimit } from "../lib/rateLimit";
import {
    adminCredit, adminEntries, adminSummary, adminWallets, cancelCredits, payWithdrawal, rejectWithdrawal,
    releaseCredits, requestWithdrawal, saveWalletRules, walletFor,
} from "../lib/wallet";

// MYUKCHEF wallets. See lib/wallet.ts for how credit is earned, released, spent and withdrawn.
const router = Router();
const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : []);

// GET /wallet: my balance, rewards on their way, and history
router.get("/", requireAuth, async (req, res, next) => {
    try { res.json(await walletFor(getUserId(req))); } catch (e) { next(e); }
});

// POST /wallet/withdraw { amount }: chefs only
router.post("/withdraw", requireAuth, rateLimit(10, 60_000), async (req, res, next) => {
    try { res.status(201).json({ id: await requestWithdrawal(getUserId(req), req.body?.amount) }); } catch (e) { next(e); }
});

// === Super Admin ===
router.get("/admin/summary", requireAdmin, async (_req, res, next) => {
    try { res.json(await adminSummary()); } catch (e) { next(e); }
});
router.get("/admin/entries", requireAdmin, async (req, res, next) => {
    try { res.json(await adminEntries(req.query)); } catch (e) { next(e); }
});
router.get("/admin/wallets", requireAdmin, async (req, res, next) => {
    try { res.json(await adminWallets(req.query.q)); } catch (e) { next(e); }
});
router.get("/admin/users/:id", requireAdmin, async (req, res, next) => {
    try { res.json(await walletFor(Number(req.params.id))); } catch (e) { next(e); }
});
// POST /wallet/admin/release { ids: [] }
router.post("/admin/release", requireAdmin, async (req, res, next) => {
    try { res.json({ released: await releaseCredits(ids(req.body?.ids), getUserId(req)) }); } catch (e) { next(e); }
});
// POST /wallet/admin/cancel { ids: [], reason }
router.post("/admin/cancel", requireAdmin, async (req, res, next) => {
    try { res.json({ cancelled: await cancelCredits(ids(req.body?.ids), req.body?.reason, getUserId(req)) }); } catch (e) { next(e); }
});
// POST /wallet/admin/credit { userId, amount, note, kind: bonus|adjustment }
router.post("/admin/credit", requireAdmin, async (req, res, next) => {
    try { res.status(201).json({ id: await adminCredit(getUserId(req), req.body ?? {}) }); } catch (e) { next(e); }
});
// POST /wallet/admin/withdrawals/:id/pay { method: stripe|bank, reference? }
router.post("/admin/withdrawals/:id/pay", requireAdmin, async (req, res, next) => {
    try { await payWithdrawal(Number(req.params.id), getUserId(req), req.body ?? {}); res.json({ ok: true }); } catch (e) { next(e); }
});
// POST /wallet/admin/withdrawals/:id/reject { reason }
router.post("/admin/withdrawals/:id/reject", requireAdmin, async (req, res, next) => {
    try { await rejectWithdrawal(Number(req.params.id), getUserId(req), req.body?.reason); res.json({ ok: true }); } catch (e) { next(e); }
});
// PUT /wallet/admin/rules
router.put("/admin/rules", requireAdmin, async (req, res, next) => {
    try { res.json(await saveWalletRules(req.body)); } catch (e) { next(e); }
});

export default router;
