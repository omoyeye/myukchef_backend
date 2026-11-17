// Where chefs deliver: each chef picks their usual area and can take orders from further away, where the
// customer agrees to the chef's extra wait. Also: adults and children for meal plans and events.
// Postcodes like "TE30 1AA" are stubbed 30 miles north of the chef (see GEOCODE_STUB).
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
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const amara = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const fay = (await patient("POST", "/auth/register", { name: "Fay Faraway", email: "fay.far@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && amara && fay, "sign in");
    const chef = (await call("GET", "/chefs/me", null, amara)).data;
    // The chef's kitchen is at the stub's fixed point.
    await db.query("UPDATE chefs SET latitude = 51.5, longitude = -0.1 WHERE id = ?", [chef.id]);
    await call("PUT", "/chefs/me", { openingHours: null, noticeHours: 0, ordersPaused: false }, amara);

    // ===== The chef's settings =====
    for (const [body, label] of [[{ serviceRadiusMiles: 0 }, "a 0 mile area"], [{ serviceRadiusMiles: 201 }, "a 201 mile area"], [{ farExtraHours: 0 }, "no extra wait"], [{ farExtraHours: 200 }, "over a week's wait"], [{ farMaxMiles: -1 }, "a negative furthest distance"]]) {
        ok((await call("PUT", "/chefs/me", body, amara)).status === 400, `refuses ${label}`);
    }
    let r = await call("PUT", "/chefs/me", { serviceRadiusMiles: 10, acceptsFarOrders: false }, amara);
    ok(r.status === 200 && r.data.serviceRadiusMiles === 10 && r.data.acceptsFarOrders === false, "chef delivers within 10 miles only", r.data);

    const dish = (await call("GET", "/chefs/products/public")).data.find((d) => d.chef?.id === chef.id);
    ok(dish, "a dish to order");
    const order = (postcode, extra = {}) => ({
        items: [{ menuItem: { id: dish.id, name: dish.name }, quantity: 1, selectedModifiers: [] }],
        deliveryMethod: "delivery",
        deliveryAddress: { firstName: "Fay", lastName: "Faraway", email: "fay.far@test.local", phone: "07123456789", line1: "1 Long Road", city: "Far Town", postcode },
        ...extra,
    });

    // ===== Inside the area: as before =====
    r = await call("POST", "/orders", order("TE5 1AA"), fay);
    ok(r.status === 201 && !r.data.farAway, "5 miles away: a normal order", r.data);

    // ===== Outside, and the chef doesn't go further =====
    r = await call("POST", "/orders", order("TE30 1AA", { acceptFarWait: true }), fay);
    ok(r.status === 400 && /doesn't deliver to TE30 1AA/.test(r.data.error) && /30 miles/.test(r.data.error), "30 miles away: refused", r.data);
    let slots = (await call("POST", "/orders/slots", { itemIds: [dish.id], postcode: "TE30 1AA" })).data;
    ok(slots.outside?.length === 1 && slots.outside[0].chefId === chef.id && slots.farAway.length === 0, "the basket check says who doesn't deliver there", slots);
    r = await call("POST", "/orders", order("TE30 1AA", { deliveryMethod: "pickup" }), fay);
    ok(r.status === 201, "collecting is always fine", r.data);
    let list = (await call("GET", "/chefs?lat=51.9345&lng=-0.1")).data;
    let me = (list.data ?? list).find((c) => c.id === chef.id);
    ok(me && me.areaStatus === "outside" && me.inServiceArea === false, "the chef list says this chef doesn't deliver there", me);

    // ===== The chef takes far-away orders: 24 hours longer, up to 50 miles =====
    r = await call("PUT", "/chefs/me", { acceptsFarOrders: true, farExtraHours: 24, farMaxMiles: 50 }, amara);
    ok(r.status === 200 && r.data.acceptsFarOrders && r.data.farExtraHours === 24 && r.data.farMaxMiles === 50, "chef takes orders up to 50 miles with a 24 hour wait", r.data);
    list = (await call("GET", "/chefs?lat=51.9345&lng=-0.1")).data;
    me = (list.data ?? list).find((c) => c.id === chef.id);
    ok(me && me.areaStatus === "far" && me.extraWaitHours === 24 && me.distanceMiles === 30, "the chef list shows they'll come, with the wait", me);

    slots = (await call("POST", "/orders/slots", { itemIds: [dish.id], postcode: "TE30 1AA" })).data;
    ok(slots.farAway?.length === 1 && slots.farAway[0].extraHours === 24 && slots.farAway[0].miles === 30, "the basket check lists the wait", slots);
    ok(slots.earliest && new Date(slots.earliest).getTime() >= Date.now() + 24 * 3600_000 - 120_000, "the first time slot is at least 24 hours away", slots.earliest);
    const near = (await call("POST", "/orders/slots", { itemIds: [dish.id], lat: 51.5, lng: -0.1 })).data;
    ok(near.farAway.length === 0 && new Date(near.earliest).getTime() < Date.now() + 3 * 3600_000, "nearby, the usual times", near.earliest);

    r = await call("POST", "/orders", order("TE30 1AA"), fay);
    ok(r.status === 409 && r.data.code === "far_wait" && r.data.farAway?.[0]?.extraHours === 24, "the customer must agree to the wait first", r.data);
    r = await call("POST", "/orders", order("TE30 1AA", { acceptFarWait: true }), fay);
    ok(r.status === 201 && r.data.farAway?.[0]?.chefId === chef.id && r.data.farWaitAcceptedAt, "agreed: the order goes ahead and the agreement is kept", r.data);
    ok(new Date(r.data.scheduledFor).getTime() >= Date.now() + 24 * 3600_000 - 120_000, "and it's due after the extra wait", r.data.scheduledFor);
    const farOrder = r.data;
    // A time the customer picks inside the wait is refused.
    r = await call("POST", "/orders", order("TE30 1AA", { acceptFarWait: true, scheduledFor: new Date(Date.now() + 3 * 3600_000).toISOString() }), fay);
    ok(r.status === 400, "can't pick a time inside the wait", r.data);
    const chefOrders = (await call("GET", "/chef-portal/orders", null, amara)).data;
    const seen = chefOrders.find((o) => o.id === farOrder.id);
    ok(seen && seen.farWaitHours === 24, "the chef sees the customer agreed to wait 24 hours longer", seen);

    // Beyond the furthest distance.
    r = await call("POST", "/orders", order("TE80 1AA", { acceptFarWait: true }), fay);
    ok(r.status === 400 && /80(\.\d)? miles/.test(r.data.error), "80 miles is beyond 50: refused", r.data);
    await call("PUT", "/chefs/me", { farMaxMiles: 0 }, amara);
    r = await call("POST", "/orders", order("TE80 1AA", { acceptFarWait: true }), fay);
    ok(r.status === 201, "with no limit, 80 miles is fine", r.data);

    // ===== Meal plans: adults and children, and far away =====
    await db.query("UPDATE meal_plans SET status = 'cancelled' WHERE chef_id = ?", [chef.id]);
    await call("PUT", "/chefs/me", { acceptsMealPlans: true }, amara);
    const config = (await call("GET", "/meal-plans/config")).data;
    ok(config.maxPeople === 12, "plans feed up to 12 people", config.maxPeople);
    const dishes = (await call("GET", `/meal-plans/chefs/${chef.id}/dishes`)).data;
    const plan = (extra) => ({ chefId: chef.id, durationWeeks: 2, mealsPerWeek: 3, deliveryWindow: "evening", startDate: day(config.leadDays + 3), rotation: dishes.slice(0, 2).map((d) => d.id), address: { street: "1 Plan Street", city: "Far Town", postcode: "TE5 1AA", phone: "07700900111" }, ...extra });
    for (const [extra, label] of [[{ adults: 0, kids: 0 }, "nobody"], [{ adults: 10, kids: 3 }, "13 people"], [{ adults: -1, kids: 2 }, "minus one adult"], [{ adults: 1.5 }, "half an adult"]]) {
        r = await call("POST", "/meal-plans", plan(extra), fay);
        ok(r.status === 400, `refuses ${label}`, r.data);
    }
    r = await call("POST", "/meal-plans", plan({ adults: 2, kids: 1 }), fay);
    ok(r.status === 201 && r.data.servings === 3 && r.data.adults === 2 && r.data.kids === 1, "2 adults and 1 child: 3 portions", r.data);
    const planId = r.data.id;
    const notes = (await call("GET", "/notifications", null, amara)).data;
    ok(notes.some((n) => n.title === "New meal plan request" && /for 2 adults and 1 child/.test(n.message)), "the chef is told who it's for", notes[0]);
    const chefPlan = (await call("GET", "/meal-plans/chef", null, amara)).data.find((p) => p.id === planId);
    ok(chefPlan && chefPlan.people === "2 adults and 1 child" && chefPlan.adults === 2 && chefPlan.kids === 1, "the chef's plan list says who it's for", chefPlan);
    await db.query("UPDATE meal_plans SET status = 'cancelled' WHERE id = ?", [planId]);
    r = await call("POST", "/meal-plans", plan({ servings: 2 }), fay);
    ok(r.status === 201 && r.data.servings === 2 && r.data.adults === 2 && r.data.kids === 0, "an older app sending servings still works", r.data);
    await db.query("UPDATE meal_plans SET status = 'cancelled' WHERE id = ?", [r.data.id]);

    // Far away: needs agreement, and starts after the wait.
    const farPlan = (extra) => plan({ adults: 1, kids: 2, address: { street: "1 Plan Street", city: "Far Town", postcode: "TE30 1AA", phone: "07700900111" }, ...extra });
    await call("PUT", "/chefs/me", { farExtraHours: 72 }, amara);
    r = await call("POST", "/meal-plans", farPlan({}), fay);
    ok(r.status === 409 && r.data.code === "far_wait", "a far-away plan needs agreement", r.data);
    r = await call("POST", "/meal-plans", farPlan({ acceptFarWait: true, startDate: day(config.leadDays) }), fay);
    ok(r.status === 400 && /more for deliveries to you/.test(r.data.error), "and has to start after the extra wait", r.data);
    r = await call("POST", "/meal-plans", farPlan({ acceptFarWait: true, startDate: day(config.leadDays + 4) }), fay);
    ok(r.status === 201 && r.data.farAway?.[0]?.extraHours === 72 && r.data.farWaitAcceptedAt, "agreed: the far-away plan is requested", r.data);
    await call("PUT", "/chefs/me", { acceptsFarOrders: false, farExtraHours: 24 }, amara);

    // ===== Events: adults and children =====
    await call("PUT", "/chefs/me", { isAvailableForEvents: true }, amara);
    const event = (extra) => ({ eventName: "Fay's party", venue: "The Hall, Far Town", eventTime: "18:00", contactPhone: "07700900222", eventDate: day(30), chefRequests: [{ chefId: chef.id, preferences: "Jollof rice and small chops" }], ...extra });
    r = await call("POST", "/events", event({ adults: 0, kids: 0 }), fay);
    ok(r.status === 400, "an event for nobody is refused", r.data);
    r = await call("POST", "/events", event({ adults: 20, kids: 8 }), fay);
    ok(r.status === 201 && r.data.headcount === 28 && r.data.adults === 20 && r.data.kids === 8, "20 adults and 8 children: 28 guests", r.data);
    const eventId = r.data.id;
    const quote = (await call("GET", "/chef-portal/quotes", null, amara)).data.quotes.find((q) => q.event?.id === eventId);
    ok(quote && quote.event.adults === 20 && quote.event.kids === 8 && quote.event.people === "20 adults and 8 children", "the chef sees adults and children", quote?.event);
    r = await call("POST", "/events", event({ headcount: 12, eventName: "Older app party" }), fay);
    ok(r.status === 201 && r.data.headcount === 12 && r.data.adults === 12, "an older app sending a headcount still works", r.data);

    await db.end();
    console.log(`area and people: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
