// Runs the integration tests against a throwaway database and a real copy of the API.
//
//   TEST_DATABASE_URL=mysql://user:pass@localhost:3306/myukchef_test npm run test:integration
//
// The database name must contain "test" or "scratch": it is emptied and rebuilt every run.
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
require(path.join(root, "node_modules/dotenv")).config({ path: path.join(root, ".env"), quiet: true });
const mysql = require(path.join(root, "node_modules/mysql2/promise"));

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error("Set TEST_DATABASE_URL to a throwaway database (its name must contain 'test' or 'scratch')."); process.exit(1); }
const parsed = new URL(url);
const dbName = parsed.pathname.slice(1);
if (!/test|scratch/i.test(dbName)) { console.error(`Refusing to wipe "${dbName}": the name must contain "test" or "scratch".`); process.exit(1); }

const PORT = Number(process.env.TEST_PORT || 3077);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "myukchef-test-"));
const env = {
    ...process.env,
    DATABASE_URL: url,
    PORT: String(PORT),
    NODE_ENV: "test",
    AUTH_SECRET: "integration-test-secret-not-for-production-0123456789",
    BREVO_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    UPLOAD_DIR: path.join(work, "uploads"),
    PRIVATE_UPLOAD_DIR: path.join(work, "private"),
    LOG_DIR: path.join(work, "logs"),
    SEED_ADMIN_EMAIL: "admin@test.local",
    SEED_ADMIN_PASSWORD: "AdminTest-2026x",
    TEST_API: `http://localhost:${PORT}/api`,
    TEST_DB_NAME: dbName,
};

(async () => {
    const conn = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.query(`CREATE DATABASE \`${dbName}\``);
    await conn.end();
    const run = (cmd) => execSync(cmd, { cwd: root, env, stdio: "pipe" });
    run("npx drizzle-kit push --force");
    run("npx tsx src/seed.ts --demo");

    const server = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let serverErrors = "";
    server.stderr.on("data", (d) => { serverErrors += d; });
    const stop = () => { try { server.kill(); } catch { /* already gone */ } };
    process.on("exit", stop);

    for (let i = 0; i < 60; i++) {
        const ok = await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false);
        if (ok) break;
        if (i === 59) { console.error("The API didn't start.\n" + serverErrors); process.exit(1); }
        await new Promise((r) => setTimeout(r, 1000));
    }

    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.cjs")).sort();
    let failed = 0;
    for (const file of files) {
        process.stdout.write(`\n▶ ${file}\n`);
        try {
            execSync(`node ${JSON.stringify(path.join(__dirname, file))}`, { cwd: root, env, stdio: "inherit" });
        } catch {
            failed++;
        }
    }
    stop();
    // Windows can keep files locked for a moment after the server stops.
    await new Promise((res) => setTimeout(res, 500));
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp files, cleaned up by the system later */ }
    const drop = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
    await drop.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await drop.end();
    console.log(failed ? `\n${failed} test file(s) failed` : "\nAll integration tests passed");
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
