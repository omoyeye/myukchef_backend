import { eq } from "drizzle-orm";
import { sendNotification, setVapidDetails } from "web-push";
import { db } from "../db";
import { mobilePushTokens, pushSubscriptions } from "../db/schema";

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
export const pushEnabled = !!(publicKey && privateKey);
export const pushPublicKey = publicKey ?? null;

if (pushEnabled) setVapidDetails(process.env.VAPID_SUBJECT || "mailto:info@myukchef.com", publicKey!, privateKey!);

// The server posts to whatever address a browser registers, so only real browser push services are allowed.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)$/;
const extraHosts = (process.env.PUSH_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);

export function isAllowedEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== "string" || endpoint.length > 700) return false;
    try {
        const url = new URL(endpoint);
        return url.protocol === "https:" && (PUSH_HOSTS.test(url.hostname) || extraHosts.includes(url.host));
    } catch {
        return false;
    }
}

/** Expo push tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[xxxx]). */
export function isExpoToken(token: unknown): token is string {
    return typeof token === "string" && token.length <= 255 && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token);
}

/** Sends to the user's phones through Expo's push service, which works without any keys of our own. */
async function sendMobilePush(userId: number, notice: { title: string; body: string; url: string }) {
    const phones = await db.select().from(mobilePushTokens).where(eq(mobilePushTokens.userId, userId));
    if (phones.length === 0) return;
    try {
        const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
        if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
        const res = await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers,
            body: JSON.stringify(phones.map((p) => ({
                to: p.token, title: notice.title, body: notice.body, sound: "default",
                data: { url: notice.url }, channelId: "default",
            }))),
            signal: AbortSignal.timeout(10_000),
        });
        const result: any = await res.json().catch(() => ({}));
        const tickets: any[] = Array.isArray(result?.data) ? result.data : [];
        // A phone that uninstalled the app or turned notifications off is removed.
        await Promise.all(tickets.map((ticket, i) => ticket?.details?.error === "DeviceNotRegistered" && phones[i]
            ? db.delete(mobilePushTokens).where(eq(mobilePushTokens.id, phones[i].id))
            : null));
    } catch (error) {
        console.error("Mobile push failed:", (error as Error).message);
    }
}

export async function sendPush(userId: number, notice: { title: string; body: string; url: string }) {
    await sendMobilePush(userId, notice);
    if (!pushEnabled) return;
    const devices = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await Promise.all(devices.map(async (device) => {
        try {
            await sendNotification(
                { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
                JSON.stringify(notice),
                { TTL: 60 * 60 * 24 },
            );
        } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            // The browser has dropped this subscription, so stop trying it.
            if (status === 404 || status === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
            else console.error("Push failed:", (error as Error).message);
        }
    }));
}
