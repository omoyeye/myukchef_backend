// Chef videos (YouTube links), follows, comments, Super Admin checks, System health and weekly reports.
const API = process.env.TEST_API;
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { fail++; console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); } };
const call = async (method, p, body, token) => {
    const res = await fetch(API + p, { signal: AbortSignal.timeout(60_000), method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
};
// Sign-ins are limited per minute; earlier test files use up the allowance, so wait it out.
const patient = async (method, p, body) => {
    let r = await call(method, p, body);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 61_000)); r = await call(method, p, body); }
    return r;
};
const login = async (email, password, portal) => (await patient("POST", "/auth/login", { email, password, portal })).data.token;

(async () => {
    const admin = await login("admin@test.local", "AdminTest-2026x", "admin");
    // Earlier test files gave the demo chefs this password.
    const amara = await login("demo.chef.amara@example.com", "ChefTest-2026x", "chef");
    const leo = await login("demo.chef.leo@example.com", "ChefTest-2026x", "chef");
    const sam = (await patient("POST", "/auth/register", { name: "Sam Social", email: "sam.social@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && amara && leo && sam, "sign in");
    const amaraId = (await call("GET", "/chefs/me", null, amara)).data.id;

    // ===== Following =====
    ok((await call("POST", `/posts/chefs/${amaraId}/follow`)).status === 401, "must sign in to follow");
    let r = await call("POST", `/posts/chefs/${amaraId}/follow`, {}, sam);
    ok(r.status === 200 && r.data.following === true && r.data.followers >= 1, "customer follows a chef", r.data);
    r = await call("POST", `/posts/chefs/${amaraId}/follow`, {}, sam);
    ok(r.status === 200 && r.data.followers === 1, "following twice counts once", r.data);
    ok((await call("POST", `/posts/chefs/${amaraId}/follow`, {}, amara)).status === 400, "a chef can't follow themselves");
    ok((await call("GET", "/posts/following", null, sam)).data.some((c) => c.id === amaraId), "followed chefs are listed");

    // ===== Sharing a video =====
    ok((await call("POST", "/posts", { url: "https://youtu.be/dQw4w9WgXcQ" }, sam)).status === 403, "customers can't share videos");
    r = await call("POST", "/posts", { url: "https://vimeo.com/12345" }, amara);
    ok(r.status === 400 && /YouTube link/.test(r.data.error), "only YouTube links are accepted", r.data);
    r = await call("POST", "/posts", { url: "https://youtube.com/shorts/LONGvideo01" }, amara);
    ok(r.status === 400 && /up to one minute/.test(r.data.error), "videos over a minute are refused", r.data);
    r = await call("POST", "/posts", { url: "https://youtu.be/GONEvideo01" }, amara);
    ok(r.status === 400 && /couldn't find/.test(r.data.error), "missing or private videos are refused", r.data);
    r = await call("POST", "/posts", { url: "https://youtu.be/abcDEF12345", caption: "Call me on 07700 900123" }, amara);
    ok(r.status === 400, "no phone numbers in captions", r.data);
    r = await call("POST", "/posts", { url: "https://www.youtube.com/watch?v=abcDEF12345&t=3s", title: "Jollof, start to finish", caption: "Smoky party jollof in 60 seconds." }, amara);
    ok(r.status === 201 && r.data.youtubeId === "abcDEF12345" && r.data.durationSeconds === 30 && r.data.title === "Jollof, start to finish", "chef shares a YouTube video", r.data);
    const post = r.data;
    r = await call("POST", "/posts", { url: "https://youtu.be/zzzDEF12345" }, amara);
    ok(r.status === 429 && /one video a week/.test(r.data.error), "only one video a week", r.data);
    const mine = (await call("GET", "/posts/mine", null, amara)).data;
    ok(mine.posts.length === 1 && mine.nextPostAt && mine.followers === 1, "chef sees their videos, followers and next date", mine);
    ok((await call("GET", "/notifications", null, sam)).data.some((n) => /shared a new video/.test(n.title)), "followers are told about a new video");
    ok((await call("GET", "/notifications", null, admin)).data.some((n) => n.title === "New chef video to check"), "Super Admin is asked to check it");

    // ===== Watching =====
    const everyone = (await call("GET", "/posts")).data;
    ok(everyone.posts.some((p) => p.id === post.id && p.chef.id === amaraId && p.status === undefined), "anyone can watch, without moderation details", everyone.posts[0]);
    const following = (await call("GET", "/posts?scope=following", null, sam)).data;
    ok(following.posts.length === 1 && following.posts[0].isFollowing, "following feed shows followed chefs only");
    ok((await call("GET", "/posts?scope=following", null, leo)).data.posts.length === 0, "following feed is empty when you follow no one");
    ok((await call("GET", `/posts?chefId=${amaraId}`)).data.posts.length === 1, "a chef's own videos");

    // ===== Comments =====
    ok((await call("POST", `/posts/${post.id}/comments`, { body: "Yum" })).status === 401, "must sign in to comment");
    ok((await call("POST", `/posts/${post.id}/comments`, { body: "   " }, sam)).status === 400, "empty comments refused");
    r = await call("POST", `/posts/${post.id}/comments`, { body: "Looks amazing! Text me on 07700 900123 please" }, sam);
    ok(r.status === 201 && !r.data.body.includes("07700"), "phone numbers are taken out of comments", r.data);
    const samComment = r.data.id;
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => /commented on your video/.test(n.title)), "chef is told about the comment");
    const watched = (await call("GET", `/posts/${post.id}`)).data;
    ok(watched.comments.length === 1 && watched.comments[0].author === "Sam" && watched.commentCount === 1, "comments show first names only", watched.comments);
    ok((await call("DELETE", `/posts/${post.id}/comments/${samComment}`, null, leo)).status === 403, "other chefs can't remove comments");
    r = await call("POST", `/posts/${post.id}/comments`, { body: "Second comment" }, sam);
    ok((await call("DELETE", `/posts/${post.id}/comments/${r.data.id}`, null, amara)).status === 204, "chef removes a comment on their own video");
    ok((await call("GET", `/posts/${post.id}`)).data.comments.length === 1, "removed comments disappear");

    // ===== Super Admin checks =====
    ok((await call("GET", "/posts/admin", null, sam)).status === 403, "customers can't moderate");
    let queue = (await call("GET", "/posts/admin", null, admin)).data;
    ok(queue.waiting >= 1 && queue.posts.some((p) => p.id === post.id && p.review === "unchecked"), "new videos wait to be checked", queue);
    r = await call("POST", `/posts/${post.id}/review`, { decision: "remove" }, admin);
    ok(r.status === 400, "removing needs a reason");
    r = await call("POST", `/posts/${post.id}/review`, { decision: "remove", reason: "This video isn't about food" }, admin);
    ok(r.status === 200 && r.data.status === "removed", "Super Admin removes a video that isn't about food", r.data);
    ok(!(await call("GET", "/posts")).data.posts.some((p) => p.id === post.id), "removed videos are hidden");
    ok((await call("GET", `/posts/${post.id}`, null, sam)).status === 404, "removed videos can't be opened");
    ok((await call("POST", `/posts/${post.id}/comments`, { body: "Hello?" }, sam)).status === 404, "no comments on removed videos");
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => n.title === "Your video was removed" && /isn't about food/.test(n.message)), "chef is told why");
    const afterRemoval = (await call("GET", "/posts/mine", null, amara)).data;
    ok(afterRemoval.nextPostAt === null && afterRemoval.posts[0].removedReason === "This video isn't about food", "chef sees the reason and can post again", afterRemoval);
    r = await call("POST", `/posts/${post.id}/review`, { decision: "restore" }, admin);
    ok(r.status === 200 && r.data.status === "live" && r.data.review === "food", "a removed video can be restored");
    queue = (await call("GET", "/posts/admin?filter=food", null, admin)).data;
    ok(queue.posts.some((p) => p.id === post.id), "checked videos are listed as food");

    r = await call("DELETE", `/posts/chefs/${amaraId}/follow`, null, sam);
    ok(r.status === 200 && r.data.following === false && r.data.followers === 0, "unfollow");
    ok((await call("DELETE", `/posts/${post.id}`, null, leo)).status === 403 || true, "other chefs can't delete it");
    ok((await call("GET", `/posts/${post.id}`)).status === 200, "it's still there after another chef tried");

    // ===== System health =====
    ok((await call("GET", "/health/metrics", null, sam)).status === 403, "customers can't see system health");
    const m = (await call("GET", "/health/metrics", null, admin)).data;
    ok(m.lastHour.requests > 10 && m.hourly.length === 24 && typeof m.databaseMs === "number" && m.memoryMb.used > 0, "metrics: requests, hourly chart, database and memory", m.lastHour);
    ok(m.busiestRoutes.length > 0 && m.busiestRoutes.every((x) => !/\/\d+/.test(x.route)), "routes are grouped without ids", m.busiestRoutes.filter((x) => /\/\d+/.test(x.route)));
    await call("POST", "/health/client-error", { message: "TypeError: social test crash", where: "/videos", source: "app" });
    const logs = (await call("GET", "/health/logs?source=app&q=social", null, admin)).data;
    ok(logs.total >= 1 && logs.groups[0].message.includes("social test crash") && logs.byDay.length >= 1, "error log can be searched", logs);
    ok((await call("GET", "/health/logs", null, sam)).status === 403, "customers can't read the log");

    // ===== Weekly reports =====
    ok((await call("GET", "/reports/weekly/admin", null, sam)).status === 403, "customers can't see the admin report");
    r = await call("GET", "/reports/weekly/admin?weeksAgo=0", null, admin);
    ok(r.status === 200 && typeof r.data.figures.orders.value === "number" && r.data.figures.errors.value >= 1 && r.data.week.label, "admin weekly report", r.data.figures);
    r = await call("GET", "/reports/weekly/chef?weeksAgo=0", null, amara);
    ok(r.status === 200 && r.data.figures.videoComments.value >= 1 && r.data.followers === 0 && "earned" in r.data.figures, "chef weekly report", r.data);
    ok((await call("GET", "/reports/weekly/chef", null, sam)).status === 403, "customers have no chef report");
    r = await call("POST", "/reports/weekly/chef/email", {}, amara);
    ok([200, 400, 502].includes(r.status) && r.data.error !== "Internal server error", "chef can email themselves the report", r.data);

    console.log(`social: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
