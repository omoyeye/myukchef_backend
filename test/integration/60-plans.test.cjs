// Meal plans of any length from 1 week to 6 months, plan history, and ordering a plan again.
const path = require("path");
const backend = path.resolve(__dirname, "../..");
require(path.join(backend, "node_modules/dotenv")).config({ path: path.join(backend, ".env"), quiet: true });
const mysql = require(path.join(backend, "node_modules/mysql2/promise"));

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
    if (r.status === 429) { await new Promise((done) => setTimeout(done, 61_000)); r = await call(method, p, body); }
    return r;
};
const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

(async () => {
    const u = new URL(process.env.DATABASE_URL);
    const db = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: process.env.TEST_DB_NAME });
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const amara = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const pat = (await patient("POST", "/auth/register", { name: "Pat Planner", email: "pat.plans@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && amara && pat, "sign in");
    const chef = (await call("GET", "/chefs/me", null, amara)).data;
    await call("PUT", "/chefs/me", { acceptsMealPlans: true }, amara);
    await db.query("UPDATE chefs SET accepts_meal_plans = 1, latitude = NULL, longitude = NULL WHERE id = ?", [chef.id]);

    // ===== What the builder offers =====
    const config = (await call("GET", "/meal-plans/config")).data;
    ok(config.minWeeks === 1 && config.maxWeeks === 26, "plans run from 1 to 26 weeks", config);
    ok(config.presets.map((p) => p.label).join(",") === "1 week,2 weeks,1 month,2 months,3 months,6 months", "quick choices from a week to six months", config.presets);
    ok(config.presets[0].discountPercent === 0 && config.presets[5].discountPercent >= config.presets[4].discountPercent, "longer plans save at least as much");
    ok(config.durations.length === 3, "older app versions still get 1, 3 and 6 months");

    const dishes = (await call("GET", `/meal-plans/chefs/${chef.id}/dishes`)).data;
    ok(Array.isArray(dishes) && dishes.length > 0, "chef has dishes for plans", dishes);
    const base = {
        chefId: chef.id, mealsPerWeek: 3, servings: 2, deliveryWindow: "evening", startDate: day(config.leadDays + 2),
        rotation: dishes.slice(0, 2).map((d) => d.id),
        address: { street: "1 Plan Street", city: "London", postcode: "SW1A 1AA", phone: "07700900111" },
    };

    // ===== Any length from 1 week to 6 months =====
    for (const bad of [0, 27, 2.5, "six"]) {
        const r = await call("POST", "/meal-plans", { ...base, durationWeeks: bad }, pat);
        ok(r.status === 400 && /1 week to 6 months/.test(r.data.error), `refuses a ${bad} week plan`, r.data);
    }
    let r = await call("POST", "/meal-plans", { ...base, durationWeeks: 6 }, pat);
    ok(r.status === 201 && r.data.durationWeeks === 6 && r.data.durationMonths === 1, "a 6 week plan", r.data);
    const plan = r.data;
    let detail = (await call("GET", `/meal-plans/${plan.id}`, null, pat)).data;
    ok(detail.weeks.length === 6 && detail.weeks[5].deliveryDate === day(config.leadDays + 2 + 35), "six weekly deliveries", detail.weeks.map((w) => w.deliveryDate));
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => /a 6 week plan/.test(n.message) && n.title === "New meal plan request"), "chef is told it's a 6 week plan");
    // An older app version asking for 3 months still works, and is a 13 week plan. (Declined straight away below.)
    const legacy = await call("POST", "/meal-plans", { ...base, chefId: chef.id, durationMonths: 3 }, pat);
    ok(legacy.status === 409, "one open plan per chef still applies");

    // ===== Cook it, finish it =====
    ok((await call("PATCH", `/meal-plans/${plan.id}/respond`, { action: "accept" }, amara)).status === 200, "chef accepts");
    // Pretend the first two weeks have happened: move them into the past and mark them paid.
    await db.query("UPDATE meal_plan_weeks SET delivery_date = DATE_SUB(CURDATE(), INTERVAL (8 - week_number) DAY), is_paid = 1, paid_at = NOW() WHERE plan_id = ? AND week_number <= 2", [plan.id]);
    for (const w of detail.weeks.slice(0, 2)) {
        const d = await call("PATCH", `/meal-plans/${plan.id}/weeks/${w.id}/status`, { status: "delivered" }, amara);
        ok(d.status === 200, `week ${w.weekNumber} delivered`, d.data);
    }
    ok((await call("PUT", `/meal-plans/admin/${plan.id}`, { status: "completed" }, admin)).status === 200, "plan finished");

    // ===== Customer history =====
    const history = (await call("GET", "/meal-plans/history", null, pat)).data;
    const past = history.plans.find((p) => p.id === plan.id);
    ok(past && past.weeksDelivered === 2 && past.mealsDelivered === 6 && past.paidTotal > 0, "history shows deliveries, meals and money", past);
    ok(past.favouriteDishes.length >= 1 && past.favouriteDishes[0].meals >= 1, "history shows favourite dishes", past.favouriteDishes);
    ok(past.canReorder === true && history.totals.plans === 1 && history.totals.meals === 6, "can order it again; totals add up", history.totals);
    ok((await call("GET", "/meal-plans/history", null, amara)).data.plans.length === 0, "a chef's own customer history is empty");

    // ===== Suggestions =====
    const suggestions = (await call("GET", "/meal-plans/suggestions", null, pat)).data;
    ok(suggestions.length === 1 && suggestions[0].planId === plan.id && suggestions[0].durationWeeks === 6 && suggestions[0].length === "6 weeks", "suggests ordering it again", suggestions);
    ok(/6 meals/.test(suggestions[0].reason) && suggestions[0].weeklyPrice > 0, "explains why, with a weekly price", suggestions[0]);

    // ===== Chef history =====
    let chefHistory = (await call("GET", "/meal-plans/chef/history", null, amara)).data;
    ok(chefHistory.plans.some((p) => p.id === plan.id && p.customerName === "Pat" && p.deliveryAddress.phone === ""), "chef history: first name only, no phone", chefHistory.plans[0]);
    ok(chefHistory.totals.plans >= 1 && chefHistory.totals.meals >= 6 && chefHistory.totals.returnRate === 0, "chef history totals", chefHistory.totals);
    ok((await call("GET", "/meal-plans/chef/history", null, pat)).status === 403, "customers have no chef history");

    // ===== Ordering again, with a new length =====
    r = await call("POST", `/meal-plans/${plan.id}/renew`, { durationWeeks: 27 }, pat);
    ok(r.status === 400, "re-order length is checked too");
    r = await call("POST", `/meal-plans/${plan.id}/renew`, { durationWeeks: 2 }, pat);
    ok(r.status === 201 && r.data.durationWeeks === 2 && r.data.renewedFromId === plan.id, "orders it again as a 2 week plan", r.data);
    const again = (await call("GET", "/meal-plans/history", null, pat)).data.plans.find((p) => p.id === plan.id);
    ok(again.canReorder === false && again.nextPlanId === r.data.id, "history links to the new plan", again);
    ok((await call("GET", "/meal-plans/suggestions", null, pat)).data.length === 0, "no suggestion once re-ordered");
    ok((await call("POST", `/meal-plans/${plan.id}/renew`, { durationWeeks: 4 }, pat)).status === 409, "can't order the same plan again twice");
    chefHistory = (await call("GET", "/meal-plans/chef/history", null, amara)).data;
    ok(chefHistory.plans.find((p) => p.id === plan.id).renewed === true && chefHistory.totals.returnRate === 100, "chef sees the customer came back", chefHistory.totals);

    // Old plans (from before flexible lengths) get their length in weeks.
    await db.query("UPDATE meal_plans SET duration_weeks = NULL, duration_months = 3 WHERE id = ?", [plan.id]);
    ok((await call("GET", `/meal-plans/${plan.id}`, null, pat)).data.durationWeeks === 13, "older plans read as 13 weeks for 3 months");

    await db.end();
    console.log(`plans: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
