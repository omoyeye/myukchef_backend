// Banner adverts: Super Admin creates them and picks the website, the app, the page, the audience and the dates.
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
const titles = (r) => (Array.isArray(r.data) ? r.data.map((b) => b.title) : r.data);

(async () => {
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const chef = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const cust = (await patient("POST", "/auth/register", { name: "Bea Banner", email: "bea.banner@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && chef && cust, "sign in");

    // ===== Only Super Admins manage banners =====
    ok((await call("GET", "/banners/admin", null, cust)).status === 403, "customers can't manage banners");
    ok((await call("POST", "/banners/admin", { title: "Hi" }, chef)).status === 403, "chefs can't create banners");

    // ===== Checks =====
    ok((await call("POST", "/banners/admin", { title: "" }, admin)).status === 400, "a headline is needed");
    ok((await call("POST", "/banners/admin", { title: "Bad link", link: "javascript:alert(1)" }, admin)).status === 400, "unsafe links are refused");
    ok((await call("POST", "/banners/admin", { title: "Bad link", link: "//evil.example" }, admin)).status === 400, "links to other sites must be https");
    ok((await call("POST", "/banners/admin", { title: "Nowhere", showOnWebsite: false, showOnApp: false }, admin)).status === 400, "must show somewhere");
    ok((await call("POST", "/banners/admin", { title: "Dates", startsAt: "2026-12-10", endsAt: "2026-12-01" }, admin)).status === 400, "end date after start date");

    // ===== Create a few =====
    const make = async (body) => (await call("POST", "/banners/admin", body, admin)).data;
    const both = await make({ title: "Both places", message: "On the website and in the app", link: "/menu", ctaLabel: "Order now", sortOrder: 1 });
    ok(both.id && both.showOnWebsite && both.showOnApp && both.placement === "home", "banner created with defaults", both);
    await make({ title: "Website only", showOnApp: false, sortOrder: 2 });
    await make({ title: "App only", showOnWebsite: false, sortOrder: 3 });
    await make({ title: "Chefs only", audience: "chefs", placement: "everywhere" });
    await make({ title: "Signed out only", audience: "signed_out" });
    await make({ title: "Menu page", placement: "menu", link: "https://example.com/offer" });
    await make({ title: "Not yet", startsAt: new Date(Date.now() + 86400_000).toISOString() });
    await make({ title: "Ended", endsAt: new Date(Date.now() - 3600_000).toISOString() });
    const off = await make({ title: "Switched off", active: false });

    // ===== Who sees what =====
    let r = await call("GET", "/banners?platform=website&placement=home", null, cust);
    ok(JSON.stringify(titles(r)) === JSON.stringify(["Both places", "Website only"]), "website, home, customer", titles(r));
    r = await call("GET", "/banners?platform=app&placement=home", null, cust);
    ok(JSON.stringify(titles(r)) === JSON.stringify(["Both places", "App only"]), "app, home, customer", titles(r));
    r = await call("GET", "/banners?platform=website&placement=home");
    ok(titles(r).includes("Signed out only") && !titles(r).includes("Chefs only"), "signed-out visitors", titles(r));
    r = await call("GET", "/banners?platform=website&placement=menu", null, chef);
    ok(titles(r).includes("Menu page") && titles(r).includes("Chefs only") && !titles(r).includes("Both places"), "menu page, chef (everywhere banners too)", titles(r));
    ok(!("views" in r.data[0]) && !("audience" in r.data[0]), "the public don't see stats or targeting");

    // ===== Views and clicks =====
    await call("POST", `/banners/${both.id}/seen`, {});
    await call("POST", `/banners/${both.id}/seen`, {});
    await call("POST", `/banners/${both.id}/seen`, { clicked: true });
    let list = (await call("GET", "/banners/admin", null, admin)).data;
    const counted = list.find((b) => b.id === both.id);
    ok(counted.views === 2 && counted.clicks === 1, "views and clicks counted", counted);

    // ===== Edit, switch off, delete =====
    r = await call("PUT", `/banners/admin/${both.id}`, { ...both, title: "Both places, edited", showOnApp: false }, admin);
    ok(r.status === 200 && r.data.title === "Both places, edited" && r.data.showOnApp === false, "edited", r.data);
    ok(!titles(await call("GET", "/banners?platform=app&placement=home", null, cust)).includes("Both places, edited"), "taken off the app");
    r = await call("PUT", `/banners/admin/${off.id}`, { active: true }, admin);
    ok(r.status === 200 && r.data.active === true && r.data.title === "Switched off", "switched on, nothing else changed", r.data);
    ok((await call("DELETE", `/banners/admin/${off.id}`, null, admin)).status === 204, "deleted");
    list = (await call("GET", "/banners/admin", null, admin)).data;
    ok(!list.some((b) => b.id === off.id), "gone from the list");

    console.log(`banners: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
