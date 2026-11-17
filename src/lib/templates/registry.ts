/**
 * Every message MYUKCHEF sends, as a template the Super Admin can edit. Each one has a default
 * wording here; anything the Super Admin changes is saved in the database and used instead.
 *
 * Placeholders are written {{name}}. Each template lists the ones it can use.
 */

export type Audience = "customer" | "chef" | "admin";
export type Channel = "inApp" | "push" | "email" | "sms";

export interface TemplateDef {
    key: string;
    group: string;
    audience: Audience;
    name: string;
    /** Placeholders this message can use. */
    vars: string[];
    title: string;
    body: string;
    /** Default text message, for messages that can go by SMS (customers with a phone number on an order). */
    sms?: string;
    /** Which channels are on until the Super Admin changes it. */
    channels: Record<Channel, boolean>;
    /** Channels that can never apply to this message (for example in-app for an email-only message). */
    unavailable?: Channel[];
}

const ALL = { inApp: true, push: true, email: true, sms: false };
const WITH_SMS = { inApp: true, push: true, email: true, sms: true };
const EMAIL_ONLY = { inApp: false, push: false, email: true, sms: false };

const t = (key: string, group: string, audience: Audience, name: string, vars: string[], title: string, body: string, extra: Partial<TemplateDef> = {}): TemplateDef =>
    ({ key, group, audience, name, vars, title, body, channels: ALL, ...extra });

export const TEMPLATES: TemplateDef[] = [
    // ===== Account =====
    t("account.welcome", "Account", "customer", "Welcome email", ["firstName"], "Welcome to the family, {{firstName}}!",
        "Hi {{firstName}},\n\nWe're thrilled to have you. Discover dishes from talented local chefs, plan your meals for weeks ahead, or book a chef for your next event.\n\nYou earn loyalty points on every order.",
        { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
    t("account.verify_email", "Account", "customer", "Confirm your email", ["firstName"], "Confirm your email address",
        "Hi {{firstName}}, please confirm this is your email address so we can send your order updates and receipts to the right place. The link works for 7 days.",
        { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
    t("account.password_reset", "Account", "customer", "Reset your password", ["firstName"], "Reset your password",
        "We received a request to reset your password. The link below works for one hour. If you didn't ask for this, you can ignore this email.",
        { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
    t("review.chef_replied", "Account", "customer", "Chef replied to a review", ["reply"], "Your chef replied to your review", "{{reply}}"),

    // ===== Orders (customer) =====
    t("order.placed", "Orders", "customer", "Order confirmation", ["firstName", "orderId", "total", "when", "items", "codeNote"], "Order #{{orderId}} confirmed",
        "Thanks for ordering from MYUKCHEF! We've received your order and your chefs are getting ready.{{codeNote}}\n\nTotal: £{{total}}\nWanted for: {{when}}\n\n{{items}}",
        { sms: "MYUKCHEF: Order #{{orderId}} received! Total £{{total}}. We'll start preparing it shortly.{{codeNote}}", channels: { inApp: false, push: false, email: true, sms: true }, unavailable: ["inApp", "push"] }),
    t("order.cooking", "Orders", "customer", "Chef started cooking", ["orderId", "chefName", "othersNote"], "{{chefName}} is cooking your order",
        "{{chefName}} has started cooking your order #{{orderId}}.{{othersNote}}", { sms: "MYUKCHEF: {{chefName}} has started cooking your order #{{orderId}}.", channels: WITH_SMS }),
    t("order.on_the_way", "Orders", "customer", "Out for delivery", ["orderId", "chefName", "othersNote", "codeNote"], "Your order from {{chefName}} is on its way",
        "{{chefName}} has sent your order #{{orderId}} out for delivery.{{othersNote}}{{codeNote}}", { sms: "MYUKCHEF: Your order #{{orderId}} from {{chefName}} is on its way.{{codeNote}}", channels: WITH_SMS }),
    t("order.ready_to_collect", "Orders", "customer", "Ready to collect", ["orderId", "chefName", "othersNote", "codeNote"], "Your order from {{chefName}} is ready",
        "Your order #{{orderId}} from {{chefName}} is ready to collect.{{othersNote}}{{codeNote}}", { sms: "MYUKCHEF: Your order #{{orderId}} from {{chefName}} is ready to collect.{{codeNote}}", channels: WITH_SMS }),
    t("order.delivered", "Orders", "customer", "Delivered: please confirm", ["orderId", "chefName"], "Order #{{orderId}} delivered",
        "Your order from {{chefName}} has been delivered. Enjoy your meal! Please confirm you received it, or tell us if something's wrong.",
        { sms: "MYUKCHEF: Your order #{{orderId}} from {{chefName}} has been delivered. Enjoy!", channels: WITH_SMS }),
    t("order.collected", "Orders", "customer", "Collected: please confirm", ["orderId", "chefName"], "Order #{{orderId}} collected",
        "You've collected your order from {{chefName}}. Enjoy your meal! Please confirm you received it, or tell us if something's wrong.",
        { sms: "MYUKCHEF: Thanks for collecting order #{{orderId}}. Enjoy!", channels: WITH_SMS }),
    t("order.cancelled", "Orders", "customer", "Order cancelled", ["orderId"], "Order #{{orderId}} cancelled",
        "Your order #{{orderId}} has been cancelled. Contact us if you have any questions.", { sms: "MYUKCHEF: Your order #{{orderId}} has been cancelled.", channels: WITH_SMS }),
    t("order.cancelled_refunded", "Orders", "customer", "Order cancelled and refunded", ["orderId", "total"], "Order #{{orderId}} cancelled",
        "Your order #{{orderId}} has been cancelled and your payment of £{{total}} refunded to your card. It can take 5 to 10 days to show.",
        { sms: "MYUKCHEF: Order #{{orderId}} cancelled. £{{total}} is on its way back to your card.", channels: WITH_SMS }),
    t("order.reopened", "Orders", "customer", "Order reopened", ["orderId"], "Order #{{orderId}} reopened",
        "Your order #{{orderId}} is back on. Your chef will start it soon.", { sms: "MYUKCHEF: Your order #{{orderId}} is back on.", channels: WITH_SMS }),

    // ===== Orders (chef) =====
    t("order.new_for_chef", "Orders", "chef", "New order for a chef", ["orderId", "items"], "New order #{{orderId}}",
        "{{items}}. Move it to \"Cooking\" when you start, so the customer knows."),
    t("order.confirmed_chef", "Orders", "chef", "Customer confirmed delivery", ["orderId"], "Order #{{orderId}} confirmed",
        "The customer confirmed they received your food. Your invoice is ready to submit."),
    t("order.problem_chef", "Orders", "chef", "Customer reported a problem", ["orderId"], "Problem reported on order #{{orderId}}",
        "The customer reported a problem. Our team will be in touch before you're paid."),
    t("order.cancelled_chef", "Orders", "chef", "Order cancelled", ["orderId", "cancelledBy"], "Order #{{orderId}} was cancelled",
        "You no longer need to prepare this order."),
    t("order.reopened_chef", "Orders", "chef", "Order reopened", ["orderId"], "Order #{{orderId}} is back on",
        "This order was reopened. Please prepare it again."),

    // ===== Meal plans =====
    t("plan.request_sent", "Meal plans", "customer", "Plan request sent", ["chefName", "length", "weeks", "months"], "We've sent your request",
        "{{chefName}} will confirm your {{length}} plan. Nothing is charged yet."),
    t("plan.confirmed", "Meal plans", "customer", "Plan confirmed", ["note"], "Your meal plan is confirmed",
        "Your chef has accepted your plan. You can now change, skip or pause any week before its cut-off."),
    t("plan.declined", "Meal plans", "customer", "Chef can't take the plan", ["note"], "Your chef can't take this plan",
        "They aren't able to take this plan right now. Nothing is owed, and you can try another chef."),
    t("plan.request_expired", "Meal plans", "customer", "Plan request expired", [], "Your meal plan request expired",
        "The chef didn't reply before your start date, so nothing went ahead. You can try a new date or another chef."),
    t("plan.status_updated", "Meal plans", "customer", "Plan status changed by MYUKCHEF", ["status"], "Your meal plan was updated", "Your plan's status is now: {{status}}."),
    t("plan.menu_closing", "Meal plans", "customer", "Week's menu closes soon", ["week"], "Week {{week}}: your menu closes soon",
        "Change your dishes or skip this delivery before the chef starts shopping."),
    t("plan.week_on_the_way", "Meal plans", "customer", "Week on its way", ["week"], "Week {{week}} is on its way", "Your meals have left the kitchen."),
    t("plan.week_delivered", "Meal plans", "customer", "Week delivered", ["week"], "Week {{week}} has arrived", "Enjoy! How was it? Rating your chef helps other customers choose."),
    t("plan.week_missed", "Meal plans", "customer", "Week not delivered", ["week"], "Week {{week}} wasn't delivered",
        "Sorry about that. You won't be charged for this delivery. Message your chef if you need anything."),
    t("plan.accepted_pay", "Meal plans", "customer", "Plan accepted: please pay", ["chefName", "amount", "week", "deliveryDate", "payBy", "note"], "{{chefName}} accepted your meal plan: please pay to start",
        "Pay £{{amount}} for your first delivery ({{deliveryDate}}) by {{payBy}}, and {{chefName}} will start cooking. You pay for each delivery as you go, and can still change, skip or pause any week before its cut-off."),
    t("plan.payment_reminder", "Meal plans", "customer", "Payment reminder", ["week", "amount", "payBy"], "Please pay for week {{week}}",
        "Pay £{{amount}} by {{payBy}} so your chef can cook it. After that, this delivery can't go ahead until it's paid."),
    t("plan.week_paid", "Meal plans", "customer", "Week paid", ["week", "amount", "chefName", "deliveryDate"], "Week {{week}} paid", "Thank you. We've received £{{amount}}. {{chefName}} has been told to start cooking for {{deliveryDate}}."),
    t("plan.resumed", "Meal plans", "customer", "Plan back on after a pause", [], "Your meal plan is back on", "Your pause has ended and your deliveries have restarted."),
    t("plan.ending_soon", "Meal plans", "customer", "Plan ends soon", ["endDate"], "Your meal plan ends soon",
        "Your plan finishes on {{endDate}}. It won't renew by itself, so renew it if you'd like to carry on."),
    t("plan.finished", "Meal plans", "customer", "Plan finished", [], "Your meal plan has finished",
        "Hope you enjoyed it. You can order it again with your chef in one tap from My meal plans, and tell others how it went."),
    t("plan.request_chef", "Meal plans", "chef", "New plan request", ["length", "weeks", "months", "mealsPerWeek", "servings", "people", "startDate"], "New meal plan request",
        "A customer would like a {{length}} plan: {{mealsPerWeek}} meals a week for {{people}}. Please reply before {{startDate}}."),
    t("plan.status_updated_chef", "Meal plans", "chef", "Plan status changed by MYUKCHEF", ["status"], "A meal plan was updated",
        "MYUKCHEF changed a plan's status to: {{status}}. Check your cook sheet."),
    t("plan.week_skipped_chef", "Meal plans", "chef", "Customer skipped a week", ["week", "date"], "A delivery was skipped",
        "A customer skipped their week {{week}} delivery on {{date}}."),
    t("plan.paused_chef", "Meal plans", "chef", "Customer paused", ["until", "count"], "A meal plan was paused",
        "A customer paused their plan until {{until}}. {{count}} deliveries are on hold."),
    t("plan.restarted_chef", "Meal plans", "chef", "Customer restarted early", [], "A meal plan has restarted", "A customer has restarted their plan early. Check your cook sheet."),
    t("plan.cancelled_chef", "Meal plans", "chef", "Customer cancelled a plan", ["lockedCount"], "A meal plan was cancelled",
        "A customer cancelled their plan. Check your cook sheet for any deliveries still going ahead."),
    t("plan.week_paid_chef", "Meal plans", "chef", "Week paid: go ahead and cook", ["week", "deliveryDate", "people"], "Week {{week}} is paid: go ahead and cook", "The customer has paid. Please cook week {{week}} for {{people}}, for delivery on {{deliveryDate}}."),
    t("plan.week_unpaid_chef", "Meal plans", "chef", "Week not paid yet", ["week", "deliveryDate"], "Week {{week}} isn't paid yet", "Please don't cook week {{week}} ({{deliveryDate}}) until we tell you it's paid."),

    // ===== Events =====
    t("event.request_sent", "Events", "customer", "Event request sent", ["eventName", "chefCount"], "We've sent your request",
        "{{chefCount}} chef(s) have been asked to quote for {{eventName}}. We'll tell you when quotes arrive."),
    t("event.quote_received", "Events", "customer", "New quote", ["eventName", "total"], "New quote for {{eventName}}", "A chef has sent a quote of £{{total}}."),
    t("event.chef_declined", "Events", "customer", "Chef can't quote", ["eventName", "note"], "A chef can't quote for {{eventName}}",
        "They aren't able to take this one. Your other quotes aren't affected."),
    t("event.quotes_ready", "Events", "customer", "All quotes in", ["eventName"], "All your quotes are in",
        "Every chef has replied about {{eventName}}. Compare them and confirm the ones you want."),
    t("event.quotes_confirmed", "Events", "customer", "Quotes confirmed: please pay", ["eventName", "total"], "Your quotes are confirmed",
        "Next, please pay £{{total}} in full to confirm {{eventName}}."),
    t("event.paid", "Events", "customer", "Booking paid", ["eventName"], "Payment received", "Thank you. {{eventName}} is confirmed and your chefs have been told."),
    t("event.payment_not_found", "Events", "customer", "Payment not found", ["eventName"], "We couldn't find your payment",
        "We haven't received your payment for {{eventName}} yet. Please check the reference and try again."),
    t("event.attendance_update", "Events", "customer", "Chef attendance update", ["eventName", "update"], "Update for {{eventName}}", "One of your chefs {{update}}."),
    t("event.status_updated", "Events", "customer", "Booking status changed", ["eventName", "status"], "Your booking was updated", "{{eventName}} is now: {{status}}."),
    t("event.refunded", "Events", "customer", "Booking refunded", ["eventName"], "Your booking was refunded", "{{eventName}} has been cancelled and refunded."),
    t("event.closed_unpaid", "Events", "customer", "Booking closed unpaid", ["eventName"], "Your booking has closed",
        "The date for {{eventName}} has passed without payment, so the booking has closed. Nothing is owed."),
    t("event.review_request", "Events", "customer", "Ask for a review", ["eventName"], "How was your event?", "We hope {{eventName}} was wonderful. You can now rate your chefs."),
    t("event.quote_withdrawn_chef", "Events", "chef", "Customer removed this chef", ["eventName", "reason"], "No longer needed for an event", "The customer no longer needs you for {{eventName}}. Nothing further is needed."),
    t("event.total_changed", "Events", "customer", "Booking total changed", ["eventName", "total"], "Your booking total has changed", "Without that chef, {{eventName}} now comes to £{{total}}."),
    t("event.quote_request_chef", "Events", "chef", "New quote request", ["eventName", "headcount", "people", "eventDate"], "New event quote request",
        "{{eventName}}: {{headcount}} guests ({{people}}). Please send your quote."),
    t("event.quote_chosen", "Events", "chef", "Quote chosen", ["eventName"], "Your quote was chosen",
        "The customer chose your quote for {{eventName}}. You'll get the venue details once they've paid."),
    t("event.quote_not_chosen", "Events", "chef", "Quote not chosen", ["eventName"], "Quote not selected", "The customer went with other options for {{eventName}}. Thanks for replying."),
    t("event.paid_chef", "Events", "chef", "Booking paid: confirmed", ["eventName"], "Booking paid: you're confirmed",
        "{{eventName}} is paid in full. You can now see the venue, date and time. Your payout follows from MYUKCHEF."),
    t("event.cancelled_chef", "Events", "chef", "Event cancelled", ["eventName", "cancelledBy"], "Event cancelled", "{{eventName}} was cancelled by {{cancelledBy}}. You no longer need to prepare for it."),

    // ===== Messages =====
    t("message.order_to_chef", "Messages", "chef", "Customer messaged about an order", ["orderId", "preview"], "Message about order #{{orderId}}", "{{preview}}"),
    t("message.order_to_customer", "Messages", "customer", "Chef messaged about an order", ["orderId", "chefName", "preview"], "{{chefName}} sent a message about order #{{orderId}}", "{{preview}}"),
    t("message.plan_to_chef", "Messages", "chef", "Customer messaged about a plan", ["preview"], "New message about a meal plan", "{{preview}}"),
    t("message.plan_to_customer", "Messages", "customer", "Chef messaged about a plan", ["preview"], "New message about your meal plan", "{{preview}}"),
    t("message.event_to_chef", "Messages", "chef", "Customer messaged about an event", ["eventName", "preview"], "New message about {{eventName}}", "{{preview}}"),
    t("message.event_to_customer", "Messages", "customer", "Chef messaged about an event", ["eventName", "preview"], "New message about {{eventName}}", "{{preview}}"),

    // ===== Chefs =====
    t("chef.application_received", "Chefs", "chef", "Application received", [], "We've got your application",
        "Our team will review it soon. In the meantime, add your food safety and payout details in the Chef Portal."),
    t("chef.account_approved", "Chefs", "chef", "Chef approved", [], "You're approved", "Welcome to MYUKCHEF. You can now add dishes and take bookings."),
    t("chef.account_suspended", "Chefs", "chef", "Chef suspended", ["reason"], "Your chef account is suspended", "{{reason}}"),
    t("chef.account_rejected", "Chefs", "chef", "Application not approved", ["reason"], "About your chef application", "{{reason}}"),
    t("chef.dish_approved", "Chefs", "chef", "Dish approved", ["dishName"], "Your dish is live", "{{dishName}} is now on sale."),
    t("chef.dish_rejected", "Chefs", "chef", "Dish not approved", ["dishName"], "Your dish wasn't approved", "{{dishName}} needs changes. Please check it and try again."),
    t("chef.details_verified", "Chefs", "chef", "Details verified", [], "Your details are verified", "Thanks. We've checked your food safety and payout details."),
    t("chef.credential_verified", "Chefs", "chef", "Certificate verified", ["title"], "{{title}} verified", "It now shows as verified on your public page."),
    t("chef.credential_rejected", "Chefs", "chef", "Certificate sent back", ["title", "reason"], "{{title}} needs another look", "{{reason}}"),
    t("chef.credential_expired", "Chefs", "chef", "Certificate expired", ["title"], "{{title}} has expired", "Please add your renewed certificate so it shows on your page again."),
    t("chef.new_review", "Chefs", "chef", "New review", ["rating"], "You have a new review", "A customer gave you {{rating}} out of 5 stars."),
    t("chef.allergens_check", "Chefs", "chef", "Check dish allergens", [], "Please check your dishes' allergens",
        "We now record all 14 allergens. Your dishes are off sale until you confirm each one under My dishes."),

    // ===== Payouts =====
    t("payout.invoice_ready", "Payouts", "chef", "Invoice ready to submit", ["invoiceNumber", "description", "amount", "percent", "tip"], "Invoice {{invoiceNumber}} is ready",
        "{{description}}: £{{amount}} after MYUKCHEF's {{percent}}% commission. Please check and submit it so we can pay you."),
    t("payout.paid", "Payouts", "chef", "Chef paid (receipt)", ["amount", "invoiceNumber", "method"], "You've been paid £{{amount}}",
        "MYUKCHEF has paid {{invoiceNumber}} {{method}}. Your receipt is ready."),
    t("payout.held", "Payouts", "chef", "Payout on hold", ["invoiceNumber", "reason"], "Payout for {{invoiceNumber}} on hold", "{{reason}}"),
    t("payout.released", "Payouts", "chef", "Payout released", ["invoiceNumber"], "Payout for {{invoiceNumber}} released", "It's on its way to being paid."),
    t("payout.cancelled", "Payouts", "chef", "Invoice cancelled", ["invoiceNumber", "reason"], "{{invoiceNumber}} cancelled", "{{reason}}"),
    t("payout.event_paid", "Payouts", "chef", "Event payout sent", ["amount", "eventName"], "Your payout has been sent", "MYUKCHEF has paid you £{{amount}} for {{eventName}}."),

    // ===== Team alerts (Super Admin) =====
    t("admin.plan_week_paid", "Team alerts", "admin", "Meal plan week paid", ["planId", "week", "amount", "chefName", "how"], "Meal plan #{{planId}}: week {{week}} paid", "£{{amount}} {{how}}. {{chefName}} has been told to cook."),
    t("admin.plan_week_unpaid", "Team alerts", "admin", "Meal plan week unpaid at cut-off", ["planId", "week", "amount"], "Meal plan #{{planId}}: week {{week}} unpaid", "£{{amount}} wasn't paid by the cut-off. The chef has been told to wait."),
    t("admin.event_chef_removed", "Team alerts", "admin", "Chef removed from a booking", ["eventName", "total"], "Chef removed from a booking", "The customer removed a chef from {{eventName}}. It now comes to £{{total}}."),
    t("admin.new_order", "Team alerts", "admin", "New order", ["orderId", "total", "paid"], "New Order Received!", "Order #{{orderId}} just came in for £{{total}}{{paid}}",
        { channels: { inApp: true, push: true, email: false, sms: false } }),
    t("admin.order_email", "Team alerts", "admin", "New order email", ["orderId", "total"], "New order #{{orderId}}: £{{total}}",
        "A new order has been placed. Open the Super Admin to see it.", { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
    t("admin.order_delivered", "Team alerts", "admin", "Chef delivered", ["orderId", "chefName", "amount"], "{{chefName}} delivered order #{{orderId}}",
        "The customer has been asked to confirm. {{chefName}}'s invoice for £{{amount}} follows once they do."),
    t("admin.order_confirmed", "Team alerts", "admin", "Delivery confirmed", ["orderId", "chefNames"], "Order #{{orderId}} delivery confirmed",
        "The customer confirmed they received their food from {{chefNames}}."),
    t("admin.order_problem", "Team alerts", "admin", "Problem reported", ["orderId", "chefNames", "issue"], "Problem reported on order #{{orderId}}", "From {{chefNames}}: {{issue}}"),
    t("admin.order_cancelled_by_customer", "Team alerts", "admin", "Customer cancelled", ["orderId", "total"], "Order #{{orderId}} cancelled by the customer", "The order was cancelled before cooking started."),
    t("admin.invoice_submitted", "Team alerts", "admin", "Invoice submitted", ["chefName", "invoiceNumber", "amount"], "Invoice {{invoiceNumber}} submitted",
        "{{chefName}} submitted {{invoiceNumber}} for £{{amount}}."),
    t("admin.pay_by_bank", "Team alerts", "admin", "Pay a chef by bank", ["chefName", "invoiceNumber", "amount", "reason"], "Pay {{chefName}} by bank transfer", "{{invoiceNumber}}, £{{amount}}: {{reason}}"),
    t("admin.chef_applied", "Team alerts", "admin", "New chef application", ["chefName"], "New chef application", "{{chefName}} has applied to join."),
    t("admin.dish_to_review", "Team alerts", "admin", "Dish to review", ["chefName", "dishName"], "New dish to review", "{{chefName}} added {{dishName}}."),
    t("admin.chef_details_updated", "Team alerts", "admin", "Chef details to check", ["chefName"], "Chef details to check", "{{chefName}} has updated their food safety and payout details."),
    t("admin.credential_to_check", "Team alerts", "admin", "Certificate to check", ["chefName", "title"], "Certificate to check", "{{chefName}} added or updated: {{title}}."),
    t("admin.event_booked", "Team alerts", "admin", "New event booking", ["eventName", "chefCount"], "New event booking", "{{eventName}} needs quotes from {{chefCount}} chef(s)."),
    t("admin.event_quotes_confirmed", "Team alerts", "admin", "Event quotes confirmed", ["eventName", "total"], "Quotes confirmed", "{{eventName}} is confirmed at £{{total}} and awaiting payment."),
    t("admin.event_payment_to_check", "Team alerts", "admin", "Event payment to check", ["eventName", "total", "reference"], "Payment to check",
        "The customer says they've paid £{{total}} for {{eventName}} (reference {{reference}})."),
    t("admin.support_message", "Team alerts", "admin", "New support message", ["name"], "New support message", "{{name}} has sent a message."),
    t("admin.support_email", "Team alerts", "admin", "Support message email", ["name", "email", "phone", "message"], "Support request from {{name}}",
        "Name: {{name}}\nEmail: {{email}}\nPhone: {{phone}}\n\n{{message}}", { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
    t("admin.error", "Team alerts", "admin", "Error alert", ["source", "message", "where"], "Something went wrong", "{{message}} ({{where}})"),
    t("admin.withdrawal_requested", "Team alerts", "admin", "Chef wallet withdrawal", ["chefName", "amount"], "Chef wallet withdrawal to pay",
        "{{chefName}} asked to withdraw £{{amount}} from their wallet.", { channels: ALL }),
    t("admin.delivery_code_locked", "Team alerts", "admin", "Delivery code locked", ["orderId"], "Order #{{orderId}}: delivery code locked",
        "Five wrong delivery codes were entered. Check with the customer, then let the order be completed without the code.", { channels: ALL }),
    t("admin.error_spike", "Team alerts", "admin", "Many errors at once", ["count", "minutes"], "Lots of errors right now",
        "{{count}} errors in the last {{minutes}} minutes. Open System health to see what's failing.", { channels: ALL }),
    t("admin.post_to_review", "Team alerts", "admin", "Chef video to check", ["chefName", "title"], "New chef video to check",
        "{{chefName}} shared \"{{title}}\". Check it's about food.", { channels: { inApp: true, push: true, email: false, sms: false } }),

    // ===== Wallet =====
    t("wallet.released", "Wallet", "customer", "Wallet credit released (customers and chefs)", ["amount", "reason", "balance"], "£{{amount}} is in your wallet",
        "{{reason}}. Your wallet now has £{{balance}}. Use it on your next order.", { channels: ALL }),
    t("wallet.withdrawal_paid", "Wallet", "chef", "Wallet withdrawal sent", ["amount", "method"], "£{{amount}} withdrawal sent",
        "We've sent £{{amount}} from your wallet {{method}}."),
    t("wallet.withdrawal_rejected", "Wallet", "chef", "Wallet withdrawal not paid", ["amount", "reason"], "Withdrawal not paid",
        "Your withdrawal of £{{amount}} wasn't paid: {{reason}}. The money is back in your wallet."),

    // ===== Chef videos =====
    t("post.new_video", "Chef videos", "customer", "New video from a chef you follow", ["chefName", "title"], "{{chefName}} shared a new video", "{{title}}",
        { channels: { inApp: true, push: true, email: false, sms: false } }),
    t("chef.post_comment", "Chef videos", "chef", "New comment on your video", ["name", "title", "preview"], "{{name}} commented on your video", "{{preview}}",
        { channels: { inApp: true, push: true, email: false, sms: false } }),
    t("chef.post_removed", "Chef videos", "chef", "Video removed", ["title", "reason"], "Your video was removed",
        "\"{{title}}\" was taken down: {{reason}}. Videos must be about your food and cooking. You can share another one now."),

    // ===== Weekly reports =====
    t("report.weekly_admin", "Weekly reports", "admin", "Weekly report for Super Admins", ["weekLabel", "orders", "revenue", "newCustomers", "errors"],
        "MYUKCHEF weekly report: {{weekLabel}}",
        "Here's how last week went.\n\n{{orders}} orders brought in £{{revenue}}, and {{newCustomers}} new customers joined. The server logged {{errors}} errors.\n\nThe full figures are below.",
        { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
    t("report.weekly_chef", "Weekly reports", "chef", "Weekly report for chefs", ["firstName", "weekLabel", "orders", "earnings", "rating", "newFollowers"],
        "Your MYUKCHEF week: {{weekLabel}}",
        "Hi {{firstName}},\n\nLast week you cooked {{orders}} orders and earned £{{earnings}}. Your rating is {{rating}}, and {{newFollowers}} new people followed you.\n\nThe full figures are below.",
        { channels: EMAIL_ONLY, unavailable: ["inApp", "push", "sms"] }),
];

export const TEMPLATE_MAP = new Map(TEMPLATES.map((d) => [d.key, d]));
