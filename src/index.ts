import compression from "compression";
import { withTemplate } from "./lib/templates";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import "./db"; // loads .env before anything below reads it

import { authenticate } from "./lib/auth";
import { serveThumbnail, UPLOAD_DIR } from "./routes/upload";
import { startRetentionJobs } from "./lib/accountData";
import { migrateAllergens } from "./lib/allergens";
import { startEventJobs } from "./lib/eventQuotes";
import { notifyChef } from "./lib/notify";
import { startMealPlanJobs } from "./lib/mealPlans";
import { renderPageHtml, renderSitemap, SITE_URL } from "./lib/seo";
import { addressesRouter } from "./routes/addresses";
import { authRouter } from "./routes/auth";
import { chefPortalRouter } from "./routes/chefPortal";
import { chefReviewsRouter } from "./routes/chefReviews";
import { chefsRouter } from "./routes/chefs";
import { contactRouter } from "./routes/contact";
import { discountsRouter } from "./routes/discounts";
import { eventsRouter } from "./routes/events";
import { integrationsRouter } from "./routes/integrations";
import { payoutsRouter } from "./routes/payouts";
import { healthRouter, reportServerError } from "./routes/health";
import { reportsRouter } from "./routes/reports";
import templatesRouter from "./routes/templates";
import postsRouter from "./routes/posts";
import bannersRouter from "./routes/banners";
import seoRouter from "./routes/seo";
import { trackRequests } from "./lib/metrics";
import { startPayoutJobs } from "./lib/chefPayouts";
import { startCredentialJobs } from "./lib/credentials";
import { startWeeklyReports } from "./lib/weeklyReports";
import { stripeWebhook } from "./routes/payments";
import { releaseStaleUnpaidOrders } from "./lib/orderPlaced";
import { locationRouter } from "./routes/location";
import { mealPlansRouter } from "./routes/mealPlans";
import { notificationsRouter } from "./routes/notifications";
import { ordersRouter } from "./routes/orders";
import { productsRouter } from "./routes/products";
import { recommendationsRouter } from "./routes/recommendations";
import { reviewsRouter } from "./routes/reviews";
import { settingsRouter } from "./routes/settings";
import uploadRouter from "./routes/upload";
import { usersRouter } from "./routes/users";

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' https://maps.googleapis.com https://www.googletagmanager.com https://www.google-analytics.com https://connect.facebook.net https://analytics.tiktok.com https://www.clarity.ms https://*.clarity.ms",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://www.googletagmanager.com",
    "connect-src 'self' https://maps.googleapis.com https://*.googleapis.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://www.facebook.com https://analytics.tiktok.com https://*.clarity.ms",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'self'",
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
].join("; ");

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(compression());
app.use(trackRequests);
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(self)");
    // Only our own scripts run, plus Google Maps once the visitor agrees to it. This limits the damage if a
    // malicious script ever reaches a page. Images may come from anywhere over HTTPS (dish photos).
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
});
// The website may live on its own domain once it has its own repo: list extra sites in CORS_ORIGINS.
const extraOrigins = (process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
app.use(cors(isProduction ? { origin: [SITE_URL, SITE_URL.replace("https://", "https://www."), ...extraOrigins] } : undefined));
// Stripe signs the exact bytes it sends, so its webhook reads the raw body.
app.post("/api/payments/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhook);
app.use(express.json({ limit: "1mb" }));
app.use(authenticate);

app.use("/api/auth", authRouter);
app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/addresses", addressesRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/discounts", discountsRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/contact", contactRouter);
app.use("/api/chef-portal", chefPortalRouter);
app.use("/api/chef-reviews", chefReviewsRouter);
app.use("/api/meal-plans", mealPlansRouter);
app.use("/api/chefs", chefsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/recommendations", recommendationsRouter);
app.use("/api/users", usersRouter);
app.use("/api/location", locationRouter);
app.use("/api/admin/integrations", integrationsRouter);
app.use("/api/payouts", payoutsRouter);
app.use("/api/health", healthRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/admin/templates", templatesRouter);
app.use("/api/posts", postsRouter);
app.use("/api/banners", bannersRouter);
app.use("/api/seo", seoRouter);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.get("/uploads/sm/:file", serveThumbnail);
// Dot folders (the thumbnail cache) aren't served directly.
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", dotfiles: "ignore" }));
// A missing upload is a 404, not the website's home page.
app.use("/uploads", (_req, res) => res.status(404).end());

app.get("/sitemap.xml", async (_req, res, next) => {
    try {
        res.type("application/xml").setHeader("Cache-Control", "public, max-age=3600").send(await renderSitemap());
    } catch (error) { next(error); }
});

// Built frontend: hashed assets can be cached for a year, the service worker must not be.
// The website is built separately and served from here in production.
const distPath = path.resolve(process.env.FRONTEND_DIST || path.join(process.cwd(), "..", "myukchef_frontend", "dist"));
app.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (/(sw|registerSW|workbox-[^/\\]*)\.js$|manifest\.webmanifest$/.test(filePath)) {
            res.setHeader("Cache-Control", "no-cache");
        }
    },
}));

let indexTemplate: string | null = null;
app.get(/.*/, async (req, res, next) => {
    try {
        indexTemplate ??= fs.readFileSync(path.join(distPath, "index.html"), "utf8");
        res.setHeader("Cache-Control", "no-cache");
        res.type("html").send(await renderPageHtml(indexTemplate, req.path));
    } catch (error) { next(error); }
});

app.use((error: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (error.code === "ENOENT") return res.status(404).send("The frontend hasn't been built yet. Run npm run build.");
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    if (error.name === "MulterError") return res.status(400).json({ error: error.message });
    console.error("Unhandled error:", error);
    reportServerError(error, `${_req.method} ${_req.path}`);
    res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    startMealPlanJobs();
    startEventJobs();
    startRetentionJobs();
    startPayoutJobs();
    startCredentialJobs();
    startWeeklyReports();
    // Unpaid orders whose payment page ran out are released, in case Stripe's webhook didn't arrive.
    setInterval(() => releaseStaleUnpaidOrders().catch((e) => console.error("Unpaid order check failed:", e)), 15 * 60 * 1000).unref();
    migrateAllergens()
        .then(({ chefIds }) => Promise.all(chefIds.map((id) => withTemplate("chef.allergens_check", {}, () => notifyChef(id, "Please check your dishes' allergens", "We now record all 14 allergens. Your dishes are off sale until you confirm each one under My dishes.", "/chef/dashboard?tab=products")))))
        .catch((e) => console.error("Allergen update failed:", e));
});
