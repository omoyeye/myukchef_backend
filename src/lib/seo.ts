import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chefProducts, chefs, products } from "../db/schema";

export const SITE_URL = (process.env.SITE_URL || "https://myukchef.com").replace(/\/$/, "");
const BRAND = "MYUKCHEF";

const STATIC_PAGES = ["/", "/menu", "/chefs", "/meal-plans", "/events", "/videos", "/app", "/recommend", "/support", "/allergens", "/privacy", "/terms", "/chef/register"];

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function publicDishes() {
    const regular = await db.select().from(products).where(eq(products.allergensDeclared, true));
    const chefRows = await db
        .select({ product: chefProducts })
        .from(chefProducts)
        .innerJoin(chefs, eq(chefProducts.chefId, chefs.id))
        .where(and(eq(chefProducts.status, "approved"), eq(chefProducts.allergensDeclared, true), eq(chefs.status, "approved")));
    return [...regular, ...chefRows.map((r) => r.product)];
}

export async function renderSitemap() {
    const dishes = await publicDishes();
    const approvedChefs = await db.select({ id: chefs.id }).from(chefs).where(eq(chefs.status, "approved"));
    const urls = [
        ...STATIC_PAGES,
        ...approvedChefs.map((c) => `/chefs/${c.id}`),
        ...dishes.map((d) => `/menu/${encodeURIComponent(d.id)}`),
    ];
    const body = urls.map((u) => `  <url><loc>${escapeHtml(SITE_URL + u)}</loc></url>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

async function pageMeta(path: string): Promise<{ title: string; description: string; image?: string } | null> {
    const dishMatch = path.match(/^\/menu\/([^/]+)$/);
    if (dishMatch) {
        const id = decodeURIComponent(dishMatch[1]);
        const dish = (await publicDishes()).find((d) => d.id === id);
        return dish ? { title: `${dish.name} | ${BRAND}`, description: dish.description.slice(0, 160), image: dish.image } : null;
    }
    const chefMatch = path.match(/^\/chefs\/(\d+)$/);
    if (chefMatch) {
        const [chef] = await db.select().from(chefs).where(and(eq(chefs.id, Number(chefMatch[1])), eq(chefs.status, "approved"))).limit(1);
        if (!chef) return null;
        const description = (chef.bio || `Plan your meals with ${chef.displayName}, order their dishes or book them for your event on ${BRAND}.`).slice(0, 160);
        return { title: `${chef.displayName}, ${chef.specialty || "Local Chef"} | ${BRAND}`, description, image: chef.coverImage || chef.avatar || undefined };
    }
    return null;
}

/**
 * Link previews and some crawlers don't run JavaScript, so dish and chef pages get
 * their real title, description and image in the HTML the server sends.
 */
export async function renderPageHtml(template: string, path: string) {
    const canonical = SITE_URL + (path === "/" ? "/" : path.replace(/\/$/, ""));
    let html = template
        .replace(/(<link rel="canonical" href=")[^"]*/, `$1${escapeHtml(canonical)}`)
        .replace(/(<meta property="og:url" content=")[^"]*/, `$1${escapeHtml(canonical)}`);

    const meta = await pageMeta(path).catch(() => null);
    if (!meta) return html;
    const absoluteImage = meta.image ? (meta.image.startsWith("http") ? meta.image : SITE_URL + meta.image) : null;
    const title = escapeHtml(meta.title);
    const description = escapeHtml(meta.description);
    html = html
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/(<meta name="description"\s+content=")[^"]*/, `$1${description}`)
        .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
        .replace(/(<meta property="og:description" content=")[^"]*/, `$1${description}`)
        .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${title}`)
        .replace(/(<meta name="twitter:description" content=")[^"]*/, `$1${description}`);
    if (absoluteImage) {
        html = html
            .replace(/(<meta property="og:image" content=")[^"]*/, `$1${escapeHtml(absoluteImage)}`)
            .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${escapeHtml(absoluteImage)}`);
    }
    return html;
}
