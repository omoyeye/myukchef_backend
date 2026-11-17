// Checks Super Admin key management, Stripe checkout, webhooks, refunds and unpaid-order handling.
const path = require("path");
const crypto = require("crypto");
const backend = path.resolve(__dirname, "../..");
require(path.join(backend, "node_modules/dotenv")).config({ path: path.join(backend, ".env"), quiet: true });
const mysql = require(path.join(backend, "node_modules/mysql2/promise"));
const bcrypt = require(path.join(backend, "node_modules/bcrypt"));

const API = process.env.TEST_API;
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { fail++; console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); } };
const call = async (method, p, body, token, headers = {}) => {
    const res = await fetch(API + p, { signal: AbortSignal.timeout(60_000), method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
};
const FAKE_SK = "sk_test_" + "A".repeat(40);
const FAKE_PK = "pk_test_" + "B".repeat(40);
const WHSEC = "whsec_" + "C".repeat(32);
const signed = (payload) => {
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
    return `t=${t},v1=${sig}`;
};
const webhook = (event, sig) => {
    const payload = JSON.stringify(event);
    return call("POST", "/payments/stripe/webhook", payload, null, { "stripe-signature": sig ?? signed(payload) });
};
const sessionEvent = (type, sessionId, orderId, paid) => ({
    id: "evt_" + crypto.randomBytes(6).toString("hex"), object: "event", type, api_version: "2025-01-01", created: Math.floor(Date.now() / 1000),
    data: { object: { id: sessionId, object: "checkout.session", payment_status: paid ? "paid" : "unpaid", status: paid ? "complete" : "expired", payment_intent: paid ? "pi_test_123" : null, metadata: { orderId: String(orderId) }, client_reference_id: String(orderId) } },
});

(async () => {
    const u = new URL(process.env.DATABASE_URL);
    const db = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: process.env.TEST_DB_NAME });
    await db.query("UPDATE users SET password=? WHERE email LIKE 'demo.chef.%'", [await bcrypt.hash("ChefTest-2026x", 10)]);
    const admin = (await call("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    // Delivery codes are tested in 90-delivery-code; these files deliver without them.
    await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "off" } }, admin);
    const amara = (await call("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const cara = (await call("POST", "/auth/register", { name: "Cara Customer", email: "cara@test.local", password: "TestPass-2026x", acceptTerms: true })).data?.token ?? (await call("POST", "/auth/login", { email: "cara@test.local", password: "TestPass-2026x" })).data.token;
    ok(admin && amara && cara, "sign in");

    // === Only the Super Admin manages keys ===
    ok((await call("GET", "/admin/integrations", null, cara)).status === 403, "customers can't see keys");
    ok((await call("GET", "/admin/integrations", null, amara)).status === 403, "chefs can't see keys");
    ok((await call("GET", "/admin/integrations")).status === 401, "signed-out visitors can't see keys");
    ok((await call("PUT", "/admin/integrations/brevo", { apiKey: "xkeysib-abc" }, cara)).status === 403, "customers can't change keys");
    let view = (await call("GET", "/admin/integrations", null, admin)).data;
    ok(view.brevo.fields.apiKey.source === "none" && view.brevo.fields.senderEmail.value === "info@myukchef.com" && view.stripe.enabled === false, "starts unset with defaults", view.brevo);
    ok(/\/api\/payments\/stripe\/webhook$/.test(view.stripe.webhookUrl), "shows the webhook address");

    // Brevo: format checks, masking, encryption at rest, clearing
    ok((await call("PUT", "/admin/integrations/brevo", { apiKey: "not-a-key" }, admin)).status === 400, "bad Brevo key refused");
    ok((await call("PUT", "/admin/integrations/brevo", { senderEmail: "nope" }, admin)).status === 400, "bad sender email refused");
    ok((await call("PUT", "/admin/integrations/brevo", { smsSender: "MuchTooLongSender" }, admin)).status === 400, "long SMS sender refused");
    const BREVO = "xkeysib-" + "d".repeat(60) + "-ZZZZ1234";
    const saved = await call("PUT", "/admin/integrations/brevo", { apiKey: BREVO, senderEmail: "orders@myukchef.com" }, admin);
    ok(saved.status === 200 && saved.data.fields.apiKey.source === "saved" && saved.data.fields.apiKey.value.endsWith("1234") && !saved.data.fields.apiKey.value.includes("dddd"), "Brevo key saved and only shown masked", saved.data);
    ok(saved.data.fields.senderEmail.value === "orders@myukchef.com", "sender email saved");
    const all = JSON.stringify((await call("GET", "/admin/integrations", null, admin)).data);
    ok(!all.includes(BREVO), "full key never sent back");
    const [[row]] = await db.query("SELECT value FROM integration_settings WHERE provider='brevo'");
    ok(row && !row.value.includes("xkeysib") && !row.value.includes("orders@myukchef.com") && row.value.startsWith("v1."), "stored encrypted");
    const keep = await call("PUT", "/admin/integrations/brevo", { smsSender: "MYUKCHEF2" }, admin);
    ok(keep.data.fields.apiKey.source === "saved" && keep.data.fields.smsSender.value === "MYUKCHEF2", "saving one field keeps the others");
    const settingsLeak = JSON.stringify((await call("GET", "/settings", null, admin)).data);
    ok(!settingsLeak.includes("xkeysib"), "keys never appear in general settings");
    const brevoTest = (await call("POST", "/admin/integrations/brevo/test", {}, admin)).data;
    ok(brevoTest && brevoTest.ok === false && /Brevo/.test(brevoTest.message), "test connection reports a bad Brevo key", brevoTest);
    const cleared = await call("PUT", "/admin/integrations/brevo", { senderEmail: "" }, admin);
    ok(cleared.data.fields.senderEmail.source === "default", "clearing one field falls back to the default");

    // Stripe: mode mismatch, then fake test keys
    ok((await call("PUT", "/admin/integrations/stripe", { secretKey: FAKE_SK, publishableKey: "pk_live_" + "B".repeat(40) }, admin)).status === 400, "test and live keys can't be mixed");
    ok((await call("PUT", "/admin/integrations/stripe", { secretKey: "sk_wrong" }, admin)).status === 400, "bad Stripe key refused");
    let config = (await call("GET", "/orders/payment-config")).data;
    ok(config.cardPayments === false, "no card payments before Stripe is set up");

    // Without Stripe, orders go straight through as before.
    const dishes = (await call("GET", "/chefs/products/public")).data;
    const dish = dishes.find((d) => d.chef?.displayName === "Amara Okafor");
    const orderBody = (method = "pickup") => ({
        items: [{ menuItem: { id: dish.id, name: dish.name }, quantity: 1, selectedModifiers: [] }],
        deliveryMethod: method,
        deliveryAddress: { firstName: "Cara", lastName: "Customer", email: "cara@test.local", phone: "07123456789", line1: "", city: "", postcode: "" },
    });
    const free = await call("POST", "/orders", orderBody(), cara);
    ok(free.status === 201 && free.data.status === "received" && free.data.paymentStatus === "not_required" && !free.data.checkoutUrl, "no Stripe: order placed unpaid as before", free.data);

    const stripeSaved = await call("PUT", "/admin/integrations/stripe", { secretKey: FAKE_SK, publishableKey: FAKE_PK, webhookSecret: WHSEC }, admin);
    ok(stripeSaved.status === 200 && stripeSaved.data.enabled === true && stripeSaved.data.testMode === true, "Stripe switched on in test mode", stripeSaved.data);
    ok(!JSON.stringify(stripeSaved.data).includes("A".repeat(20)), "Stripe secret only shown masked");
    config = (await call("GET", "/orders/payment-config")).data;
    ok(config.cardPayments === true && config.publishableKey === FAKE_PK && config.testMode === true, "checkout now takes card payments");
    const stripeTest = (await call("POST", "/admin/integrations/stripe/test", {}, admin)).data;
    ok(stripeTest && stripeTest.ok === false && /Stripe/.test(stripeTest.message), "test connection reports a bad Stripe key", stripeTest);

    // With a key Stripe rejects, the order can't go ahead and nobody is told about it.
    const chefNotesBefore = (await call("GET", "/notifications", null, amara)).data.length;
    const rejected = await call("POST", "/orders", orderBody(), cara);
    ok(rejected.status === 502 && /payment page/.test(rejected.data.error), "Stripe failure: order not placed", rejected);
    const [[failedRow]] = await db.query("SELECT status, payment_status FROM orders ORDER BY id DESC LIMIT 1");
    ok(failedRow.status === "cancelled" && failedRow.payment_status === "failed", "failed checkout leaves the order cancelled");
    ok((await call("GET", "/notifications", null, amara)).data.length === chefNotesBefore, "chef not told about an unpaid order");

    // An order waiting for payment, as if Stripe had opened the payment page.
    const [ins] = await db.query("INSERT INTO orders (user_id, status, total, delivery_address, tracking_token, payment_status, stripe_session_id) VALUES ((SELECT id FROM users WHERE email='cara@test.local'), 'awaiting_payment', ?, ?, 'tok123', 'awaiting', 'cs_test_1')", [dish.price, JSON.stringify({ firstName: "Cara", email: "cara@test.local", method: "pickup" })]);
    const oid = ins.insertId;
    await db.query("INSERT INTO order_items (order_id, chef_product_id, quantity, price, selected_modifiers) VALUES (?, ?, 1, ?, '[]')", [oid, dish.id, dish.price]);
    const chefOrders = (await call("GET", "/chef-portal/orders", null, amara)).data;
    ok(!chefOrders.some((o) => o.id === oid), "chefs don't see unpaid orders");
    ok((await call("PATCH", `/chef-portal/orders/${oid}/status`, { status: "preparing" }, amara)).status !== 200, "chefs can't move unpaid orders");
    const tracked = (await call("GET", `/orders/${oid}?t=tok123`)).data;
    ok(tracked.paymentStatus === "awaiting" && tracked.stripeSessionId === undefined && tracked.stripePaymentIntentId === undefined, "tracker shows payment state but not Stripe ids", tracked);
    ok((await call("POST", `/orders/${oid}/pay`, {})).status === 403, "strangers can't start payment for an order");
    ok((await call("POST", `/orders/${oid}/payment-status`, {})).status === 403, "strangers can't check an order's payment");

    // Webhooks
    ok((await webhook(sessionEvent("checkout.session.completed", "cs_test_1", oid, true), "t=1,v1=bad")).status === 400, "unsigned webhook refused");
    const before = (await call("GET", "/notifications", null, amara)).data.length;
    ok((await webhook(sessionEvent("checkout.session.completed", "cs_test_1", oid, true))).status === 200, "signed webhook accepted");
    let [[paid]] = await db.query("SELECT status, payment_status, paid_at, stripe_payment_intent_id FROM orders WHERE id=?", [oid]);
    ok(paid.status === "received" && paid.payment_status === "paid" && paid.paid_at && paid.stripe_payment_intent_id === "pi_test_123", "webhook marks the order paid", paid);
    const chefNotes = (await call("GET", "/notifications", null, amara)).data;
    ok(chefNotes.length === before + 1 && chefNotes[0].title === `New order #${oid}`, "chef told once it's paid");
    await webhook(sessionEvent("checkout.session.completed", "cs_test_1", oid, true));
    ok((await call("GET", "/notifications", null, amara)).data.length === before + 1, "repeated webhook doesn't notify twice");
    const adminNotes = (await call("GET", "/notifications", null, admin)).data;
    ok(adminNotes.some((n) => n.message.includes(`#${oid}`) && n.message.includes("paid by card")), "Super Admin told it was paid by card");
    ok((await call("GET", "/chef-portal/orders", null, amara)).data.some((o) => o.id === oid), "chef sees the order once paid");

    // Cancelling a paid order refunds it; if Stripe refuses, nothing changes.
    const cancel = await call("PATCH", `/orders/${oid}/status`, { status: "cancelled" }, admin);
    ok(cancel.status === 409 && /refund/.test(cancel.data.error), "refund failure is reported to the Super Admin", cancel);
    [[paid]] = await db.query("SELECT status, payment_status FROM orders WHERE id=?", [oid]);
    ok(paid.status === "received" && paid.payment_status === "paid", "order untouched when the refund fails");

    // Expired checkout cancels an unpaid order; an older session can't.
    const [ins2] = await db.query("INSERT INTO orders (user_id, status, total, delivery_address, tracking_token, payment_status, stripe_session_id) VALUES (NULL, 'awaiting_payment', 12, ?, 'tok456', 'awaiting', 'cs_test_new')", [JSON.stringify({ firstName: "Gus", email: "gus@test.local", method: "pickup" })]);
    await webhook(sessionEvent("checkout.session.expired", "cs_test_old", ins2.insertId, false));
    let [[o2]] = await db.query("SELECT status, payment_status FROM orders WHERE id=?", [ins2.insertId]);
    ok(o2.payment_status === "awaiting", "an older expired checkout doesn't cancel the order");
    await webhook(sessionEvent("checkout.session.expired", "cs_test_new", ins2.insertId, false));
    [[o2]] = await db.query("SELECT status, payment_status FROM orders WHERE id=?", [ins2.insertId]);
    ok(o2.status === "cancelled" && o2.payment_status === "failed", "expired checkout releases the order");
    ok((await call("PATCH", `/orders/${ins2.insertId}/status`, { status: "received" }, admin)).status === 400, "unpaid order can't be reopened");

    // Stats leave out unpaid and cancelled orders.
    const stats = (await call("GET", "/orders/stats", null, admin)).data;
    const [[sum]] = await db.query("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status NOT IN ('awaiting_payment','cancelled')");
    ok(stats.totalRevenue === `£${Number(sum.s).toFixed(2)}`, "revenue only counts real sales", stats.totalRevenue);

    // Switching card payments off takes orders without payment again.
    const off = await call("PUT", "/admin/integrations/stripe", { enabled: false }, admin);
    ok(off.data.enabled === false && off.data.switchedOff === true, "Super Admin switches card payments off");
    ok((await call("GET", "/orders/payment-config")).data.cardPayments === false, "checkout stops asking for a card");
    const after = await call("POST", "/orders", orderBody(), cara);
    ok(after.status === 201 && after.data.paymentStatus === "not_required", "orders go through without payment while off");
    ok((await webhook(sessionEvent("checkout.session.completed", "cs_test_1", oid, true))).status === 400, "webhooks refused while Stripe is off");

    // Remove all saved keys.
    const gone = await call("DELETE", "/admin/integrations/stripe", null, admin);
    ok(gone.status === 200 && gone.data.fields.secretKey.source === "none" && gone.data.updatedAt === null, "Super Admin removes saved Stripe keys");
    const [[count]] = await db.query("SELECT COUNT(*) n FROM integration_settings WHERE provider='stripe'");
    ok(count.n === 0, "removed from the database");

    await db.end();
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
