import { eq } from "drizzle-orm";
import { db } from "../db";
import { siteSettings } from "../db/schema";

/**
 * Search and tracking settings the Super Admin manages: Google Tag Manager, Google Analytics 4 and
 * other tags, search engine verification codes, and each main page's title and description.
 * Tracking tags only ever load in a visitor's browser after they agree to analytics or marketing cookies.
 */

const KEY = "seo_config";
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });

/** The main pages Super Admins can write titles and descriptions for, with what each is for (used by Claude). */
export const SEO_PAGES = [
    { path: "/", name: "Home", purpose: "The front page: order home-cooked food from local chefs, meal plans, events, and how MYUKCHEF works." },
    { path: "/menu", name: "Menu", purpose: "Every dish available to order today from MYUKCHEF chefs, with allergens and dietary filters." },
    { path: "/chefs", name: "Our chefs", purpose: "The vetted local chefs on MYUKCHEF, with ratings, specialities and food hygiene checks." },
    { path: "/meal-plans", name: "Meal plans", purpose: "Weekly home-cooked meal plans with a chosen chef, any length from 1 week to 6 months; skip or pause any week, pay per delivery." },
    { path: "/events", name: "Events", purpose: "Book a private chef for weddings, parties and gatherings; get quotes from several chefs." },
    { path: "/videos", name: "Chef videos", purpose: "Short weekly cooking videos from MYUKCHEF chefs; follow your favourites." },
    { path: "/app", name: "Get the app", purpose: "Install the MYUKCHEF app on a phone or computer: order in two taps, live tracking, notifications." },
    { path: "/recommend", name: "Find my meal", purpose: "Answer a few questions about diet, budget and occasion to get dish and chef suggestions." },
    { path: "/chef/register", name: "Become a chef", purpose: "For cooks: apply to sell home-cooked food on MYUKCHEF, set your own menu and hours, get paid weekly." },
    { path: "/support", name: "Help", purpose: "Contact MYUKCHEF support and answers to common questions." },
] as const;
const PAGE_PATHS = new Set<string>(SEO_PAGES.map((p) => p.path));

export interface SeoConfig {
    tracking: {
        gtmId: string;          // GTM-XXXXXXX
        ga4Id: string;          // G-XXXXXXXXXX
        metaPixelId: string;    // digits
        tiktokPixelId: string;  // letters and digits
        clarityId: string;      // Microsoft Clarity project id
    };
    verification: { google: string; bing: string; pinterest: string };
    defaults: { description: string; keywords: string; ogImage: string };
    pages: Record<string, { title?: string; description?: string; keywords?: string }>;
    allowIndexing: boolean;
    updatedAt?: string;
}

export const EMPTY: SeoConfig = {
    tracking: { gtmId: "", ga4Id: "", metaPixelId: "", tiktokPixelId: "", clarityId: "" },
    verification: { google: "", bing: "", pinterest: "" },
    defaults: { description: "", keywords: "", ogImage: "" },
    pages: {},
    allowIndexing: true,
};

let cache: { at: number; config: SeoConfig } | null = null;

export async function getSeoConfig(): Promise<SeoConfig> {
    if (cache && Date.now() - cache.at < 60_000) return cache.config;
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, KEY)).limit(1).catch(() => []);
    const v = (row?.value ?? {}) as Partial<SeoConfig>;
    const config: SeoConfig = {
        tracking: { ...EMPTY.tracking, ...(v.tracking ?? {}) },
        verification: { ...EMPTY.verification, ...(v.verification ?? {}) },
        defaults: { ...EMPTY.defaults, ...(v.defaults ?? {}) },
        pages: v.pages ?? {},
        allowIndexing: v.allowIndexing !== false,
        updatedAt: v.updatedAt,
    };
    cache = { at: Date.now(), config };
    return config;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function id(value: unknown, pattern: RegExp, label: string, example: string, lower = false) {
    // IDs are often pasted in the wrong case; GTM, GA4 and TikTok use capitals, Clarity lower case.
    const v = lower ? str(value, 40).toLowerCase() : str(value, 40).toUpperCase();
    if (v && !pattern.test(v)) throw fail(`${label} doesn't look right. It should look like ${example}.`);
    return v;
}
/** Search engines give a code, or a whole <meta> tag; either can be pasted. */
function verification(value: unknown, label: string) {
    let v = str(value, 300);
    const m = v.match(/content=["']([^"']+)["']/i);
    if (m) v = m[1]!;
    if (v && !/^[A-Za-z0-9_\-.=:]{6,120}$/.test(v)) throw fail(`The ${label} verification code doesn't look right. Paste the code, or the whole meta tag.`);
    return v;
}

export async function saveSeoConfig(body: Record<string, unknown>) {
    const t = (body.tracking ?? {}) as Record<string, unknown>;
    const ver = (body.verification ?? {}) as Record<string, unknown>;
    const d = (body.defaults ?? {}) as Record<string, unknown>;
    const pagesIn = (body.pages ?? {}) as Record<string, Record<string, unknown>>;
    const pages: SeoConfig["pages"] = {};
    for (const [path, p] of Object.entries(pagesIn)) {
        if (!PAGE_PATHS.has(path) || !p || typeof p !== "object") continue;
        const entry = { title: str(p.title, 70), description: str(p.description, 170), keywords: str(p.keywords, 300) };
        if (entry.title || entry.description || entry.keywords) pages[path] = entry;
    }
    const ogImage = str(d.ogImage, 300);
    if (ogImage && !/^(\/uploads\/[\w-]+\.(jpg|jpeg|png|webp)|https:\/\/\S+)$/.test(ogImage)) throw fail("Upload the sharing image again.");
    const config: SeoConfig = {
        tracking: {
            gtmId: id(t.gtmId, /^GTM-[A-Z0-9]{4,10}$/, "The Google Tag Manager ID", "GTM-ABC1234"),
            ga4Id: id(t.ga4Id, /^G-[A-Z0-9]{6,12}$/, "The Google Analytics 4 measurement ID", "G-ABC123DEF4"),
            metaPixelId: id(t.metaPixelId, /^\d{10,20}$/, "The Meta Pixel ID", "1234567890123456"),
            tiktokPixelId: id(t.tiktokPixelId, /^[A-Z0-9]{10,30}$/, "The TikTok Pixel ID", "C1A2B3C4D5E6F7G8H9I0"),
            clarityId: id(t.clarityId, /^[a-z0-9]{6,20}$/, "The Microsoft Clarity project ID", "abcd1234ef", true),
        },
        verification: { google: verification(ver.google, "Google"), bing: verification(ver.bing, "Bing"), pinterest: verification(ver.pinterest, "Pinterest") },
        defaults: { description: str(d.description, 170), keywords: str(d.keywords, 300), ogImage },
        pages,
        allowIndexing: body.allowIndexing !== false,
        updatedAt: new Date().toISOString(),
    };
    await db.insert(siteSettings).values({ key: KEY, value: config }).onDuplicateKeyUpdate({ set: { value: config, updatedAt: new Date() } });
    cache = null;
    return config;
}

/** What the website needs: tag IDs (public by nature) and the pages' titles. Never anything secret. */
export async function publicSeo() {
    const c = await getSeoConfig();
    return { tracking: c.tracking, pages: c.pages, defaults: { description: c.defaults.description }, allowIndexing: c.allowIndexing };
}
