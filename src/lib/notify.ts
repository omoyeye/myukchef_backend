import { eq } from "drizzle-orm";
import { db } from "../db";
import { chefs, notificationPreferences, notifications, users } from "../db/schema";
import { sendNotificationEmail } from "./mail";
import { sendPush } from "./push";

export const DEFAULT_PREFERENCES = { emailUpdates: true, emailMessages: true };

export async function getPreferences(userId: number) {
    const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1);
    return row ? { emailUpdates: row.emailUpdates, emailMessages: row.emailMessages } : DEFAULT_PREFERENCES;
}

// A busy conversation sends one email per person per chat every 15 minutes. The bell and push still update.
const MESSAGE_EMAIL_GAP_MS = 15 * 60 * 1000;
const lastMessageEmail = new Map<string, number>();

/**
 * The one way to tell someone something: always the in-app bell, then email and push.
 * Nothing here can stop the action that caused the notice.
 */
export async function notify(userId: number, title: string, message: string, link: string, type = "update") {
    await db.insert(notifications).values({ userId, type, title, message, link }).catch((e) => console.error("In-app notice failed:", e));
    sendPush(userId, { title, body: message, url: link }).catch((e: Error) => console.error("Push failed:", e.message));
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
        if (person) sendNotificationEmail(person.email, title, message, link).catch((e: Error) => console.error("Notice email failed:", e.message));
    } catch (e) {
        console.error("Notice email failed:", e);
    }
}

export async function notifyChef(chefId: number, title: string, message: string, link = "/chef/dashboard?tab=plans", type = "update") {
    const [chef] = await db.select({ userId: chefs.userId }).from(chefs).where(eq(chefs.id, chefId)).limit(1);
    if (chef) await notify(chef.userId, title, message, link, type);
}

export async function notifyAdmins(title: string, message: string, link: string) {
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    await Promise.all(admins.map((admin) => notify(admin.id, title, message, link, "admin_alert")));
}
