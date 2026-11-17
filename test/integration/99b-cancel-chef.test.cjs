// Event bookings with several chefs: the customer can let one chef go (with a reason) and keep the rest.
// Removing the last chef cancels the booking; removing a chosen chef before payment updates the total.
const mysql = require("mysql2/promise");
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
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

(async () => {
    const u = new URL(process.env.DATABASE_URL);
    const db = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: process.env.TEST_DB_NAME });
    const [demo] = await db.query("SELECT c.id, u.email FROM chefs c JOIN users u ON u.id = c.user_id WHERE u.email LIKE 'demo.chef.%' AND c.status = 'approved' ORDER BY c.id LIMIT 3");
    ok(demo.length >= 3, "three demo chefs", demo);
    await db.query("UPDATE chefs SET is_available_for_events = 1 WHERE id IN (?)", [demo.map((c) => c.id)]);
    const tokens = [];
    for (const c of demo) tokens.push((await patient("POST", "/auth/login", { email: c.email, password: "ChefTest-2026x", portal: "chef" })).data.token);
    const cass = (await patient("POST", "/auth/register", { name: "Cass Canceller", email: "cass.cancel@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(tokens.every(Boolean) && cass, "sign in");

    const book = async (chefs) => (await call("POST", "/events", { eventName: "Cass's party", venue: "The Hall", eventTime: "18:00", contactPhone: "07700900555", eventDate: day(45), adults: 20, kids: 0, chefRequests: chefs.map((c) => ({ chefId: c.id, preferences: "Jollof and chicken for everyone" })) }, cass)).data;
    const quoteOf = async (event, chef) => (await call("GET", `/events/${event.id}`, null, cass)).data.quotes.find((q) => q.chef.id === chef.id);

    // ===== Still collecting quotes: remove one chef =====
    let event = await book(demo);
    ok(event?.id, "booking with three chefs", event);
    let q0 = await quoteOf(event, demo[0]);
    let r = await call("PATCH", `/events/${event.id}/quotes/${q0.id}/cancel`, { reason: "Our numbers changed" }, cass);
    ok(r.status === 200 && r.data.status === "quoting", "one chef removed, the booking carries on", r.data);
    q0 = await quoteOf(event, demo[0]);
    ok(q0.status === "withdrawn", "that chef is marked as removed", q0.status);
    const told = (await call("GET", "/notifications", null, tokens[0])).data;
    ok(told.some((n) => n.title === "No longer needed for an event" && /Our numbers changed/.test(n.message)), "the chef is told, with the reason", told[0]);
    ok((await call("POST", `/chef-portal/quotes/${q0.id}/submit`, { items: [], serviceFee: 100, willAttend: "yes" }, tokens[0])).status === 400, "a removed chef can't send a quote");
    ok((await call("PATCH", `/events/${event.id}/quotes/${q0.id}/cancel`, {}, cass)).status === 400, "can't remove the same chef twice");
    ok((await call("PATCH", `/events/${event.id}/quotes/999999/cancel`, {}, cass)).status === 404, "unknown chef on this booking");
    const stranger = (await patient("POST", "/auth/register", { name: "Sam Stranger", email: "sam.stranger.cancel@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    const q1 = await quoteOf(event, demo[1]);
    ok([403, 404].includes((await call("PATCH", `/events/${event.id}/quotes/${q1.id}/cancel`, {}, stranger)).status), "nobody else can remove chefs");
    ok((await call("PATCH", `/events/${event.id}/quotes/${q1.id}/cancel`, { reason: "Call me on 07700900123" }, cass)).status === 400, "no phone numbers in the reason");

    // When everyone left has replied, the customer can compare.
    const q2 = await quoteOf(event, demo[2]);
    for (const [q, t] of [[q1, tokens[1]], [q2, tokens[2]]]) ok((await call("POST", `/chef-portal/quotes/${q.id}/submit`, { items: [], serviceFee: 200, willAttend: "yes" }, t)).status === 200, "a chef sends a quote");
    let detail = (await call("GET", `/events/${event.id}`, null, cass)).data;
    ok(detail.status === "quotes_ready", "quotes ready once the remaining chefs replied", detail.status);

    // ===== Chosen and awaiting payment: removing a chef updates the total =====
    r = await call("POST", `/events/${event.id}/confirm`, { acceptedQuoteIds: [q1.id, q2.id] }, cass);
    ok(r.status === 200 && r.data.finalTotal === 400, "both quotes chosen: £400 to pay", r.data);
    r = await call("PATCH", `/events/${event.id}/quotes/${q2.id}/cancel`, {}, cass);
    ok(r.status === 200 && r.data.finalTotal === 200, "removing one chosen chef: £200 to pay", r.data);
    detail = (await call("GET", `/events/${event.id}`, null, cass)).data;
    ok(detail.status === "awaiting_payment" && detail.finalTotal === 200, "still awaiting payment at the new total", { s: detail.status, t: detail.finalTotal });
    ok((await call("GET", "/notifications", null, cass)).data.some((n) => n.title === "Your booking total has changed"), "the customer is told the new total");

    // ===== Removing the last chef cancels the booking =====
    r = await call("PATCH", `/events/${event.id}/quotes/${q1.id}/cancel`, {}, cass);
    ok(r.status === 200 && r.data.cancelledAll === true, "removing the last chef cancels the booking", r.data);
    detail = (await call("GET", `/events/${event.id}`, null, cass)).data;
    ok(detail.status === "cancelled", "booking cancelled", detail.status);
    ok((await call("PATCH", `/events/${event.id}/quotes/${q1.id}/cancel`, {}, cass)).status === 400, "nothing more to cancel");

    // ===== Paid bookings can't be changed this way =====
    event = await book(demo.slice(0, 2));
    await db.query("UPDATE events SET status = 'confirmed', payment_status = 'paid' WHERE id = ?", [event.id]);
    const paidQuote = await quoteOf(event, demo[0]);
    r = await call("PATCH", `/events/${event.id}/quotes/${paidQuote.id}/cancel`, {}, cass);
    ok(r.status === 400 && /support/.test(r.data.error), "paid: ask support instead", r.data);

    await db.end();
    console.log(`cancel one chef: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
