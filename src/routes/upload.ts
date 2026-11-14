import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';

/** Uploaded photos are never stored wider or taller than this. */
const MAX_IMAGE_WIDTH = 1600;
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { requireAuth } from '../lib/auth';
import { videoDurationSeconds } from '../lib/videoDuration';

const router = express.Router();

// Ensure upload directory exists
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
const uploadDir = UPLOAD_DIR;
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + ALLOWED_TYPES[file.mimetype]);
    }
});

// File filter to only allow images
const ALLOWED_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const fileFilter = (req: any, file: any, cb: any) => {
    if (ALLOWED_TYPES[file.mimetype]) {
        cb(null, true);
    } else {
        cb(Object.assign(new Error('Please upload a JPG, PNG, WebP or GIF image.'), { status: 400 }), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 12 * 1024 * 1024 // 12MB: phone photos are large, and they're shrunk after upload
    }
});

// POST /api/upload
// Only staff and chefs add images to the site.
const requireUploader = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
        const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, req.userId!)).limit(1);
        if (user?.role !== 'admin' && user?.role !== 'chef') return res.status(403).json({ error: 'Forbidden' });
        next();
    } catch (error) { next(error); }
};

router.post('/', requireAuth, requireUploader, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Phone photos are several megabytes. Each one is turned the right way up, shrunk to a
        // sensible size and saved as WebP, which is usually a tenth of the size.
        let filename = req.file.filename;
        if (req.file.mimetype !== 'image/gif') {
            const optimised = `${path.parse(filename).name}.webp`;
            try {
                await sharp(req.file.path).rotate().resize({ width: MAX_IMAGE_WIDTH, height: MAX_IMAGE_WIDTH, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(uploadDir, `tmp-${optimised}`));
                await fs.promises.unlink(req.file.path).catch(() => undefined);
                await fs.promises.rename(path.join(uploadDir, `tmp-${optimised}`), path.join(uploadDir, optimised));
                filename = optimised;
            } catch {
                await fs.promises.unlink(req.file.path).catch(() => undefined);
                await fs.promises.unlink(path.join(uploadDir, `tmp-${optimised}`)).catch(() => undefined);
                return res.status(400).json({ error: "We couldn't read that image. Please try a JPG or PNG." });
            }
        }

        // Note: The /uploads prefix matches the static route in index.ts
        const imageUrl = `/uploads/${filename}`;
        res.json({ url: imageUrl });
    } catch (error: any) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// === Kitchen videos ===
// Chefs show customers where their food is made in a video of up to one minute.
export const MAX_VIDEO_SECONDS = 60;
const VIDEO_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov' };

const videoUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${VIDEO_TYPES[file.mimetype]}`),
    }),
    fileFilter: (_req, file, cb) => {
        if (VIDEO_TYPES[file.mimetype]) cb(null, true);
        else cb(Object.assign(new Error('Please upload an MP4 or MOV video.'), { status: 400 }));
    },
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// POST /api/upload/video
router.post('/video', requireAuth, requireUploader, videoUpload.single('video'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No video uploaded' });
        // The length is read from the file itself, so a longer video can't slip through.
        const seconds = await videoDurationSeconds(req.file.path);
        if (seconds === null || seconds > MAX_VIDEO_SECONDS + 1) {
            await fs.promises.unlink(req.file.path).catch(() => undefined);
            return res.status(400).json({
                error: seconds === null
                    ? "We couldn't read that video. Please try an MP4 or MOV file."
                    : `Your video is ${Math.round(seconds)} seconds long. Please keep it to one minute.`,
            });
        }
        res.json({ url: `/uploads/${req.file.filename}`, seconds: Math.round(seconds) });
    } catch (error) { next(error); }
});

// === Small versions for cards and lists ===
const THUMB_DIR = path.join(uploadDir, '.thumbs');
const THUMB_WIDTHS = [240, 480, 960];
const UPLOADED_IMAGE = /^[\w-]+\.(jpg|jpeg|png|webp)$/;

/**
 * GET /uploads/sm/:file?w=480: a small WebP copy of an uploaded image, made the first time it's
 * asked for and kept. Cards and lists use these, so a menu page doesn't download full-size photos.
 */
export async function serveThumbnail(req: express.Request, res: express.Response) {
    const file = String(req.params.file ?? '');
    if (!UPLOADED_IMAGE.test(file)) return res.status(404).end();
    const wanted = Number(req.query.w) || 480;
    const width = THUMB_WIDTHS.find((w) => w >= wanted) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
    const source = path.join(uploadDir, file);
    const target = path.join(THUMB_DIR, `${path.parse(file).name}-${width}.webp`);
    try {
        if (!fs.existsSync(target)) {
            if (!fs.existsSync(source)) return res.status(404).end();
            await fs.promises.mkdir(THUMB_DIR, { recursive: true });
            await sharp(source).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toFile(`${target}.tmp`);
            await fs.promises.rename(`${target}.tmp`, target);
        }
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        res.type('image/webp').sendFile(target, { dotfiles: 'allow' });
    } catch {
        // If anything goes wrong, the full image still works.
        res.redirect(`/uploads/${file}`);
    }
}

// === Private documents ===
// Certificates and other compliance evidence. Kept outside the public uploads folder and only
// served, through the API, to the chef they belong to and to Super Admins.
export const PRIVATE_UPLOAD_DIR = path.resolve(process.env.PRIVATE_UPLOAD_DIR || path.join(process.cwd(), "private_uploads"));
if (!fs.existsSync(PRIVATE_UPLOAD_DIR)) fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });
const DOCUMENT_TYPES: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
/** The first bytes of each allowed file type, so a renamed file can't pass as a document. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
    ".pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
    ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    ".png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ".webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
export const PRIVATE_FILE = /^private:[\w-]+\.(pdf|jpg|png|webp)$/;

const documentUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, PRIVATE_UPLOAD_DIR),
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${DOCUMENT_TYPES[file.mimetype]}`),
    }),
    fileFilter: (_req, file, cb) => {
        if (DOCUMENT_TYPES[file.mimetype]) cb(null, true);
        else cb(Object.assign(new Error("Please upload a PDF, JPG, PNG or WebP file."), { status: 400 }));
    },
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// POST /api/upload/document: returns a private reference, not a public link
router.post("/document", requireAuth, requireUploader, documentUpload.single("document"), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        const handle = await fs.promises.open(req.file.path, "r");
        const head = Buffer.alloc(12);
        await handle.read(head, 0, 12, 0);
        await handle.close();
        const ext = path.extname(req.file.filename);
        if (!SIGNATURES[ext]?.(head)) {
            await fs.promises.unlink(req.file.path).catch(() => undefined);
            return res.status(400).json({ error: "That file doesn't look like a real PDF or image." });
        }
        res.json({ file: `private:${req.file.filename}`, name: req.file.originalname.slice(0, 120) });
    } catch (error) { next(error); }
});

/** The file on disk for a private reference, or null if it isn't one. */
export function privateFilePath(ref: string | null | undefined) {
    if (!ref || !PRIVATE_FILE.test(ref)) return null;
    return path.join(PRIVATE_UPLOAD_DIR, ref.slice("private:".length));
}

export default router;
