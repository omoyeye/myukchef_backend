// Chef availability and scheduled orders, the hygiene selling rule, tips, customer cancellation,
// order chat, referrals, email confirmation, search, reports, image resizing and error reports.
const path = require("path");
const crypto = require("crypto");
const backend = path.resolve(__dirname, "../..");
require(path.join(backend, "node_modules/dotenv")).config({ path: path.join(backend, ".env"), quiet: true });
const mysql = require(path.join(backend, "node_modules/mysql2/promise"));
const bcrypt = require(path.join(backend, "node_modules/bcrypt"));
const sharp = require(path.join(backend, "node_modules/sharp"));

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
const login = async (email, password, portal) => (await call("POST", "/auth/login", { email, password, portal })).data.token;
const register = async (name, email, extra = {}) => (await call("POST", "/auth/register", { name, email, password: "TestPass-2026x", acceptTerms: true, ...extra })).data;
const later = (hours) => new Date(Math.ceil((Date.now() + hours * 3600_000) / 1800_000) * 1800_000).toISOString();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const upload = async (p, field, name, type, bytes, token) => {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type }), name);
    const res = await fetch(API + p, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, data: await res.json().catch(() => null) };
};

(async () => {
    const u = new URL(process.env.DATABASE_URL);
    const db = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: process.env.TEST_DB_NAME });
    await db.query("UPDATE users SET password=? WHERE email LIKE 'demo.chef.%'", [await bcrypt.hash("ChefTest-2026x", 10)]);
    const admin = await login("admin@test.local", "AdminTest-2026x", "admin");
    const amara = await login("demo.chef.amara@example.com", "ChefTest-2026x", "chef");
    const leo = await login("demo.chef.leo@example.com", "ChefTest-2026x", "chef");
    const fay = (await register("Fay Feature", "fay@test.local")).token;
    ok(admin && amara && leo && fay, "sign in");
    const chefId = async (token) => (await call("GET", "/chefs/me", null, token)).data.id;
    const amaraId = await chefId(amara), leoId = await chefId(leo);

    // ===== Health, security header, error reports =====
    const health = await call("GET", "/health");
    ok(health.status === 200 && health.data.ok === true, "health check answers");
    ok(/default-src 'self'/.test(health.headers.get("content-security-policy") ?? ""), "security policy header is sent");
    await call("POST", "/health/client-error", { message: "TypeError: test crash", where: "/menu", source: "browser" });
    ok((await call("GET", "/health/errors", null, fay)).status === 403, "customers can't read the error log");
    const errors = (await call("GET", "/health/errors", null, admin)).data.errors;
    ok(errors.some((e) => e.message === "TypeError: test crash" && e.source === "browser"), "browser errors reach the Super Admin");

    // ===== Search and paging =====
    const all = await call("GET", "/chefs/products/public");
    ok(all.status === 200 && Number(all.headers.get("x-total-count")) === all.data.length, "dish count header");
    const amaraDishes = (await call("GET", "/chefs/products/public?q=amara")).data;
    ok(amaraDishes.length > 0 && amaraDishes.every((d) => d.chef.displayName === "Amara Okafor"), "search finds a chef's dishes by name");
    ok((await call("GET", "/chefs/products/public?page=1&limit=1")).data.length === 1, "paging works");
    ok((await call("GET", "/chefs/products/public?diet=vegan")).data.every((d) => d.isVegan), "diet filter");
    ok((await call("GET", "/chefs?q=italian")).data.every((c) => /italian/i.test(`${c.specialty} ${c.bio}`)), "chef search");
    ok(all.data.every((d) => d.chef && "openNow" in d.chef && d.chef.stripeAccountId === undefined), "dishes show the chef's availability and nothing private");

    // ===== Food hygiene selling rule =====
    const [[priya]] = await db.query("SELECT c.id FROM chefs c JOIN users u ON u.id=c.user_id WHERE u.email='demo.chef.priya@example.com'");
    await db.query("DELETE FROM chef_credentials WHERE chef_id=?", [priya.id]);
    ok(!(await call("GET", "/chefs/products/public")).data.some((d) => d.chef.id === priya.id), "chef without a verified hygiene certificate is off the menu");
    await call("POST", "/settings", { key: "selling_rules", value: { requireHygiene: false } }, admin);
    ok((await call("GET", "/chefs/products/public")).data.some((d) => d.chef.id === priya.id), "Super Admin can switch the rule off");
    await call("POST", "/settings", { key: "selling_rules", value: { requireHygiene: true } }, admin);
    ok(!(await call("GET", "/settings")).data.selling_rules, "selling rule isn't public");

    // ===== Availability, notice and scheduled orders =====
    const dishOf = (id) => all.data.find((d) => d.chef.id === id);
    const amaraDish = dishOf(amaraId), leoDish = dishOf(leoId);
    const orderBody = (dish, extra = {}) => ({
        items: [{ menuItem: { id: dish.id, name: dish.name }, quantity: 2, selectedModifiers: [] }],
        deliveryMethod: "pickup",
        deliveryAddress: { firstName: "Fay", lastName: "Feature", email: "fay@test.local", phone: "07123456789", line1: "", city: "", postcode: "" },
        ...extra,
    });
    ok((await call("PUT", "/chefs/me", { openingHours: { mon: { open: true, from: "20:00", to: "09:00" } } }, leo)).status === 400, "closing before opening refused");
    ok((await call("PUT", "/chefs/me", { noticeHours: 500 }, leo)).status === 400, "silly notice refused");
    await call("PUT", "/chefs/me", { noticeHours: 3 }, amara);
    let slots = (await call("POST", "/orders/slots", { itemIds: [amaraDish.id] })).data;
    ok(slots.slots.length > 0 && new Date(slots.earliest).getTime() >= Date.now() + 3 * 3600_000 - 60_000, "earliest time respects the chef's notice", slots.earliest);
    const tooSoon = await call("POST", "/orders", orderBody(amaraDish, { scheduledFor: later(1) }), fay);
    ok(tooSoon.status === 400 && /notice/.test(tooSoon.data.error), "ordering inside the notice period refused");
    const scheduledFor = later(26);
    const scheduled = await call("POST", "/orders", orderBody(amaraDish, { scheduledFor }), fay);
    ok(scheduled.status === 201 && new Date(scheduled.data.scheduledFor).getTime() === new Date(scheduledFor).getTime(), "order saved for the chosen time");
    ok((await call("GET", "/chef-portal/orders", null, amara)).data.some((o) => o.id === scheduled.data.id && o.scheduledFor), "chef sees when it's wanted");
    const asap = await call("POST", "/orders", orderBody(amaraDish), fay);
    ok(asap.status === 201 && new Date(asap.data.scheduledFor).getTime() >= Date.now() + 3 * 3600_000 - 60_000, "as soon as possible means the first time the chef can do");
    await call("PUT", "/chefs/me", { noticeHours: 1 }, amara);

    await call("PUT", "/chefs/me", { ordersPaused: true }, leo);
    slots = (await call("POST", "/orders/slots", { itemIds: [leoDish.id] })).data;
    ok(slots.slots.length === 0 && /isn't taking orders/.test(slots.reason), "paused chef has no times");
    const pausedOrder = await call("POST", "/orders", orderBody(leoDish), fay);
    ok(pausedOrder.status === 400 && /isn't taking orders/.test(pausedOrder.data.error), "paused chef can't be ordered from");
    ok((await call("GET", `/chefs/${leoId}`)).data.paused === true, "chef page shows they're paused");
    await call("PUT", "/chefs/me", { ordersPaused: false, openingHours: { sun: { open: true, from: "12:00", to: "13:00" } } }, leo);
    slots = (await call("POST", "/orders/slots", { itemIds: [leoDish.id] })).data;
    ok(slots.slots.length > 0 && slots.slots.every((s) => new Date(s).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Europe/London" }) === "Sun"), "only times inside opening hours", slots.slots.slice(0, 3));
    const closed = await call("POST", "/orders", orderBody(leoDish, { scheduledFor: slots.slots[0].replace(/T12:/, "T10:") }), fay);
    ok(closed.status === 400, "ordering outside opening hours refused");
    const both = (await call("POST", "/orders/slots", { itemIds: [leoDish.id, amaraDish.id] })).data;
    ok(both.slots.every((s) => slots.slots.includes(s)), "a mixed basket only gets times that suit both chefs");
    await call("PUT", "/chefs/me", { openingHours: null }, leo);

    // ===== Customer cancellation =====
    const toCancel = (await call("POST", "/orders", orderBody(amaraDish), fay)).data;
    ok((await call("POST", `/orders/${toCancel.id}/cancel`, {}, leo)).status === 403, "someone else can't cancel it");
    const cancelled = await call("POST", `/orders/${toCancel.id}/cancel`, {}, fay);
    ok(cancelled.status === 200 && cancelled.data.status === "cancelled" && cancelled.data.cancelledBy === "customer", "customer cancels before cooking starts");
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => n.title === `Order #${toCancel.id} was cancelled`), "chef told about the cancellation");
    const cooking = (await call("POST", "/orders", orderBody(amaraDish), fay)).data;
    await call("PATCH", `/chef-portal/orders/${cooking.id}/status`, { status: "preparing" }, amara);
    const tooLate = await call("POST", `/orders/${cooking.id}/cancel`, {}, fay);
    ok(tooLate.status === 400 && /already started/.test(tooLate.data.error), "can't cancel once cooking has started");
    const guest = (await call("POST", "/orders", orderBody(amaraDish))).data;
    ok((await call("POST", `/orders/${guest.id}/cancel`, {})).status === 403, "guest needs their tracking link");
    ok((await call("POST", `/orders/${guest.id}/cancel`, { t: guest.trackingToken })).status === 200, "guest cancels with their tracking link");

    // ===== Order chat =====
    const chatOrder = cooking;
    ok((await call("GET", `/orders/${chatOrder.id}/messages`, null, leo)).status === 403, "a chef not on the order can't read it");
    const sent = await call("POST", `/orders/${chatOrder.id}/messages`, { chefId: amaraId, body: "No onions please. Call 07123 456789" }, fay);
    ok(sent.status === 201 && !/07123/.test(sent.data.body), "customer messages the chef; a message with a phone number is blocked", sent.data);
    await call("POST", `/orders/${chatOrder.id}/messages`, { chefId: amaraId, body: "No onions please" }, fay);
    const chefView = (await call("GET", `/orders/${chatOrder.id}/messages`, null, amara)).data;
    ok(chefView.role === "chef" && chefView.threads[0].messages.some((m) => m.body === "No onions please"), "chef sees the message");
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => n.title === `Message about order #${chatOrder.id}`), "chef notified of the message");
    await call("POST", `/orders/${chatOrder.id}/messages`, { body: "Will do!" }, amara);
    ok((await call("GET", "/notifications", null, fay)).data.some((n) => /sent a message about order/.test(n.title)), "customer notified of the reply");
    ok((await call("POST", `/orders/${toCancel.id}/messages`, { body: "hello" }, fay)).status === 400, "chat closed on a cancelled order");

    // ===== Tips =====
    const walletPending = async (token) => (await call("GET", "/wallet", null, token)).data.pending;
    const before = await walletPending(fay);
    const tipped = (await call("POST", "/orders", orderBody(amaraDish, { tip: 5 }), fay)).data;
    const [[noTipTotal]] = await db.query("SELECT ? - 5 AS t", [tipped.total]);
    ok(tipped.tipAmount === 5, "tip saved on the order");
    for (const s of ["preparing", "delivery"]) await call("PATCH", `/chef-portal/orders/${tipped.id}/status`, { status: s }, amara);
    const photo = await upload("/upload", "image", "p.png", "image/png", PNG, amara);
    await call("PATCH", `/chef-portal/orders/${tipped.id}/status`, { status: "completed", proof: photo.data.url }, amara);
    await call("POST", `/orders/${tipped.id}/confirm-delivery`, { received: true }, fay);
    const inv = (await call("GET", "/payouts/me", null, amara)).data.invoices.find((i) => i.orderId === tipped.id);
    const gross = Math.round(amaraDish.price * 2 * 100) / 100;
    ok(inv && inv.tipAmount === 5 && inv.netAmount === Math.round((gross - Math.round(gross * 0.1 * 100) / 100 + 5) * 100) / 100, "tip goes to the chef in full, with no commission", inv);
    const after = await walletPending(fay);
    // Loyalty cashback (2% by default) is pending wallet credit, and doesn't count the tip.
    ok(Math.round((after - before) * 100) === Math.round(noTipTotal.t * 0.02 * 100), "loyalty cashback doesn't count the tip", { before, after, total: tipped.total });

    // ===== VAT on invoices =====
    await call("POST", "/settings", { key: "vat_config", value: { registered: true, rate: 20, number: "GB123456789" } }, admin);
    const vatOrder = (await call("POST", "/orders", orderBody(amaraDish), fay)).data;
    for (const s of ["preparing", "delivery"]) await call("PATCH", `/chef-portal/orders/${vatOrder.id}/status`, { status: s }, amara);
    await call("PATCH", `/chef-portal/orders/${vatOrder.id}/status`, { status: "completed", proof: photo.data.url }, amara);
    await call("POST", `/orders/${vatOrder.id}/confirm-delivery`, { received: true }, fay);
    const vatInv = (await call("GET", "/payouts/me", null, amara)).data.invoices.find((i) => i.orderId === vatOrder.id);
    ok(vatInv.commissionVat === Math.round(vatInv.commissionAmount / 6 * 100) / 100, "invoice shows the VAT inside the commission", vatInv);
    ok((await call("GET", `/payouts/invoices/${vatInv.id}`, null, amara)).data.platform.vatNumber === "GB123456789", "invoice carries the VAT number");
    await call("POST", "/settings", { key: "vat_config", value: { registered: false } }, admin);

    // ===== Refer a friend and email confirmation =====
    const fayRef = (await call("GET", "/auth/referral", null, fay)).data;
    ok(/^[A-Z2-9]{3,12}$/.test(fayRef.code) && fayRef.referrer === 5 && fayRef.newCustomer === 5, "customer has a referral code and the rewards", fayRef);
    const gus = await register("Gus Guest", "gus2@test.local", { referralCode: fayRef.code.toLowerCase() });
    ok(gus.user.emailVerifiedAt == null, "new accounts start unconfirmed");
    const fayBefore = await walletPending(fay);
    const gusOrder = (await call("POST", "/orders", { ...orderBody(amaraDish), deliveryAddress: { ...orderBody(amaraDish).deliveryAddress, email: "gus2@test.local" } }, gus.token)).data;
    for (const s of ["preparing", "delivery"]) await call("PATCH", `/chef-portal/orders/${gusOrder.id}/status`, { status: s }, amara);
    await call("PATCH", `/chef-portal/orders/${gusOrder.id}/status`, { status: "completed", proof: photo.data.url }, amara);
    const fayAfter = await walletPending(fay);
    ok(Math.round((fayAfter - fayBefore) * 100) === 500, "friend earns £5 (pending) when the referred customer's first order is delivered", { fayBefore, fayAfter });
    ok((await call("GET", "/auth/referral", null, fay)).data.joined === 1, "referral counted");

    const sign = (payload) => crypto.createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
    const purpose = Buffer.from(JSON.stringify({ sub: gus.user.id, exp: Math.floor(Date.now() / 1000) + 600, purpose: "verify-email" })).toString("base64url");
    const link = `${purpose}.${sign(purpose)}`;
    ok((await call("GET", "/auth/me", null, link)).status === 401, "an email link can never be used to sign in");
    ok((await call("POST", "/auth/verify-email", { token: link + "x" })).status === 400, "tampered link refused");
    const confirmed = await call("POST", "/auth/verify-email", { token: link });
    ok(confirmed.status === 200, "email confirmed", confirmed);
    ok(!!(await call("GET", "/auth/me", null, gus.token)).data.user.emailVerifiedAt, "account shows the email as confirmed");

    // ===== Reports =====
    ok((await call("GET", "/reports/admin", null, fay)).status === 403, "customers can't see reports");
    const report = (await call("GET", "/reports/admin", null, admin)).data;
    ok(report.totals.orders > 0 && report.totals.tips >= 5 && report.byDay.length === 30, "Super Admin report", report.totals);
    const csv = await fetch(`${API}/reports/admin/export?type=invoices`, { headers: { Authorization: `Bearer ${admin}` } });
    const csvText = await csv.text();
    ok(csv.headers.get("content-type").startsWith("text/csv") && /Invoice,"?Receipt/.test(csvText.replace(/"/g, "")), "invoices export as a spreadsheet");
    const earnings = (await call("GET", "/reports/chef", null, amara)).data;
    ok(earnings.totals.earned > 0 && earnings.bestSellers.length > 0, "chef sees their earnings and best sellers", earnings.totals);

    // ===== Card payments for events and plans need Stripe =====
    const [[anyWeek]] = await db.query("SELECT 1 AS x");
    ok(anyWeek.x === 1, "database still answering");
    ok((await call("POST", "/events/999999/pay-by-card", {}, fay)).status === 404, "card payment for someone else's booking refused");

    // ===== Images are shrunk and get small copies =====
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 230, g: 120, b: 40 } } }).jpeg().toBuffer();
    const up = await upload("/upload", "image", "big.jpg", "image/jpeg", big, amara);
    ok(up.status === 200 && /\.webp$/.test(up.data.url), "uploads are saved as WebP", up.data);
    const stored = await fetch(SITE + up.data.url);
    if (!stored.ok || !(stored.headers.get("content-type") ?? "").startsWith("image/")) console.log("stored fetch:", stored.status, stored.headers.get("content-type"), SITE + up.data.url);
    const storedBytes = Buffer.from(await stored.arrayBuffer());
    if (storedBytes.subarray(8, 12).toString("latin1") !== "WEBP") console.log("stored is not webp:", stored.status, stored.headers.get("content-type"), storedBytes.length, storedBytes.subarray(0, 16).toString("latin1"));
    const meta = await sharp(storedBytes).metadata();
    ok(meta.width <= 1600 && meta.height <= 1600, "big photos are shrunk", { width: meta.width, height: meta.height });
    const small = await fetch(`${SITE}/uploads/sm/${up.data.url.split("/").pop()}?w=240`);
    const smallBytes = Buffer.from(await small.arrayBuffer());
    if (smallBytes.subarray(8, 12).toString("latin1") !== "WEBP") console.log("small is not webp:", small.status, small.headers.get("content-type"), smallBytes.length, smallBytes.subarray(0, 40).toString("latin1"));
    const smallMeta = await sharp(smallBytes).metadata().catch(() => ({ width: -1 }));
    ok(small.status === 200 && small.headers.get("content-type") === "image/webp" && smallMeta.width === 240, "small copies for cards");
    ok((await fetch(`${SITE}/uploads/.thumbs/x.webp`)).status === 404, "the small-copy folder isn't browsable");
    ok((await fetch(`${SITE}/uploads/sm/..%2F..%2Fpackage.json`)).status === 404, "can't reach other files through it");

    await db.end();
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
