import fs from "fs";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { chefCredentials } from "../db/schema";
import { PRIVATE_FILE, privateFilePath } from "../routes/upload";
import { assertNoContactDetails } from "./contactGuard";
import { notifyAdmins, notifyChef } from "./notify";

/**
 * Evidence that a chef is trained and checked. Chefs add certificates and checks, Super Admins verify
 * them, and verified ones can show as badges on the chef's public page (never the document itself).
 */

export const CREDENTIAL_TYPES = {
    food_hygiene: { label: "Food hygiene certificate", needsDocument: true },
    allergen_awareness: { label: "Allergen awareness training", needsDocument: true },
    council_registration: { label: "Food business registration with the local council", needsDocument: false },
    hygiene_rating: { label: "Food Hygiene Rating (FSA)", needsDocument: false },
    insurance: { label: "Public liability insurance", needsDocument: true },
    // DBS certificates hold criminal record information, so we never store a copy, only that a check was done.
    dbs_check: { label: "DBS check", needsDocument: false },
    other: { label: "Other training or check", needsDocument: false },
} as const;
export type CredentialType = keyof typeof CREDENTIAL_TYPES;
const isType = (t: unknown): t is CredentialType => typeof t === "string" && t in CREDENTIAL_TYPES;

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;

type Row = typeof chefCredentials.$inferSelect;

function cleanInput(body: Record<string, unknown>) {
    if (!isType(body.type)) throw fail("Choose what kind of certificate or check this is.");
    const type = body.type;
    const title = text(body.title, 150) ?? CREDENTIAL_TYPES[type].label;
    const issuer = text(body.issuer, 150);
    const level = text(body.level, 20);
    const issuedOn = text(body.issuedOn, 10);
    const expiresOn = text(body.expiresOn, 10);
    let reference = text(body.reference, 80);
    let document = text(body.document, 255);
    if (issuedOn && (!DATE.test(issuedOn) || issuedOn > today())) throw fail("The issue date must be a real date, not in the future.");
    if (expiresOn && !DATE.test(expiresOn)) throw fail("Enter the expiry date as a date.");
    if (issuedOn && expiresOn && expiresOn <= issuedOn) throw fail("The expiry date must be after the issue date.");
    if (!issuedOn) throw fail("Add the date it was issued or completed.");
    if (document && !PRIVATE_FILE.test(document)) throw fail("Upload the certificate again.");
    if (type === "dbs_check") {
        // Only the fact of the check and its date are kept.
        document = null;
        reference = null;
    }
    if (CREDENTIAL_TYPES[type].needsDocument && !document) throw fail("Upload a copy of the certificate (PDF or photo).");
    assertNoContactDetails(title, issuer ?? "", reference ?? "");
    return { type, title, issuer, level, issuedOn, expiresOn, reference, document, showOnProfile: body.showOnProfile !== false };
}

export const listForChef = (chefId: number) =>
    db.select().from(chefCredentials).where(eq(chefCredentials.chefId, chefId)).orderBy(desc(chefCredentials.createdAt));

export async function addCredential(chefId: number, chefName: string, body: Record<string, unknown>) {
    const values = cleanInput(body);
    const [{ id }] = await db.insert(chefCredentials).values({ chefId, ...values }).$returningId();
    await notifyAdmins("Certificate to check", `${chefName} added: ${values.title}.`, "/admin/chefs?tab=credentials");
    return (await db.select().from(chefCredentials).where(eq(chefCredentials.id, id)).limit(1))[0];
}

async function ownCredential(chefId: number, id: number) {
    const [row] = await db.select().from(chefCredentials).where(and(eq(chefCredentials.id, id), eq(chefCredentials.chefId, chefId))).limit(1);
    if (!row) throw fail("Certificate not found", 404);
    return row;
}

/** Any change goes back for checking. Only showing or hiding it on the public page keeps it verified. */
export async function updateCredential(chefId: number, chefName: string, id: number, body: Record<string, unknown>) {
    const row = await ownCredential(chefId, id);
    const onlyVisibility = Object.keys(body).every((k) => k === "showOnProfile");
    if (onlyVisibility) {
        await db.update(chefCredentials).set({ showOnProfile: body.showOnProfile !== false, updatedAt: new Date() }).where(eq(chefCredentials.id, row.id));
    } else {
        const values = cleanInput({ ...row, ...body });
        if (row.document && row.document !== values.document) removeFile(row.document);
        await db.update(chefCredentials).set({ ...values, status: "pending", reviewNote: null, verifiedAt: null, updatedAt: new Date() }).where(eq(chefCredentials.id, row.id));
        await notifyAdmins("Certificate to check", `${chefName} updated: ${values.title}.`, "/admin/chefs?tab=credentials");
    }
    return (await db.select().from(chefCredentials).where(eq(chefCredentials.id, row.id)).limit(1))[0];
}

function removeFile(ref: string | null) {
    const file = privateFilePath(ref);
    if (file) fs.promises.unlink(file).catch(() => undefined);
}

export async function deleteCredential(chefId: number, id: number) {
    const row = await ownCredential(chefId, id);
    await db.delete(chefCredentials).where(eq(chefCredentials.id, row.id));
    removeFile(row.document);
}

/** A Super Admin verifies or rejects a certificate, and the chef hears about it. */
export async function reviewCredential(id: number, status: unknown, note: unknown) {
    if (status !== "verified" && status !== "rejected" && status !== "pending") throw fail("Choose verified or rejected.");
    const [row] = await db.select().from(chefCredentials).where(eq(chefCredentials.id, id)).limit(1);
    if (!row) throw fail("Certificate not found", 404);
    const reason = text(note, 300);
    if (status === "rejected" && !reason) throw fail("Tell the chef why, so they can put it right.");
    if (status === "verified" && row.expiresOn && row.expiresOn < today()) throw fail("This certificate has expired, so it can't be verified.");
    await db.update(chefCredentials).set({ status, reviewNote: reason, verifiedAt: status === "verified" ? new Date() : null, updatedAt: new Date() }).where(eq(chefCredentials.id, row.id));
    if (status !== "pending") {
        await notifyChef(
            row.chefId,
            status === "verified" ? `${row.title} verified` : `${row.title} needs another look`,
            status === "verified" ? "It now shows as verified on your public page." : reason!,
            "/chef/dashboard?tab=compliance",
        );
    }
    return (await db.select().from(chefCredentials).where(eq(chefCredentials.id, row.id)).limit(1))[0];
}

/** What the public sees: verified, in-date credentials the chef has chosen to show. No documents or numbers. */
export async function publicCredentials(chefIds: number[]) {
    const result = new Map<number, { type: string; title: string; issuer: string | null; level: string | null; issuedOn: string | null; expiresOn: string | null; verifiedAt: Date | null }[]>();
    if (!chefIds.length) return result;
    const rows = await db.select().from(chefCredentials)
        .where(and(inArray(chefCredentials.chefId, chefIds), eq(chefCredentials.status, "verified"), eq(chefCredentials.showOnProfile, true)));
    for (const r of rows) {
        if (r.expiresOn && r.expiresOn < today()) continue;
        const list = result.get(r.chefId) ?? [];
        list.push({ type: r.type, title: r.title, issuer: r.issuer, level: r.level, issuedOn: r.issuedOn, expiresOn: r.expiresOn, verifiedAt: r.verifiedAt });
        result.set(r.chefId, list);
    }
    return result;
}

/** Whether a chef has a verified, in-date food hygiene certificate. Needed before their details can be verified. */
export async function hasVerifiedHygiene(chefId: number) {
    const rows = await db.select({ expiresOn: chefCredentials.expiresOn }).from(chefCredentials)
        .where(and(eq(chefCredentials.chefId, chefId), eq(chefCredentials.type, "food_hygiene"), eq(chefCredentials.status, "verified")));
    return rows.some((r) => !r.expiresOn || r.expiresOn >= today());
}

/** Marks expired certificates and tells the chef. Runs daily. */
export async function expireCredentials() {
    const expired = await db.select().from(chefCredentials).where(and(eq(chefCredentials.status, "verified"), lt(chefCredentials.expiresOn, today())));
    for (const row of expired) {
        await db.update(chefCredentials).set({ status: "expired", updatedAt: new Date() }).where(eq(chefCredentials.id, row.id));
        await notifyChef(row.chefId, `${row.title} has expired`, "Please add your renewed certificate so it shows on your page again.", "/chef/dashboard?tab=compliance");
    }
    return expired.length;
}

export function startCredentialJobs() {
    const run = () => expireCredentials().catch((e) => console.error("Certificate expiry check failed:", e));
    setTimeout(run, 60_000).unref();
    setInterval(run, 24 * 60 * 60 * 1000).unref();
}

export type { Row as CredentialRow };
