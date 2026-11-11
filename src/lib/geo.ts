export interface GeoPoint {
    lat: number;
    lng: number;
    label?: string;
}

const REQUEST_TIMEOUT_MS = 4000;

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** About 1km of blur, so a chef's home address can't be worked out from public data. */
export const blurCoordinate = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/** A full postcode can point to a handful of homes, so the public only sees the area ("E1"). */
export const publicArea = (location: string | null) =>
    location?.replace(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/gi, (_m, outward: string) => outward.toUpperCase()) ?? null;

export const parseCoordinates = (lat: unknown, lng: unknown): { lat: number; lng: number } | null => {
    if (lat === undefined || lng === undefined || lat === "" || lng === "") return null;
    const point = { lat: Number(lat), lng: Number(lng) };
    const valid = Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
    return valid ? point : null;
};

async function fromGoogle(query: string, key: string): Promise<GeoPoint | null> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:GB&region=uk&key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data: any = await res.json();
    const result = data.results?.[0];
    if (data.status !== "OK" || !result) {
        if (data.status !== "ZERO_RESULTS") console.error("Google geocoding error:", data.status);
        return null;
    }
    return { lat: result.geometry.location.lat, lng: result.geometry.location.lng, label: result.formatted_address };
}

/** Free UK lookup used until a Google key is added. Handles postcodes and place names. */
async function fromPostcodesIo(query: string): Promise<GeoPoint | null> {
    const postcode = query.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i)?.[0];
    const url = postcode
        ? `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`
        : `https://api.postcodes.io/places?q=${encodeURIComponent(query.split(",")[0].trim())}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data: any = await res.json();
    const hit = Array.isArray(data.result) ? data.result[0] : data.result;
    if (!hit) return null;
    if (postcode) return { lat: hit.latitude, lng: hit.longitude, label: hit.postcode };
    return { lat: hit.latitude, lng: hit.longitude, label: hit.name_1 };
}

export async function geocode(query: string | null | undefined): Promise<GeoPoint | null> {
    const q = query?.trim();
    if (!q) return null;
    try {
        const key = process.env.GOOGLE_MAPS_API_KEY;
        return key ? await fromGoogle(q, key) : await fromPostcodesIo(q);
    } catch (error) {
        console.error("Geocoding failed:", (error as Error).message);
        return null;
    }
}
