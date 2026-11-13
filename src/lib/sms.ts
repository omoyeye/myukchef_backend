import { getBrevo } from "./integrations";

/**
 * Send a transactional SMS via Brevo
 * @param to Phone number in international format (e.g. +447123456789)
 * @param text The SMS content
 */
export async function sendSMS(to: string, text: string) {
    const { apiKey: BREVO_API_KEY, smsSender: BREVO_SMS_SENDER } = await getBrevo();
    if (!BREVO_API_KEY) {
        console.warn("No Brevo API key set. SMS skipped.");
        return;
    }

    // Basic phone normalization (Brevo expects digits, but usually handles +)
    const digits = to.replace(/[^\d+]/g, '');
    const normalizedTo = digits.startsWith('+') ? digits
        : digits.startsWith('00') ? `+${digits.slice(2)}`
        : digits.startsWith('0') ? `+44${digits.slice(1)}`
        : `+${digits}`;

    try {
        const response = await fetch("https://api.brevo.com/v3/transactionalSMS/sms", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": BREVO_API_KEY
            },
            body: JSON.stringify({
                type: "transactional",
                sender: BREVO_SMS_SENDER,
                recipient: normalizedTo,
                content: text,
            })
        });

        if (!response.ok) {
            const error: any = await response.json();
            console.error("Brevo SMS fallback failed:", error);
            throw new Error(`Brevo API error: ${JSON.stringify(error)}`);
        }

        const result: any = await response.json();
        console.log(`SMS sent successfully to ${normalizedTo}. Message ID: ${result.messageId}`);
        return result;
    } catch (error) {
        console.error("Failed to send SMS via Brevo:", error);
        throw error;
    }
}
