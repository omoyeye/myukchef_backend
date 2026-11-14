// Message templates: the Super Admin edits wording and channels, and every email is branded.
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

(async () => {
    const admin = (await call("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const cust = (await call("POST", "/auth/register", { name: "Tina Template", email: "tina@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && cust, "sign in");

    // ===== Who can see them =====
    ok((await call("GET", "/admin/templates", null, cust)).status === 403, "customers can't see templates");
    ok((await call("GET", "/admin/templates")).status === 401, "signed-out visitors can't see templates");
    const list = (await call("GET", "/admin/templates", null, admin)).data;
    ok(Array.isArray(list.templates) && list.templates.length >= 80, "every message is listed", list.templates?.length);
    const cooking = list.templates.find((t) => t.key === "order.cooking");
    ok(cooking && cooking.vars.includes("orderId") && cooking.channels.sms === true && cooking.saved === null, "order messages list their placeholders and text option");
    ok(list.sampleValues && list.sampleValues.orderId, "example values are provided for previews");

    // ===== Checks on what's saved =====
    let r = await call("PUT", "/admin/templates/admin.support_message", { title: "Help needed: {{orderNumber}}" }, admin);
    ok(r.status === 400 && /can't use \{\{orderNumber\}\}/.test(r.data.error), "unknown placeholders are refused", r.data);
    r = await call("PUT", "/admin/templates/admin.support_message", { channels: { sms: true } }, admin);
    ok(r.status === 400, "texts can't be switched on for team alerts", r.data);
    r = await call("PUT", "/admin/templates/admin.support_message", { body: "x".repeat(5000) }, admin);
    ok(r.status === 400, "very long wording is refused");
    ok((await call("PUT", "/admin/templates/nope.nothing", { title: "Hi" }, admin)).status === 404, "unknown messages are 404");

    // ===== A saved change is what people receive =====
    r = await call("PUT", "/admin/templates/admin.support_message", { title: "Support request from {{name}}", body: "{{name}} needs a hand. Reply within the hour." }, admin);
    ok(r.status === 200 && r.data.saved?.title === "Support request from {{name}}", "the change is saved", r.data);
    const contact = (name) => call("POST", "/contact", { name, email: "help@test.local", phone: "07700900123", message: "Please can you help with my order?" });
    ok((await contact("Wanda Wording")).status === 200, "support message sent");
    let notes = (await call("GET", "/notifications", null, admin)).data;
    const mine = notes.find((n) => n.title === "Support request from Wanda Wording");
    ok(mine && mine.message === "Wanda Wording needs a hand. Reply within the hour.", "the in-app notice uses the new wording", notes.slice(0, 2));

    // Switching the in-app channel off stops the notice.
    r = await call("PUT", "/admin/templates/admin.support_message", { title: "Support request from {{name}}", channels: { inApp: false } }, admin);
    ok(r.status === 200 && r.data.saved?.channels?.inApp === false, "channel switched off");
    await contact("Quinn Quiet");
    notes = (await call("GET", "/notifications", null, admin)).data;
    ok(!notes.some((n) => n.title.includes("Quinn Quiet")), "no in-app notice when the channel is off");

    // Reset puts the original wording back.
    r = await call("DELETE", "/admin/templates/admin.support_message", null, admin);
    ok(r.status === 200 && r.data.saved === null, "reset clears the change");
    await contact("Rita Reset");
    notes = (await call("GET", "/notifications", null, admin)).data;
    ok(notes.some((n) => n.title === "New support message" && n.message.includes("Rita Reset")), "the default wording is back after a reset");

    // ===== Branded email preview =====
    await call("POST", "/settings", { key: "store_info", value: { name: "MYUKCHEF", phone: "020 7946 0000", email: "hello@test.local", address: "1 Test Street, London" } }, admin);
    await call("POST", "/settings", { key: "footer_info", value: { socials: { instagram: "https://instagram.com/myukchef", tiktok: "https://tiktok.com/@myukchef" } } }, admin);
    r = await call("POST", "/admin/templates/order.cooking/preview", {}, admin);
    ok(r.status === 200 && r.data.subject && /<img[^>]+logo/i.test(r.data.html), "preview has the logo", r.data.subject);
    ok(r.data.html.includes("020 7946 0000") && r.data.html.includes("1 Test Street, London"), "preview has the phone number and address");
    ok(r.data.html.includes("https://instagram.com/myukchef") && r.data.html.includes("TikTok"), "preview has the social links");
    r = await call("POST", "/admin/templates/order.cooking/preview", { emailSubject: "Order {{orderId}} is cooking", emailBody: "Hello <script>alert(1)</script>" }, admin);
    ok(r.data.subject === `Order ${list.sampleValues.orderId} is cooking`, "draft subject is filled with example values", r.data.subject);
    ok(!r.data.html.includes("<script>alert(1)</script>"), "wording is escaped in the email");
    ok((await call("POST", "/admin/templates/order.cooking/preview", {}, cust)).status === 403, "customers can't preview");
    r = await call("POST", "/admin/templates/order.cooking/test", {}, admin);
    ok([400, 502].includes(r.status) && /Brevo/.test(r.data.error), "test email explains when Brevo isn't working", r.data);

    console.log(`templates: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
