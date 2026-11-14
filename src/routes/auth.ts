import crypto from "crypto";
import { afterSignUp, confirmEmail, referralSummary, sendVerificationEmail } from "../lib/accounts";
import { Router } from "express";
import bcrypt from "bcrypt";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { users, notifications, passwordResetTokens } from "../db/schema";
import { sendWelcomeEmail, sendPasswordResetEmail } from "../lib/mail";
import { getUserId, isValidEmail, MIN_PASSWORD_LENGTH, normaliseEmail, signToken, requireAuth } from "../lib/auth";
import { erasePersonalData, exportUserData, openCommitments } from "../lib/accountData";
import { rateLimit } from "../lib/rateLimit";

const router = Router();

const loginLimit = rateLimit(10, 60_000, "Too many attempts. Please wait a minute and try again.");
const accountLimit = rateLimit(5, 60_000, "Too many attempts. Please wait a minute and try again.");
// Email links are signed, so they can't be guessed; this only stops a page being hammered.
const verifyLimit = rateLimit(20, 60_000, "Too many attempts. Please wait a minute and try again.");

const hashResetToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const toSession = <T extends { id: number; password: string }>(user: T) => {
    const { password: _password, ...safe } = user;
    return { user: safe, token: signToken(user.id) };
};

// GET /auth/me
router.get("/me", async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { password: _password, ...safe } = user;
        res.json({ user: safe });
    } catch (error) {
        console.error("Auth me error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /auth/register
router.post("/register", accountLimit, async (req, res) => {
    try {
        const { name, password } = req.body;
        if (req.body.acceptTerms !== true) return res.status(400).json({ error: "Please agree to the Terms and Privacy Policy" });
        const email = normaliseEmail(String(req.body.email ?? ""));

        if (!name || !email || !password) return res.status(400).json({ error: "Missing required fields" });
        if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email format" });
        if (String(password).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }

        const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (existing.length > 0) return res.status(400).json({ error: "Email already in use" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const [{ id }] = await db.insert(users).values({ name, email, password: hashedPassword, termsAcceptedAt: new Date() }).$returningId();
        const [newUser] = await db.select().from(users).where(eq(users.id, id)).limit(1);

        sendWelcomeEmail(newUser.email, newUser.name).catch((err: unknown) => console.error("Welcome email failed:", err));
        // Their own referral code, who referred them, and the "confirm your email" link.
        await afterSignUp(newUser, req.body.referralCode);

        await db.insert(notifications).values({
            userId: newUser.id,
            type: "welcome",
            title: "Welcome to MYUKCHEF!",
            message: "Explore the menu, meet our chefs and start earning points.",
            link: "/menu",
        }).catch((err: unknown) => console.error("Welcome notification failed:", err));

        res.status(201).json(toSession(newUser));
    } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /auth/verify-email { token }: the link from the confirmation email
router.post("/verify-email", verifyLimit, async (req, res, next) => {
    try { res.json(await confirmEmail(req.body?.token)); } catch (error) { next(error); }
});

// POST /auth/resend-verification: sends the confirmation email again
router.post("/resend-verification", requireAuth, accountLimit, async (req, res, next) => {
    try {
        const [user] = await db.select().from(users).where(eq(users.id, getUserId(req))).limit(1);
        if (!user) return res.status(404).json({ error: "Account not found" });
        if (user.emailVerifiedAt) return res.json({ sent: false, verified: true });
        await sendVerificationEmail(user);
        res.json({ sent: true });
    } catch (error) { next(error); }
});

// GET /auth/referral: the person's code and how many friends have joined
router.get("/referral", requireAuth, async (req, res, next) => {
    try { res.json(await referralSummary(getUserId(req))); } catch (error) { next(error); }
});

// GET /auth/me/export: everything held about this person, as a file
router.get("/me/export", requireAuth, async (req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="myukchef-my-data.json"');
    res.json(await exportUserData(getUserId(req)));
});

// DELETE /auth/me { password }: customers can close their own account
router.delete("/me", requireAuth, loginLimit, async (req, res) => {
    const userId = getUserId(req);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: "Account not found" });
    if (!(await bcrypt.compare(String(req.body?.password ?? ""), user.password))) return res.status(401).json({ error: "That password isn't right" });
    if (user.role !== "customer") return res.status(400).json({ error: "Chef and staff accounts have payment records to keep. Please contact support to close this account." });
    const open = await openCommitments(userId);
    if (open.hasOpenPlan) return res.status(409).json({ error: "Please cancel your active meal plans first" });
    if (open.hasOpenBooking) return res.status(409).json({ error: "You have an event booking in progress. Please cancel it, or contact support if it's been paid" });
    await erasePersonalData(userId);
    res.json({ message: "Your account has been deleted" });
});

// POST /auth/login
router.post("/login", loginLimit, async (req, res) => {
    try {
        const email = normaliseEmail(String(req.body.email ?? ""));
        const { password } = req.body;
        // Each portal has its own sign-in page, and each page only accepts its own kind of account.
        const portal = ["customer", "chef", "admin"].includes(req.body.portal) ? req.body.portal : "customer";
        if (!email || !password) return res.status(400).json({ error: "Missing required fields" });

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user || !(await bcrypt.compare(String(password), user.password))) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        if (user.role !== portal) {
            const message = user.role === "chef" ? "This is a chef account. Please use the chef sign-in page."
                : portal === "admin" ? "This account doesn't have Super Admin access."
                : portal === "chef" ? "This isn't a chef account. Please use the customer sign-in page, or apply to become a chef."
                : "This account can't sign in here. Please use the correct sign-in page.";
            return res.status(403).json({ error: message });
        }

        res.json(toSession(user));
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /auth/forgot-password
router.post("/forgot-password", accountLimit, async (req, res) => {
    try {
        const email = normaliseEmail(String(req.body.email ?? ""));
        if (!email) return res.status(400).json({ error: "Email is required" });

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (user) {
            // Only a hash is stored, so a database leak can't be used to reset passwords.
            const token = crypto.randomBytes(32).toString("hex");
            await db.insert(passwordResetTokens).values({
                userId: user.id,
                token: hashResetToken(token),
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            });
            await sendPasswordResetEmail(email, token, user.role).catch((err: unknown) => console.error("Failed to send reset email:", err));
        }

        // Same reply either way, so this can't be used to find out who has an account.
        res.json({ message: "If that email has an account, a reset link is on its way." });
    } catch (error) {
        console.error("Forgot password error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /auth/reset-password
router.post("/reset-password", accountLimit, async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: "Missing fields" });
        if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }

        const [resetToken] = await db.select().from(passwordResetTokens)
            .where(and(
                eq(passwordResetTokens.token, hashResetToken(String(token))),
                eq(passwordResetTokens.used, false),
                gt(passwordResetTokens.expiresAt, new Date()),
            ))
            .limit(1);
        if (!resetToken) return res.status(400).json({ error: "This reset link is invalid or has expired" });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.update(users).set({ password: hashedPassword }).where(eq(users.id, resetToken.userId));
        await db.update(passwordResetTokens).set({ used: true }).where(eq(passwordResetTokens.id, resetToken.id));

        res.json({ message: "Password updated successfully" });
    } catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export const authRouter = router;
