/**
 * Chef videos are YouTube links, so nothing is uploaded to or stored on our server. This reads the
 * video's id from any normal YouTube link, checks the video exists and can be shown on other sites,
 * and finds its length so videos over a minute can be refused.
 */

const ID = /^[A-Za-z0-9_-]{11}$/;
const TIMEOUT_MS = 8_000;
export const MAX_POST_SECONDS = 60;

/** The 11-character video id from a youtube.com, youtu.be, Shorts or embed link, or null. */
export function youtubeIdFrom(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (ID.test(text)) return text;
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
    const host = url.hostname.replace(/^(www|m|music)\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0] ?? null;
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
        if (url.pathname === "/watch") id = url.searchParams.get("v");
        else {
            const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
            id = m?.[2] ?? null;
        }
    }
    return id && ID.test(id) ? id : null;
}

export interface VideoInfo { title: string; durationSeconds: number | null }

const fail = (message: string) => Object.assign(new Error(message), { status: 400 });

/** ISO 8601 durations from the YouTube API, e.g. PT1M5S. */
const isoSeconds = (iso: string) => {
    const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return null;
    return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0);
};

/** Tests run without the internet: ids starting LONG are two minutes, GONE don't exist, others 30s. */
function stub(id: string): VideoInfo {
    if (id.startsWith("GONE")) throw fail("We couldn't find that video. Check the link, and that the video is public or unlisted.");
    return { title: `Test video ${id}`, durationSeconds: id.startsWith("LONG") ? 120 : 30 };
}

export async function lookUpVideo(id: string): Promise<VideoInfo> {
    if (process.env.YOUTUBE_STUB === "1") return stub(id);

    // With an API key, YouTube tells us the title, length and whether it can be embedded.
    const key = process.env.YOUTUBE_API_KEY;
    if (key) {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) {
            const item = ((await res.json()) as { items?: { snippet?: { title?: string }; contentDetails?: { duration?: string }; status?: { embeddable?: boolean; privacyStatus?: string } }[] }).items?.[0];
            if (!item) throw fail("We couldn't find that video. Check the link, and that the video is public or unlisted.");
            if (item.status?.privacyStatus === "private") throw fail("That video is private. Make it public or unlisted on YouTube first.");
            if (item.status?.embeddable === false) throw fail("That video can't be shown on other sites. Turn on \"Allow embedding\" for it in YouTube Studio.");
            return { title: item.snippet?.title ?? "", durationSeconds: isoSeconds(item.contentDetails?.duration ?? "") };
        }
        // Fall through to the keyless checks if the key is wrong or over its limit.
    }

    // Without a key: oEmbed confirms the video exists and can be embedded.
    const oembed = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        .catch(() => null);
    if (oembed && (oembed.status === 404 || oembed.status === 400)) throw fail("We couldn't find that video. Check the link, and that the video is public or unlisted.");
    if (oembed && oembed.status === 401) throw fail("That video can't be shown on other sites. Make it public or unlisted, and turn on \"Allow embedding\" in YouTube Studio.");
    const title = oembed?.ok ? (((await oembed.json().catch(() => ({}))) as { title?: string }).title ?? "") : "";

    // The length is on the video's own page. If YouTube changes that page we still accept the video,
    // and the Super Admin sees its length as "not checked".
    let durationSeconds: number | null = null;
    try {
        const page = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { "accept-language": "en-GB", cookie: "CONSENT=YES+1; SOCS=CAI" },
        });
        const html = await page.text();
        const m = html.match(/"lengthSeconds":"(\d+)"/) ?? html.match(/<meta itemprop="duration" content="([^"]+)"/);
        if (m) durationSeconds = /^\d+$/.test(m[1]!) ? Number(m[1]) : isoSeconds(m[1]!);
    } catch { /* length unknown */ }
    return { title, durationSeconds };
}
