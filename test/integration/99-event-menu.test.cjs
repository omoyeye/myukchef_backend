// Event menus: chefs offer items just for events (trays, platters, extras like serving staff), with
// their own unit, price, people served and minimum, alongside their everyday dishes. Customers pick
// from them when asking for quotes. Event-only items never appear on the everyday menu or in baskets.
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
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const amara = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const evan = (await patient("POST", "/auth/register", { name: "Evan Eventful", email: "evan.event@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && amara && evan, "sign in");
    const chef = (await call("GET", "/chefs/me", null, amara)).data;
    await call("PUT", "/chefs/me", { isAvailableForEvents: true, acceptsFarOrders: false }, amara);

    const base = { description: "Party jollof, smoky and rich", image: "/uploads/tray.png", category: "platters", allergens: [], allergensDeclared: true };
    // ===== Checks on what chefs send =====
    let r = await call("POST", "/chefs/me/products", { ...base, name: "Nowhere tray", price: 10, forMenu: false, forEvents: false }, amara);
    ok(r.status === 400 && /everyday menu, for events, or both/.test(r.data.error), "must be on the menu, for events, or both", r.data);
    r = await call("POST", "/chefs/me/products", { ...base, name: "Odd unit tray", price: 10, forMenu: false, eventUnit: "barrel" }, amara);
    ok(r.status === 400, "unknown unit refused", r.data);
    r = await call("POST", "/chefs/me/products", { ...base, name: "Zero serves tray", price: 10, forMenu: false, eventServes: 0 }, amara);
    ok(r.status === 400, "a tray must feed someone", r.data);

    // ===== An event-only tray and an extra =====
    r = await call("POST", "/chefs/me/products", { ...base, name: "Party jollof tray", price: 60, forMenu: false, forEvents: true, eventUnit: "tray", eventServes: 10, eventPrice: 55, eventMinQty: 2 }, amara);
    ok(r.status === 201 && r.data.forMenu === false && r.data.eventUnit === "tray" && r.data.eventServes === 10 && r.data.eventPrice === 55 && r.data.eventMinQty === 2, "event-only tray saved", r.data);
    const tray = r.data;
    r = await call("POST", "/chefs/me/products", { ...base, name: "Serving staff", description: "A server for your guests", category: "extras", price: 20, forMenu: false, eventUnit: "hour", eventMinQty: 3 }, amara);
    ok(r.status === 201, "an extra (serving staff by the hour) saved", r.data);
    const staff = r.data;
    for (const d of [tray, staff]) ok((await call("PATCH", `/chefs/admin/products/${d.id}/status`, { status: "approved" }, admin)).status === 200, `admin approves ${d.name}`);

    // ===== Never on the everyday menu or in a basket =====
    const publicDishes = (await call("GET", "/chefs/products/public")).data;
    ok(!(publicDishes.data ?? publicDishes).some((d) => d.id === tray.id), "the tray isn't on the everyday menu");
    ok(!(await call("GET", `/chefs/${chef.id}/products`)).data.some((d) => d.id === tray.id), "or on the chef's everyday dishes");
    ok((await call("GET", `/products/${tray.id}`)).status === 404, "or as a dish page");
    r = await call("POST", "/orders", { items: [{ menuItem: { id: tray.id, name: tray.name }, quantity: 1, selectedModifiers: [] }], deliveryMethod: "pickup", deliveryAddress: { firstName: "Evan", lastName: "E", email: "evan.event@test.local", phone: "07123456789", line1: "", city: "", postcode: "" } }, evan);
    ok(r.status === 400, "and can't be ordered from the basket", r.data);

    // ===== The event menu =====
    const menu = (await call("GET", `/events/menu?chef=${chef.id}`)).data;
    const t = menu.find((d) => d.id === tray.id);
    ok(t && t.eventOnly === true && t.unit === "tray" && t.serves === 10 && t.price === 55 && t.minQty === 2, "the event menu shows the tray with its event price, unit, serves and minimum", t);
    ok(menu.findIndex((d) => d.id === tray.id) < menu.findIndex((d) => !d.eventOnly), "event-only items come first", menu.map((d) => d.name));
    const everyday = menu.find((d) => !d.eventOnly);
    ok(everyday && everyday.unit === "portion" && everyday.serves === 1, "everyday dishes are there too, by the portion", everyday);
    ok((await call("GET", "/events/menu")).data.some((d) => d.id === tray.id), "the full event menu lists it too");

    // A chef can keep an everyday dish off the event menu.
    const mine = (await call("GET", "/chefs/me/products", null, amara)).data;
    const hidden = mine.find((d) => d.status === "approved" && d.forMenu && d.id !== tray.id && d.id !== staff.id);
    if (hidden) {
        await call("PUT", `/chefs/me/products/${hidden.id}`, { ...hidden, forEvents: false }, amara);
        await call("PATCH", `/chefs/admin/products/${hidden.id}/status`, { status: "approved" }, admin);
        ok(!(await call("GET", `/events/menu?chef=${chef.id}`)).data.some((d) => d.id === hidden.id), "a dish kept off the event menu isn't listed");
        await call("PUT", `/chefs/me/products/${hidden.id}`, { ...hidden, forEvents: true }, amara);
        await call("PATCH", `/chefs/admin/products/${hidden.id}/status`, { status: "approved" }, admin);
    }

    // ===== Asking for a quote =====
    const event = (items) => ({ eventName: "Evan's graduation", venue: "The Hall", eventTime: "17:00", contactPhone: "07700900444", eventDate: day(40), adults: 25, kids: 5, chefRequests: [{ chefId: chef.id, preferences: "", items }] });
    r = await call("POST", "/events", event([{ id: tray.id, quantity: 1 }]), evan);
    ok(r.status === 400 && /minimum of 2 trays/.test(r.data.error), "the minimum is enforced", r.data);
    r = await call("POST", "/events", event([{ id: tray.id, quantity: 3 }, { id: staff.id, quantity: 4 }]), evan);
    ok(r.status === 201, "quote request with a tray and serving staff", r.data);
    const quotes = (await call("GET", "/chef-portal/quotes", null, amara)).data.quotes;
    const q = quotes.find((x) => x.event?.id === r.data.id);
    const line = q?.items.find((i) => i.id === tray.id);
    ok(line && line.quantity === 3 && line.unit === "tray" && line.serves === 10 && line.guidePrice === 55, "the chef sees 3 trays (serving 10 each) at the event price", line);
    ok(q?.items.find((i) => i.id === staff.id)?.unit === "hour", "and 4 hours of serving staff", q?.items);

    // Tidy up: these items belong to this test only.
    for (const d of [tray, staff]) await call("DELETE", `/chefs/me/products/${d.id}`, null, amara);

    console.log(`event menu: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
