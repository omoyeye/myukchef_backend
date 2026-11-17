import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chefs, mealPlans, mealPlanWeeks } from "../db/schema";
import { getPlanConfig, isLocked, lockTime, notify, notifyChef } from "./mealPlans";
import { notifyAdmins } from "./notify";
import { paymentConfig } from "./payments";
import { peopleLabel } from "./people";
import { withTemplate } from "./templates";

/**
 * Paying for a meal plan with Stripe. When the chef accepts, the customer is asked (email, push and
 * a card on the plan) to pay for the next delivery. Once it's paid, Super Admins hear about it and the
 * chef is told to go ahead and cook. Customers get a reminder before the cut-off, and if a delivery
 * is still unpaid at the cut-off, the chef is told not to cook it yet and Super Admins can follow up.
 */

type Plan = typeof mealPlans.$inferSelect;
type Week = typeof mealPlanWeeks.$inferSelect;

const PAYABLE = ["scheduled", "preparing", "out_for_delivery", "delivered"];
const money = (n: number) => `£${n.toFixed(2)}`;
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
const whenLabel = (d: Date) => d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/** The next delivery the customer still has to pay for, in week order. */
export function nextDue(weeks: Week[]) {
    return [...weeks].sort((a, b) => a.weekNumber - b.weekNumber).find((w) => !w.isPaid && w.total >= 0.3 && PAYABLE.includes(w.status)) ?? null;
}

/** What the plan page shows on its "pay now" card: null when nothing is due or card payments are off. */
export async function paymentDue(plan: Plan, weeks: Week[], cutoffHours: number) {
    if (plan.status !== "active") return null;
    const week = nextDue(weeks);
    if (!week) return null;
    const { cardPayments } = await paymentConfig();
    if (!cardPayments) return null;
    const payBy = lockTime(week.deliveryDate, cutoffHours);
    return {
        weekId: week.id,
        weekNumber: week.weekNumber,
        deliveryDate: week.deliveryDate,
        amount: week.total,
        payBy: payBy.toISOString(),
        // Past the cut-off: the chef won't cook it until it's paid.
        late: isLocked(week.deliveryDate, cutoffHours),
        unpaidCount: weeks.filter((w) => !w.isPaid && w.total >= 0.3 && PAYABLE.includes(w.status)).length,
    };
}

/** Straight after the chef accepts: tell the customer, and ask for the first payment if cards are on. */
export async function announceAccepted(plan: Plan, note: string | null) {
    const { cutoffHours } = await getPlanConfig();
    const weeks = await db.select().from(mealPlanWeeks).where(eq(mealPlanWeeks.planId, plan.id)).orderBy(asc(mealPlanWeeks.weekNumber));
    const [chef] = await db.select({ displayName: chefs.displayName }).from(chefs).where(eq(chefs.id, plan.chefId)).limit(1);
    const chefName = chef?.displayName ?? "Your chef";
    const due = await paymentDue({ ...plan, status: "active" }, weeks, cutoffHours);
    if (!due) {
        await withTemplate("plan.confirmed", { note: note ?? "" }, () => notify(plan.userId, "Your meal plan is confirmed", note || "Your chef has accepted your plan. You can now change, skip or pause any week before its cut-off.", `/my-plans/${plan.id}`));
        return;
    }
    const vars = { chefName, amount: due.amount.toFixed(2), week: due.weekNumber, deliveryDate: longDate(due.deliveryDate), payBy: whenLabel(new Date(due.payBy)), note: note ?? "" };
    await withTemplate("plan.accepted_pay", vars, () => notify(
        plan.userId,
        `${chefName} accepted your meal plan: please pay to start`,
        `${note ? `${chefName} says: "${note}"\n\n` : ""}Pay ${money(due.amount)} for your first delivery (${vars.deliveryDate}) by ${vars.payBy}, and ${chefName} will start cooking. You pay for each delivery as you go, and can still change, skip or pause any week before its cut-off.`,
        `/my-plans/${plan.id}?pay=${due.weekId}`,
    ));
}

/** Once a delivery is paid (by card, or recorded by a Super Admin): thank the customer, tell admins, tell the chef to cook. */
export async function afterWeekPaid(week: Week, plan: Plan, how: "card" | "admin") {
    const [chef] = await db.select({ displayName: chefs.displayName }).from(chefs).where(eq(chefs.id, plan.chefId)).limit(1);
    const chefName = chef?.displayName ?? "your chef";
    const date = longDate(week.deliveryDate);
    const who = peopleLabel(plan, plan.servings);
    await withTemplate("plan.week_paid", { week: week.weekNumber, amount: week.total.toFixed(2), chefName, deliveryDate: date }, () => notify(plan.userId, `Week ${week.weekNumber} paid`, `Thank you. We've received ${money(week.total)}. ${chefName} has been told to start cooking for ${date}.`, `/my-plans/${plan.id}`));
    await withTemplate("admin.plan_week_paid", { planId: plan.id, week: week.weekNumber, amount: week.total.toFixed(2), chefName, how: how === "card" ? "by card" : "recorded by a Super Admin" }, () => notifyAdmins(`Meal plan #${plan.id}: week ${week.weekNumber} paid`, `${money(week.total)} ${how === "card" ? "paid by card" : "recorded as paid"}. ${chefName} has been told to cook for ${date}.`, "/admin/meal-plans"));
    await withTemplate("plan.week_paid_chef", { week: week.weekNumber, deliveryDate: date, people: who }, () => notifyChef(plan.chefId, `Week ${week.weekNumber} is paid: go ahead and cook`, `The customer has paid. Please cook week ${week.weekNumber} (${plan.mealsPerWeek} meals for ${who}) for delivery on ${date}.`, `/chef/dashboard?tab=plans&plan=${plan.id}`));
}

/** Hourly: remind customers to pay before the cut-off, and flag deliveries still unpaid at the cut-off. */
export async function runPlanPaymentJobs(now = new Date()) {
    const { cardPayments } = await paymentConfig();
    if (!cardPayments) return;
    const { cutoffHours } = await getPlanConfig();
    const rows = await db.select({ week: mealPlanWeeks, plan: mealPlans }).from(mealPlanWeeks)
        .innerJoin(mealPlans, eq(mealPlanWeeks.planId, mealPlans.id))
        .where(and(eq(mealPlans.status, "active"), eq(mealPlanWeeks.isPaid, false), inArray(mealPlanWeeks.status, ["scheduled", "preparing"])));
    for (const { week, plan } of rows) {
        if (week.total < 0.3) continue;
        const payBy = lockTime(week.deliveryDate, cutoffHours);
        const hoursLeft = (payBy.getTime() - now.getTime()) / 3600_000;
        if (hoursLeft > 0 && hoursLeft <= 24 && !week.paymentReminderSent) {
            await db.update(mealPlanWeeks).set({ paymentReminderSent: true }).where(eq(mealPlanWeeks.id, week.id));
            await withTemplate("plan.payment_reminder", { week: week.weekNumber, amount: week.total.toFixed(2), payBy: whenLabel(payBy) }, () => notify(plan.userId, `Please pay for week ${week.weekNumber}`, `Pay ${money(week.total)} by ${whenLabel(payBy)} so your chef can cook it. After that, this delivery can't go ahead until it's paid.`, `/my-plans/${plan.id}?pay=${week.id}`));
        }
        if (hoursLeft <= 0 && !week.unpaidAlertSent) {
            await db.update(mealPlanWeeks).set({ unpaidAlertSent: true }).where(eq(mealPlanWeeks.id, week.id));
            const date = longDate(week.deliveryDate);
            await withTemplate("plan.week_unpaid_chef", { week: week.weekNumber, deliveryDate: date }, () => notifyChef(plan.chefId, `Week ${week.weekNumber} isn't paid yet`, `Please don't cook week ${week.weekNumber} (${date}) until we tell you it's paid.`, `/chef/dashboard?tab=plans&plan=${plan.id}`));
            await withTemplate("admin.plan_week_unpaid", { planId: plan.id, week: week.weekNumber, amount: week.total.toFixed(2) }, () => notifyAdmins(`Meal plan #${plan.id}: week ${week.weekNumber} unpaid`, `${money(week.total)} for ${date} wasn't paid by the cut-off. The chef has been told to wait.`, "/admin/meal-plans"));
        }
    }
}
