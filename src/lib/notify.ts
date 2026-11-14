import { eq } from "drizzle-orm";
import { db } from "../db";
import { chefs, notificationPreferences, notifications, users } from "../db/schema";
import { sendNotificationEmail } from "./mail";
import { sendPush } from "./push";
import { sendSMS } from "./sms";
import { currentTemplate, resolveContent } from "./templates";

export const DEFAULT_PREFERENCES = { emailUpdates: true, emailMessages: true };

export async function getPreferences(userId: number) {
    const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1);
    return row ? { emailUpdates: row.emailUpdates, emailMessages: row.emailMessages } : DEFAULT_PREFERENCES;
}

// A busy conversation sends one email per person per chat every 15 minutes. The bell and push still update.
const MESSAGE_EMAIL_GAP_MS = 15 * 60 * 1000;
const lastMessageEmail = new Map<string, number>();

/** The wording and channels for this notice: the Super Admin's template if the send has one. */
async function contentFor(title: string, message: string) {
    const tpl = currentTemplate();
    return resolveContent(tpl?.key ?? null, tpl?.vars ?? {}, { title, body: message });
}

/**
 * The one way to tell someone something: the in-app bell, push and email, each switched on or off
 * by the message's template. Nothing here can stop the action that caused the notice.
 */
export async function notify(userId: number, title: string, message: string, link: string, type = "update", extra?: { phone?: string | null }) {
    const c = await contentFor(title, message);
    if (c.channels.inApp) {
        await db.insert(notifications).values({ userId, type, title: c.title.slice(0, 500), message: c.body, link }).catch((e) => console.error("In-app notice failed:", e));
    }
    if (c.channels.push) sendPush(userId, { title: c.pushTitle, body: c.pushBody, url: link }).catch((e: Error) => console.error("Push failed:", e.message));
    if (c.channels.sms && extra?.phone) sendSMS(extra.phone, c.sms).catch((e: Error) => console.error("SMS failed:", e.message));
    if (!c.channels.email) return;
    try {
        const preferences = await getPreferences(userId);
        const isMessage = type === "message";
        if (!(isMessage ? preferences.emailMessages : preferences.emailUpdates)) return;
        if (isMessage) {
            const key = `${userId}:${link}`;
            if (Date.now() - (lastMessageEmail.get(key) ?? 0) < MESSAGE_EMAIL_GAP_MS) return;
            lastMessageEmail.set(key, Date.now());
        }
        const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        if (person) sendNotificationEmail(person.email, c.emailSubject, c.emailBody, link).catch((e: Error) => console.error("Notice email failed:", e.message));
    } catch (e) {
        console.error("Notice email failed:", e);
    }
}

/** For guests, who have no account: email (with their private link) and text message only. */
export async function notifyGuest(contact: { email?: string | null; phone?: string | null }, title: string, message: string, link: string) {
    const c = await contentFor(title, message);
    if (c.channels.email && contact.email) sendNotificationEmail(contact.email, c.emailSubject, c.emailBody, link).catch((e: Error) => console.error("Guest email failed:", e.message));
    if (c.channels.sms && contact.phone) sendSMS(contact.phone, c.sms).catch((e: Error) => console.error("Guest SMS failed:", e.message));
}

export async function notifyChef(chefId: number, title: string, message: string, link = "/chef/dashboard?tab=plans", type = "update") {
    const [chef] = await db.select({ userId: chefs.userId }).from(chefs).where(eq(chefs.id, chefId)).limit(1);
    if (chef) await notify(chef.userId, title, message, link, type);
}

export async function notifyAdmins(title: string, message: string, link: string) {
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    await Promise.all(admins.map((admin) => notify(admin.id, title, message, link, "admin_alert")));
}
