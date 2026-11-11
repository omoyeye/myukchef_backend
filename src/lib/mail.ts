const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 10_000;

interface EmailMessage {
    senderName: string;
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
}

/** Sends one email through Brevo's API. Callers decide what a failure means, so this throws. */
async function sendEmail({ senderName, to, subject, html, replyTo }: EmailMessage) {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
        console.warn(`BREVO_API_KEY not set. Email skipped: ${subject}`);
        return;
    }
    const response = await fetch(BREVO_EMAIL_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
        body: JSON.stringify({
            sender: { name: senderName, email: MAIL_FROM },
            to: [{ email: to }],
            subject,
            htmlContent: html,
            ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => null) as { code?: string; message?: string } | null;
        throw new Error(`Brevo refused the email (${response.status}): ${detail?.message ?? detail?.code ?? "no details"}`);
    }
}

const escapeHtml = (text: unknown) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BRAND_NAME = "MYUKCHEF";
const SITE_URL = (process.env.SITE_URL || 'https://myukchef.com').replace(/\/$/, '');
const MAIL_FROM = process.env.MAIL_FROM || 'info@myukchef.com';
const SUPPORT_INBOX = process.env.SUPPORT_EMAIL || 'info@myukchef.com';
const LOGO_URL = `${SITE_URL}/logo.png`;

export const sendWelcomeEmail = async (to: string, name: string) => {
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #ea580c; margin: 0;">Welcome to ${BRAND_NAME}!</h1>
            </div>
            <p>Hi ${escapeHtml(name)},</p>
            <p>We're thrilled to have you join our community of food lovers! Discover dishes from talented local chefs, or book one for your next event.</p>
            <p>As a member, you'll earn loyalty points on every order, get exclusive access to "Sweet" rewards, and be the first to know about our special drops.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${SITE_URL}/menu" style="background-color: #ea580c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Order Your First Feast</a>
            </div>
            <p>Stay hungry,</p>
            <p>The MYUKCHEF Team</p>
        </div>
    `;

    return sendEmail({
        senderName: `${BRAND_NAME}`,
        to,
        subject: `Welcome to the Family, ${name}!`,
        html,
    });
};

export const sendOrderConfirmationEmail = async (to: string, order: any, lines: { name: string; quantity: number; allergens: string }[] = []) => {
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #ea580c; margin: 0;">Order Confirmed!</h1>
                <p style="color: #666;">Order #${order.id}</p>
            </div>
            <p>Thanks for ordering from ${BRAND_NAME}! We've received your order and our chefs are getting ready to cook up something special.</p>
            <div style="background-color: #f9fafb; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Order Summary</h3>
                <p><strong>Total:</strong> £${Number(order.total).toFixed(2)}</p>
                <p><strong>Delivery Address:</strong> ${escapeHtml(order.deliveryAddress.line1)}, ${escapeHtml(order.deliveryAddress.city)}</p>
            </div>
            ${lines.length ? `<div style="background-color: #fff7ed; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Allergen information for your order</h3>
                ${lines.map((l) => `<p style="margin: 6px 0;"><strong>${l.quantity} x ${escapeHtml(l.name)}:</strong> ${escapeHtml(l.allergens)}</p>`).join("")}
                <p style="font-size: 13px; color: #666;">Food is made in kitchens that may handle other allergens. If you have a severe allergy, please check before eating.</p>
            </div>` : ""}
            <div style="text-align: center; margin: 30px 0;">
                <a href="${SITE_URL}/order-tracker/${order.id}?t=${order.trackingToken}" style="background-color: #ea580c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Track Your Order</a>
            </div>
            <p>Enjoy your meal!</p>
        </div>
    `;

    return sendEmail({
        senderName: `${BRAND_NAME}`,
        to,
        subject: `We've Got Your Order! (#${order.id})`,
        html,
    });
};

export const sendAdminOrderAlert = async (to: string, order: any) => {
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ea580c; border-radius: 10px;">
            <h1 style="color: #ea580c;">🔥 NEW ORDER RECEIVED!</h1>
            <p><strong>Order ID:</strong> #${order.id}</p>
            <p><strong>Amount:</strong> £${Number(order.total).toFixed(2)}</p>
            <p><strong>Customer:</strong> ${order.userId ? `User ID: ${order.userId}` : 'Guest'}</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${SITE_URL}/admin/orders" style="background-color: #000; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Open Admin Dashboard</a>
            </div>
        </div>
    `;

    return sendEmail({
        senderName: "MYUKCHEF System",
        to,
        subject: `NEW ORDER ALERT: #${order.id}`,
        html,
    });
};

export const sendOrderStatusUpdateEmail = async (to: string, orderId: number, status: string) => {
    const statusMessages: Record<string, string> = {
        preparing: "Our chefs are in the kitchen working their magic!",
        delivery: "Your driver has picked up your food and is on the way!",
        completed: "Your meal has been delivered. Dig in and enjoy!",
    };

    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #ea580c; margin: 0;">Order Status Update</h1>
                <p style="color: #666;">Order #${orderId}</p>
            </div>
            <h2 style="text-align: center; text-transform: uppercase;">Status: ${status}</h2>
            <p style="text-align: center; font-size: 1.1em;">${statusMessages[status] || "Your order status has changed!"}</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${SITE_URL}/order-tracker/${orderId}" style="background-color: #ea580c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Track Real-Time</a>
            </div>
        </div>
    `;

    return sendEmail({
        senderName: `${BRAND_NAME}`,
        to,
        subject: `Update on Order #${orderId}: ${status}`,
        html,
    });
};

/** One simple layout for every notice sent through the app. */
export const sendNotificationEmail = async (to: string, title: string, message: string, link: string) => {
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h1 style="color: #ea580c; font-size: 22px;">${escapeHtml(title)}</h1>
            <p style="font-size: 16px; line-height: 1.5;">${escapeHtml(message)}</p>
            <div style="margin: 28px 0;">
                <a href="${SITE_URL}${link}" style="background-color: #ea580c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">View details</a>
            </div>
            <p style="font-size: 12px; color: #888;">You can change which emails you get from the bell icon when signed in to ${BRAND_NAME}.</p>
        </div>
    `;
    return sendEmail({ senderName: BRAND_NAME, to, subject: title, html });
};

export const sendPasswordResetEmail = async (to: string, token: string, role = "customer") => {
    // The link opens the reset page of the portal this account belongs to.
    const portalPath = role === "chef" ? "/chef" : role === "admin" ? "/admin" : "";
    const resetLink = `${SITE_URL}${portalPath}/reset-password?token=${token}`;

    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #ea580c; margin: 0;">Reset Your Password</h1>
            </div>
            <p>Somebody (hopefully you!) requested a password reset for your ${BRAND_NAME} account.</p>
            <p>If you didn't make this request, you can safely ignore this email. Your password will not change.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="background-color: #ea580c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset My Password</a>
            </div>
            <p>This link will expire in 1 hour.</p>
            <p>Stay hungry,</p>
            <p>The MYUKCHEF Team</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="font-size: 0.8em; color: #666;">If you're having trouble clicking the button, copy and paste this URL into your browser:</p>
            <p style="font-size: 0.8em; color: #666;">${resetLink}</p>
        </div>
    `;

    return sendEmail({
        senderName: `${BRAND_NAME}`,
        to,
        subject: `Reset your ${BRAND_NAME} password`,
        html,
    });
};
export const sendSupportRequestEmail = async (data: { name: string; email: string; phone: string; message: string }) => {
    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #ea580c; margin: 0;">New Support Request</h1>
            </div>
            <div style="background-color: #f9fafb; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Name:</strong> ${escapeHtml(data.name)}</p>
                <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
                <p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;" />
                <p><strong>Message:</strong></p>
                <p style="white-space: pre-wrap;">${escapeHtml(data.message)}</p>
            </div>
            <p>This message was sent from the Support Me page on ${BRAND_NAME}.</p>
        </div>
    `;

    return sendEmail({
        senderName: `${BRAND_NAME} Support`,
        replyTo: data.email,
        to: SUPPORT_INBOX,
        subject: `Support Request from ${data.name}`,
        html,
    });
};
