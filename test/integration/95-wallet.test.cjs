// Wallets: rewards wait for a Super Admin to release them, customers spend credit at checkout, chefs withdraw.
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
    return (await (await fetch(API + "/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form })).json()).url;
};
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
    const admin = (await patient("POST", "/auth/login", { email: "admin@test.local", password: "AdminTest-2026x", portal: "admin" })).data.token;
    const amara = (await patient("POST", "/auth/login", { email: "demo.chef.amara@example.com", password: "ChefTest-2026x", portal: "chef" })).data.token;
    const reg = (await patient("POST", "/auth/register", { name: "Wendy Wallet", email: "wendy.wallet@test.local", password: "TestPass-2026x", acceptTerms: true })).data;
    const wendy = reg.token;
    ok(admin && amara && wendy, "sign in");
    await call("POST", "/settings", { key: "delivery_code_config", value: { mode: "off" } }, admin);

    // ===== Rules =====
    ok((await call("PUT", "/wallet/admin/rules", {}, wendy)).status === 403, "customers can't change wallet rules");
    let r = await call("PUT", "/wallet/admin/rules", { release: "manual", referral: { enabled: true, newCustomer: 5, referrer: 5 }, loyalty: { enabled: true, percent: 10 }, spend: { maxPercent: 50, minOrder: 1 }, withdraw: { minAmount: 10 } }, admin);
    ok(r.status === 200 && r.data.loyalty.percent === 10 && r.data.release === "manual", "rules saved", r.data);

    const amaraId = (await call("GET", "/chefs/me", null, amara)).data.id;
    const dish = (await call("GET", "/chefs/products/public")).data.find((d) => d.chef?.id === amaraId);
    const body = (extra = {}) => ({
        items: [{ menuItem: { id: dish.id, name: dish.name }, quantity: 2, selectedModifiers: [] }],
        deliveryMethod: "pickup",
        deliveryAddress: { firstName: "Wendy", lastName: "Wallet", email: "wendy.wallet@test.local", phone: "07123456789", line1: "", city: "", postcode: "" },
        ...extra,
    });
    const proof = await upload(amara);
    const deliver = async (id) => {
        for (const s of ["preparing", "delivery"]) await call("PATCH", `/chef-portal/orders/${id}/status`, { status: s }, amara);
        return call("PATCH", `/chef-portal/orders/${id}/status`, { status: "completed", proof }, amara);
    };

    // ===== Earning: pending until released =====
    let w = (await call("GET", "/wallet", null, wendy)).data;
    ok(w.available === 0 && w.pending === 0 && w.withdraw.allowed === false, "new wallet is empty; customers can't withdraw", w);
    const first = (await call("POST", "/orders", body(), wendy)).data;
    ok((await deliver(first.id)).status === 200, "first order delivered");
    w = (await call("GET", "/wallet", null, wendy)).data;
    ok(w.pending === r2(first.total * 0.1) && w.available === 0, "10% cashback is pending, not spendable yet", w);
    ok(w.entries[0].type === "loyalty" && w.entries[0].status === "pending" && w.entries[0].orderId === first.id, "history shows the pending cashback", w.entries[0]);

    const pending = (await call("GET", "/wallet/admin/entries?status=pending", null, admin)).data;
    const mine = pending.find((e) => e.userId === reg.user.id);
    ok(mine && mine.name === "Wendy Wallet" && mine.role === "customer", "Super Admin sees it waiting", mine);
    ok((await call("GET", "/wallet/admin/entries", null, wendy)).status === 403, "customers can't see everyone's wallets");
    r = await call("POST", "/wallet/admin/release", { ids: [mine.id] }, admin);
    ok(r.status === 200 && r.data.released === 1, "released");
    ok((await call("POST", "/wallet/admin/release", { ids: [mine.id] }, admin)).data.released === 0, "can't release twice");
    w = (await call("GET", "/wallet", null, wendy)).data;
    ok(w.available === r2(first.total * 0.1) && w.pending === 0, "now spendable", w);
    ok((await call("GET", "/notifications", null, wendy)).data.some((n) => /is in your wallet/.test(n.title)), "the customer is told when it's released");

    // ===== Super Admin gifts and corrections =====
    ok((await call("POST", "/wallet/admin/credit", { userId: reg.user.id, amount: 20 }, admin)).status === 400, "a note is needed");
    ok((await call("POST", "/wallet/admin/credit", { userId: reg.user.id, amount: -5, note: "x" }, admin)).status === 400, "gifts can't be negative");
    r = await call("POST", "/wallet/admin/credit", { userId: reg.user.id, amount: 20, note: "Sorry your order was late" }, admin);
    ok(r.status === 201, "gift added");
    ok((await call("POST", "/wallet/admin/credit", { userId: reg.user.id, amount: -1000, kind: "adjustment", note: "Mistake" }, admin)).status === 400, "can't take a wallet below £0");
    const balance = (await call("GET", "/wallet", null, wendy)).data.available;
    ok(balance === r2(first.total * 0.1 + 20), "gift is spendable straight away", balance);

    // ===== Spending at checkout =====
    const plain = (await call("POST", "/orders", body(), wendy)).data;
    ok(plain.walletAmount === 0, "the wallet isn't used unless the customer chooses to");
    r = await call("POST", "/orders", body({ useWallet: true }), wendy);
    const paidByWallet = r.data;
    const beforeTip = plain.total;
    ok(r.status === 201 && paidByWallet.walletAmount === r2(Math.min(balance, beforeTip * 0.5)) && paidByWallet.total === r2(beforeTip - paidByWallet.walletAmount), "wallet pays up to half the order", { walletAmount: paidByWallet.walletAmount, total: paidByWallet.total, beforeTip });
    w = (await call("GET", "/wallet", null, wendy)).data;
    ok(w.available === r2(balance - paidByWallet.walletAmount) && w.entries.some((e) => e.type === "spend" && e.orderId === paidByWallet.id), "taken from the wallet, linked to the order", w.available);
    r = await call("POST", `/orders/${paidByWallet.id}/cancel`, {}, wendy);
    ok(r.status === 200, "order cancelled", r.data);
    ok((await call("GET", "/wallet", null, wendy)).data.available === balance, "a cancelled order gives the wallet money back");

    // Two orders at once can't spend the same money.
    const [a, b] = await Promise.all([call("POST", "/orders", body({ useWallet: true }), wendy), call("POST", "/orders", body({ useWallet: true }), wendy)]);
    ok(r2(a.data.walletAmount + b.data.walletAmount) <= balance && (await call("GET", "/wallet", null, wendy)).data.available >= 0, "never spends more than the balance", { a: a.data.walletAmount, b: b.data.walletAmount, balance });

    await call("PUT", "/wallet/admin/rules", { release: "manual", referral: { enabled: true, newCustomer: 5, referrer: 5 }, loyalty: { enabled: true, percent: 10 }, spend: { maxPercent: 50, minOrder: 500 }, withdraw: { minAmount: 10 } }, admin);
    r = await call("POST", "/orders", body({ useWallet: true }), wendy);
    ok(r.status === 400 && /£500.00 or more/.test(r.data.error), "minimum order for using the wallet", r.data);
    ok((await call("POST", "/wallet/withdraw", { amount: 10 }, wendy)).status === 403, "customers can't withdraw");

    // ===== Chefs withdraw =====
    const amaraUser = (await call("GET", "/auth/me", null, amara)).data.user;
    await call("POST", "/wallet/admin/credit", { userId: amaraUser.id, amount: 30, note: "Thanks for referring three chefs" }, admin);
    w = (await call("GET", "/wallet", null, amara)).data;
    ok(w.available >= 30 && w.withdraw.allowed && w.withdraw.minAmount === 10, "chef wallet, with withdrawal allowed", w.withdraw);
    const chefStart = w.available;
    ok((await call("POST", "/wallet/withdraw", { amount: 5 }, amara)).status === 400, "below the minimum withdrawal");
    ok((await call("POST", "/wallet/withdraw", { amount: chefStart + 1 }, amara)).status === 400, "can't withdraw more than the balance");
    r = await call("POST", "/wallet/withdraw", { amount: 15 }, amara);
    ok(r.status === 201, "withdrawal requested", r.data);
    const wd = r.data.id;
    ok((await call("POST", "/wallet/withdraw", { amount: 10 }, amara)).status === 409, "one withdrawal at a time");
    ok((await call("GET", "/wallet", null, amara)).data.available === r2(chefStart - 15), "held while it waits");
    ok((await call("GET", "/notifications", null, admin)).data.some((n) => n.title === "Chef wallet withdrawal to pay"), "Super Admin is told");
    ok((await call("POST", `/wallet/admin/withdrawals/${wd}/reject`, {}, admin)).status === 400, "rejecting needs a reason");
    ok((await call("POST", `/wallet/admin/withdrawals/${wd}/reject`, { reason: "Please add your bank details first" }, admin)).status === 200, "rejected");
    ok((await call("GET", "/wallet", null, amara)).data.available === chefStart, "rejected money is back");
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => n.title === "Withdrawal not paid" && /bank details/.test(n.message)), "chef told why");

    const wd2 = (await call("POST", "/wallet/withdraw", { amount: 15 }, amara)).data.id;
    ok((await call("POST", `/wallet/admin/withdrawals/${wd2}/pay`, { method: "bank" }, admin)).status === 400, "bank payment needs a reference");
    ok((await call("POST", `/wallet/admin/withdrawals/${wd2}/pay`, { method: "bank", reference: "BACS 17/11 MYUK-W2" }, admin)).status === 200, "paid by bank transfer");
    ok((await call("POST", `/wallet/admin/withdrawals/${wd2}/pay`, { method: "bank", reference: "again" }, admin)).status === 400, "can't pay twice");
    w = (await call("GET", "/wallet", null, amara)).data;
    ok(w.available === r2(chefStart - 15) && w.entries.some((e) => e.type === "withdrawal" && e.status === "paid"), "chef sees it paid", w.available);
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => /withdrawal sent/.test(n.title)), "chef told it's sent");

    // ===== Cancelling a reward, overview, people =====
    const second = (await call("POST", "/orders", body(), wendy)).data;
    await deliver(second.id);
    const cashback = (await call("GET", "/wallet/admin/entries?status=pending&type=loyalty", null, admin)).data.find((e) => e.orderId === second.id);
    ok(cashback, "second order's cashback waiting");
    ok((await call("POST", "/wallet/admin/cancel", { ids: [cashback.id] }, admin)).status === 400, "cancelling needs a reason");
    r = await call("POST", "/wallet/admin/cancel", { ids: [cashback.id], reason: "Order was refunded outside the app" }, admin);
    ok(r.data.cancelled === 1, "reward cancelled");
    const s = (await call("GET", "/wallet/admin/summary", null, admin)).data;
    ok(typeof s.balances === "number" && s.withdrawalCount === 0 && s.rules.loyalty.percent === 10, "overview", s);
    const people = (await call("GET", "/wallet/admin/wallets?q=wendy", null, admin)).data;
    ok(people.length === 1 && people[0].name === "Wendy Wallet", "find a person's wallet", people);
    ok((await call("GET", `/wallet/admin/users/${reg.user.id}`, null, admin)).data.entries.length >= 4, "Super Admin sees their history");

    // Put the default rules back for anything that runs later.
    await call("PUT", "/wallet/admin/rules", {}, admin);
    console.log(`wallet: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
