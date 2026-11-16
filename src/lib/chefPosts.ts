import { and, count, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "../db";
import { chefFollows, chefPosts, chefs, postComments, users } from "../db/schema";
import { assertNoContactDetails, redactContactDetails } from "./contactGuard";
import { notify, notifyAdmins, notifyChef } from "./notify";
import { withTemplate } from "./templates";
import { lookUpVideo, MAX_POST_SECONDS, youtubeIdFrom } from "./youtube";

/**
 * Chef videos: each approved chef shares one YouTube video a week, up to a minute long. Customers
 * follow chefs and comment. A Super Admin checks every video is about food and removes any that isn't.
 */

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const WEEK_MS = 7 * 24 * 3600_000;
const PAGE = 20;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+\n/g, "\n").slice(0, max) : "");
const firstName = (name: string) => name.split(" ")[0] || name;

type PostRow = typeof chefPosts.$inferSelect;
const chefFields = { id: chefs.id, displayName: chefs.displayName, avatar: chefs.avatar, userId: chefs.userId };

async function chefForUser(userId: number) {
    const [chef] = await db.select().from(chefs).where(eq(chefs.userId, userId)).limit(1);
    if (!chef) throw fail(403, "Only chefs can share videos.");
    return chef;
}

/** When the chef may share their next video: a week after their last one that's still up. */
export async function nextPostAt(chefId: number) {
    const [last] = await db.select({ at: chefPosts.createdAt }).from(chefPosts)
        .where(and(eq(chefPosts.chefId, chefId), eq(chefPosts.status, "live"))).orderBy(desc(chefPosts.createdAt)).limit(1);
    if (!last) return null;
    const next = new Date(new Date(last.at).getTime() + WEEK_MS);
    return next.getTime() > Date.now() ? next : null;
}

const followerCount = async (chefId: number) =>
    (await db.select({ n: count() }).from(chefFollows).where(eq(chefFollows.chefId, chefId)))[0]?.n ?? 0;

/** Adds the chef, comment count and (for a signed-in viewer) whether they follow the chef. */
async function present(rows: PostRow[], viewerId: number, opts: { admin?: boolean } = {}) {
    if (!rows.length) return [];
    const chefIds = [...new Set(rows.map((r) => r.chefId))];
    const postIds = rows.map((r) => r.id);
    const [chefRows, comments, follows] = await Promise.all([
        db.select(chefFields).from(chefs).where(inArray(chefs.id, chefIds)),
        db.select({ postId: postComments.postId, n: count() }).from(postComments)
            .where(and(inArray(postComments.postId, postIds), eq(postComments.status, "visible"))).groupBy(postComments.postId),
        viewerId ? db.select({ chefId: chefFollows.chefId }).from(chefFollows).where(and(eq(chefFollows.userId, viewerId), inArray(chefFollows.chefId, chefIds))) : Promise.resolve([]),
    ]);
    const followed = new Set(follows.map((f) => f.chefId));
    return rows.map((r) => {
        const chef = chefRows.find((c) => c.id === r.chefId);
        return {
            id: r.id,
            youtubeId: r.youtubeId,
            title: r.title,
            caption: r.caption,
            durationSeconds: r.durationSeconds,
            createdAt: r.createdAt,
            commentCount: comments.find((c) => c.postId === r.id)?.n ?? 0,
            chef: chef ? { id: chef.id, displayName: chef.displayName, avatar: chef.avatar } : null,
            isFollowing: followed.has(r.chefId),
            mine: !!chef && chef.userId === viewerId,
            ...(opts.admin || (chef && chef.userId === viewerId)
                ? { status: r.status, review: r.review, removedReason: r.removedReason, reviewedAt: r.reviewedAt }
                : {}),
        };
    });
}

// === Chefs share videos ===

export async function createPost(userId: number, body: Record<string, unknown>) {
    const chef = await chefForUser(userId);
    if (chef.status !== "approved") throw fail(403, "You can share videos once your chef account is approved.");
    const next = await nextPostAt(chef.id);
    if (next) throw fail(429, `You can share one video a week. Your next one can go up on ${next.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" })}.`);

    const youtubeId = youtubeIdFrom(body.url);
    if (!youtubeId) throw fail(400, "Paste a YouTube link, like https://youtube.com/shorts/... or https://youtu.be/...");
    const caption = text(body.caption, 500) || null;
    let title = text(body.title, 150);
    assertNoContactDetails(title, caption ?? "");

    const info = await lookUpVideo(youtubeId);
    if (info.durationSeconds !== null && info.durationSeconds > MAX_POST_SECONDS) {
        throw fail(400, `Videos can be up to one minute long. This one is ${Math.floor(info.durationSeconds / 60)}:${String(info.durationSeconds % 60).padStart(2, "0")}.`);
    }
    title ||= info.title.slice(0, 150) || "My latest dish";
    assertNoContactDetails(title);

    const [{ id }] = await db.insert(chefPosts).values({ chefId: chef.id, youtubeId, title, caption, durationSeconds: info.durationSeconds }).$returningId();

    // Followers hear about it; the Super Admin is asked to check it's about food.
    const fans = await db.select({ userId: chefFollows.userId }).from(chefFollows).where(eq(chefFollows.chefId, chef.id));
    for (const f of fans) {
        await withTemplate("post.new_video", { chefName: chef.displayName, title }, () =>
            notify(f.userId, `${chef.displayName} shared a new video`, title, `/videos/${id}`, "update")).catch(() => undefined);
    }
    await withTemplate("admin.post_to_review", { chefName: chef.displayName, title }, () =>
        notifyAdmins("New chef video to check", `${chef.displayName} shared "${title}". Check it's about food.`, "/admin/videos")).catch(() => undefined);
    return (await present([(await db.select().from(chefPosts).where(eq(chefPosts.id, id)).limit(1))[0]!], userId))[0]!;
}

/** The chef's own videos, including any the Super Admin removed, and when they can post next. */
export async function myPosts(userId: number) {
    const chef = await chefForUser(userId);
    const rows = await db.select().from(chefPosts).where(eq(chefPosts.chefId, chef.id)).orderBy(desc(chefPosts.createdAt)).limit(100);
    return { posts: await present(rows, userId), nextPostAt: await nextPostAt(chef.id), followers: await followerCount(chef.id), canPost: chef.status === "approved" };
}

/** A chef deletes their own video for good. */
export async function deletePost(userId: number, postId: number) {
    const chef = await chefForUser(userId);
    const [post] = await db.select().from(chefPosts).where(and(eq(chefPosts.id, postId), eq(chefPosts.chefId, chef.id))).limit(1);
    if (!post) throw fail(404, "Video not found");
    await db.delete(chefPosts).where(eq(chefPosts.id, post.id));
}

// === Watching ===

export async function listPosts(viewerId: number, query: { scope?: unknown; chefId?: unknown; page?: unknown }) {
    const page = Math.max(1, Math.min(100, Number(query.page) || 1));
    const conditions = [eq(chefPosts.status, "live"), eq(chefs.status, "approved")];
    const chefId = Number(query.chefId);
    if (chefId) conditions.push(eq(chefPosts.chefId, chefId));
    if (query.scope === "following") {
        if (!viewerId) throw fail(401, "Sign in to see videos from chefs you follow.");
        conditions.push(inArray(chefPosts.chefId, db.select({ id: chefFollows.chefId }).from(chefFollows).where(eq(chefFollows.userId, viewerId))));
    }
    const rows = await db.select({ post: chefPosts }).from(chefPosts).innerJoin(chefs, eq(chefs.id, chefPosts.chefId))
        .where(and(...conditions)).orderBy(desc(chefPosts.createdAt), desc(chefPosts.id)).limit(PAGE + 1).offset((page - 1) * PAGE);
    return { posts: await present(rows.slice(0, PAGE).map((r) => r.post), viewerId), hasMore: rows.length > PAGE, page };
}

export async function getPost(viewerId: number, postId: number, isAdmin = false) {
    const [row] = await db.select({ post: chefPosts, chefStatus: chefs.status, chefUserId: chefs.userId }).from(chefPosts)
        .innerJoin(chefs, eq(chefs.id, chefPosts.chefId)).where(eq(chefPosts.id, postId)).limit(1);
    const own = row?.chefUserId === viewerId;
    if (!row || (!isAdmin && !own && (row.post.status !== "live" || row.chefStatus !== "approved"))) throw fail(404, "This video isn't available.");
    const comments = await db.select({ id: postComments.id, body: postComments.body, createdAt: postComments.createdAt, userId: postComments.userId, name: users.name, status: postComments.status })
        .from(postComments).innerJoin(users, eq(users.id, postComments.userId))
        .where(and(eq(postComments.postId, postId), ...(isAdmin ? [] : [eq(postComments.status, "visible")])))
        .orderBy(desc(postComments.createdAt)).limit(200);
    const [post] = await present([row.post], viewerId, { admin: isAdmin });
    return {
        ...post!,
        comments: comments.map((c) => ({
            id: c.id,
            body: c.body,
            createdAt: c.createdAt,
            author: firstName(c.name),
            mine: c.userId === viewerId,
            canRemove: isAdmin || own || c.userId === viewerId,
            ...(isAdmin ? { status: c.status } : {}),
        })),
    };
}

// === Comments ===

export async function addComment(userId: number, postId: number, input: unknown) {
    const [row] = await db.select({ post: chefPosts, chef: chefs }).from(chefPosts).innerJoin(chefs, eq(chefs.id, chefPosts.chefId)).where(eq(chefPosts.id, postId)).limit(1);
    if (!row || row.post.status !== "live" || row.chef.status !== "approved") throw fail(404, "This video isn't available.");
    const raw = text(input, 500);
    if (!raw) throw fail(400, "Write a comment first.");
    // Phone numbers, emails and links are taken out, as everywhere else on MYUKCHEF.
    const body = redactContactDetails(raw) ?? "";
    if (!body.trim()) throw fail(400, "Comments can't include phone numbers, emails or links.");
    const recentByUser = await db.select({ n: count() }).from(postComments)
        .where(and(eq(postComments.userId, userId), gte(postComments.createdAt, new Date(Date.now() - 60_000))));
    if ((recentByUser[0]?.n ?? 0) >= 5) throw fail(429, "You're commenting very quickly. Please wait a moment.");
    const [{ id }] = await db.insert(postComments).values({ postId, userId, body }).$returningId();
    const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (row.chef.userId !== userId) {
        const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body;
        await withTemplate("chef.post_comment", { name: firstName(me?.name ?? "Someone"), title: row.post.title, preview }, () =>
            notifyChef(row.chef.id, `${firstName(me?.name ?? "Someone")} commented on your video`, preview, `/chef/dashboard?tab=videos&post=${postId}`, "message")).catch(() => undefined);
    }
    return { id, body, createdAt: new Date(), author: firstName(me?.name ?? ""), mine: true, canRemove: true };
}

/** The person who wrote it, the chef whose video it's on, or a Super Admin can take a comment down. */
export async function removeComment(userId: number, commentId: number, isAdmin: boolean) {
    const [row] = await db.select({ comment: postComments, chefUserId: chefs.userId }).from(postComments)
        .innerJoin(chefPosts, eq(chefPosts.id, postComments.postId)).innerJoin(chefs, eq(chefs.id, chefPosts.chefId))
        .where(eq(postComments.id, commentId)).limit(1);
    if (!row) throw fail(404, "Comment not found");
    if (!isAdmin && row.comment.userId !== userId && row.chefUserId !== userId) throw fail(403, "You can't remove this comment.");
    await db.update(postComments).set({ status: "removed" }).where(eq(postComments.id, commentId));
}

// === Following ===

export async function follow(userId: number, chefId: number, on: boolean) {
    const [chef] = await db.select({ id: chefs.id, userId: chefs.userId, status: chefs.status }).from(chefs).where(eq(chefs.id, chefId)).limit(1);
    if (!chef || chef.status !== "approved") throw fail(404, "Chef not found");
    if (chef.userId === userId) throw fail(400, "You can't follow yourself.");
    if (on) await db.insert(chefFollows).values({ userId, chefId }).onDuplicateKeyUpdate({ set: { userId } });
    else await db.delete(chefFollows).where(and(eq(chefFollows.userId, userId), eq(chefFollows.chefId, chefId)));
    return followState(userId, chefId);
}

export async function followState(userId: number, chefId: number) {
    const [mine] = userId ? await db.select({ c: chefFollows.chefId }).from(chefFollows).where(and(eq(chefFollows.userId, userId), eq(chefFollows.chefId, chefId))).limit(1) : [];
    return { following: !!mine, followers: await followerCount(chefId) };
}

export async function followingList(userId: number) {
    return db.select({ id: chefs.id, displayName: chefs.displayName, avatar: chefs.avatar, followedAt: chefFollows.createdAt })
        .from(chefFollows).innerJoin(chefs, eq(chefs.id, chefFollows.chefId))
        .where(and(eq(chefFollows.userId, userId), eq(chefs.status, "approved"))).orderBy(desc(chefFollows.createdAt));
}

// === Super Admin checks ===

export async function adminList(filter: unknown, page: unknown) {
    const p = Math.max(1, Number(page) || 1);
    const where = filter === "removed" ? eq(chefPosts.status, "removed")
        : filter === "food" ? and(eq(chefPosts.status, "live"), eq(chefPosts.review, "food"))
        : filter === "all" ? undefined
        : and(eq(chefPosts.status, "live"), eq(chefPosts.review, "unchecked"));
    const rows = await db.select().from(chefPosts).where(where).orderBy(desc(chefPosts.createdAt)).limit(PAGE + 1).offset((p - 1) * PAGE);
    const [waiting] = await db.select({ n: count() }).from(chefPosts).where(and(eq(chefPosts.status, "live"), eq(chefPosts.review, "unchecked")));
    return { posts: await present(rows.slice(0, PAGE), 0, { admin: true }), hasMore: rows.length > PAGE, page: p, waiting: waiting?.n ?? 0 };
}

/** food: it's fine. remove: take it down and tell the chef why. restore: put a removed video back. */
export async function reviewPost(adminId: number, postId: number, decision: unknown, reasonInput: unknown) {
    const [post] = await db.select().from(chefPosts).where(eq(chefPosts.id, postId)).limit(1);
    if (!post) throw fail(404, "Video not found");
    const reason = text(reasonInput, 300);
    const stamp = { reviewedBy: adminId, reviewedAt: new Date() };
    if (decision === "food") {
        await db.update(chefPosts).set({ ...stamp, review: "food", status: "live", removedReason: null }).where(eq(chefPosts.id, postId));
    } else if (decision === "remove") {
        if (!reason) throw fail(400, "Tell the chef why it's being removed.");
        await db.update(chefPosts).set({ ...stamp, status: "removed", removedReason: reason }).where(eq(chefPosts.id, postId));
        await withTemplate("chef.post_removed", { title: post.title, reason }, () =>
            notifyChef(post.chefId, "Your video was removed", `"${post.title}" was taken down: ${reason}. Videos must be about your food and cooking. You can share another one now.`, "/chef/dashboard?tab=videos")).catch(() => undefined);
    } else if (decision === "restore") {
        await db.update(chefPosts).set({ ...stamp, status: "live", review: "food", removedReason: null }).where(eq(chefPosts.id, postId));
    } else throw fail(400, "Choose food, remove or restore.");
    return (await present([(await db.select().from(chefPosts).where(eq(chefPosts.id, postId)).limit(1))[0]!], 0, { admin: true }))[0]!;
}

/** For weekly reports. */
export async function postStats(chefId: number, from: Date, to: Date) {
    const [followers] = await db.select({ n: count() }).from(chefFollows).where(and(eq(chefFollows.chefId, chefId), gte(chefFollows.createdAt, from), lt(chefFollows.createdAt, to)));
    const [comments] = await db.select({ n: count() }).from(postComments).innerJoin(chefPosts, eq(chefPosts.id, postComments.postId))
        .where(and(eq(chefPosts.chefId, chefId), eq(postComments.status, "visible"), gte(postComments.createdAt, from), lt(postComments.createdAt, to)));
    const [posts] = await db.select({ n: count() }).from(chefPosts).where(and(eq(chefPosts.chefId, chefId), ne(chefPosts.status, "removed"), gte(chefPosts.createdAt, from), lt(chefPosts.createdAt, to)));
    return { newFollowers: followers?.n ?? 0, comments: comments?.n ?? 0, videos: posts?.n ?? 0, followers: await followerCount(chefId) };
}

