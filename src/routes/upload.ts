import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
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
        fileSize: 5 * 1024 * 1024 // 5MB limit
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

router.post('/', requireAuth, requireUploader, upload.single('image'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Return the URL for the uploaded file
        // Note: The /uploads prefix matches the static route in index.ts
        const imageUrl = `/uploads/${req.file.filename}`;
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

export default router;
