// Unit tests for the business rules that don't need a database. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableSlots, cleanOpeningHours, isOpenAt, problemWith, ukTime, type ChefTimes } from "../../src/lib/availability";
import { hasContactDetails, redactContactDetails } from "../../src/lib/contactGuard";
import { calculateTotals, cleanTiers, tierFor } from "../../src/lib/pricing";
import { filterDishes, pageOf } from "../../src/lib/search";

// A Wednesday at 15:00 UK time (winter, so UK time is UTC).
const WED_3PM = new Date("2026-11-18T15:00:00Z");

const chef = (over: Partial<ChefTimes> = {}): ChefTimes => ({ id: 1, displayName: "Amara", openingHours: null, ordersPaused: false, noticeHours: 1, ...over });

describe("UK time", () => {
    it("reads the UK weekday and time", () => {
        assert.deepEqual(ukTime(WED_3PM), { day: "wed", minutes: 15 * 60, date: "2026-11-18" });
    });
    it("handles British Summer Time", () => {
        // 11:30 UTC in July is 12:30 in the UK.
        assert.equal(ukTime(new Date("2026-07-01T11:30:00Z")).minutes, 12 * 60 + 30);
    });
});

describe("Chef opening hours", () => {
    const hours = cleanOpeningHours({ wed: { open: true, from: "17:00", to: "21:00" }, thu: { open: false } })!;
    it("is open inside the hours and closed outside", () => {
        assert.equal(isOpenAt({ openingHours: hours }, new Date("2026-11-18T18:00:00Z")), true);
        assert.equal(isOpenAt({ openingHours: hours }, new Date("2026-11-18T12:00:00Z")), false);
        assert.equal(isOpenAt({ openingHours: hours }, new Date("2026-11-19T18:00:00Z")), false);
    });
    it("treats no hours as always open", () => {
        assert.equal(isOpenAt({ openingHours: null }, WED_3PM), true);
    });
    it("refuses a closing time before the opening time", () => {
        assert.throws(() => cleanOpeningHours({ mon: { open: true, from: "20:00", to: "09:00" } }), /closing time/);
    });
    it("explains why a time doesn't work", () => {
        assert.match(problemWith(chef({ ordersPaused: true }), WED_3PM, 1, WED_3PM)!, /isn't taking orders/);
        assert.match(problemWith(chef(), new Date(WED_3PM.getTime() + 30 * 60_000), 1, WED_3PM)!, /notice/);
        assert.match(problemWith(chef({ openingHours: hours }), new Date("2026-11-18T23:00:00Z"), 1, WED_3PM)!, /doesn't cook/);
        assert.equal(problemWith(chef({ openingHours: hours }), new Date("2026-11-18T18:00:00Z"), 1, WED_3PM), null);
    });
});

describe("Delivery slots for a basket", () => {
    it("starts after the longest notice and only when every chef is open", () => {
        const a = { chef: chef({ id: 1, openingHours: cleanOpeningHours({ wed: { open: true, from: "16:00", to: "20:00" } }) }), noticeHours: 1 };
        const b = { chef: chef({ id: 2, openingHours: cleanOpeningHours({ wed: { open: true, from: "18:00", to: "22:00" } }) }), noticeHours: 2 };
        const { slots } = availableSlots([a, b], WED_3PM);
        assert.equal(slots[0], "2026-11-18T18:00:00.000Z");
        assert.equal(slots.at(-1), "2026-11-25T20:00:00.000Z", "next Wednesday too, within two weeks");
        assert.ok(slots.every((s) => { const m = ukTime(new Date(s)).minutes; return m >= 18 * 60 && m <= 20 * 60; }));
    });
    it("has nothing when a chef is paused", () => {
        const { slots, reason } = availableSlots([{ chef: chef({ ordersPaused: true }), noticeHours: 1 }], WED_3PM);
        assert.equal(slots.length, 0);
        assert.match(reason!, /isn't taking orders/);
    });
});

describe("Delivery price bands", () => {
    const tiers = cleanTiers([{ minOrder: 50, fee: 0, note: "By van" }, { minOrder: 20, fee: 2.5 }, { minOrder: -1, fee: 1 }, { minOrder: 20, fee: 9 }, { minOrder: 10, fee: 999 }]);
    it("keeps sensible bands, lowest first, one per amount", () => {
        assert.deepEqual(tiers, [{ minOrder: 20, fee: 2.5 }, { minOrder: 50, fee: 0, note: "By van" }]);
    });
    it("picks the highest band an order reaches", () => {
        assert.equal(tierFor(19.99, tiers), null);
        assert.equal(tierFor(20, tiers)?.fee, 2.5);
        assert.equal(tierFor(80, tiers)?.fee, 0);
    });
    it("prices orders with bands, free delivery and collection", () => {
        const delivery = { fee: 4, serviceFeePercent: 10, freeOver: 0, tiers };
        assert.equal(calculateTotals(10, "delivery", delivery).total, 15);
        assert.equal(calculateTotals(30, "delivery", delivery).total, 35.5);
        assert.equal(calculateTotals(60, "delivery", delivery).total, 66);
        assert.equal(calculateTotals(10, "pickup", delivery).total, 11);
        assert.equal(calculateTotals(10, "delivery", delivery, { type: "fixed", value: 20 }).total, 5, "a discount never goes below the food");
    });
});

describe("Dish search", () => {
    const dishes = [
        { name: "Jollof rice", description: "Smoky", category: "mains", price: 12, tags: ["spicy"], isVegan: true, chef: { id: 1, displayName: "Amara", openNow: true } },
        { name: "Tiramisu", description: "Coffee", category: "desserts", price: 6, tags: [], isVegetarian: true, chef: { id: 2, displayName: "Leo", openNow: false } },
        { name: "Chicken curry", description: "Mild", category: "mains", price: 14, tags: [], isHalal: true, chef: { id: 1, displayName: "Amara", openNow: true } },
    ];
    it("matches words in any order, across dish and chef", () => {
        assert.deepEqual(filterDishes(dishes, { q: "amara curry" }).map((d) => d.name), ["Chicken curry"]);
    });
    it("filters by diet, price, chef and who's open", () => {
        assert.deepEqual(filterDishes(dishes, { diet: "vegetarian" }).map((d) => d.name), ["Jollof rice", "Tiramisu"]);
        assert.deepEqual(filterDishes(dishes, { maxPrice: "12" }).map((d) => d.name), ["Jollof rice", "Tiramisu"]);
        assert.deepEqual(filterDishes(dishes, { openNow: "1" }).map((d) => d.name), ["Jollof rice", "Chicken curry"]);
        assert.equal(filterDishes(dishes, { chef: "2" }).length, 1);
    });
    it("sorts and pages", () => {
        assert.deepEqual(filterDishes(dishes, { sort: "price" }).map((d) => d.price), [6, 12, 14]);
        assert.deepEqual(pageOf([1, 2, 3, 4, 5], { page: "2", limit: "2" }), [3, 4]);
        assert.deepEqual(pageOf([1, 2, 3], {}), [1, 2, 3], "no page means everything");
    });
});

describe("Contact details stay on MYUKCHEF", () => {
    it("spots phone numbers, emails and links", () => {
        assert.equal(hasContactDetails("Call me on 07123 456789"), true);
        assert.equal(hasContactDetails("email me at amara@example.com"), true);
        assert.equal(hasContactDetails("see www.example.com"), true);
        assert.equal(hasContactDetails("No onions please, flat 2"), false);
    });
    it("removes them from messages", () => {
        assert.doesNotMatch(redactContactDetails("ring 07123456789 when outside")!, /07123456789/);
    });
});
