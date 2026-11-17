// Customers can delete their own notifications: one at a time, every read one, or all of them.
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
const patient = async (method, p, body) => {
    let r = await call(method, p, body);
    if (r.status === 429) { await new Promise((done) => setTimeout(done, 61_000)); r = await call(method, p, body); }
    return r;
};

(async () => {
    const nia = (await patient("POST", "/auth/register", { name: "Nia Notified", email: "nia.notes@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    const other = (await patient("POST", "/auth/register", { name: "Oli Other", email: "oli.notes@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(nia && other, "sign in");
    // Three small wallet gifts each send a notice.
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const me = (await call("GET", "/auth/me", null, nia)).data;
    const userId = me.id ?? me.user?.id;
    for (let i = 0; i < 3; i++) await call("POST", "/wallet/admin/credit", { userId, amount: 1, note: `Thank you ${i}`, kind: "bonus" }, admin);
    let list = (await call("GET", "/notifications", null, nia)).data;
    ok(list.length >= 3, "has a few notifications", list.length);

    // ===== One at a time =====
    const first = list[0];
    ok((await call("DELETE", `/notifications/${first.id}`, null, other)).status === 404, "someone else can't delete it");
    ok((await call("DELETE", `/notifications/${first.id}`)).status === 401, "must be signed in");
    ok((await call("DELETE", `/notifications/${first.id}`, null, nia)).status === 200, "deleted");
    list = (await call("GET", "/notifications", null, nia)).data;
    ok(!list.some((n) => n.id === first.id), "gone from the list");
    ok((await call("DELETE", `/notifications/${first.id}`, null, nia)).status === 404, "can't delete twice");
    ok((await call("DELETE", "/notifications/abc", null, nia)).status === 404, "a bad id is not found");

    // ===== Clear the read ones =====
    await call("PATCH", `/notifications/${list[0].id}/read`, {}, nia);
    const unreadBefore = list.filter((n) => !n.isRead && n.id !== list[0].id).length;
    ok((await call("DELETE", "/notifications?only=read", null, nia)).status === 200, "cleared the read ones");
    list = (await call("GET", "/notifications", null, nia)).data;
    ok(list.length === unreadBefore && list.every((n) => !n.isRead), "only unread ones are left", list.map((n) => n.isRead));

    // ===== Clear all =====
    ok((await call("DELETE", "/notifications", null, nia)).status === 200, "cleared everything");
    ok((await call("GET", "/notifications", null, nia)).data.length === 0, "nothing left");

    console.log(`notifications: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
