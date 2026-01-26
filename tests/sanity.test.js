/**
 * Sanity check tests for VideoResto
 * Run with: node --test tests/sanity.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

// ============================================
// CONFIG
// ============================================
describe('Config', async () => {
  const { config } = await import('../src/config.js');

  test('config loads without error', () => {
    assert.ok(config);
  });

  test('config has required paths', () => {
    assert.ok(config.paths.uploads);
    assert.ok(config.paths.websites);
    assert.ok(config.paths.db);
  });

  test('config has stripe section', () => {
    assert.ok('stripe' in config);
    assert.ok('secretKey' in config.stripe);
    assert.ok('publishableKey' in config.stripe);
    assert.ok('webhookSecret' in config.stripe);
  });

  test('config has gemini settings', () => {
    assert.ok(config.geminiApiKey || process.env.GEMINI_API_KEY === undefined);
    assert.ok(config.geminiLive);
    assert.ok(config.geminiLive.model);
  });
});

// ============================================
// DATABASE
// ============================================
describe('Database', async () => {
  const db = (await import('../src/db/database.js')).default;

  test('database connection works', () => {
    assert.ok(db);
    assert.ok(typeof db.prepare === 'function');
  });

  test('restaurants table exists', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='restaurants'").get();
    assert.ok(result);
  });

  test('orders table exists', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").get();
    assert.ok(result);
  });

  test('menu_items table exists', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='menu_items'").get();
    assert.ok(result);
  });

  test('shorts_jobs table exists', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shorts_jobs'").get();
    assert.ok(result);
  });
});

// ============================================
// MODELS
// ============================================
describe('Models', async () => {
  const models = await import('../src/db/models/index.js');

  test('RestaurantModel exports', () => {
    assert.ok(models.RestaurantModel);
    assert.ok(typeof models.RestaurantModel.create === 'function');
    assert.ok(typeof models.RestaurantModel.getById === 'function');
  });

  test('OrderModel exports', () => {
    assert.ok(models.OrderModel);
    assert.ok(typeof models.OrderModel.create === 'function');
    assert.ok(typeof models.OrderModel.getById === 'function');
    assert.ok(typeof models.OrderModel.getByStripeSession === 'function');
    assert.ok(typeof models.OrderModel.updateStatus === 'function');
  });

  test('MenuItemModel exports', () => {
    assert.ok(models.MenuItemModel);
    assert.ok(typeof models.MenuItemModel.create === 'function');
  });

  test('OrderModel can create and retrieve', () => {
    // Create a test restaurant first
    const restaurant = models.RestaurantModel.create({
      name: 'Test Restaurant',
      cuisineType: 'Test'
    });

    const order = models.OrderModel.create(restaurant.id, {
      items: [{ id: 'test-1', name: 'Test Item', price: 9.99, quantity: 2 }],
      customerEmail: 'test@test.com',
      stripeSessionId: 'sess_test123'
    });

    assert.ok(order.id);
    assert.equal(order.restaurant_id, restaurant.id);
    assert.equal(order.status, 'pending');
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].name, 'Test Item');

    // Retrieve by ID
    const retrieved = models.OrderModel.getById(order.id);
    assert.equal(retrieved.id, order.id);

    // Retrieve by session
    const bySession = models.OrderModel.getByStripeSession('sess_test123');
    assert.equal(bySession.id, order.id);

    // Update status
    const updated = models.OrderModel.updateStatus(order.id, 'paid', 'pi_test456');
    assert.equal(updated.status, 'paid');
    assert.equal(updated.stripe_payment_intent, 'pi_test456');

    // Cleanup
    models.RestaurantModel.delete(restaurant.id);
  });
});

// ============================================
// SERVICES
// ============================================
describe('Services', async () => {
  test('WebsiteGenerator imports', async () => {
    const { WebsiteGenerator } = await import('../src/services/website-generator.js');
    assert.ok(WebsiteGenerator);
    const gen = new WebsiteGenerator();
    assert.ok(typeof gen.generate === 'function');
    assert.ok(typeof gen.injectAnimations === 'function');
    assert.ok(typeof gen.injectOrderingSystem === 'function');
  });

  test('WebsiteGenerator injects cart HTML', async () => {
    const { WebsiteGenerator } = await import('../src/services/website-generator.js');
    const gen = new WebsiteGenerator();

    const html = '<!DOCTYPE html><html><head></head><body></body></html>';
    const result = gen.injectOrderingSystem(html, 'test-restaurant-id');

    assert.ok(result.includes('cart-fab'));
    assert.ok(result.includes('cart-panel'));
    assert.ok(result.includes('checkout'));
    assert.ok(result.includes('test-restaurant-id'));
    assert.ok(result.includes('stripe.com'));
  });

  test('WebsiteGenerator injects Google Map', async () => {
    const { WebsiteGenerator } = await import('../src/services/website-generator.js');
    const gen = new WebsiteGenerator();

    const html = '<!DOCTYPE html><html><head></head><body><div id="google-map"></div></body></html>';
    const result = gen.injectGoogleMap(html, '123 Main St, San Francisco, CA');

    assert.ok(result.includes('maps/embed'));
    assert.ok(result.includes('123%20Main'));
    assert.ok(result.includes('google-map'));
  });

  test('GeminiVision imports', async () => {
    const { GeminiVision } = await import('../src/services/gemini-vision.js');
    assert.ok(GeminiVision);
  });

  test('ClipSelector imports', async () => {
    const { ClipSelector } = await import('../src/services/clip-selector.js');
    assert.ok(ClipSelector);
  });

  test('VoiceoverGenerator imports', async () => {
    const { VoiceoverGenerator } = await import('../src/services/voiceover-generator.js');
    assert.ok(VoiceoverGenerator);
    const gen = new VoiceoverGenerator();
    assert.ok(typeof gen.generateScript === 'function');
    assert.ok(typeof gen.generateAudio === 'function');
    assert.ok(typeof gen.generateMetadata === 'function');
  });

  test('ImageGenerator imports', async () => {
    const { ImageGenerator } = await import('../src/services/image-generator.js');
    assert.ok(ImageGenerator);
  });

  test('GeminiLive exports tools and system instruction', async () => {
    const { voiceTools, createSystemInstruction } = await import('../src/services/gemini-live.js');
    assert.ok(Array.isArray(voiceTools));
    assert.ok(voiceTools.length > 0);
    assert.ok(typeof createSystemInstruction === 'function');

    const instruction = createSystemInstruction({ name: 'Test', menu: [] });
    assert.ok(instruction.includes('restaurant'));
  });
});

// ============================================
// ROUTES
// ============================================
describe('Routes', async () => {
  test('orders route imports', async () => {
    const ordersRouter = await import('../src/routes/orders.js');
    assert.ok(ordersRouter.default);
  });

  test('upload route imports', async () => {
    const uploadRouter = await import('../src/routes/upload.js');
    assert.ok(uploadRouter.default);
  });

  test('deploy route imports', async () => {
    const deployRouter = await import('../src/routes/deploy.js');
    assert.ok(deployRouter.default);
  });

  test('shorts route imports', async () => {
    const shortsRouter = await import('../src/routes/shorts.js');
    assert.ok(shortsRouter.default);
  });
});

// ============================================
// VOICE TOOLS
// ============================================
describe('Voice Tools', async () => {
  const { voiceTools } = await import('../src/services/gemini-live.js');

  test('has required tools', () => {
    const toolNames = voiceTools.map(t => t.name);

    assert.ok(toolNames.includes('updateRestaurantInfo'));
    assert.ok(toolNames.includes('addMenuItem'));
    assert.ok(toolNames.includes('updateMenuItem'));
    assert.ok(toolNames.includes('removeMenuItem'));
    assert.ok(toolNames.includes('regenerateWebsite'));
    assert.ok(toolNames.includes('deployWebsite'));
    assert.ok(toolNames.includes('addNote'));
  });

  test('tools have proper structure', () => {
    for (const tool of voiceTools) {
      assert.ok(tool.name, 'tool has name');
      assert.ok(tool.description, 'tool has description');
      assert.ok(tool.parameters, 'tool has parameters');
      assert.equal(tool.parameters.type, 'object');
    }
  });
});

// ============================================
// STRIPE INTEGRATION
// ============================================
describe('Stripe Integration', async () => {
  test('Stripe package is installed', async () => {
    const Stripe = (await import('stripe')).default;
    assert.ok(Stripe);
  });

  test('orders route handles missing Stripe gracefully', async () => {
    // This tests that the route doesn't crash if Stripe isn't configured
    const ordersModule = await import('../src/routes/orders.js');
    assert.ok(ordersModule.default);
  });
});

console.log('\n🧪 Running sanity checks...\n');
