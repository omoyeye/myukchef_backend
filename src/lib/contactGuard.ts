import { badRequest } from "./pricing";

/**
 * Customers and chefs deal with each other only through MYUKCHEF, so anything they write to
 * each other is checked for phone numbers, email addresses, links and social handles.
 */
const NUMBER_WORD = "zero|oh|one|two|three|four|five|six|seven|eight|nine";
const CONTACT_PATTERNS: RegExp[] = [
    /[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\sat\s)\s*[a-z0-9-]+\s*(\.|\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}/i,
    /[a-z0-9._%+-]+@[a-z0-9-]+/i,
    /\b(https?:\/\/|www\.)\S+/i,
    /\b[a-z0-9-]+\.(com|co\.uk|org\.uk|net|org|uk|io|me|ly|info|biz)\b/i,
    /\b(whats\s?app|wa\.me|telegram|snap\s?chat|insta(gram)?|facebook|messenger|tik\s?tok|wechat|viber|skype|signal app)\b/i,
    /\b(call|text|ring|phone|sms|email|e-mail|dm|message)\s+me\b(?!\s+(here|on (the )?(app|myukchef)))/i,
    /\bmy\s+(number|mobile|phone|cell|email|e-mail|handle)\b/i,
    new RegExp(`\\b(${NUMBER_WORD})(?:[\\s,.-]+(?:${NUMBER_WORD})){6,}\\b`, "i"),
];
const NUMBER_RUN = /(?:\+|\b00)?\d(?:[\s().-]*\d){8,}/g;

/** A long run of digits starting 0 or + is a phone number. Dates and quantities are left alone. */
const looksLikePhone = (run: string) => {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 11) return true;
    return (run.startsWith("+") || digits.startsWith("0")) && digits.length >= 10;
};

export function hasContactDetails(text: string | null | undefined) {
    if (!text) return false;
    if (CONTACT_PATTERNS.some((pattern) => pattern.test(text))) return true;
    return (text.match(NUMBER_RUN) ?? []).some(looksLikePhone);
}

export const CONTACT_BLOCKED_MESSAGE =
    "For everyone's safety, phone numbers, email addresses, links and social media can't be shared on MYUKCHEF. Please remove them and keep your conversation here.";

/** Refuses the request if any of these texts contain contact details. */
export function assertNoContactDetails(...texts: (string | null | undefined)[]) {
    if (texts.some(hasContactDetails)) throw badRequest(CONTACT_BLOCKED_MESSAGE);
}

/** For text written before this rule, or kept for records, when it's shown to the other side. */
export function redactContactDetails(text: string | null | undefined) {
    if (!text) return text ?? null;
    return hasContactDetails(text) ? "[Removed: contained contact details]" : text;
}
