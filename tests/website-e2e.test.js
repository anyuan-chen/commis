/**
 * End-to-end website generation test
 * Run with: node --env-file=.env tests/website-e2e.test.js
 */

import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel } from '../src/db/models/index.js';
import { WebsiteGenerator } from '../src/services/website-generator.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { config } from '../src/config.js';

const TEST_RESTAURANT = {
  name: "Mama Rosa's Trattoria",
  tagline: "Authentic Italian cuisine since 1985",
  description: "A cozy family-owned Italian restaurant serving traditional recipes passed down through generations. Our handmade pasta and wood-fired pizzas transport you straight to Naples.",
  cuisineType: "Italian",
  address: "123 Main Street, San Francisco, CA 94102",
  phone: "(415) 555-0123",
  email: "ciao@mamarosas.com",
  hours: {
    monday: "11am - 9pm",
    tuesday: "11am - 9pm",
    wednesday: "11am - 9pm",
    thursday: "11am - 10pm",
    friday: "11am - 11pm",
    saturday: "10am - 11pm",
    sunday: "10am - 9pm"
  },
  styleTheme: "rustic",
  primaryColor: "#8B4513"
};

const TEST_MENU = [
  {
    name: "Antipasti",
    items: [
      { name: "Bruschetta al Pomodoro", description: "Toasted bread with fresh tomatoes, basil, garlic, and olive oil", price: 12 },
      { name: "Calamari Fritti", description: "Crispy fried calamari with marinara sauce", price: 16 },
      { name: "Burrata", description: "Creamy burrata with prosciutto and fig jam", price: 18 }
    ]
  },
  {
    name: "Pasta",
    items: [
      { name: "Spaghetti Carbonara", description: "Classic Roman pasta with egg, pecorino, guanciale, and black pepper", price: 22 },
      { name: "Fettuccine Alfredo", description: "Fresh fettuccine in creamy parmesan sauce", price: 20 },
      { name: "Penne Arrabbiata", description: "Penne with spicy tomato sauce and fresh basil", price: 18 },
      { name: "Lasagna della Nonna", description: "Grandma's recipe with beef ragù and béchamel", price: 24 }
    ]
  },
  {
    name: "Pizza",
    items: [
      { name: "Margherita", description: "San Marzano tomatoes, fresh mozzarella, basil", price: 18 },
      { name: "Quattro Formaggi", description: "Mozzarella, gorgonzola, fontina, parmesan", price: 22 },
      { name: "Diavola", description: "Spicy salami, chili flakes, mozzarella", price: 20 }
    ]
  },
  {
    name: "Dolci",
    items: [
      { name: "Tiramisu", description: "Classic espresso-soaked ladyfingers with mascarpone", price: 10 },
      { name: "Panna Cotta", description: "Vanilla cream with berry compote", price: 9 },
      { name: "Cannoli", description: "Crispy shells filled with sweet ricotta", price: 8 }
    ]
  }
];

async function runTest() {
  console.log("🍝 Starting end-to-end website generation test\n");

  let restaurantId = null;

  try {
    // Step 1: Create restaurant
    console.log("1️⃣  Creating restaurant in database...");
    const restaurant = RestaurantModel.create({
      name: TEST_RESTAURANT.name,
      tagline: TEST_RESTAURANT.tagline,
      description: TEST_RESTAURANT.description,
      cuisineType: TEST_RESTAURANT.cuisineType,
      address: TEST_RESTAURANT.address,
      phone: TEST_RESTAURANT.phone,
      email: TEST_RESTAURANT.email,
      hours: TEST_RESTAURANT.hours,
      styleTheme: TEST_RESTAURANT.styleTheme,
      primaryColor: TEST_RESTAURANT.primaryColor
    });
    restaurantId = restaurant.id;
    console.log(`   ✓ Created restaurant: ${restaurant.name} (${restaurantId})\n`);

    // Step 2: Add menu categories and items
    console.log("2️⃣  Adding menu items...");
    let totalItems = 0;
    for (const category of TEST_MENU) {
      const cat = MenuCategoryModel.create(restaurantId, {
        name: category.name,
        displayOrder: TEST_MENU.indexOf(category)
      });

      for (const item of category.items) {
        MenuItemModel.create(cat.id, {
          name: item.name,
          description: item.description,
          price: item.price,
          displayOrder: category.items.indexOf(item)
        });
        totalItems++;
      }
    }
    console.log(`   ✓ Added ${TEST_MENU.length} categories, ${totalItems} items\n`);

    // Step 3: Verify data
    console.log("3️⃣  Verifying restaurant data...");
    const fullData = RestaurantModel.getFullData(restaurantId);
    console.log(`   ✓ Restaurant: ${fullData.name}`);
    console.log(`   ✓ Cuisine: ${fullData.cuisine_type}`);
    console.log(`   ✓ Menu categories: ${fullData.menu.length}`);
    console.log(`   ✓ Total menu items: ${fullData.menu.reduce((sum, cat) => sum + cat.items.length, 0)}\n`);

    // Step 4: Generate website
    console.log("4️⃣  Generating website with Gemini...");
    const generator = new WebsiteGenerator();
    const startTime = Date.now();
    const result = await generator.generate(restaurantId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✓ Website generated in ${duration}s`);
    console.log(`   ✓ Output: ${result.path}\n`);

    // Step 5: Verify output
    console.log("5️⃣  Verifying generated website...");
    const htmlPath = join(result.path, 'index.html');
    const html = await fs.readFile(htmlPath, 'utf-8');

    const checks = [
      { name: "Has DOCTYPE", test: html.includes('<!DOCTYPE html') },
      { name: "Has restaurant name", test: html.includes(TEST_RESTAURANT.name) || html.includes("Mama Rosa") },
      { name: "Has phone number", test: html.includes(TEST_RESTAURANT.phone) || html.includes("555-0123") },
      { name: "Has menu items", test: html.includes("Carbonara") || html.includes("Margherita") },
      { name: "Has prices", test: html.includes("$") || html.includes("22") || html.includes("18") },
      { name: "Has cart button", test: html.includes("cart-fab") },
      { name: "Has cart panel", test: html.includes("cart-panel") },
      { name: "Has checkout function", test: html.includes("checkout()") },
      { name: "Has Stripe script", test: html.includes("stripe.com") },
      { name: "Has add-to-cart buttons", test: html.includes("add-to-cart-btn") },
      { name: "Has animation CSS", test: html.includes("animate-fade-up") || html.includes("animate-hero") },
      { name: "Has responsive meta", test: html.includes("viewport") },
    ];

    let passed = 0;
    for (const check of checks) {
      const status = check.test ? "✓" : "✗";
      console.log(`   ${status} ${check.name}`);
      if (check.test) passed++;
    }

    console.log(`\n   Results: ${passed}/${checks.length} checks passed\n`);

    // Step 6: Show file size
    const stats = await fs.stat(htmlPath);
    console.log(`6️⃣  File stats:`);
    console.log(`   ✓ Size: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`   ✓ Lines: ${html.split('\n').length}`);

    // Show snippet
    console.log(`\n7️⃣  HTML Preview (first 500 chars):`);
    console.log("   " + "─".repeat(50));
    console.log(html.substring(0, 500).split('\n').map(l => "   " + l).join('\n'));
    console.log("   " + "─".repeat(50));

    console.log(`\n✅ Test completed successfully!`);
    console.log(`\n📂 View the website at: file://${htmlPath}`);
    console.log(`   Or run the server and visit: http://localhost:3000/preview-static/${restaurantId}/index.html\n`);

    return { success: true, restaurantId, htmlPath };

  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}`);
    console.error(error.stack);
    return { success: false, error };

  } finally {
    // Cleanup option - uncomment to delete test data
    // if (restaurantId) {
    //   console.log("\n🧹 Cleaning up test data...");
    //   RestaurantModel.delete(restaurantId);
    // }
  }
}

// Run the test
runTest();
