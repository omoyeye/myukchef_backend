import crypto from "crypto";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "../db";
import { integrationSettings } from "../db/schema";

// Keys for Stripe, Brevo and Claude (AI writing help in the admin area). Super Admins save them from the admin area; anything they haven't
// saved falls back to the server's environment variables. Saved values are encrypted, and secret
// keys are never sent back to the browser in full.

export type Provider = "stripe" | "brevo" | "claude";

interface FieldSpec {
    label: string;
    secret?: boolean;
    env?: string;
    check?: (value: string) => string | null; // returns an error message
    max?: number;
}

const isEmail = (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter a valid email address");

export const FIELDS: Record<Provider, Record<string, FieldSpec>> = {
    stripe: {
        secretKey: { label: "Secret key", secret: true, env: "STRIPE_SECRET_KEY", check: (v) => (/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(v) ? null : "Stripe secret keys start with sk_test_, sk_live_, rk_test_ or rk_live_") },
        publishableKey: { label: "Publishable key", env: "STRIPE_PUBLISHABLE_KEY", check: (v) => (/^pk_(test|live)_[A-Za-z0-9]+$/.test(v) ? null : "Stripe publishable keys start with pk_test_ or pk_live_") },
        webhookSecret: { label: "Webhook signing secret", secret: true, env: "STRIPE_WEBHOOK_SECRET", check: (v) => (/^whsec_[A-Za-z0-9]+$/.test(v) ? null : "Stripe webhook secrets start with whsec_") },
    },
    brevo: {
        apiKey: { label: "API key", secret: true, env: "BREVO_API_KEY", check: (v) => (/^xkeysib-[A-Za-z0-9-]+$/.test(v) ? null : "Brevo API keys start with xkeysib-") },
        senderEmail: { label: "Send emails from", env: "MAIL_FROM", check: isEmail },
        supportEmail: { label: "Support inbox", env: "SUPPORT_EMAIL", check: isEmail },
        smsSender: { label: "SMS sender name", env: "BREVO_SMS_SENDER", check: (v) => (/^[A-Za-z0-9 ]{1,11}$/.test(v) ? null : "SMS sender names are up to 11 letters or numbers") },
    },
    claude: {
        apiKey: { label: "Claude API key", secret: true, env: "ANTHROPIC_API_KEY", check: (v) => (/^sk-ant-[A-Za-z0-9_-]+$/.test(v) ? null : "Claude API keys start with sk-ant-") },
    },
};
// Switches that aren't keys.
const FLAGS: Record<Provider, string[]> = { stripe: ["enabled"], brevo: [], claude: [] };

const DEFAULTS: Record<Provider, Record<string, string>> = {
    stripe: {},
    brevo: { senderEmail: "info@myukchef.com", supportEmail: "info@myukchef.com", smsSender: "MYUKCHEF" },
    claude: {},
};

export const isProvider = (p: unknown): p is Provider => p === "stripe" || p === "brevo" || p === "claude";

// === Encryption ===

function encryptionKey(): Buffer | null {
    const secret = process.env.SECRETS_KEY || process.env.AUTH_SECRET;
    if (!secret || secret.length < 32) return null;
    return crypto.createHash("sha256").update(`myukchef-integrations:${secret}`).digest();
}

function encrypt(data: object) {
    const key = encryptionKey();
    if (!key) throw Object.assign(new Error("The server needs AUTH_SECRET (or SECRETS_KEY) set to at least 32 characters before keys can be saved."), { status: 400 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

function decrypt(value: string): Record<string, unknown> | null {
    const key = encryptionKey();
    const [version, iv, tag, body] = value.split(".");
    if (!key || version !== "v1" || !iv || !tag || !body) return null;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
    } catch {
        return null;
    }
}

// === Reading ===

interface Stored { values: Record<string, unknown>; unreadable: boolean; updatedAt: Date | null }
const CACHE_MS = 60_000;
const cache = new Map<Provider, { at: number; stored: Stored }>();

async function stored(provider: Provider): Promise<Stored> {
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.stored;
    const [row] = await db.select().from(integrationSettings).where(eq(integrationSettings.provider, provider)).limit(1);
    const values = row ? decrypt(row.value) : {};
    if (row && !values) console.error(`Saved ${provider} keys can't be read. Was AUTH_SECRET changed? Re-enter them in the admin area.`);
    const result = { values: values ?? {}, unreadable: !!row && !values, updatedAt: row?.updatedAt ?? null };
    cache.set(provider, { at: Date.now(), stored: result });
    return result;
}

/** Each field: the saved value, else the environment variable, else the default. */
async function resolved(provider: Provider) {
    const { values } = await stored(provider);
    const out: Record<string, { value: string; source: "saved" | "server" | "default" | "none" }> = {};
    for (const [name, spec] of Object.entries(FIELDS[provider])) {
        const saved = typeof values[name] === "string" ? (values[name] as string) : "";
        const env = spec.env ? process.env[spec.env] ?? "" : "";
        const fallback = DEFAULTS[provider][name] ?? "";
        out[name] = saved ? { value: saved, source: "saved" } : env ? { value: env, source: "server" } : fallback ? { value: fallback, source: "default" } : { value: "", source: "none" };
    }
    return { fields: out, values };
}

export async function getBrevo() {
    const { fields } = await resolved("brevo");
    return { apiKey: fields.apiKey.value, senderEmail: fields.senderEmail.value, supportEmail: fields.supportEmail.value, smsSender: fields.smsSender.value };
}

/** The Claude API key for AI writing help, or "" when none is set. */
export async function getClaudeKey() {
    const { fields } = await resolved("claude");
    return fields.apiKey.value;
}

export async function getStripeSettings() {
    const { fields, values } = await resolved("stripe");
    const secretKey = fields.secretKey.value;
    // Payments are on when a secret key exists, unless an admin has switched them off.
    const enabled = !!secretKey && values.enabled !== false;
    return { enabled, secretKey, publishableKey: fields.publishableKey.value, webhookSecret: fields.webhookSecret.value, testMode: /_test_/.test(secretKey) };
}

const clients = new Map<string, Stripe>();
/** A Stripe client for the current key, or null when card payments are off. */
export async function getStripe() {
    const settings = await getStripeSettings();
    if (!settings.enabled) return null;
    let client = clients.get(settings.secretKey);
    if (!client) {
        client = new Stripe(settings.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
        clients.clear();
        clients.set(settings.secretKey, client);
    }
    return { client, settings };
}

// === Admin view and changes ===

const mask = (v: string) => (v.length > 8 ? `${v.startsWith("sk-ant-") ? "sk-ant-" : v.slice(0, v.indexOf("_", 3) + 1 || 4)}••••${v.slice(-4)}` : "••••");

export async function adminView(provider: Provider) {
    const { fields, values } = await resolved(provider);
    const { unreadable, updatedAt } = await stored(provider);
    const view: Record<string, unknown> = { provider, updatedAt, unreadable, fields: {} as Record<string, unknown> };
    for (const [name, spec] of Object.entries(FIELDS[provider])) {
        const f = fields[name];
        (view.fields as Record<string, unknown>)[name] = {
            label: spec.label,
            secret: !!spec.secret,
            source: f.source,
            isSet: !!f.value,
            // Secret keys are only ever shown masked.
            value: spec.secret ? (f.value ? mask(f.value) : "") : f.value,
        };
    }
    if (provider === "stripe") {
        const s = await getStripeSettings();
        Object.assign(view, { enabled: s.enabled, switchedOff: values.enabled === false, testMode: s.testMode });
    }
    return view;
}

/**
 * Saves changes. For each field: a string sets it, "" clears the saved value (falling back to
 * the server's setting), and leaving it out keeps what's there.
 */
export async function saveSettings(provider: Provider, body: Record<string, unknown>, userId: number) {
    const current = { ...(await stored(provider)).values };
    for (const [name, spec] of Object.entries(FIELDS[provider])) {
        if (!(name in body)) continue;
        const raw = body[name];
        if (raw === null || raw === "") { delete current[name]; continue; }
        if (typeof raw !== "string") throw Object.assign(new Error(`${spec.label} must be text`), { status: 400 });
        const value = raw.trim();
        if (value.length > 500) throw Object.assign(new Error(`${spec.label} is too long`), { status: 400 });
        const problem = spec.check?.(value);
        if (problem) throw Object.assign(new Error(problem), { status: 400 });
        current[name] = value;
    }
    for (const flag of FLAGS[provider]) {
        if (flag in body) current[flag] = body[flag] !== false;
    }
    if (provider === "stripe") {
        const secret = typeof current.secretKey === "string" ? current.secretKey : process.env.STRIPE_SECRET_KEY ?? "";
        const pub = typeof current.publishableKey === "string" ? current.publishableKey : process.env.STRIPE_PUBLISHABLE_KEY ?? "";
        const mode = (k: string) => (/_live_/.test(k) ? "live" : /_test_/.test(k) ? "test" : null);
        if (secret && pub && mode(secret) !== mode(pub)) throw Object.assign(new Error("The secret and publishable keys must both be test keys or both be live keys."), { status: 400 });
    }
    const value = encrypt(current);
    const [existing] = await db.select({ id: integrationSettings.id }).from(integrationSettings).where(eq(integrationSettings.provider, provider)).limit(1);
    if (existing) await db.update(integrationSettings).set({ value, updatedBy: userId, updatedAt: new Date() }).where(eq(integrationSettings.id, existing.id));
    else await db.insert(integrationSettings).values({ provider, value, updatedBy: userId });
    cache.delete(provider);
    return adminView(provider);
}

/** Removes everything saved for a provider, so the server's own settings apply again. */
export async function clearSettings(provider: Provider) {
    await db.delete(integrationSettings).where(eq(integrationSettings.provider, provider));
    cache.delete(provider);
    return adminView(provider);
}

/** Checks the keys work by making a harmless read-only call. */
export async function testConnection(provider: Provider) {
    if (provider === "claude") {
        const { checkClaude } = await import("./claude");
        return checkClaude();
    }
    if (provider === "brevo") {
        const { apiKey } = await getBrevo();
        if (!apiKey) return { ok: false, message: "No Brevo API key yet." };
        const res = await fetch("https://api.brevo.com/v3/account", { headers: { accept: "application/json", "api-key": apiKey }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!res) return { ok: false, message: "Couldn't reach Brevo. Try again in a moment." };
        if (!res.ok) return { ok: false, message: res.status === 401 ? "Brevo didn't accept this API key." : `Brevo replied with an error (${res.status}).` };
        const account = (await res.json().catch(() => ({}))) as { email?: string; companyName?: string };
        return { ok: true, message: `Connected to Brevo${account.companyName ? ` as ${account.companyName}` : ""}.` };
    }
    const settings = await getStripeSettings();
    if (!settings.secretKey) return { ok: false, message: "No Stripe secret key yet." };
    try {
        const client = new Stripe(settings.secretKey, { timeout: 10_000 });
        const account = await client.accounts.retrieve();
        const name = account.settings?.dashboard?.display_name || account.business_profile?.name;
        const warnings = [
            !settings.publishableKey && "add the publishable key",
            !settings.webhookSecret && "add the webhook signing secret",
        ].filter(Boolean);
        return {
            ok: true,
            message: `Connected to Stripe${name ? ` (${name})` : ""} in ${settings.testMode ? "test" : "live"} mode.${warnings.length ? ` Still to do: ${warnings.join(" and ")}.` : ""}`,
        };
    } catch (error) {
        const e = error as { type?: string; message?: string };
        return { ok: false, message: e.type === "StripeAuthenticationError" ? "Stripe didn't accept this secret key." : `Stripe error: ${e.message ?? "unknown"}` };
    }
}
