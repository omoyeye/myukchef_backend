import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeKey } from "./integrations";

/**
 * AI writing help for the Super Admin, from Claude. Used to draft SEO titles, descriptions and
 * keywords that a person then checks and saves. The API key is saved (encrypted) under
 * Payments and email, or comes from ANTHROPIC_API_KEY on the server.
 */

const MODEL = "claude-opus-5-5";
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

let cached: { key: string; client: Anthropic } | null = null;
async function client() {
    const key = await getClaudeKey();
    if (!key) throw fail(400, "Add a Claude API key under Payments & keys to use AI writing.");
    if (cached?.key !== key) cached = { key, client: new Anthropic({ apiKey: key, timeout: 60_000, maxRetries: 2 }) };
    return cached.client;
}

/** Turns SDK errors into messages a Super Admin can act on. */
function explain(error: unknown): never {
    if (error instanceof Anthropic.AuthenticationError) throw fail(400, "Claude didn't accept the API key. Check it under Payments & keys.");
    if (error instanceof Anthropic.PermissionDeniedError) throw fail(400, "This Claude API key isn't allowed to use the model. Check the key's workspace in the Claude Console.");
    if (error instanceof Anthropic.RateLimitError) throw fail(429, "Claude is busy or the account has hit its limit. Try again in a minute.");
    if (error instanceof Anthropic.BadRequestError) throw fail(502, `Claude couldn't handle the request: ${error.message}`);
    if (error instanceof Anthropic.APIConnectionError) throw fail(502, "Couldn't reach Claude. Try again in a moment.");
    if (error instanceof Anthropic.APIError) throw fail(502, `Claude replied with an error (${error.status ?? "unknown"}).`);
    throw error;
}

/** A harmless check that the key works, for the "Test connection" button. */
export async function checkClaude() {
    try {
        const model = await (await client()).models.retrieve(MODEL);
        return { ok: true, message: `Connected to Claude (${model.display_name}).` };
    } catch (error) {
        try { explain(error); } catch (e) { return { ok: false, message: (e as Error).message }; }
        return { ok: false, message: "Couldn't check the key." };
    }
}

export const SeoDraft = z.object({
    title: z.string(),
    description: z.string(),
    keywords: z.array(z.string()),
    notes: z.string(),
});
export type SeoDraft = z.infer<typeof SeoDraft>;

const SCHEMA = {
    type: "object",
    properties: {
        title: { type: "string", description: "Page title for search results, 30 to 60 characters, ending with ' | MYUKCHEF'." },
        description: { type: "string", description: "Meta description, 120 to 155 characters, one or two plain sentences with a clear reason to click." },
        keywords: { type: "array", items: { type: "string" }, description: "5 to 8 search phrases a UK customer would type." },
        notes: { type: "string", description: "One short sentence on why this wording should work." },
    },
    required: ["title", "description", "keywords", "notes"],
    additionalProperties: false,
} as const;

const SYSTEM = `You write search engine text (SEO) for MYUKCHEF, a UK website and app where people order home-cooked food from vetted local chefs, plan meals with a chef for 1 week to 6 months, and book chefs for events.

Write in plain British English for ordinary customers. Be specific and truthful: describe only what the page offers, using the facts you're given. No exaggerated claims ("best in the UK", "number one"), no prices or offers unless they're in the facts, no keyword stuffing, no all-caps, no emojis. Titles end with " | MYUKCHEF". Keep within the length limits, because search engines cut off longer text.`;

/** Asks Claude to draft a page's title, description and keywords. The Super Admin reviews before saving. */
export async function draftSeo(page: { path: string; name: string; purpose: string; current?: { title?: string; description?: string }; focus?: string; brand?: { name?: string; area?: string } }): Promise<SeoDraft> {
    const facts = [
        `Page: ${page.name} (${page.path})`,
        `What the page is for: ${page.purpose}`,
        page.brand?.area ? `Where MYUKCHEF works: ${page.brand.area}` : "",
        page.current?.title ? `Current title: ${page.current.title}` : "",
        page.current?.description ? `Current description: ${page.current.description}` : "",
        page.focus ? `The Super Admin wants to focus on: ${page.focus}` : "",
    ].filter(Boolean).join("\n");

    let response;
    try {
        response = await (await client()).beta.messages.create({
            model: MODEL,
            max_tokens: 16000,
            system: SYSTEM,
            // A short writing task: low effort keeps it quick and cheap.
            output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
            // If Claude declines, Anthropic retries on a suitable model in the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            messages: [{ role: "user", content: `Write the SEO title, meta description and keywords for this page.\n\n${facts}` }],
        });
    } catch (error) {
        explain(error);
    }
    if (response.stop_reason === "refusal") throw fail(422, "Claude declined to write this one. Try rewording the focus.");
    if (response.stop_reason !== "end_turn") throw fail(502, `Claude stopped early (${response.stop_reason}). Try again.`);
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = SeoDraft.safeParse(JSON.parse(text));
    if (!parsed.success) throw fail(502, "Claude's answer wasn't in the expected shape. Try again.");
    const d = parsed.data;
    return {
        title: d.title.trim().slice(0, 70),
        description: d.description.trim().slice(0, 170),
        keywords: d.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 10),
        notes: d.notes.trim().slice(0, 300),
    };
}
