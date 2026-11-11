import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { discounts, orders, siteSettings } from "../db/schema";

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

export const DELIVERY_DEFAULTS = { fee: 3.99, serviceFeePercent: 10, freeOver: 0, minOrder: 0 };
const roundMoney = (n: number) => Math.round(n * 100) / 100;

async function readSettings(keys: string[]) {
    const rows = await db.select().from(siteSettings).where(inArray(siteSettings.key, keys));
    return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, any>;
}

export async function getOrderSettings() {
    const s = await readSettings(["delivery_config", "operational_status", "loyalty_config"]);
    const d = s.delivery_config ?? {};
    return {
        delivery: {
            fee: Number(d.fee ?? DELIVERY_DEFAULTS.fee),
            serviceFeePercent: Number(d.serviceFeePercent ?? DELIVERY_DEFAULTS.serviceFeePercent),
            freeOver: Number(d.freeOver ?? DELIVERY_DEFAULTS.freeOver),
            minOrder: Number(d.minOrder ?? DELIVERY_DEFAULTS.minOrder),
        },
        isOpen: s.operational_status?.isOpen ?? true,
        loyalty: { enabled: s.loyalty_config?.enabled ?? true, earnRatio: Number(s.loyalty_config?.earnRatio ?? 10) },
    };
}

export async function validateDiscount(code: string, amount: number, userId: number) {
    const [discount] = await db.select().from(discounts).where(eq(discounts.code, code.toUpperCase())).limit(1);
    if (!discount || !discount.isActive) throw badRequest("Invalid or inactive discount code");
    if (discount.expiryDate && new Date(discount.expiryDate) < new Date()) throw badRequest("This discount code has expired");
    if (amount < (discount.minOrderAmount ?? 0)) throw badRequest(`Minimum order amount for this code is £${discount.minOrderAmount}`);
    if (discount.isFirstOrderOnly) {
        if (!userId) throw badRequest("Please log in to use this first-order discount");
        const previous = await db.select({ id: orders.id }).from(orders).where(eq(orders.userId, userId)).limit(1);
        if (previous.length > 0) throw badRequest("This discount is only for your first order");
    }
    return discount;
}

export function calculateTotals(
    subtotal: number,
    method: "delivery" | "pickup",
    delivery: { fee: number; serviceFeePercent: number; freeOver: number },
    discount?: { type: string; value: number } | null,
) {
    const serviceFee = subtotal * (delivery.serviceFeePercent / 100);
    const qualifiesForFree = delivery.freeOver > 0 && subtotal >= delivery.freeOver;
    const deliveryFee = method === "pickup" || subtotal === 0 || qualifiesForFree ? 0 : delivery.fee;
    const rawDiscount = !discount ? 0 : discount.type === "percentage" ? subtotal * (discount.value / 100) : discount.value;
    const discountAmount = Math.min(rawDiscount, subtotal);
    return {
        serviceFee: roundMoney(serviceFee),
        deliveryFee: roundMoney(deliveryFee),
        discountAmount: roundMoney(discountAmount),
        total: roundMoney(Math.max(0, subtotal + serviceFee + deliveryFee - discountAmount)),
    };
}

export { badRequest };
