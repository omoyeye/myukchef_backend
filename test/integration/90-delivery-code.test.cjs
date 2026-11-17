// Delivery codes (like Uber Eats): the customer gives a 4-digit code to whoever hands the food over.
// Also: what chefs see of where the customer is, and the arrival time while the driver shares their position.
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
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const upload = async (token) => {
    const form = new FormData();
    form.append("image", new Blob([PNG], { type: "image/png" }), "p.png");
    const res = await fetch(API + "/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return (await res.json()).url;
};

(async () => {
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const amara = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const dee = (await patient("POST", "/auth/register", { name: "Dee Delivery", email: "dee.delivery@test.local", password: "TestPass-2026x", acceptTerms: true })).data.token;
    ok(admin && amara && dee, "sign in");

    // ===== Rules =====
    ok((await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "over", overAmount: 0 } }, admin)).status === 400, "an amount is needed for 'over'");
    ok((await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "first" } }, admin)).status === 200, "first orders only (the default)");
    await call("PUT", "/chefs/me", { openingHours: null, noticeHours: 0, ordersPaused: false }, amara);

    const amaraId = (await call("GET", "/chefs/me", null, amara)).data.id;
    const dish = (await call("GET", "/chefs/products/public")).data.find((d) => d.chef?.id === amaraId);
    ok(dish, "a dish to order");
    const body = (extra = {}) => ({
        items: [{ menuItem: { id: dish.id, name: dish.name }, quantity: 1, selectedModifiers: [] }],
        deliveryMethod: "pickup",
        deliveryAddress: { firstName: "Dee", lastName: "Delivery", email: "dee.delivery@test.local", phone: "07123456789", line1: "", city: "", postcode: "" },
        ...extra,
    });

    // ===== First order gets a code =====
    let r = await call("POST", "/orders", body(), dee);
    ok(r.status === 201 || r.status === 200, "first order placed", r.data);
    const first = r.data;
    const mine = (await call("GET", `/orders/${first.id}`, null, dee)).data;
    ok(/^\d{4}$/.test(mine.deliveryCode ?? ""), "the customer sees a 4-digit code", mine.deliveryCode);
    const code = mine.deliveryCode;
    const stranger = (await call("GET", `/orders/${first.id}`)).data;
    ok(stranger && !("deliveryCode" in stranger) && !JSON.stringify(stranger).includes(`"${code}"`), "someone with just the order number can't see it");

    // The chef knows a code is needed, but never sees it.
    let chefList = (await call("GET", "/chef-portal/orders", null, amara)).data;
    let chefView = chefList.find((o) => o.id === first.id);
    ok(chefView && chefView.codeRequired === true && chefView.codeLocked === false, "chef told a code is needed", chefView);
    ok(!JSON.stringify(chefView).includes("deliveryCode") && !Object.values(chefView).includes(code), "the chef never gets the code");

    // ===== Moving the order on =====
    await call("PATCH", `/chef-portal/orders/${first.id}/status`, { status: "preparing" }, amara);
    await call("PATCH", `/chef-portal/orders/${first.id}/status`, { status: "delivery" }, amara);
    const notes = (await call("GET", "/notifications", null, dee)).data;
    ok(notes.some((n) => n.message.includes(`Your delivery code is ${code}`) && /collect/.test(n.message)), "the 'ready to collect' notice includes the code", notes[0]);

    const proof = await upload(amara);
    r = await call("PATCH", `/chef-portal/orders/${first.id}/status`, { status: "completed", proof }, amara);
    ok(r.status === 400 && /delivery code/.test(r.data.error), "can't finish without the code", r.data);
    const wrong = code === "0000" ? "1111" : "0000";
    r = await call("PATCH", `/chef-portal/orders/${first.id}/status`, { status: "completed", proof, code: wrong }, amara);
    ok(r.status === 400 && /4 tries left/.test(r.data.error), "a wrong code counts", r.data);
    r = await call("PATCH", `/chef-portal/orders/${first.id}/status`, { status: "completed", proof, code: ` ${code.slice(0, 2)} ${code.slice(2)} ` }, amara);
    ok(r.status === 200, "the right code (spaces ignored) completes it", r.data);
    ok((await call("GET", `/orders/${first.id}`, null, dee)).data.deliveryCode === null, "the code disappears once delivered");

    // ===== Second order: no code =====
    r = await call("POST", "/orders", body(), dee);
    const second = r.data;
    ok(!(await call("GET", `/orders/${second.id}`, null, dee)).data.deliveryCode, "second order has no code");
    await call("PATCH", `/chef-portal/orders/${second.id}/status`, { status: "preparing" }, amara);
    await call("PATCH", `/chef-portal/orders/${second.id}/status`, { status: "delivery" }, amara);
    ok((await call("PATCH", `/chef-portal/orders/${second.id}/status`, { status: "completed", proof }, amara)).status === 200, "finishes without a code");

    // ===== Every order, and locking after five wrong codes =====
    await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "all" } }, admin);
    r = await call("POST", "/orders", body(), dee);
    const third = r.data;
    const thirdCode = (await call("GET", `/orders/${third.id}`, null, dee)).data.deliveryCode;
    ok(/^\d{4}$/.test(thirdCode ?? ""), "every order gets one when Super Admin asks");
    await call("PATCH", `/chef-portal/orders/${third.id}/status`, { status: "preparing" }, amara);
    await call("PATCH", `/chef-portal/orders/${third.id}/status`, { status: "delivery" }, amara);
    const bad = thirdCode === "9999" ? "8888" : "9999";
    for (let i = 0; i < 4; i++) await call("PATCH", `/chef-portal/orders/${third.id}/status`, { status: "completed", proof, code: bad }, amara);
    r = await call("PATCH", `/chef-portal/orders/${third.id}/status`, { status: "completed", proof, code: bad }, amara);
    ok(r.status === 423 && /Too many/.test(r.data.error), "locked after five wrong codes", r.data);
    r = await call("PATCH", `/chef-portal/orders/${third.id}/status`, { status: "completed", proof, code: thirdCode }, amara);
    ok(r.status === 423, "even the right code is refused once locked");
    ok((await call("GET", "/notifications", null, admin)).data.some((n) => n.title === `Order #${third.id}: delivery code locked`), "Super Admin is told");
    chefView = (await call("GET", "/chef-portal/orders", null, amara)).data.find((o) => o.id === third.id);
    ok(chefView.codeLocked === true, "the chef sees it's locked");

    ok((await call("POST", `/orders/${third.id}/delivery-code/waive`, { reason: "x" }, amara)).status === 403, "chefs can't skip the code");
    ok((await call("POST", `/orders/${third.id}/delivery-code/waive`, {}, admin)).status === 400, "skipping needs a reason");
    ok((await call("POST", `/orders/${third.id}/delivery-code/waive`, { reason: "Phoned the customer, who confirmed they have it" }, admin)).status === 200, "Super Admin lets it finish without the code");
    ok((await call("PATCH", `/chef-portal/orders/${third.id}/status`, { status: "completed", proof }, amara)).status === 200, "then the chef can finish it");

    // ===== Orders over an amount =====
    await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "over", overAmount: 100000 } }, admin);
    r = await call("POST", "/orders", body(), dee);
    ok(!(await call("GET", `/orders/${r.data.id}`, null, dee)).data.deliveryCode, "small repeat orders have no code under 'over'");
    await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "first" } }, admin);

    // ===== Chefs see where the customer is; customers see an arrival time =====
    await call("PUT", "/chefs/me", { latitude: 51.5074, longitude: -0.1278 }, amara).catch(() => null);
    r = await call("POST", "/orders", body({ deliveryMethod: "delivery", deliveryAddress: { firstName: "Dee", lastName: "Delivery", email: "dee.delivery@test.local", phone: "07123456789", line1: "1 Test Street", city: "London", postcode: "SW1A 1AA" } }), dee);
    const del = r.data;
    chefView = (await call("GET", "/chef-portal/orders", null, amara)).data.find((o) => o.id === del.id);
    ok(chefView && chefView.deliveryAddress?.postcode === "SW1A 1AA" && "destination" in chefView && "distanceMiles" in chefView, "chef sees the address, map point and distance fields", chefView);
    const tracker = (await call("GET", `/orders/${del.id}`, null, dee)).data;
    ok("etaMinutes" in tracker && tracker.etaMinutes === null, "no arrival time before the driver sets off");

    console.log(`delivery code: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
