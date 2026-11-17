// Paying for a meal plan with Stripe: the chef accepts, the customer is asked to pay (with a "pay now"
// card on the plan), and once Stripe says it's paid, Super Admins hear about it and the chef is told to cook.
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const API = process.env.TEST_API;
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { fail++; console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); } };
const call = async (method, p, body, token, headers = {}) => {
    const res = await fetch(API + p, { signal: AbortSignal.timeout(60_000), method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
};
const patient = async (method, p, body) => {
    let r = await call(method, p, body);
    if (r.status === 429) { await new Promise((done) => setTimeout(done, 61_000)); r = await call(method, p, body); }
    return r;
};
const FAKE_SK = "sk_test_" + "A".repeat(40);
const FAKE_PK = "pk_test_" + "B".repeat(40);
const WHSEC = "whsec_" + "D".repeat(32);
const webhook = (event) => {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
    return call("POST", "/payments/stripe/webhook", payload, null, { "stripe-signature": `t=${t},v1=${sig}` });
};
const paidSession = (weekId) => ({
    id: "evt_" + crypto.randomBytes(6).toString("hex"), object: "event", type: "checkout.session.completed", api_version: "2025-01-01", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_plan_" + weekId, object: "checkout.session", payment_status: "paid", status: "complete", payment_intent: "pi_plan_" + weekId, metadata: { kind: "plan_week", id: String(weekId) } } },
});
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
void path;

(async () => {
    const u = new URL(process.env.DATABASE_URL);
    const db = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: process.env.TEST_DB_NAME });
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const amara = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const paula = (await patient("POST", "/auth/register", { name: "Paula Payer", email: "paula.pay@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && amara && paula, "sign in");
    const chef = (await call("GET", "/chefs/me", null, amara)).data;
    await db.query("UPDATE chefs SET accepts_meal_plans = 1, latitude = NULL, longitude = NULL WHERE id = ?", [chef.id]);
    await db.query("UPDATE meal_plans SET status = 'cancelled' WHERE chef_id = ?", [chef.id]);

    // ===== Card payments on (test keys) =====
    const saved = await call("PUT", "/admin/integrations/stripe", { secretKey: FAKE_SK, publishableKey: FAKE_PK, webhookSecret: WHSEC }, admin);
    ok(saved.status === 200 && saved.data.enabled, "Stripe on in test mode", saved.data);

    const config = (await call("GET", "/meal-plans/config")).data;
    const dishes = (await call("GET", `/meal-plans/chefs/${chef.id}/dishes`)).data;
    let r = await call("POST", "/meal-plans", { chefId: chef.id, durationWeeks: 3, mealsPerWeek: 3, adults: 2, kids: 2, deliveryWindow: "evening", startDate: day(config.leadDays + 3), rotation: dishes.slice(0, 2).map((d) => d.id), address: { street: "1 Pay Street", city: "London", postcode: "SW1A 1AA", phone: "07700900333" } }, paula);
    ok(r.status === 201, "plan requested", r.data);
    const planId = r.data.id;
    let detail = (await call("GET", `/meal-plans/${planId}`, null, paula)).data;
    ok(detail.paymentDue === null, "nothing to pay before the chef accepts", detail.paymentDue);

    // ===== The chef accepts: the customer is asked to pay =====
    ok((await call("PATCH", `/meal-plans/${planId}/respond`, { action: "accept", note: "Looking forward to cooking for you" }, amara)).status === 200, "chef accepts");
    const week1 = detail.weeks[0];
    let notes = (await call("GET", "/notifications", null, paula)).data;
    const accepted = notes.find((n) => /accepted your meal plan: please pay/.test(n.title));
    ok(accepted && accepted.link === `/my-plans/${planId}?pay=${week1.id}` && accepted.message.includes(`£${week1.total.toFixed(2)}`) && /Looking forward/.test(accepted.message), "customer gets 'accepted, please pay' with the amount and a pay link", accepted ?? notes[0]);
    detail = (await call("GET", `/meal-plans/${planId}`, null, paula)).data;
    ok(detail.paymentDue && detail.paymentDue.weekId === week1.id && detail.paymentDue.amount === week1.total && detail.paymentDue.unpaidCount === 3 && detail.paymentDue.payBy, "the plan shows a 'pay now' card for week 1", detail.paymentDue);
    const mine = (await call("GET", "/meal-plans/mine", null, paula));
    if (mine.status === 200) {
        const listed = mine.data.find((p) => p.id === planId);
        ok(listed && listed.nextPayment?.weekId === week1.id, "the plans list knows what's due", listed?.nextPayment);
    }
    let sheet = (await call("GET", "/meal-plans/chef/cook-sheet", null, amara)).data.filter((w) => w.planId === planId);
    ok(sheet.length > 0 && sheet.every((w) => w.awaitingPayment === true), "the chef's cook sheet says to wait for payment", sheet.map((w) => w.awaitingPayment));

    // ===== Stripe says it's paid =====
    r = await webhook(paidSession(week1.id));
    ok(r.status === 200, "signed webhook accepted", r.data);
    const [[row]] = await db.query("SELECT is_paid, paid_at, stripe_payment_intent_id FROM meal_plan_weeks WHERE id = ?", [week1.id]);
    ok(row.is_paid === 1 && row.paid_at && row.stripe_payment_intent_id === "pi_plan_" + week1.id, "week 1 recorded as paid", row);
    notes = (await call("GET", "/notifications", null, paula)).data;
    ok(notes.some((n) => n.title === "Week 1 paid" && /told to start cooking/.test(n.message)), "customer thanked and told the chef is cooking", notes[0]);
    const adminNotes = (await call("GET", "/notifications", null, admin)).data;
    ok(adminNotes.some((n) => n.title === `Meal plan #${planId}: week 1 paid` && /paid by card/.test(n.message)), "Super Admin told it's paid", adminNotes[0]);
    const chefNotes = (await call("GET", "/notifications", null, amara)).data;
    ok(chefNotes.some((n) => n.title === "Week 1 is paid: go ahead and cook" && /2 adults and 2 children/.test(n.message)), "chef told to go ahead and cook, for whom", chefNotes[0]);
    // The same webhook again changes nothing.
    await webhook(paidSession(week1.id));
    ok((await call("GET", "/notifications", null, amara)).data.filter((n) => n.title === "Week 1 is paid: go ahead and cook").length === 1, "a repeated webhook doesn't tell the chef twice");

    detail = (await call("GET", `/meal-plans/${planId}`, null, paula)).data;
    ok(detail.paymentDue?.weekNumber === 2 && detail.paymentDue.unpaidCount === 2, "the card moves on to week 2", detail.paymentDue);
    sheet = (await call("GET", "/meal-plans/chef/cook-sheet", null, amara)).data.filter((w) => w.planId === planId);
    ok(sheet.find((w) => w.id === week1.id)?.awaitingPayment === false, "week 1 is ready to cook on the cook sheet", sheet.map((w) => [w.weekNumber, w.awaitingPayment]));

    // ===== A Super Admin records a payment (bank transfer, say) =====
    const week2 = detail.weeks[1];
    ok((await call("PATCH", `/meal-plans/${planId}/weeks/${week2.id}/payment`, { isPaid: true }, admin)).status === 200, "admin records week 2 paid");
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => n.title === "Week 2 is paid: go ahead and cook"), "chef told to cook week 2");
    ok((await call("GET", "/notifications", null, admin)).data.some((n) => n.title === `Meal plan #${planId}: week 2 paid` && /recorded as paid/.test(n.message)), "admins see it was recorded");

    // ===== Without card payments, acceptance is just "confirmed" =====
    await call("PUT", "/admin/integrations/stripe", { enabled: false }, admin);
    detail = (await call("GET", `/meal-plans/${planId}`, null, paula)).data;
    ok(detail.paymentDue === null, "no 'pay now' card when card payments are off", detail.paymentDue);
    await db.query("UPDATE meal_plans SET status = 'cancelled' WHERE id = ?", [planId]);
    r = await call("POST", "/meal-plans", { chefId: chef.id, durationWeeks: 1, mealsPerWeek: 3, servings: 2, deliveryWindow: "evening", startDate: day(config.leadDays + 3), rotation: dishes.slice(0, 2).map((d) => d.id), address: { street: "1 Pay Street", city: "London", postcode: "SW1A 1AA", phone: "07700900333" } }, paula);
    await call("PATCH", `/meal-plans/${r.data.id}/respond`, { action: "accept" }, amara);
    ok((await call("GET", "/notifications", null, paula)).data[0]?.title === "Your meal plan is confirmed", "card payments off: the usual 'confirmed' message");
    await db.query("UPDATE meal_plans SET status = 'cancelled' WHERE id = ?", [r.data.id]);
    await call("DELETE", "/admin/integrations/stripe", null, admin);

    await db.end();
    console.log(`plan payments: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
