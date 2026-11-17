// SEO and tracking settings, and Claude as an integration (without calling Claude).
const API = process.env.TEST_API;
const SITE = API.replace(/\/api$/, "");
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { fail++; console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); } };
const call = async (method, p, body, token) => {
    const res = await fetch(API + p, { signal: AbortSignal.timeout(60_000), method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
};
const patient = async (method, p, body) => {
    let r = await call(method, p, body);
    if (r.status === 429) { await new Promise((done) => setTimeout(done, 61_000)); r = await call(method, p, body); }
    return r;
};

(async () => {
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const cust = (await patient("POST", "/auth/register", { name: "Sid Seo", email: "sid.seo@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && cust, "sign in");

    // ===== Only Super Admins =====
    ok((await call("GET", "/seo", null, cust)).status === 403, "customers can't see SEO settings");
    ok((await call("PUT", "/seo", {}, cust)).status === 403, "customers can't change them");
    ok((await call("POST", "/seo/ai", { path: "/" }, cust)).status === 403, "customers can't use AI writing");

    let r = await call("GET", "/seo", null, admin);
    ok(r.status === 200 && r.data.pages.length >= 8 && r.data.config.allowIndexing === true, "settings and page list", r.data.pages?.length);
    ok(r.data.aiReady === false, "AI is off until a Claude key is added");

    // ===== Checks =====
    for (const [field, value] of [["gtmId", "GTM"], ["ga4Id", "UA-12345-1"], ["metaPixelId", "abc"], ["clarityId", "<script>"]]) {
        r = await call("PUT", "/seo", { tracking: { [field]: value } }, admin);
        ok(r.status === 400, `refuses a bad ${field}`, r.data);
    }
    r = await call("PUT", "/seo", { verification: { google: '"><script>alert(1)</script>' } }, admin);
    ok(r.status === 400, "refuses a bad verification code");

    // ===== Save =====
    r = await call("PUT", "/seo", {
        tracking: { gtmId: "gtm-abc1234", ga4Id: "g-abc123def4", metaPixelId: "1234567890123456", clarityId: "ABCD1234EF" },
        verification: { google: '<meta name="google-site-verification" content="abcDEF123_xyz-987" />' },
        defaults: { description: "Home-cooked food from local chefs.", keywords: "home cooked food, local chefs" },
        pages: {
            "/meal-plans": { title: "Meal Plans, 1 Week to 6 Months | MYUKCHEF", description: "Plan home-cooked meals with a local chef." },
            "/not-a-page": { title: "Ignored" },
        },
        allowIndexing: true,
    }, admin);
    const c = r.data.config;
    ok(r.status === 200 && c.tracking.gtmId === "GTM-ABC1234" && c.tracking.ga4Id === "G-ABC123DEF4" && c.tracking.clarityId === "abcd1234ef", "IDs saved in the right case", c?.tracking);
    ok(c.verification.google === "abcDEF123_xyz-987", "the code is taken from a pasted meta tag", c.verification);
    ok(c.pages["/meal-plans"]?.title && !c.pages["/not-a-page"], "page text saved; unknown pages ignored", c.pages);

    // ===== What the public sees =====
    r = await call("GET", "/seo/public");
    ok(r.status === 200 && r.data.tracking.gtmId === "GTM-ABC1234" && r.data.pages["/meal-plans"].title.startsWith("Meal Plans"), "public: tag IDs and page titles", r.data);
    ok(!("verification" in r.data) && !("keywords" in (r.data.defaults ?? {})), "public: nothing more than needed");

    // The page HTML (when the website is built) carries the title, verification and keywords.
    const html = await fetch(`${SITE}/meal-plans`).then((x) => (x.ok ? x.text() : null)).catch(() => null);
    if (html && html.includes("<title>")) {
        ok(html.includes("<title>Meal Plans, 1 Week to 6 Months | MYUKCHEF</title>"), "page title in the HTML");
        ok(html.includes('name="google-site-verification" content="abcDEF123_xyz-987"'), "Google verification in the HTML");
        ok(!html.includes("noindex"), "indexing allowed");
    }
    const csp = (await call("GET", "/health")).headers.get("content-security-policy") ?? "";
    ok(csp.includes("https://www.googletagmanager.com") && csp.includes("https://connect.facebook.net"), "tag providers allowed by the security policy");

    // ===== Turning indexing off =====
    await call("PUT", "/seo", { ...c, allowIndexing: false }, admin);
    const hidden = await fetch(`${SITE}/meal-plans`).then((x) => (x.ok ? x.text() : null)).catch(() => null);
    if (hidden && hidden.includes("<title>")) ok(hidden.includes('content="noindex, nofollow"'), "noindex when indexing is off");
    ok((await call("GET", "/seo/public")).data.allowIndexing === false, "public shows indexing off");

    // ===== AI writing =====
    r = await call("POST", "/seo/ai", { path: "/nowhere" }, admin);
    ok(r.status === 400, "AI needs a real page");
    r = await call("POST", "/seo/ai", { path: "/meal-plans" }, admin);
    ok(r.status === 400 && /Claude API key/.test(r.data.error), "AI explains a key is needed", r.data);

    // ===== Claude as an integration =====
    r = await call("GET", "/admin/integrations", null, admin);
    ok(r.status === 200 && r.data.claude && r.data.claude.fields.apiKey.isSet === false, "Claude listed under integrations", r.data.claude);
    r = await call("PUT", "/admin/integrations/claude", { apiKey: "not-a-key" }, admin);
    ok(r.status === 400 && /sk-ant-/.test(r.data.error), "Claude key format checked", r.data);
    r = await call("PUT", "/admin/integrations/claude", { apiKey: "sk-ant-test-0000000000000000abcd" }, admin);
    ok(r.status === 200 && r.data.fields.apiKey.isSet && r.data.fields.apiKey.value.startsWith("sk-ant-") && r.data.fields.apiKey.value.endsWith("abcd") && !r.data.fields.apiKey.value.includes("0000000000"), "Claude key saved and shown masked", r.data.fields.apiKey);
    ok((await call("GET", "/seo", null, admin)).data.aiReady === true, "AI is ready once a key is saved");
    await call("DELETE", "/admin/integrations/claude", null, admin);
    ok((await call("GET", "/seo", null, admin)).data.aiReady === false, "and off again once removed");

    console.log(`seo: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
