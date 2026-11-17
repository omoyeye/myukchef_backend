import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { notificationTemplates, type TemplateOverride } from "../../db/schema";
import { TEMPLATE_MAP, TEMPLATES, type Channel, type TemplateDef } from "./registry";

/**
 * Applies the Super Admin's edits to messages. Code that sends a message wraps the send in
 * withTemplate(key, vars, ...): with no edits, the code's own wording is used (it matches the
 * defaults); with edits, the saved wording is filled in with the placeholders instead.
 */

type Vars = Record<string, unknown>;
interface Context { key: string; vars: Vars }
const store = new AsyncLocalStorage<Context>();

/** Runs a send with a template attached, so notify() and friends can find it. */
export function withTemplate<T>(key: string, vars: Vars, send: () => T): T {
    return store.run({ key, vars }, send);
}
export const currentTemplate = () => store.getStore() ?? null;

/** Fills in {{placeholders}}. Unknown ones become empty. */
export const fill = (text: string, vars: Vars) =>
    text.replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (_m, name: string) => (vars[name] === undefined || vars[name] === null ? "" : String(vars[name])));

// === Saved edits, cached for a minute ===
const CACHE_MS = 60_000;
let cache: { at: number; map: Map<string, TemplateOverride> } | null = null;
async function overrides() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.map;
    const rows = await db.select().from(notificationTemplates).catch(() => []);
    cache = { at: Date.now(), map: new Map(rows.map((r) => [r.key, r.value])) };
    return cache.map;
}
const forget = () => { cache = null; };

export interface Content {
    channels: Record<Channel, boolean>;
    title: string;
    body: string;
    pushTitle: string;
    pushBody: string;
    emailSubject: string;
    emailBody: string;
    sms: string;
}

const ON = { inApp: true, push: true, email: true, sms: false };
const clean = (v: string | undefined) => (v && v.trim() ? v : undefined);

/**
 * What to send on each channel. `inline` is the wording the code built itself; it's used whenever
 * the Super Admin hasn't changed that part of the template.
 */
export async function resolveContent(key: string | null, vars: Vars, inline?: { title: string; body: string }): Promise<Content> {
    const def = key ? TEMPLATE_MAP.get(key) : undefined;
    const saved = key ? (await overrides()).get(key) : undefined;
    const allVars = { siteName: "MYUKCHEF", ...vars };
    const base = {
        title: inline?.title ?? (def ? fill(def.title, allVars) : ""),
        body: inline?.body ?? (def ? fill(def.body, allVars) : ""),
    };
    const pick = (field: keyof TemplateOverride, fallback: string) => {
        const custom = clean(saved?.[field] as string | undefined);
        return custom ? fill(custom, allVars) : fallback;
    };
    const title = pick("title", base.title);
    const body = pick("body", base.body);
    const channels = { ...(def?.channels ?? ON), ...(saved?.channels ?? {}) };
    for (const c of def?.unavailable ?? []) channels[c] = false;
    return {
        channels,
        title,
        body,
        pushTitle: pick("pushTitle", title),
        pushBody: pick("pushBody", body),
        emailSubject: pick("emailSubject", title),
        emailBody: pick("emailBody", body),
        sms: pick("sms", def?.sms ? fill(def.sms, allVars) : `MYUKCHEF: ${body}`).slice(0, 612),
    };
}

// === Super Admin ===

export async function listTemplates() {
    const map = await overrides();
    return TEMPLATES.map((d) => ({ ...d, saved: map.get(d.key) ?? null }));
}

const LIMITS: Record<string, number> = { title: 150, body: 2000, pushTitle: 100, pushBody: 300, emailSubject: 200, emailBody: 8000, sms: 612 };

export async function saveTemplate(key: string, input: Record<string, unknown>, userId: number) {
    const def = TEMPLATE_MAP.get(key);
    if (!def) throw Object.assign(new Error("Unknown message"), { status: 404 });
    const value: TemplateOverride = {};
    for (const [field, max] of Object.entries(LIMITS)) {
        const v = input[field];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string") throw Object.assign(new Error(`${field} must be text`), { status: 400 });
        if (v.length > max) throw Object.assign(new Error(`${field} is too long (up to ${max} characters)`), { status: 400 });
        const unknown = [...v.matchAll(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g)].map((m) => m[1]!).filter((n) => !def.vars.includes(n) && n !== "siteName");
        if (unknown.length) throw Object.assign(new Error(`This message can't use {{${unknown[0]}}}. It can use: ${[...def.vars, "siteName"].map((n) => `{{${n}}}`).join(", ")}`), { status: 400 });
        if (v.trim()) (value as Record<string, string>)[field] = v;
    }
    if (input.channels && typeof input.channels === "object") {
        value.channels = {};
        for (const c of ["inApp", "push", "email", "sms"] as Channel[]) {
            const on = (input.channels as Record<string, unknown>)[c];
            if (typeof on === "boolean" && !def.unavailable?.includes(c)) value.channels[c] = on;
        }
        if (value.channels.sms && !def.sms && def.audience !== "customer") throw Object.assign(new Error("Text messages only work for customer order messages, where we have a phone number."), { status: 400 });
    }
    await db.insert(notificationTemplates).values({ key, value, updatedBy: userId }).onDuplicateKeyUpdate({ set: { value, updatedBy: userId, updatedAt: new Date() } });
    forget();
    return (await listTemplates()).find((t) => t.key === key)!;
}

export async function resetTemplate(key: string) {
    if (!TEMPLATE_MAP.has(key)) throw Object.assign(new Error("Unknown message"), { status: 404 });
    await db.delete(notificationTemplates).where(eq(notificationTemplates.key, key));
    forget();
    return (await listTemplates()).find((t) => t.key === key)!;
}

/** Example values for previews, so the Super Admin sees a realistic message. */
export const SAMPLE_VARS: Record<string, string> = {
    firstName: "Sam", orderId: "1042", total: "36.40", amount: "27.00", chefName: "Amara Okafor", chefNames: "Amara Okafor",
    items: "2 x Jollof rice, 1 x Plantain", when: "Friday, 19:00", othersNote: "", week: "3", status: "active", note: "",
    codeNote: " Your delivery code is 4821. Give it to the person who delivers your food.", months: "3", length: "6 week", weeks: "6", mealsPerWeek: "5", servings: "2", startDate: "2026-12-01", endDate: "2027-03-01", until: "2026-12-14", count: "2",
    lockedCount: "1", date: "2026-12-05", eventName: "Sam's 40th birthday", headcount: "40", eventDate: "12/12/2026", chefCount: "3",
    update: "will be there", cancelledBy: "the customer", reference: "MYUK-E12", preview: "No onions please, I'm in flat 2.",
    reason: "The name on the certificate doesn't match.", invoiceNumber: "INV-2026-000123", description: "Order #1042", percent: "10",
    tip: "3.00", method: "to your Stripe account", dishName: "Jollof rice", title: "Level 2 Food Hygiene and Safety", rating: "5",
    reply: "Thank you so much, Sam!", points: "500", friendName: "Jo", paid: " (paid by card)", name: "Sam Smith", email: "sam@example.com",
    phone: "07700 900123", message: "Hello, I have a question about my order.", source: "server", where: "POST /api/orders",
};

export type { TemplateDef };
export { TEMPLATE_MAP };
