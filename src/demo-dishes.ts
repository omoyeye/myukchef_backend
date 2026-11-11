// Sample dishes for local testing only: `npm run db:seed -- --demo`. Not for the live site.
const image = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80`;

export const demoDishes = [
    { allergensDeclared: true, id: "demo-roast-chicken", name: "Herb Roast Chicken", description: "Free-range chicken roasted with lemon, thyme and garlic, served with seasonal greens.", price: 14.5, category: "mains", image: image("1604329760661-e71dc83f8f26"), tags: ["savory", "comfort"], allergens: [], isHalal: true, isGlutenFree: true, isPopular: true, modifiers: [{ id: "extra-greens", name: "Extra greens", price: 2.5, type: "add" }], calories: 620 },
    { allergensDeclared: true, id: "demo-grilled-skewers", name: "Spiced Beef Skewers", description: "Chargrilled beef skewers with a smoky spice rub and fresh onion salad.", price: 13, category: "mains", image: image("1555939594-58d7cb561ad1"), tags: ["spicy", "savory"], allergens: ["peanuts", "tree_nuts"], isHalal: true, isGlutenFree: true, isPopular: true, modifiers: [], calories: 480 },
    { allergensDeclared: true, id: "demo-veg-bowl", name: "Garden Power Bowl", description: "Roasted vegetables, herby grains, avocado and a bright lemon dressing.", price: 11.5, category: "mains", image: image("1512058564366-18510be2db19"), tags: ["healthy"], allergens: [], isVegan: true, isVegetarian: true, isGlutenFree: true, isPopular: true, modifiers: [], calories: 430 },
    { allergensDeclared: true, id: "demo-fish-stew", name: "Coastal Fish Stew", description: "Fresh white fish and tomatoes, slow-simmered with fennel and saffron.", price: 15, category: "mains", image: image("1504674900247-0877df9cc836"), tags: ["comfort"], allergens: ["fish"], isGlutenFree: true, modifiers: [], calories: 540 },
    { allergensDeclared: true, id: "demo-garlic-greens", name: "Garlic Greens", description: "Tenderstem broccoli and kale, tossed with garlic and chilli oil.", price: 4.5, category: "sides", image: image("1512058564366-18510be2db19"), tags: ["healthy"], allergens: [], isVegan: true, isVegetarian: true, isGlutenFree: true, modifiers: [], calories: 150 },
    { allergensDeclared: true, id: "demo-flatbread", name: "Warm Flatbread", description: "Freshly baked flatbread brushed with olive oil and sea salt.", price: 3.5, category: "sides", image: image("1504674900247-0877df9cc836"), tags: ["comfort"], allergens: ["gluten"], isVegan: true, isVegetarian: true, modifiers: [], calories: 220 },
    { allergensDeclared: true, id: "demo-ginger-lemonade", name: "Ginger Lemonade", description: "House-made sparkling lemonade with fresh ginger.", price: 3, category: "drinks", image: image("1512058564366-18510be2db19"), tags: ["sweet"], allergens: [], isVegan: true, isVegetarian: true, isGlutenFree: true, modifiers: [], calories: 90 },
    { allergensDeclared: true, id: "demo-chocolate-pot", name: "Dark Chocolate Pot", description: "Rich dark chocolate custard with a touch of sea salt.", price: 5.5, category: "desserts", image: image("1504674900247-0877df9cc836"), tags: ["sweet"], allergens: ["milk", "eggs"], isVegetarian: true, isGlutenFree: true, modifiers: [], calories: 340 },
];

// Who cooks each sample menu dish.
export const demoDishChefs: Record<string, string> = {
    "demo-roast-chicken": "demo.chef.amara@example.com",
    "demo-grilled-skewers": "demo.chef.amara@example.com",
    "demo-veg-bowl": "demo.chef.priya@example.com",
    "demo-garlic-greens": "demo.chef.priya@example.com",
    "demo-ginger-lemonade": "demo.chef.priya@example.com",
    "demo-fish-stew": "demo.chef.leo@example.com",
    "demo-flatbread": "demo.chef.leo@example.com",
    "demo-chocolate-pot": "demo.chef.leo@example.com",
};

// Sample chefs for local testing. Their dishes use the same placeholder photos.
const chefDish = (id: string, name: string, description: string, price: number, photo: string, flags: Record<string, boolean>, allergens: string[], calories: number) => ({
    id, name, description, price, image: image(photo), category: "mains", tags: [], allergens, allergensDeclared: true, ...flags, status: "approved", calories,
});

export const demoChefs = [
    {
        email: "demo.chef.amara@example.com",
        displayName: "Amara Okafor",
        specialty: "West African home cooking",
        bio: "Slow-cooked stews, smoky jollof and big flavours, made the way my family has always made them. I batch-cook fresh for the week and label everything clearly.",
        location: "Peckham, London",
        latitude: 51.4735, longitude: -0.0691, serviceRadiusMiles: 12, yearsExperience: 11, eventRate: 220, hygieneRating: 5,
        dishes: [
            chefDish("demo-amara-jollof", "Smoky Jollof with Chicken", "Party-style jollof rice with grilled thigh and sweet plantain.", 11.5, "1604329760661-e71dc83f8f26", { isHalal: true, isGlutenFree: true }, [], 720),
            chefDish("demo-amara-egusi", "Egusi Stew with Greens", "Rich melon-seed stew with spinach and tender beef.", 12.5, "1555939594-58d7cb561ad1", { isHalal: true, isGlutenFree: true }, ["fish"], 640),
            chefDish("demo-amara-beans", "Honey Beans and Plantain", "Slow-simmered beans in palm oil with fried plantain.", 9.5, "1512058564366-18510be2db19", { isVegan: true, isVegetarian: true, isGlutenFree: true, isHalal: true }, [], 560),
            chefDish("demo-amara-suya", "Suya Beef Rice Bowl", "Peanut-spiced beef, coconut rice and pickled onions.", 12, "1504674900247-0877df9cc836", { isHalal: true, isGlutenFree: true }, ["peanuts"], 690),
        ],
    },
    {
        email: "demo.chef.leo@example.com",
        displayName: "Leo Marchetti",
        specialty: "Italian comfort food",
        bio: "Fresh pasta, long-simmered ragù and honest sauces. Ten years in restaurant kitchens, now cooking for families across south London.",
        location: "Clapham, London",
        latitude: 51.4622, longitude: -0.1381, serviceRadiusMiles: 10, yearsExperience: 10, eventRate: 260, hygieneRating: 5,
        dishes: [
            chefDish("demo-leo-ragu", "Beef Ragù Tagliatelle", "Eight-hour beef ragù with fresh egg pasta.", 13, "1555939594-58d7cb561ad1", {}, ["gluten", "eggs", "milk"], 780),
            chefDish("demo-leo-aubergine", "Aubergine Parmigiana", "Layers of aubergine, tomato and melting mozzarella.", 11, "1512058564366-18510be2db19", { isVegetarian: true, isGlutenFree: true }, ["milk"], 610),
            chefDish("demo-leo-fish", "Lemon Baked Cod", "Cod with lemon, capers and crushed new potatoes.", 14, "1504674900247-0877df9cc836", { isGlutenFree: true }, ["fish"], 520),
        ],
    },
    {
        email: "demo.chef.priya@example.com",
        displayName: "Priya Nair",
        specialty: "Plant-based South Indian",
        bio: "Vibrant vegan curries, dals and dosas, full of fresh spice and good for you. Every dish is plant-based and made without nuts.",
        location: "Croydon, London",
        latitude: 51.3762, longitude: -0.0982, serviceRadiusMiles: 15, yearsExperience: 7, eventRate: 180, hygieneRating: 4,
        dishes: [
            chefDish("demo-priya-dal", "Coconut Tarka Dal", "Red lentils with coconut, curry leaves and basmati rice.", 9, "1512058564366-18510be2db19", { isVegan: true, isVegetarian: true, isGlutenFree: true, isHalal: true }, [], 540),
            chefDish("demo-priya-chana", "Kerala Chickpea Curry", "Chickpeas in roasted coconut masala with lemon rice.", 9.5, "1504674900247-0877df9cc836", { isVegan: true, isVegetarian: true, isGlutenFree: true, isHalal: true }, [], 590),
            chefDish("demo-priya-veg", "Roasted Veg Thali", "Three seasonal vegetable curries, rice and sambar.", 11.5, "1555939594-58d7cb561ad1", { isVegan: true, isVegetarian: true, isGlutenFree: true, isHalal: true }, [], 650),
            chefDish("demo-priya-dosa", "Masala Dosa Box", "Crisp rice pancakes with spiced potato and chutney.", 10, "1604329760661-e71dc83f8f26", { isVegan: true, isVegetarian: true, isGlutenFree: true, isHalal: true }, [], 480),
        ],
    },
];
