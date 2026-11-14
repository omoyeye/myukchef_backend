import { mysqlTable, serial, text, varchar, int, timestamp, boolean, json, double, primaryKey, date, unique, index } from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

export const users = mysqlTable("users", {
    id: int("id").autoincrement().primaryKey(),
    name: text("name").notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password: text("password").notNull(),
    role: text("role").default("customer").notNull(), // 'admin' | 'customer' | 'chef'
    points: int("points").default(0).notNull(),
    termsAcceptedAt: timestamp("terms_accepted_at"),
    // Set when the person clicks the link in their confirmation email.
    emailVerifiedAt: timestamp("email_verified_at"),
    // Refer a friend: each person's own code, who referred them, and when both were rewarded.
    // Built from the account number, so it is always unique. (Not a unique column: adding one to a
    // table that already has people in it makes the database tool offer to empty the table.)
    referralCode: varchar("referral_code", { length: 12 }),
    referredBy: int("referred_by"),
    referralRewardedAt: timestamp("referral_rewarded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ byReferral: index("users_referral_idx").on(t.referralCode) }));

/** One day's opening times, in UK time, as "HH:MM". */
export interface DayHours { open: boolean; from: string; to: string }
export type OpeningHours = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DayHours>>;

// === CHEF SYSTEM ===
export const chefs = mysqlTable("chefs", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull().unique(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    // A longer "about me" the chef writes for their public page.
    story: text("story"),
    // A short (up to one minute) video of the kitchen, so customers can see where their food is made.
    kitchenVideo: text("kitchen_video"),
    kitchenVideoUpdatedAt: timestamp("kitchen_video_updated_at"),
    // The chef's Stripe Connect account, so MYUKCHEF can pay them automatically.
    stripeAccountId: varchar("stripe_account_id", { length: 64 }),
    stripePayoutsEnabled: boolean("stripe_payouts_enabled").default(false).notNull(),
    specialty: text("specialty"),
    avatar: text("avatar"),
    coverImage: text("cover_image"),
    phone: text("phone"),
    location: text("location"),
    // Private: found from the location text. The public site only gets a blurred position.
    latitude: double("latitude"),
    longitude: double("longitude"),
    serviceRadiusMiles: int("service_radius_miles").default(15).notNull(),
    yearsExperience: int("years_experience"),
    status: text("status").default("pending").notNull(), // pending | approved | suspended | rejected
    rejectionReason: text("rejection_reason"),
    isAvailableForEvents: boolean("is_available_for_events").default(true).notNull(),
    eventRate: double("event_rate"),
    acceptsMealPlans: boolean("accepts_meal_plans").default(true).notNull(),
    // When the chef cooks one-off orders. Empty means any time.
    openingHours: json("opening_hours").$type<OpeningHours>(),
    // The chef's own switch to stop new one-off orders for now (holiday, too busy).
    ordersPaused: boolean("orders_paused").default(false).notNull(),
    // How much warning the chef needs before an order is due, unless a dish says otherwise.
    noticeHours: int("notice_hours").default(1).notNull(),
    // Set by an admin after checking the Food Standards Agency listing, never by the chef.
    hygieneRating: int("hygiene_rating"),
    agreementAcceptedAt: timestamp("agreement_accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    approvedAt: timestamp("approved_at"),
});

export const chefProducts = mysqlTable("chef_products", {
    id: varchar("id", { length: 255 }).primaryKey(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    price: double("price").notNull(),
    image: text("image").notNull(),
    category: text("category").notNull(),
    tags: json("tags").$type<string[]>().default([]),
    allergens: json("allergens").$type<string[]>().default([]),
    // True once the chef has confirmed the allergen list, so an empty list means "none".
    allergensDeclared: boolean("allergens_declared").default(false).notNull(),
    isVegetarian: boolean("is_vegetarian").default(false),
    isVegan: boolean("is_vegan").default(false),
    isGlutenFree: boolean("is_gluten_free").default(false),
    isHalal: boolean("is_halal").default(false),
    isPopular: boolean("is_popular").default(false),
    isSoldOut: boolean("is_sold_out").default(false),
    status: text("status").default("pending").notNull(), // pending | approved | rejected
    // Warning this dish needs, when it's more than the chef's usual (for example slow-cooked dishes).
    noticeHours: int("notice_hours"),
    calories: int("calories"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// === EVENT BOOKING ===
export const events = mysqlTable("events", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull(),
    chefId: int("chef_id").references(() => chefs.id),
    packageType: text("package_type").notNull(), // catering | catering_extras | private_chef
    eventName: text("event_name").notNull(),
    eventDate: timestamp("event_date").notNull(),
    eventTime: text("event_time").notNull(),
    headcount: int("headcount").notNull(),
    venue: text("venue").notNull(),
    contactPhone: text("contact_phone").notNull(),
    contactEmail: text("contact_email").notNull(),
    selectedItems: json("selected_items").$type<Array<{ id: string; name: string; quantity: number; price: number; type: 'product' | 'chef_product' }>>().default([]),
    extras: json("extras").$type<Array<{ key: string; label: string; price: number }>>().default([]),
    specialRequests: text("special_requests"),
    estimatedTotal: double("estimated_total").notNull(),
    // quoting | quotes_ready | awaiting_payment | confirmed (paid) | in_progress | completed | cancelled
    status: text("status").default("quoting").notNull(),
    adminNotes: text("admin_notes"),
    finalTotal: double("final_total"), // What the customer pays: the quotes they chose, added together
    paymentStatus: varchar("payment_status", { length: 20 }).default("unpaid").notNull(), // unpaid | submitted | paid | refunded
    paidAt: timestamp("paid_at"),
    // Set when the customer pays by card instead of bank transfer.
    stripeSessionId: varchar("stripe_session_id", { length: 255 }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export interface QuoteItem {
    id: string;
    name: string;
    image: string;
    quantity: number;
    allergens?: string[];
    guidePrice: number; // Menu price when requested
    unitPrice: number | null; // The chef's price
}

// One chef's part of an event. A booking gathers one of these for every chef the customer asked.
export const eventQuotes = mysqlTable("event_quotes", {
    id: int("id").autoincrement().primaryKey(),
    eventId: int("event_id").references(() => events.id, { onDelete: "cascade" }).notNull(),
    chefId: int("chef_id").references(() => chefs.id).notNull(),
    // requested | submitted | declined | accepted | not_selected
    status: varchar("status", { length: 20 }).default("requested").notNull(),
    preferences: text("preferences"),
    items: json("items").$type<QuoteItem[]>().default([]),
    serviceFee: double("service_fee").default(0).notNull(),
    total: double("total"),
    willAttend: varchar("will_attend", { length: 20 }), // yes | if_possible | no
    note: text("note"),
    submittedAt: timestamp("submitted_at"),
    attended: boolean("attended"),
    // Staff records of how MYUKCHEF shares out the customer's payment. Never sent to customers.
    commissionPercent: double("commission_percent"),
    payoutAmount: double("payout_amount"),
    payoutStatus: varchar("payout_status", { length: 20 }), // pending | paid | cancelled
    payoutPaidAt: timestamp("payout_paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ oneEach: unique("event_quote_unique").on(t.eventId, t.chefId) }));

export const eventQuoteMessages = mysqlTable("event_quote_messages", {
    id: int("id").autoincrement().primaryKey(),
    quoteId: int("quote_id").references(() => eventQuotes.id, { onDelete: "cascade" }).notNull(),
    senderId: int("sender_id").references(() => users.id).notNull(),
    senderRole: varchar("sender_role", { length: 20 }).notNull(), // customer | chef | admin
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const products = mysqlTable("products", {
    id: varchar("id", { length: 255 }).primaryKey(),
    // The chef who cooks this dish, shown on its menu card.
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    price: double("price").notNull(),
    image: text("image").notNull(),
    category: text("category").notNull(),
    tags: json("tags").$type<string[]>().default([]),
    allergens: json("allergens").$type<string[]>().default([]),
    // A dish isn't on sale until someone has confirmed its list against all 14 allergens.
    allergensDeclared: boolean("allergens_declared").default(false).notNull(),
    modifiers: json("modifiers").$type<any[]>().default([]),
    isVegetarian: boolean("is_vegetarian").default(false),
    isVegan: boolean("is_vegan").default(false),
    isGlutenFree: boolean("is_gluten_free").default(false),
    isHalal: boolean("is_halal").default(false),
    isPopular: boolean("is_popular").default(false),
    isSoldOut: boolean("is_sold_out").default(false),
    calories: int("calories"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const orders = mysqlTable("orders", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id),
    status: text("status").default("pending").notNull(), // pending, confirmed, preparing, ready, delivered, cancelled
    total: double("total").notNull(),
    deliveryAddress: json("delivery_address").notNull(),
    deliveryLat: double("delivery_lat"),
    deliveryLng: double("delivery_lng"),
    courierLat: double("courier_lat"),
    courierLng: double("courier_lng"),
    courierUpdatedAt: timestamp("courier_updated_at"),
    // Lets guests open their own tracking page without an account.
    trackingToken: varchar("tracking_token", { length: 64 }),
    // not_required (card payments not switched on) | awaiting | paid | refunded | failed
    paymentStatus: varchar("payment_status", { length: 20 }).default("not_required").notNull(),
    stripeSessionId: varchar("stripe_session_id", { length: 255 }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    paidAt: timestamp("paid_at"),
    refundedAt: timestamp("refunded_at"),
    // When the customer wants it delivered or ready to collect.
    scheduledFor: timestamp("scheduled_for"),
    // A tip for the chefs, on top of the total. It goes to them in full, with no commission.
    tipAmount: double("tip_amount").default(0).notNull(),
    cancelledBy: varchar("cancelled_by", { length: 20 }), // customer | admin | system
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ byCreated: index("orders_created_idx").on(t.createdAt) }));

export const orderItems = mysqlTable("order_items", {
    id: int("id").autoincrement().primaryKey(),
    orderId: int("order_id").references(() => orders.id).notNull(),
    // Exactly one of these is set: a dish from the main menu or from a partner chef.
    productId: varchar("product_id", { length: 255 }).references(() => products.id),
    chefProductId: varchar("chef_product_id", { length: 255 }).references(() => chefProducts.id, { onDelete: "set null" }),
    quantity: int("quantity").notNull(),
    price: double("price").notNull(), // Price at time of order
    selectedModifiers: json("selected_modifiers").$type<any[]>().default([]),
    specialInstructions: text("special_instructions"),
});

// Each chef moves their own part of an order through the kitchen. An order can hold dishes
// from several chefs, so each one has a stage here; the order follows the chef furthest behind.
export const orderChefProgress = mysqlTable("order_chef_progress", {
    id: int("id").autoincrement().primaryKey(),
    orderId: int("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).notNull(),
    status: varchar("status", { length: 20 }).default("received").notNull(), // received | preparing | delivery | completed
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // Evidence of fulfilment: the chef's photo of the handover, and the customer's own confirmation.
    deliveryProof: text("delivery_proof"),
    deliveredAt: timestamp("delivered_at"),
    customerConfirmedAt: timestamp("customer_confirmed_at"),
    customerIssue: text("customer_issue"),
    // Confirmed automatically when the customer neither confirms nor reports a problem in time.
    autoConfirmed: boolean("auto_confirmed").default(false).notNull(),
    // The chef's dishes at the prices paid, MYUKCHEF's commission, and what the chef receives.
    grossAmount: double("gross_amount"),
    commissionPercent: double("commission_percent"),
    // This chef's share of the customer's tip, paid in full on top of their sales.
    tipAmount: double("tip_amount").default(0).notNull(),
    payoutAmount: double("payout_amount"),
    payoutStatus: varchar("payout_status", { length: 20 }).default("pending").notNull(), // pending | paid
    paidAt: timestamp("paid_at"),
}, (t) => ({ oneEach: unique("order_chef_unique").on(t.orderId, t.chefId), byStatus: index("progress_status_idx").on(t.status, t.deliveredAt) }));

// An invoice MYUKCHEF raises for each delivered order part or attended event. The chef checks and
// submits it, MYUKCHEF pays them (automatically through Stripe where it can), and a receipt is issued.
export const chefInvoices = mysqlTable("chef_invoices", {
    id: int("id").autoincrement().primaryKey(),
    number: varchar("number", { length: 32 }).notNull().unique(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "restrict" }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(), // order | event
    // One invoice per delivered order part ("order:<progress id>") or attended event ("event:<quote id>").
    sourceKey: varchar("source_key", { length: 40 }).notNull().unique(),
    orderId: int("order_id").references(() => orders.id, { onDelete: "set null" }),
    progressId: int("progress_id").references(() => orderChefProgress.id, { onDelete: "set null" }),
    quoteId: int("quote_id"),
    description: varchar("description", { length: 255 }).notNull(),
    grossAmount: double("gross_amount").notNull(),
    commissionPercent: double("commission_percent").notNull(),
    commissionAmount: double("commission_amount").notNull(),
    // The part of the commission that is VAT, when MYUKCHEF is VAT registered (shown on the invoice).
    commissionVat: double("commission_vat").default(0).notNull(),
    // The customer's tip for this chef, added in full.
    tipAmount: double("tip_amount").default(0).notNull(),
    netAmount: double("net_amount").notNull(),
    // awaiting_chef | submitted | processing | paid | held | void
    status: varchar("status", { length: 20 }).default("awaiting_chef").notNull(),
    holdReason: text("hold_reason"),
    // The chef's details as they stood when the invoice was raised, so the record never changes.
    chefDetails: json("chef_details").$type<Record<string, string | null>>(),
    submittedAt: timestamp("submitted_at"),
    submittedName: varchar("submitted_name", { length: 150 }),
    paidAt: timestamp("paid_at"),
    payMethod: varchar("pay_method", { length: 20 }), // stripe | bank
    stripeTransferId: varchar("stripe_transfer_id", { length: 64 }),
    paidBy: int("paid_by").references(() => users.id, { onDelete: "set null" }),
    payoutError: text("payout_error"),
    receiptNumber: varchar("receipt_number", { length: 32 }).unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ byStatus: index("invoices_status_idx").on(t.status) }));

// Messages between a customer and one of the chefs cooking their order ("I'm outside", "no onions please").
export const orderMessages = mysqlTable("order_messages", {
    id: int("id").autoincrement().primaryKey(),
    orderId: int("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).notNull(),
    senderId: int("sender_id").references(() => users.id, { onDelete: "set null" }),
    senderRole: varchar("sender_role", { length: 10 }).notNull(), // customer | chef
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ byThread: index("order_messages_thread_idx").on(t.orderId, t.chefId, t.createdAt) }));

// Evidence a chef is trained and checked: food hygiene certificates, council registration, insurance,
// a DBS check. A Super Admin verifies each one; verified ones can show on the chef's public page.
export const chefCredentials = mysqlTable("chef_credentials", {
    id: int("id").autoincrement().primaryKey(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).notNull(),
    // food_hygiene | allergen_awareness | council_registration | hygiene_rating | insurance | dbs_check | other
    type: varchar("type", { length: 30 }).notNull(),
    title: varchar("title", { length: 150 }).notNull(),
    issuer: varchar("issuer", { length: 150 }),
    reference: varchar("reference", { length: 80 }),
    level: varchar("level", { length: 20 }),
    issuedOn: varchar("issued_on", { length: 10 }),
    expiresOn: varchar("expires_on", { length: 10 }),
    // A private file, only shown to the chef and Super Admins. Never used for DBS checks.
    document: varchar("document", { length: 255 }),
    status: varchar("status", { length: 20 }).default("pending").notNull(), // pending | verified | rejected | expired
    reviewNote: varchar("review_note", { length: 300 }),
    verifiedAt: timestamp("verified_at"),
    showOnProfile: boolean("show_on_profile").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ byStatus: index("credentials_status_idx").on(t.status) }));

export const passwordResetTokens = mysqlTable("password_reset_tokens", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    used: boolean("used").default(false).notNull(),
});

export const addresses = mysqlTable("addresses", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull(),
    name: text("name").notNull(), // e.g. "Home", "Work"
    street: text("street").notNull(),
    city: text("city").notNull(),
    postcode: text("postcode").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const reviews = mysqlTable("reviews", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull(),
    productId: varchar("product_id", { length: 255 }).references(() => products.id).notNull(),
    rating: int("rating").notNull(), // 1-5
    comment: text("comment"),
    status: text("status").default("approved").notNull(), // approved | rejected. Only hide abusive, unlawful or non-genuine reviews.
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
    orders: many(orders),
    addresses: many(addresses),
    reviews: many(reviews),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
    user: one(users, {
        fields: [orders.userId],
        references: [users.id],
    }),
    items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
    order: one(orders, {
        fields: [orderItems.orderId],
        references: [orders.id],
    }),
    product: one(products, {
        fields: [orderItems.productId],
        references: [products.id],
    }),
    chefProduct: one(chefProducts, {
        fields: [orderItems.chefProductId],
        references: [chefProducts.id],
    }),
}));

export const addressesRelations = relations(addresses, ({ one }) => ({
    user: one(users, {
        fields: [addresses.userId],
        references: [users.id],
    }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
    user: one(users, {
        fields: [reviews.userId],
        references: [users.id],
    }),
    product: one(products, {
        fields: [reviews.productId],
        references: [products.id],
    }),
}));

export const productsRelations = relations(products, ({ many }) => ({
    reviews: many(reviews),
}));

export const discounts = mysqlTable("discounts", {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 255 }).notNull().unique(),
    type: text("type").notNull(), // 'percentage' | 'fixed'
    value: double("value").notNull(),
    minOrderAmount: double("min_order_amount").default(0),
    isFirstOrderOnly: boolean("is_first_order_only").default(false),
    isActive: boolean("is_active").default(true),
    expiryDate: timestamp("expiry_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const siteSettings = mysqlTable("site_settings", {
    id: int("id").autoincrement().primaryKey(),
    key: varchar("key", { length: 255 }).notNull().unique(), // e.g. 'store_info', 'operational_status', 'delivery_config', 'loyalty_config'
    value: json("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** A Super Admin's version of a message template. Anything left empty uses the default wording. */
export interface TemplateOverride {
    channels?: Partial<Record<"inApp" | "push" | "email" | "sms", boolean>>;
    title?: string;
    body?: string;
    pushTitle?: string;
    pushBody?: string;
    emailSubject?: string;
    emailBody?: string;
    sms?: string;
}

// The Super Admin's changes to message templates (see src/lib/templates/registry.ts for the defaults).
export const notificationTemplates = mysqlTable("notification_templates", {
    id: int("id").autoincrement().primaryKey(),
    key: varchar("key", { length: 64 }).notNull().unique(),
    value: json("value").$type<TemplateOverride>().notNull(),
    updatedBy: int("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Keys for outside services (Stripe, Brevo) that Super Admins manage. Values are encrypted.
export const integrationSettings = mysqlTable("integration_settings", {
    id: int("id").autoincrement().primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull().unique(),
    value: text("value").notNull(),
    updatedBy: int("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const notifications = mysqlTable("notifications", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id), // Nullable for admin or generic alerts
    type: text("type").notNull(), // 'order_placed', 'status_update', 'welcome', 'admin_alert'
    title: text("title").notNull(),
    message: text("message").notNull(),
    link: text("link"), // Optional link to a page (e.g. /order-tracker/123)
    isRead: boolean("is_read").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ byUser: index("notifications_user_idx").on(t.userId, t.createdAt) }));

export const notificationsRelations = relations(notifications, ({ one }) => ({
    user: one(users, {
        fields: [notifications.userId],
        references: [users.id],
    }),
}));

// === CHEF / EVENT RELATIONS ===
export const chefsRelations = relations(chefs, ({ one, many }) => ({
    user: one(users, { fields: [chefs.userId], references: [users.id] }),
    products: many(chefProducts),
    events: many(events),
}));

export const chefProductsRelations = relations(chefProducts, ({ one }) => ({
    chef: one(chefs, { fields: [chefProducts.chefId], references: [chefs.id] }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
    user: one(users, { fields: [events.userId], references: [users.id] }),
    chef: one(chefs, { fields: [events.chefId], references: [chefs.id] }),
}));

// === MEAL PLANS ===
export interface PlanDish {
    dishId: string;
    name: string;
    image: string;
    price: number; // Per portion, fixed when the dish was chosen
    allergens?: string[];
    meals: number; // How many of this week's meals are this dish
}

export const mealPlans = mysqlTable("meal_plans", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull(),
    chefId: int("chef_id").references(() => chefs.id).notNull(),
    durationMonths: int("duration_months").notNull(), // 1 | 3 | 6
    mealsPerWeek: int("meals_per_week").notNull(),
    servings: int("servings").notNull(),
    deliveryWindow: varchar("delivery_window", { length: 20 }).default("afternoon").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    // requested | active | paused | completed | cancelled | declined | expired
    status: varchar("status", { length: 20 }).default("requested").notNull(),
    pausedUntil: date("paused_until", { mode: "string" }),
    discountPercent: double("discount_percent").default(0).notNull(),
    deliveryFee: double("delivery_fee").default(0).notNull(),
    dietary: json("dietary").$type<string[]>().default([]),
    avoidAllergens: json("avoid_allergens").$type<string[]>().default([]),
    healthConsentAt: timestamp("health_consent_at"), // Agreement to use dietary and allergy details
    requests: text("requests"), // Anything the customer wants that isn't on the chef's menu
    rotation: json("rotation").$type<string[]>().default([]),
    deliveryAddress: json("delivery_address").$type<{ street: string; city: string; postcode: string; phone: string }>().notNull(),
    chefNote: text("chef_note"),
    adminNotes: text("admin_notes"),
    cancelReason: text("cancel_reason"),
    renewedFromId: int("renewed_from_id"),
    endingReminderSent: boolean("ending_reminder_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const mealPlanWeeks = mysqlTable("meal_plan_weeks", {
    id: int("id").autoincrement().primaryKey(),
    planId: int("plan_id").references(() => mealPlans.id, { onDelete: "cascade" }).notNull(),
    weekNumber: int("week_number").notNull(),
    deliveryDate: date("delivery_date", { mode: "string" }).notNull(),
    // scheduled | skipped | paused | preparing | out_for_delivery | delivered | missed | cancelled
    status: varchar("status", { length: 20 }).default("scheduled").notNull(),
    items: json("items").$type<PlanDish[]>().default([]),
    note: text("note"),
    subtotal: double("subtotal").default(0).notNull(),
    discount: double("discount").default(0).notNull(),
    deliveryFee: double("delivery_fee").default(0).notNull(),
    total: double("total").default(0).notNull(),
    isPaid: boolean("is_paid").default(false).notNull(),
    // Set when the customer pays this delivery by card.
    stripeSessionId: varchar("stripe_session_id", { length: 255 }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    paidAt: timestamp("paid_at"),
    lockReminderSent: boolean("lock_reminder_sent").default(false).notNull(),
}, (t) => ({ planWeek: unique("plan_week_unique").on(t.planId, t.weekNumber) }));

export const mealPlanMessages = mysqlTable("meal_plan_messages", {
    id: int("id").autoincrement().primaryKey(),
    planId: int("plan_id").references(() => mealPlans.id, { onDelete: "cascade" }).notNull(),
    senderId: int("sender_id").references(() => users.id).notNull(),
    senderRole: varchar("sender_role", { length: 20 }).notNull(), // customer | chef | admin
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// === CHEF RATINGS ===
// One review per customer per chef, and only from someone the chef has actually cooked for.
export const chefReviews = mysqlTable("chef_reviews", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id).notNull(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).notNull(),
    rating: int("rating").notNull(), // 1-5
    tasteRating: int("taste_rating"),
    reliabilityRating: int("reliability_rating"),
    valueRating: int("value_rating"),
    comment: text("comment"),
    tags: json("tags").$type<string[]>().default([]),
    source: varchar("source", { length: 20 }).notNull(), // meal_plan | order | event
    status: varchar("status", { length: 20 }).default("published").notNull(), // published | hidden
    chefReply: text("chef_reply"),
    chefRepliedAt: timestamp("chef_replied_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({ oneEach: unique("chef_review_unique").on(t.userId, t.chefId) }));

export const favouriteChefs = mysqlTable("favourite_chefs", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ oneEach: unique("favourite_chef_unique").on(t.userId, t.chefId) }));

// === NOTIFICATIONS AND SUPPORT ===
export const notificationPreferences = mysqlTable("notification_preferences", {
    userId: int("user_id").references(() => users.id, { onDelete: "cascade" }).primaryKey(),
    emailUpdates: boolean("email_updates").default(true).notNull(),
    emailMessages: boolean("email_messages").default(true).notNull(),
});

// One row per browser or installed app that has agreed to push notifications.
export const pushSubscriptions = mysqlTable("push_subscriptions", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    endpoint: varchar("endpoint", { length: 700 }).notNull().unique(),
    p256dh: varchar("p256dh", { length: 255 }).notNull(),
    auth: varchar("auth", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Phones running the MYUKCHEF app. Expo hands each install a token that reaches Apple or Google push.
export const mobilePushTokens = mysqlTable("mobile_push_tokens", {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    token: varchar("token", { length: 255 }).notNull().unique(),
    platform: varchar("platform", { length: 20 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const supportMessages = mysqlTable("support_messages", {
    id: int("id").autoincrement().primaryKey(),
    name: text("name").notNull(),
    email: varchar("email", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 30 }).notNull(),
    message: text("message").notNull(),
    status: varchar("status", { length: 20 }).default("open").notNull(), // open | closed
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// === CHEF COMPLIANCE ===
// Private records for food safety, HMRC seller reporting and payouts. Never sent to the public site.
export const chefCompliance = mysqlTable("chef_compliance", {
    chefId: int("chef_id").references(() => chefs.id, { onDelete: "cascade" }).primaryKey(),
    legalName: varchar("legal_name", { length: 200 }),
    dateOfBirth: varchar("date_of_birth", { length: 10 }),
    addressLine: varchar("address_line", { length: 300 }),
    city: varchar("city", { length: 120 }),
    postcode: varchar("postcode", { length: 12 }),
    taxReference: varchar("tax_reference", { length: 40 }),
    localAuthority: varchar("local_authority", { length: 150 }),
    registeredOn: varchar("registered_on", { length: 10 }),
    hygieneCertificate: varchar("hygiene_certificate", { length: 200 }),
    insurance: varchar("insurance", { length: 200 }),
    bankAccountName: varchar("bank_account_name", { length: 150 }),
    bankSortCode: varchar("bank_sort_code", { length: 10 }),
    bankAccountNumber: varchar("bank_account_number", { length: 12 }),
    verifiedAt: timestamp("verified_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
