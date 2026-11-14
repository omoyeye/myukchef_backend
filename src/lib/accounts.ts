import { and, eq, isNull, sql } from "drizzle-orm";
import { withTemplate } from "./templates";
import { db } from "../db";
import { siteSettings, users } from "../db/schema";
import { signPurposeToken, verifyPurposeToken } from "./auth";
import { sendVerifyEmail } from "./mail";
import { notify } from "./notify";

/**
 * Things that happen around an account: confirming the email address, and "refer a friend".
 */

type User = typeof users.$inferSelect;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const VERIFY_DAYS = 7;

// === Confirming the email address ===

/** Emails a link that confirms the address. It lasts a week. */
export async function sendVerificationEmail(user: Pick<User, "id" | "email" | "name">) {
    const token = signPurposeToken(user.id, "verify-email", VERIFY_DAYS * 86400);
    await sendVerifyEmail(user.email, user.name, `/verify-email?token=${encodeURIComponent(token)}`);
}

export async function confirmEmail(token: unknown) {
    const userId = typeof token === "string" ? verifyPurposeToken(token, "verify-email") : null;
    if (!userId) throw fail(400, "This link has expired or isn't valid. Ask for a new one from your account page.");
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    return { verified: true };
}

// === Refer a friend ===

export const REFERRAL_DEFAULTS = { enabled: true, points: 500 };

export async function getReferralRules() {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, "referral_config")).limit(1);
    const value = (row?.value ?? {}) as { enabled?: boolean; points?: unknown };
    const points = Number(value.points ?? REFERRAL_DEFAULTS.points);
    return { enabled: value.enabled !== false, points: Number.isFinite(points) && points >= 0 ? Math.min(Math.round(points), 100_000) : REFERRAL_DEFAULTS.points };
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A code built from the account number (so no two people share one) plus two random letters. */
const codeFor = (userId: number) => {
    let n = userId;
    let code = "";
    do { code = ALPHABET[n % ALPHABET.length] + code; n = Math.floor(n / ALPHABET.length); } while (n > 0);
    const pad = () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return `${pad()}${pad()}${code}`.slice(0, 12);
};

/** The person's own code, made the first time it's needed. */
export async function referralCodeFor(user: Pick<User, "id" | "referralCode">) {
    if (user.referralCode) return user.referralCode;
    const code = codeFor(user.id);
    await db.update(users).set({ referralCode: code }).where(and(eq(users.id, user.id), isNull(users.referralCode)));
    const [fresh] = await db.select({ code: users.referralCode }).from(users).where(eq(users.id, user.id)).limit(1);
    return fresh?.code ?? code;
}

/** Runs after sign-up: gives the person a code, remembers who referred them, and sends the confirmation email. */
export async function afterSignUp(user: User, referralInput?: unknown) {
    await referralCodeFor(user);
    const code = typeof referralInput === "string" ? referralInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : "";
    if (code) {
        const [referrer] = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, code)).limit(1);
        if (referrer && referrer.id !== user.id) await db.update(users).set({ referredBy: referrer.id }).where(eq(users.id, user.id));
    }
    sendVerificationEmail(user).catch((e: Error) => console.error("Confirmation email failed:", e.message));
}

/** When a referred customer's first order is delivered, they and their friend both get points. Once only. */
export async function rewardReferral(userId: number) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.referredBy || user.referralRewardedAt) return;
    const rules = await getReferralRules();
    if (!rules.enabled || rules.points <= 0) return;
    const [claim] = await db.update(users).set({ referralRewardedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.referralRewardedAt)));
    if (!(claim as unknown as { affectedRows?: number }).affectedRows) return;
    await db.update(users).set({ points: sql`${users.points} + ${rules.points}` }).where(eq(users.id, userId));
    await db.update(users).set({ points: sql`${users.points} + ${rules.points}` }).where(eq(users.id, user.referredBy));
    await withTemplate("referral.rewarded_new", { points: rules.points }, () => notify(userId, `You've earned ${rules.points} points`, "Thanks for joining through a friend. Your welcome points are in your account.", "/profile?tab=rewards"));
    await withTemplate("referral.rewarded_referrer", { points: rules.points, friendName: user.name.split(" ")[0] }, () => notify(user.referredBy!, `You've earned ${rules.points} points`, `${user.name.split(" ")[0]} placed their first order with your code. Thank you for spreading the word!`, "/profile?tab=rewards"));
}

/** What the "refer a friend" page shows. */
export async function referralSummary(userId: number) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw fail(404, "Account not found");
    const rules = await getReferralRules();
    const [counts] = await db.select({
        joined: sql<number>`count(*)`,
        rewarded: sql<number>`sum(case when ${users.referralRewardedAt} is not null then 1 else 0 end)`,
    }).from(users).where(eq(users.referredBy, userId));
    return { ...rules, code: await referralCodeFor(user), joined: Number(counts?.joined ?? 0), rewarded: Number(counts?.rewarded ?? 0) };
}
