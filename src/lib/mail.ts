import { inArray } from "drizzle-orm";
import { db } from "../db";
import { siteSettings } from "../db/schema";
import { getBrevo } from "./integrations";
import { resolveContent, SAMPLE_VARS } from "./templates";

/**
 * Every email MYUKCHEF sends goes through here, in one branded layout: the logo at the top, and the
 * store's phone number, address and social links at the bottom (all from Super Admin, Settings).
 * The words come from the message templates the Super Admin can edit.
 */

const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 10_000;
const SITE_URL = (process.env.SITE_URL || "https://myukchef.com").replace(/\/$/, "");
const BRAND = "#ea580c";

interface EmailMessage { senderName: string; to: string; subject: string; html: string; replyTo?: string }

/** Sends one email through Brevo's API. Callers decide what a failure means, so this throws. */
export async function sendEmail({ senderName, to, subject, html, replyTo }: EmailMessage) {
    // Keys come from the admin area (Payments and email), or the server settings.
    const { apiKey, senderEmail } = await getBrevo();
    if (!apiKey) {
        console.warn(`No Brevo API key set. Email skipped: ${subject}`);
        return;
    }
    const response = await fetch(BREVO_EMAIL_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
        body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: to }],
            subject,
            htmlContent: html,
            ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => null) as { code?: string; message?: string } | null;
        throw new Error(`Brevo refused the email (${response.status}): ${detail?.message ?? detail?.code ?? "no details"}`);
    }
}

const escapeHtml = (text: unknown) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// === The brand: from Super Admin, Settings ===

interface Brand { name: string; logo: string; phone: string; email: string; address: string; socials: { label: string; url: string }[]; legal: string }
let brandCache: { at: number; brand: Brand } | null = null;

export async function getBrand(): Promise<Brand> {
    if (brandCache && Date.now() - brandCache.at < 60_000) return brandCache.brand;
    const rows = await db.select().from(siteSettings).where(inArray(siteSettings.key, ["store_info", "footer_info", "company_info"])).catch(() => []);
    const get = (key: string) => (rows.find((r) => r.key === key)?.value ?? {}) as Record<string, unknown>;
    const store = get("store_info"), footer = get("footer_info"), company = get("company_info");
    const socials = (footer.socials ?? {}) as Record<string, string>;
    const logo = typeof store.logo === "string" && store.logo ? (store.logo.startsWith("http") ? store.logo : `${SITE_URL}${store.logo}`) : `${SITE_URL}/logo.png`;
    const brand: Brand = {
        name: (store.name as string) || "MYUKCHEF",
        logo,
        phone: (store.phone as string) || "",
        email: (store.email as string) || "info@myukchef.com",
        address: (store.address as string) || "",
        socials: [["Instagram", socials.instagram], ["Facebook", socials.facebook], ["X", socials.twitter], ["TikTok", socials.tiktok]]
            .filter((s): s is [string, string] => typeof s[1] === "string" && /^https?:\/\//.test(s[1]))
            .map(([label, url]) => ({ label, url })),
        legal: [company.legalName, company.companyNumber && `Company number ${company.companyNumber}`, company.registeredAddress].filter(Boolean).join(" · "),
    };
    brandCache = { at: Date.now(), brand };
    return brand;
}
export const forgetBrand = () => { brandCache = null; };

/** Plain text from a template, as email paragraphs. Blank lines start a new paragraph. */
const paragraphs = (text: string) => text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#1f2937;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");

/** The branded layout every email uses. */
export async function brandedHtml(opts: { heading: string; body: string; button?: { label: string; url: string }; extraHtml?: string; footnote?: string }) {
    const b = await getBrand();
    const button = opts.button
        ? `<p style="margin:26px 0;"><a href="${escapeHtml(opts.button.url)}" style="display:inline-block;background:${BRAND};color:#ffffff;padding:13px 26px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;">${escapeHtml(opts.button.label)}</a></p>`
        : "";
    const contact = [b.phone && `<a href="tel:${escapeHtml(b.phone.replace(/\s/g, ""))}" style="color:#6b7280;text-decoration:none;">${escapeHtml(b.phone)}</a>`, `<a href="mailto:${escapeHtml(b.email)}" style="color:#6b7280;text-decoration:none;">${escapeHtml(b.email)}</a>`].filter(Boolean).join(" &nbsp;·&nbsp; ");
    const socials = b.socials.map((s) => `<a href="${escapeHtml(s.url)}" style="color:${BRAND};text-decoration:none;font-weight:600;margin:0 8px;">${s.label}</a>`).join("");
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f5efe9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5efe9;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
  <tr><td style="background:#1c1410;border-radius:18px 18px 0 0;padding:22px 28px;" align="left">
    <a href="${SITE_URL}" style="text-decoration:none;"><img src="${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)}" width="48" height="48" style="vertical-align:middle;border-radius:12px;border:0;"><span style="color:#ffffff;font-weight:800;font-size:20px;vertical-align:middle;margin-left:12px;letter-spacing:0.5px;">${escapeHtml(b.name)}</span></a>
  </td></tr>
  <tr><td style="background:#ffffff;padding:30px 28px 18px;">
    <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#111827;">${escapeHtml(opts.heading)}</h1>
    ${paragraphs(opts.body)}
    ${opts.extraHtml ?? ""}
    ${button}
    ${opts.footnote ? `<p style="margin:18px 0 0;font-size:12px;color:#9ca3af;">${escapeHtml(opts.footnote)}</p>` : ""}
  </td></tr>
  <tr><td style="background:#fff7ed;border-radius:0 0 18px 18px;padding:20px 28px;text-align:center;font-size:13px;color:#6b7280;line-height:1.6;">
    ${socials ? `<p style="margin:0 0 10px;">${socials}</p>` : ""}
    <p style="margin:0;">${contact}</p>
    ${b.address ? `<p style="margin:4px 0 0;">${escapeHtml(b.address)}</p>` : ""}
    ${b.legal ? `<p style="margin:8px 0 0;font-size:11px;color:#9ca3af;">${escapeHtml(b.legal)}</p>` : ""}
    <p style="margin:8px 0 0;font-size:11px;color:#9ca3af;"><a href="${SITE_URL}/privacy" style="color:#9ca3af;">Privacy</a> · <a href="${SITE_URL}/terms" style="color:#9ca3af;">Terms</a></p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

const fullUrl = (link: string) => (link.startsWith("http") ? link : `${SITE_URL}${link}`);

/** A notice (order update, message, payout and so on), already worded by its template. */
export const sendNotificationEmail = async (to: string, title: string, message: string, link: string) => {
    const b = await getBrand();
    const html = await brandedHtml({ heading: title, body: message, button: { label: "View details", url: fullUrl(link) }, footnote: `You can change which emails you get from the bell icon when signed in to ${b.name}.` });
    return sendEmail({ senderName: b.name, to, subject: title, html });
};

/** Sends a template that only goes by email (welcome, password reset and so on). */
export async function sendTemplateEmail(key: string, to: string, vars: Record<string, unknown>, opts: { button?: { label: string; url: string }; extraHtml?: string; senderName?: string; replyTo?: string } = {}) {
    const c = await resolveContent(key, vars);
    if (!c.channels.email) return;
    const b = await getBrand();
    const html = await brandedHtml({ heading: c.emailSubject, body: c.emailBody, button: opts.button, extraHtml: opts.extraHtml });
    return sendEmail({ senderName: opts.senderName ?? b.name, to, subject: c.emailSubject, html, replyTo: opts.replyTo });
}

const first = (name: string) => name.trim().split(/\s+/)[0] || "there";

export const sendWelcomeEmail = (to: string, name: string) =>
    sendTemplateEmail("account.welcome", to, { firstName: first(name) }, { button: { label: "Find something to eat", url: `${SITE_URL}/menu` } });

export const sendVerifyEmail = (to: string, name: string, link: string) =>
    sendTemplateEmail("account.verify_email", to, { firstName: first(name) }, { button: { label: "Confirm my email", url: fullUrl(link) } });

export const sendPasswordResetEmail = (to: string, token: string, role = "customer") => {
    // The link opens the reset page of the portal this account belongs to.
    const portalPath = role === "chef" ? "/chef" : role === "admin" ? "/admin" : "";
    const resetLink = `${SITE_URL}${portalPath}/reset-password?token=${token}`;
    return sendTemplateEmail("account.password_reset", to, {}, {
        button: { label: "Reset my password", url: resetLink },
        extraHtml: `<p style="font-size:12px;color:#6b7280;word-break:break-all;">If the button doesn't work, copy this link into your browser: ${escapeHtml(resetLink)}</p>`,
    });
};

export const sendOrderConfirmationEmail = async (to: string, order: { id: number; total: number; trackingToken: string | null; scheduledFor?: Date | null; deliveryAddress?: unknown }, lines: { name: string; quantity: number; allergens: string }[] = [], firstName = "") => {
    const vars = orderPlacedVars(order, lines, firstName);
    const allergens = lines.length ? `<div style="background:#fff7ed;border-radius:12px;padding:14px 16px;margin:6px 0 10px;">
        <p style="margin:0 0 6px;font-weight:700;color:#111827;">Allergen information</p>
        ${lines.map((l) => `<p style="margin:4px 0;font-size:14px;color:#374151;"><strong>${l.quantity} x ${escapeHtml(l.name)}:</strong> ${escapeHtml(l.allergens)}</p>`).join("")}
        <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">Food is made in kitchens that may handle other allergens. If you have a severe allergy, please check before eating.</p></div>` : "";
    return sendTemplateEmail("order.placed", to, vars, {
        button: { label: "Track your order", url: `${SITE_URL}/order-tracker/${order.id}${order.trackingToken ? `?t=${order.trackingToken}` : ""}` },
        extraHtml: allergens,
    });
};

/** The placeholders for an order confirmation, shared by the email and the text message. */
export function orderPlacedVars(order: { id: number; total: number; scheduledFor?: Date | null }, lines: { name: string; quantity: number }[], firstName = "") {
    return {
        firstName: firstName || "there",
        orderId: order.id,
        total: Number(order.total).toFixed(2),
        when: order.scheduledFor ? new Date(order.scheduledFor).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "As soon as possible",
        items: lines.map((l) => `${l.quantity} x ${l.name}`).join("\n"),
    };
}

export const sendAdminOrderAlert = (to: string, order: { id: number; total: number }) =>
    sendTemplateEmail("admin.order_email", to, { orderId: order.id, total: Number(order.total).toFixed(2) }, { button: { label: "Open the Super Admin", url: `${SITE_URL}/admin/orders` }, senderName: "MYUKCHEF System" });

export const sendSupportRequestEmail = async (data: { name: string; email: string; phone: string; message: string }) =>
    sendTemplateEmail("admin.support_email", (await getBrevo()).supportEmail, data, { senderName: "MYUKCHEF Support", replyTo: data.email });

/** What an email template looks like, with example values, for the Super Admin's preview. */
export async function previewEmail(key: string, draft?: { emailSubject?: string; emailBody?: string }) {
    const c = await resolveContent(key, SAMPLE_VARS);
    const { fill } = await import("./templates");
    const subject = draft?.emailSubject?.trim() ? fill(draft.emailSubject, { siteName: "MYUKCHEF", ...SAMPLE_VARS }) : c.emailSubject;
    const body = draft?.emailBody?.trim() ? fill(draft.emailBody, { siteName: "MYUKCHEF", ...SAMPLE_VARS }) : c.emailBody;
    return { subject, html: await brandedHtml({ heading: subject, body, button: { label: "View details", url: SITE_URL } }) };
}

