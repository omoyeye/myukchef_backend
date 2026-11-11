import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { supportMessages } from "../db/schema";
import { requireAdmin } from "../lib/auth";
import { sendSupportRequestEmail } from "../lib/mail";
import { notifyAdmins } from "../lib/notify";
import { rateLimit } from "../lib/rateLimit";

const contactRouter = Router();

const contactSchema = z.object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
    email: z.string().trim().email("Invalid email address").max(200),
    phone: z.string().trim().min(10, "Phone number must be at least 10 characters").max(30),
    message: z.string().trim().min(10, "Message must be at least 10 characters").max(5000),
});

// The message is saved first, so a mail problem can never lose it.
contactRouter.post("/", rateLimit(5, 60_000), async (req, res) => {
    try {
        const data = contactSchema.parse(req.body);
        await db.insert(supportMessages).values(data);
        sendSupportRequestEmail(data).catch((e: Error) => console.error("Support email failed:", e.message));
        await notifyAdmins("New support message", `${data.name} has sent a message.`, "/admin/support");
        res.json({ message: "Support request sent successfully" });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors[0].message });
        }
        console.error("Support request error:", error);
        res.status(500).json({ error: "Failed to send support request" });
    }
});

contactRouter.get("/admin", requireAdmin, async (_req, res) => {
    res.json(await db.select().from(supportMessages).orderBy(desc(supportMessages.createdAt)).limit(500));
});

contactRouter.patch("/admin/:id", requireAdmin, async (req, res) => {
    const status = req.body.status;
    if (!["open", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    await db.update(supportMessages).set({ status }).where(eq(supportMessages.id, Number(req.params.id)));
    res.json({ status });
});

contactRouter.delete("/admin/:id", requireAdmin, async (req, res) => {
    await db.delete(supportMessages).where(eq(supportMessages.id, Number(req.params.id)));
    res.json({ message: "Deleted" });
});

export { contactRouter };
