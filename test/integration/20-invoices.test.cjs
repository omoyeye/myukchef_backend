// Checks chef invoices and payouts, certificates, delivery bands and the related admin controls.
const path = require("path");
const backend = path.resolve(__dirname, "../..");
require(path.join(backend, "node_modules/dotenv")).config({ path: path.join(backend, ".env"), quiet: true });
const mysql = require(path.join(backend, "node_modules/mysql2/promise"));
const bcrypt = require(path.join(backend, "node_modules/bcrypt"));

const API = process.env.TEST_API;
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { fail++; console.log("FAIL:", label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); } };
const call = async (method, p, body, token) => {
    const res = await fetch(API + p, { signal: AbortSignal.timeout(60_000), method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null), res };
};
const upload = async (p, field, name, type, bytes, token) => {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type }), name);
    const res = await fetch(API + p, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
    return { status: res.status, data: await res.json().catch(() => null) };
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

(async () => {
    const u = new URL(process.env.DATABASE_URL);
    const db = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: process.env.TEST_DB_NAME });
    await db.query("UPDATE users SET password=? WHERE email LIKE 'demo.chef.%'", [await bcrypt.hash("ChefTest-2026x", 10)]);
    const login = async (email, password, portal) => (await call("POST", "/auth/login", { email, password, portal })).data.token;
    const admin = await login("admin@test.local", "AdminTest-2026x", "admin");
    const amara = await login("demo.chef.amara@example.com", "ChefTest-2026x", "chef");
    const leo = await login("demo.chef.leo@example.com", "ChefTest-2026x", "chef");
    const cara = (await call("POST", "/auth/register", { name: "Cara Customer", email: "cara@test.local", password: "TestPass-2026x", acceptTerms: true })).data?.token ?? await login("cara@test.local", "TestPass-2026x");
    ok(admin && amara && leo && cara, "sign in");
    const amaraId = (await call("GET", "/chefs/me", null, amara)).data.id;

    // ===== Delivery bands =====
    const bands = await call("POST", "/settings", { key: "delivery_config", value: { fee: 4, freeOver: 0, serviceFeePercent: 10, minOrder: 0, tiers: [{ minOrder: 50, fee: 0, note: "Big orders come by van" }, { minOrder: 20, fee: 2.5 }, { minOrder: -5, fee: 1 }, { minOrder: 20, fee: 9 }] } }, admin);
    ok(bands.status === 200, "Super Admin saves delivery bands");
    const settings = (await call("GET", "/settings")).data;
    const t = settings.delivery_config.tiers;
    ok(t.length === 2 && t[0].minOrder === 20 && t[0].fee === 2.5 && t[1].minOrder === 50 && t[1].fee === 0 && t[1].note === "Big orders come by van", "bands tidied: sorted, bad and duplicate ones dropped", settings.delivery_config.tiers);
    ok((await call("POST", "/settings", { key: "delivery_config", value: { tiers: [] } }, cara)).status === 403, "customers can't change delivery bands");
    const dishes = (await call("GET", "/chefs/products/public")).data;
    const dish = dishes.find((d) => d.chef?.displayName === "Amara Okafor");
    const place = async (qty, method = "delivery", token = cara) => call("POST", "/orders", {
        items: [{ menuItem: { id: dish.id, name: dish.name }, quantity: qty, selectedModifiers: [] }],
        deliveryMethod: method,
        deliveryAddress: { firstName: "Cara", lastName: "Customer", email: "cara@test.local", phone: "07123456789", line1: "3 Test Lane", city: "London", postcode: "E1 6AN" },
    }, token);
    const totalFor = (qty, fee) => Math.round((dish.price * qty * 1.1 + fee) * 100) / 100;
    const small = await place(1);
    ok(small.data.total === totalFor(1, dish.price * 1 >= 20 ? 2.5 : 4), "small order pays the standard or band fee", { got: small.data.total, price: dish.price });
    const qtyBig = Math.ceil(50 / dish.price);
    const big = await place(qtyBig);
    ok(big.data.total === totalFor(qtyBig, 0), "big order gets the free-delivery band", { got: big.data.total, want: totalFor(qtyBig, 0) });
    const qtyMid = Math.ceil(20 / dish.price);
    if (dish.price * qtyMid < 50) {
        const mid = await place(qtyMid);
        ok(mid.data.total === totalFor(qtyMid, 2.5), "middle order gets the £2.50 band", { got: mid.data.total });
    }
    const pickup = await place(1, "pickup");
    ok(pickup.data.total === totalFor(1, 0), "collection pays no delivery");

    // ===== Payout rules =====
    ok((await call("GET", "/payouts/admin", null, cara)).status === 403, "customers can't see payouts");
    ok((await call("GET", "/payouts/admin", null, amara)).status === 403, "chefs can't see everyone's payouts");
    let rules = (await call("GET", "/payouts/admin", null, admin)).data.rules;
    ok(rules.percent === 10 && rules.autoConfirmHours === 48, "default commission 10% and 48 hours", rules);
    ok((await call("PUT", "/payouts/admin/rules", { percent: 80, autoConfirmHours: 48 }, admin)).status === 400, "silly commission refused");
    ok((await call("PUT", "/payouts/admin/rules", { percent: 10, autoConfirmHours: 0 }, admin)).status === 400, "zero hours refused");
    ok((await call("POST", "/settings", { key: "chef_commission", value: { percent: 1 } }, admin)).status === 400, "commission can't be changed through general settings");

    // ===== Delivery → confirmation → invoice → submit → bank payout → receipt =====
    const flow = async (qty) => {
        const o = (await place(qty)).data;
        for (const s of ["preparing", "delivery"]) await call("PATCH", `/chef-portal/orders/${o.id}/status`, { status: s }, amara);
        const photo = await upload("/upload", "image", "p.png", "image/png", PNG, amara);
        await call("PATCH", `/chef-portal/orders/${o.id}/status`, { status: "completed", proof: photo.data.url }, amara);
        return o;
    };
    const o1 = await flow(2);
    let mine = (await call("GET", "/payouts/me", null, amara)).data;
    ok(mine.invoices.length === 0, "no invoice before the customer confirms");
    const queue = (await call("GET", "/payouts/admin", null, admin)).data;
    ok(queue.deliveries.some((d) => d.orderId === o1.id && !d.customerConfirmedAt), "admin sees delivery waiting for the customer");

    await call("POST", `/orders/${o1.id}/confirm-delivery`, { received: true }, cara);
    mine = (await call("GET", "/payouts/me", null, amara)).data;
    const inv = mine.invoices.find((i) => i.orderId === o1.id);
    const gross = Math.round(dish.price * 2 * 100) / 100;
    ok(inv && inv.status === "awaiting_chef" && /^INV-\d{4}-\d{6}$/.test(inv.number), "invoice raised once the customer confirms", inv);
    ok(inv.grossAmount === gross && inv.commissionPercent === 10 && inv.commissionAmount === Math.round(gross * 0.1 * 100) / 100 && inv.netAmount === Math.round((gross - Math.round(gross * 0.1 * 100) / 100) * 100) / 100, "10% commission taken off the chef's sales", inv);
    ok(mine.payoutAccount.stripeReady === false, "no Stripe: chef told they'll be paid by bank");
    const notes = (await call("GET", "/notifications", null, amara)).data;
    ok(notes.some((n) => n.title === `Invoice ${inv.number} is ready` && n.link === "/chef/dashboard?tab=payouts"), "chef told the invoice is ready");

    ok((await call("POST", `/payouts/me/invoices/${inv.id}/submit`, { confirm: true, name: "Leo M" }, leo)).status === 404, "another chef can't submit it");
    ok((await call("POST", `/payouts/me/invoices/${inv.id}/submit`, { name: "Amara Okafor" }, amara)).status === 400, "submitting needs the confirmation");
    ok((await call("POST", `/payouts/me/invoices/${inv.id}/submit`, { confirm: true, name: "" }, amara)).status === 400, "submitting needs a name");
    ok((await call("POST", `/payouts/admin/invoices/${inv.id}/pay`, {}, admin)).status === 400, "can't pay before the chef submits");
    const sub = await call("POST", `/payouts/me/invoices/${inv.id}/submit`, { confirm: true, name: "Amara Okafor" }, amara);
    ok(sub.status === 200 && sub.data.status === "submitted" && /bank transfer/.test(sub.data.payoutError), "submitted; waits for a bank transfer without Stripe", sub.data);
    ok((await call("POST", `/payouts/me/invoices/${inv.id}/submit`, { confirm: true, name: "Amara Okafor" }, amara)).status === 400, "can't submit twice");
    const adminNotes = (await call("GET", "/notifications", null, admin)).data;
    ok(adminNotes.some((n) => /Pay .* by bank transfer/.test(n.title)), "Super Admin told to pay by bank");
    ok((await call("POST", "/payouts/me/connect", {}, amara)).status === 400, "connecting Stripe explains it isn't available yet");

    const paid = await call("POST", `/payouts/admin/invoices/${inv.id}/pay`, {}, admin);
    ok(paid.status === 200 && paid.data.status === "paid" && paid.data.payMethod === "bank" && /^RCT-\d{4}-\d{6}$/.test(paid.data.receiptNumber), "Super Admin records the transfer; receipt issued", paid.data);
    ok((await call("POST", `/payouts/admin/invoices/${inv.id}/pay`, {}, admin)).data.receiptNumber === paid.data.receiptNumber, "paying again changes nothing");
    const [[prog]] = await db.query("SELECT payout_status, paid_at, gross_amount, commission_percent, payout_amount FROM order_chef_progress WHERE id=?", [inv.progressId]);
    ok(prog.payout_status === "paid" && prog.paid_at && prog.commission_percent === 10 && prog.payout_amount === inv.netAmount, "order record shows the chef paid", prog);
    const chefNotes = (await call("GET", "/notifications", null, amara)).data;
    ok(chefNotes.some((n) => /You've been paid/.test(n.title) && n.link === `/chef/receipts/${inv.id}`), "chef gets the receipt notice");
    const receipt = await call("GET", `/payouts/invoices/${inv.id}`, null, amara);
    ok(receipt.status === 200 && receipt.data.receiptNumber && receipt.data.submittedName === "Amara Okafor", "chef opens the receipt");
    ok((await call("GET", `/payouts/invoices/${inv.id}`, null, admin)).status === 200, "Super Admin opens the receipt");
    ok((await call("GET", `/payouts/invoices/${inv.id}`, null, leo)).status === 404, "another chef can't open it");
    ok((await call("GET", `/payouts/invoices/${inv.id}`, null, cara)).status === 404, "customers can't open it");

    // Problem reported: no invoice until the Super Admin lets it go ahead.
    const o2 = await flow(1);
    await call("POST", `/orders/${o2.id}/confirm-delivery`, { received: false, issue: "Cold food" }, cara);
    ok(!(await call("GET", "/payouts/me", null, amara)).data.invoices.some((i) => i.orderId === o2.id), "no invoice while there's a problem");
    const problem = (await call("GET", "/payouts/admin", null, admin)).data.deliveries.find((d) => d.orderId === o2.id);
    ok(problem && problem.customerIssue === "Cold food", "admin sees the problem");
    const released = await call("POST", `/payouts/admin/deliveries/${problem.id}/release`, {}, admin);
    ok(released.status === 200 && released.data.status === "awaiting_chef", "admin lets the invoice go ahead");

    // Hold and release, and cancelling an order voids its unpaid invoice.
    const held = await call("POST", `/payouts/admin/invoices/${released.data.id}/hold`, { reason: "Checking with the customer" }, admin);
    ok(held.data.status === "held", "invoice put on hold");
    ok((await call("POST", `/payouts/me/invoices/${released.data.id}/submit`, { confirm: true, name: "Amara" }, amara)).status === 400, "can't submit while on hold");
    ok((await call("POST", `/payouts/admin/invoices/${released.data.id}/release`, {}, admin)).data.status === "awaiting_chef", "released back to the chef");
    await call("PATCH", `/orders/${o2.id}/status`, { status: "cancelled" }, admin);
    const [[voided]] = await db.query("SELECT status FROM chef_invoices WHERE id=?", [released.data.id]);
    ok(voided.status === "void", "cancelling the order cancels its unpaid invoice");

    // Auto-confirm after the set time.
    const o3 = await flow(1);
    await db.query("UPDATE order_chef_progress SET delivered_at = NOW() - INTERVAL 3 DAY WHERE order_id=?", [o3.id]);
    const { execSync } = require("child_process");
    execSync(`npx tsx -e "import('./src/lib/chefPayouts').then(async (m) => { console.log(await m.autoConfirmDeliveries()); process.exit(0); })"`, { cwd: backend, env: process.env, stdio: "pipe" });
    const [[auto]] = await db.query("SELECT auto_confirmed, customer_confirmed_at FROM order_chef_progress WHERE order_id=?", [o3.id]);
    ok(auto.auto_confirmed === 1 && auto.customer_confirmed_at, "unconfirmed delivery auto-confirmed after 48 hours");
    ok((await call("GET", "/payouts/me", null, amara)).data.invoices.some((i) => i.orderId === o3.id), "auto-confirmed delivery gets its invoice");

    // Commission change applies to new deliveries only.
    await call("PUT", "/payouts/admin/rules", { percent: 12.5, autoConfirmHours: 24 }, admin);
    const o4 = await flow(4);
    await call("POST", `/orders/${o4.id}/confirm-delivery`, { received: true }, cara);
    const inv4 = (await call("GET", "/payouts/me", null, amara)).data.invoices.find((i) => i.orderId === o4.id);
    ok(inv4.commissionPercent === 12.5, "new rate used for new deliveries");
    ok((await call("GET", `/payouts/invoices/${inv.id}`, null, amara)).data.commissionPercent === 10, "old invoices keep their rate");
    await call("PUT", "/payouts/admin/rules", { percent: 10, autoConfirmHours: 48 }, admin);

    // ===== Certificates =====
    // The sample data gives each demo chef a verified certificate; start Amara from scratch.
    await db.query("DELETE FROM chef_credentials WHERE chef_id = ?", [amaraId]);
    const pdf = await upload("/upload/document", "document", "cert.pdf", "application/pdf", PDF, amara);
    ok(pdf.status === 200 && /^private:[\w-]+\.pdf$/.test(pdf.data.file), "chef uploads a private PDF", pdf.data);
    ok((await upload("/upload/document", "document", "fake.pdf", "application/pdf", Buffer.from("not a pdf"), amara)).status === 400, "fake PDF refused");
    ok((await upload("/upload/document", "document", "c.pdf", "application/pdf", PDF, cara)).status === 403, "customers can't upload documents");
    ok((await fetch(`${API.replace(/\/api$/, "")}/uploads/${pdf.data.file.slice(8)}`)).status !== 200, "private file isn't on the public uploads path");

    ok((await call("POST", "/chefs/me/credentials", { type: "food_hygiene", issuedOn: daysAgo(100) }, amara)).status === 400, "hygiene certificate needs a copy");
    ok((await call("POST", "/chefs/me/credentials", { type: "food_hygiene", issuedOn: "2099-01-01", document: pdf.data.file }, amara)).status === 400, "future issue date refused");
    const cert = await call("POST", "/chefs/me/credentials", { type: "food_hygiene", title: "Level 2 Food Hygiene and Safety for Catering", issuer: "Highfield", level: "2", issuedOn: daysAgo(100), expiresOn: daysAgo(-900), document: pdf.data.file }, amara);
    ok(cert.status === 201 && cert.data.status === "pending", "chef adds a hygiene certificate", cert.data);
    const dbs = await call("POST", "/chefs/me/credentials", { type: "dbs_check", issuer: "Basic", issuedOn: daysAgo(30), document: pdf.data.file, reference: "001234567890" }, amara);
    ok(dbs.status === 201 && dbs.data.document === null && dbs.data.reference === null, "DBS check keeps no copy and no number", dbs.data);
    ok((await call("POST", "/chefs/me/credentials", { type: "insurance", issuedOn: daysAgo(10), title: "Call 07123 456789", document: pdf.data.file }, amara)).status === 400, "contact details refused");

    let pub = (await call("GET", `/chefs/${amaraId}`)).data;
    ok(pub.credentials.length === 0 && pub.hygieneVerified === false, "nothing public before it's verified");
    ok(pub.stripeAccountId === undefined && pub.stripePayoutsEnabled === undefined, "public page never shows payout account fields");

    // The private copy: only the chef and Super Admins.
    const docUrl = `/chefs/credentials/${cert.data.id}/document`;
    ok((await fetch(API + docUrl, { headers: { Authorization: `Bearer ${amara}` } })).status === 200, "chef opens their copy");
    ok((await fetch(API + docUrl, { headers: { Authorization: `Bearer ${admin}` } })).status === 200, "Super Admin opens the copy");
    ok((await fetch(API + docUrl, { headers: { Authorization: `Bearer ${leo}` } })).status === 404, "another chef can't");
    ok((await fetch(API + docUrl, { headers: { Authorization: `Bearer ${cara}` } })).status === 404, "customers can't");
    ok((await fetch(API + docUrl)).status === 401, "signed-out visitors can't");

    // Compliance can't be verified without a verified hygiene certificate.
    await call("PUT", "/chefs/me/compliance", { legalName: "Amara Okafor", dateOfBirth: "1990-01-01", addressLine: "1 Road", city: "London", postcode: "E1 1AA", taxReference: "AB123456C", localAuthority: "Tower Hamlets", registeredOn: "2024-01-01", hygieneCertificate: "Level 2", bankAccountName: "A Okafor", bankSortCode: "12-34-56", bankAccountNumber: "12345678" }, amara);
    const early = await call("PATCH", `/chefs/admin/${amaraId}/compliance`, { verified: true }, admin);
    ok(early.status === 400 && /hygiene/.test(early.data.error), "details can't be verified before the hygiene certificate", early.data);

    ok((await call("GET", "/chefs/admin/credentials?status=pending", null, amara)).status === 403, "chefs can't review certificates");
    const queueCerts = (await call("GET", "/chefs/admin/credentials?status=pending", null, admin)).data;
    ok(queueCerts.some((c) => c.id === cert.data.id && c.hasDocument && c.chefName === "Amara Okafor"), "Super Admin sees it to check");
    ok((await call("PATCH", `/chefs/admin/credentials/${cert.data.id}`, { status: "rejected" }, admin)).status === 400, "rejecting needs a reason");
    const verified = await call("PATCH", `/chefs/admin/credentials/${cert.data.id}`, { status: "verified" }, admin);
    ok(verified.data.status === "verified", "Super Admin verifies it");
    ok((await call("GET", "/notifications", null, amara)).data.some((n) => /verified/.test(n.title)), "chef told it's verified");
    await call("PATCH", `/chefs/admin/credentials/${dbs.data.id}`, { status: "verified" }, admin);
    pub = (await call("GET", `/chefs/${amaraId}`)).data;
    ok(pub.hygieneVerified === true && pub.credentials.length === 2, "public page shows verified certificates", pub.credentials);
    ok(pub.credentials.every((c) => c.document === undefined && c.reference === undefined), "no copies or numbers on the public page");
    ok((await call("GET", "/chefs")).data.find((c) => c.id === amaraId).hygieneVerified === true, "chef list shows the badge");
    ok((await call("PATCH", `/chefs/admin/${amaraId}/compliance`, { verified: true }, admin)).status === 200, "details verified once hygiene is");

    // Hiding a badge keeps it verified; editing sends it back for checking.
    await call("PUT", `/chefs/me/credentials/${dbs.data.id}`, { showOnProfile: false }, amara);
    const [[dbsRow]] = await db.query("SELECT status FROM chef_credentials WHERE id=?", [dbs.data.id]);
    ok(dbsRow.status === "verified" && (await call("GET", `/chefs/${amaraId}`)).data.credentials.length === 1, "hidden badge stays verified but leaves the page");
    await call("PUT", `/chefs/me/credentials/${cert.data.id}`, { level: "3" }, amara);
    ok((await call("GET", `/chefs/${amaraId}`)).data.hygieneVerified === false, "edited certificate needs checking again");
    await call("PATCH", `/chefs/admin/credentials/${cert.data.id}`, { status: "verified" }, admin);

    // Expiry.
    const old = await call("POST", "/chefs/me/credentials", { type: "allergen_awareness", issuedOn: daysAgo(800), expiresOn: daysAgo(5), document: pdf.data.file }, amara);
    ok((await call("PATCH", `/chefs/admin/credentials/${old.data.id}`, { status: "verified" }, admin)).status === 400, "expired certificate can't be verified");

    // Data export includes certificates and invoices, without file paths.
    const exp = (await call("GET", "/auth/me/export", null, amara)).data;
    ok(exp.chefCertificates.length >= 2 && exp.chefCertificates.every((c) => c.document === undefined) && exp.chefInvoices.length >= 1 && exp.chefProfile.stripeAccountId === undefined, "chef's data export includes certificates and invoices");

    // Chefs with invoices can't be deleted.
    ok((await call("DELETE", `/chefs/${amaraId}`, null, admin)).status === 400, "chef with invoices can't be deleted");

    await db.end();
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
