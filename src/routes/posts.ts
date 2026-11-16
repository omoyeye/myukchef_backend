import { Router } from "express";
import { getUserId, isAdmin, requireAdmin, requireAuth } from "../lib/auth";
import { addComment, adminList, createPost, deletePost, follow, followingList, followState, getPost, listPosts, myPosts, removeComment, reviewPost } from "../lib/chefPosts";
import { rateLimit } from "../lib/rateLimit";

// Chef videos (YouTube links), follows and comments. See lib/chefPosts.ts for the rules.
const router = Router();
const id = (v: unknown) => Number(v) || 0;

// GET /posts?scope=following|all&chefId=&page=
router.get("/", async (req, res, next) => {
    try { res.json(await listPosts(getUserId(req), req.query)); } catch (e) { next(e); }
});

// GET /posts/mine: a chef's own videos and when they can post next
router.get("/mine", requireAuth, async (req, res, next) => {
    try { res.json(await myPosts(getUserId(req))); } catch (e) { next(e); }
});

// GET /posts/following: chefs the signed-in person follows
router.get("/following", requireAuth, async (req, res, next) => {
    try { res.json(await followingList(getUserId(req))); } catch (e) { next(e); }
});

// GET /posts/admin?filter=unchecked|food|removed|all: Super Admin checks
router.get("/admin", requireAdmin, async (req, res, next) => {
    try { res.json(await adminList(req.query.filter, req.query.page)); } catch (e) { next(e); }
});

// POST /posts/:id/review { decision: food|remove|restore, reason }
router.post("/:id/review", requireAdmin, async (req, res, next) => {
    try { res.json(await reviewPost(getUserId(req), id(req.params.id), req.body?.decision, req.body?.reason)); } catch (e) { next(e); }
});

// GET/POST/DELETE /posts/chefs/:chefId/follow
router.get("/chefs/:chefId/follow", async (req, res, next) => {
    try { res.json(await followState(getUserId(req), id(req.params.chefId))); } catch (e) { next(e); }
});
router.post("/chefs/:chefId/follow", requireAuth, rateLimit(30, 60_000), async (req, res, next) => {
    try { res.json(await follow(getUserId(req), id(req.params.chefId), true)); } catch (e) { next(e); }
});
router.delete("/chefs/:chefId/follow", requireAuth, async (req, res, next) => {
    try { res.json(await follow(getUserId(req), id(req.params.chefId), false)); } catch (e) { next(e); }
});

// POST /posts { url, title?, caption? }: a chef shares a YouTube video
router.post("/", requireAuth, rateLimit(10, 60_000), async (req, res, next) => {
    try { res.status(201).json(await createPost(getUserId(req), req.body ?? {})); } catch (e) { next(e); }
});

// GET /posts/:id: one video with its comments
router.get("/:id", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        res.json(await getPost(userId, id(req.params.id), userId ? await isAdmin(userId) : false));
    } catch (e) { next(e); }
});

// DELETE /posts/:id: the chef deletes their own video
router.delete("/:id", requireAuth, async (req, res, next) => {
    try { await deletePost(getUserId(req), id(req.params.id)); res.status(204).end(); } catch (e) { next(e); }
});

// POST /posts/:id/comments { body }
router.post("/:id/comments", requireAuth, rateLimit(20, 60_000), async (req, res, next) => {
    try { res.status(201).json(await addComment(getUserId(req), id(req.params.id), req.body?.body)); } catch (e) { next(e); }
});

// DELETE /posts/:id/comments/:commentId
router.delete("/:id/comments/:commentId", requireAuth, async (req, res, next) => {
    try {
        const userId = getUserId(req);
        await removeComment(userId, id(req.params.commentId), await isAdmin(userId));
        res.status(204).end();
    } catch (e) { next(e); }
});

export default router;
