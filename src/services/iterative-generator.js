import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import prettier from 'prettier';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel, NoteModel } from '../db/models/index.js';
import { analyticsSnippet } from './analytics-snippet.js';
import { UIEvaluator, generateDesignBrief } from './ui-evaluator.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Iterative Website Generator
 * Generates HTML, evaluates it visually, and refines in a loop until quality passes
 */
export class IterativeWebsiteGenerator {
  constructor(options = {}) {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    this.evaluator = new UIEvaluator();
    this.maxIterations = options.maxIterations || 3;
    this.qualityThreshold = options.qualityThreshold || 65; // out of 100
    this.debugMode = options.debugMode || false;
  }

  /**
   * Generate website with iterative refinement
   */
  async generate(restaurantId) {
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error('Restaurant not found');
    }

    // Create output directory
    const outputDir = join(config.paths.websites, restaurantId);
    const debugDir = this.debugMode ? join(outputDir, 'debug') : null;
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(join(outputDir, 'images'), { recursive: true });
    if (debugDir) {
      await fs.mkdir(debugDir, { recursive: true });
    }

    // Process images first
    const processedPhotos = await this.processImages(restaurant.photos, outputDir);

    // Generate design brief
    const designBrief = generateDesignBrief(restaurant);

    // Iteration tracking
    const iterations = [];
    let currentFiles = null;
    let feedback = null;
    let finalEvaluation = null;

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        const iterationNum = i + 1;
        console.log(`[IterativeGenerator] Iteration ${iterationNum}/${this.maxIterations}`);

        // Generate HTML
        currentFiles = await this.generateHTML(
          restaurant,
          processedPhotos,
          designBrief,
          feedback,
          iterationNum
        );

        // Get the menu.html for evaluation (most complex page)
        const htmlToEvaluate = currentFiles['menu.html'] || currentFiles['index.html'];

        // Evaluate the design
        const evalDir = debugDir ? join(debugDir, `iteration_${iterationNum}`) : null;
        const evaluation = await this.evaluator.evaluate(
          htmlToEvaluate,
          restaurant,
          evalDir
        );

        iterations.push({
          iteration: iterationNum,
          score: evaluation.combinedScore,
          passed: evaluation.passesQualityBar,
          issues: evaluation.allIssues.length,
          summary: evaluation.visualEvaluation?.summary
        });

        console.log(`[IterativeGenerator] Iteration ${iterationNum} score: ${evaluation.combinedScore}/100`);

        // Save debug info
        if (debugDir) {
          await fs.writeFile(
            join(debugDir, `iteration_${iterationNum}`, 'evaluation.json'),
            JSON.stringify(evaluation, null, 2)
          );
          await fs.writeFile(
            join(debugDir, `iteration_${iterationNum}`, 'index.html'),
            currentFiles['index.html']
          );
          await fs.writeFile(
            join(debugDir, `iteration_${iterationNum}`, 'menu.html'),
            currentFiles['menu.html'] || ''
          );
        }

        // Check if we pass the quality bar
        if (evaluation.combinedScore >= this.qualityThreshold && evaluation.passesQualityBar) {
          console.log(`[IterativeGenerator] Quality bar passed on iteration ${iterationNum}`);
          finalEvaluation = evaluation;
          break;
        }

        // Generate feedback for next iteration
        feedback = this.evaluator.generateFeedback(evaluation);
        finalEvaluation = evaluation;

        // If this is the last iteration, we use what we have
        if (iterationNum === this.maxIterations) {
          console.log(`[IterativeGenerator] Max iterations reached, using best result`);
        }
      }

      // Write final HTML files
      for (const [filename, html] of Object.entries(currentFiles)) {
        let processed = html;

        // Inject systems
        if (filename === 'menu.html') {
          processed = this.injectOrderingSystem(processed, restaurant.id);
        }
        if (filename === 'index.html' && restaurant.address && config.google?.mapsApiKey) {
          processed = this.injectGoogleMap(processed, restaurant.address);
        }
        processed = this.injectAnalytics(processed, restaurant.id);

        const formatted = await this.formatHTML(processed);
        await fs.writeFile(join(outputDir, filename), formatted);
      }

      // Track generated material
      const material = MaterialModel.create(restaurantId, {
        type: 'website',
        filePath: outputDir
      });

      return {
        path: outputDir,
        materialId: material.id,
        iterations,
        finalScore: finalEvaluation?.combinedScore,
        passed: finalEvaluation?.passesQualityBar,
        evaluation: finalEvaluation
      };

    } finally {
      // Clean up Puppeteer
      await this.evaluator.close();
    }
  }

  /**
   * Generate HTML with optional feedback from previous iteration
   */
  async generateHTML(restaurant, photos, designBrief, feedback, iterationNum) {
    const photoDescriptions = photos.map(p => ({
      path: p.webPath,
      type: p.type,
      caption: p.caption,
      isPrimary: p.isPrimary
    }));

    const menuData = restaurant.menu.map(cat => ({
      category: cat.name,
      items: cat.items.map(item => ({
        name: item.name,
        description: item.description,
        price: item.price
      }))
    }));

    const activeNotes = NoteModel.getActive(restaurant.id);

    // Build the prompt
    let prompt = `You are an elite web designer creating a stunning restaurant website.
${iterationNum > 1 ? `\nThis is ITERATION ${iterationNum}. Your previous design was evaluated and needs improvements.\n` : ''}
RESTAURANT:
- Name: ${restaurant.name || 'Restaurant'}
- Tagline: ${restaurant.tagline || ''}
- Description: ${restaurant.description || ''}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Vibe: ${restaurant.style_theme || 'modern'}
- Brand Color: ${restaurant.primary_color || '#2563eb'}
- Address: ${restaurant.address || ''}
- Phone: ${restaurant.phone || ''}
- Email: ${restaurant.email || ''}
- Hours: ${JSON.stringify(restaurant.hours || {})}

MENU:
${JSON.stringify(menuData, null, 2)}

PHOTOS (use these exact paths):
${JSON.stringify(photoDescriptions, null, 2)}

${activeNotes.length > 0 ? `ANNOUNCEMENTS: ${activeNotes.map(n => n.content).join(' | ')}` : ''}

${designBrief}
`;

    // Add feedback from previous iteration
    if (feedback) {
      prompt += `
================================================================================
${feedback}
================================================================================

IMPORTANT: Address ALL the issues listed above. This feedback comes from an automated
visual analysis of your previous design. Focus especially on the CRITICAL ISSUES.
`;
    }

    prompt += `
CREATE TWO FILES:

===FILE:index.html===
A stunning landing page that captures the restaurant's soul.
- Must include: <div id="google-map"></div> somewhere in contact area
- Link to menu.html with compelling CTA
- Ensure strong visual hierarchy with clear focal points
- Use generous whitespace (minimum 2rem padding on sections)
- Hero should have strong contrast for text legibility

===FILE:menu.html===
Beautiful menu with ordering. Each item needs:
<button class="add-to-cart-btn" data-item-id="[unique]" data-name="[name]" data-price="[price]">Add to Cart</button>
- Menu items should be easy to scan (clear names, prices visible)
- Categories should be visually distinct
- Add to cart buttons should be obvious but tasteful

TECHNICAL REQUIREMENTS:
- All CSS inline in <style> tags (no external files)
- Fully responsive (mobile-first with @media queries)
- Viewport meta tag: <meta name="viewport" content="width=device-width, initial-scale=1">
- Use clamp() for responsive font sizes: font-size: clamp(1rem, 2vw + 0.5rem, 1.25rem)
- Smooth animations with @keyframes and transitions
- prefers-reduced-motion support with @media (prefers-reduced-motion: reduce)
- Semantic HTML5 (header, nav, main, section, article, footer)
- NO JavaScript (cart JS will be injected)

CART ELEMENTS TO STYLE (these IDs will exist):
#cart-fab - floating action button (bottom-right, min 48px tap target)
#cart-count - item count badge on FAB
#cart-panel - slide-in panel from right (min 320px wide, max 400px)
#cart-overlay - backdrop behind panel (rgba black, blur optional)
#cart-header, #cart-items, #cart-footer - panel sections
.cart-item, .cart-item-name, .cart-item-price - item rows
.qty-btn - quantity +/- buttons (min 44px tap target)
#checkout-btn - checkout CTA (prominent, high contrast)
#cart-toast - "added to cart" notification

QUALITY CHECKLIST (your design will be evaluated on these):
□ Text contrast ratio >= 4.5:1 (especially on images)
□ Consistent spacing using CSS custom properties
□ Typography hierarchy clear (h1 > h2 > h3 > body)
□ Mobile layout works without horizontal scroll
□ Images don't break layout on any viewport
□ Brand colors used cohesively throughout
□ Buttons have hover/focus states
□ No orphaned text (single words on their own line)

OUTPUT (no markdown, no code fences):
===FILE:index.html===
<!DOCTYPE html>
...
</html>
===FILE:menu.html===
<!DOCTYPE html>
...
</html>`;

    const result = await this.model.generateContent(prompt);
    let response = result.response.text();

    // Clean up any markdown
    response = response.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    // Parse files
    const files = this.parseMultipleFiles(response);

    // Ensure proper structure
    for (const [filename, content] of Object.entries(files)) {
      let html = content;
      if (!html.toLowerCase().startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }
      files[filename] = html;
    }

    return files;
  }

  /**
   * Parse multiple files from response
   */
  parseMultipleFiles(response) {
    const files = {};
    const filePattern = /===FILE:(\w+\.html)===([\s\S]*?)(?====FILE:|$)/g;
    let match;

    while ((match = filePattern.exec(response)) !== null) {
      const filename = match[1];
      let content = match[2].trim();
      files[filename] = content;
    }

    if (Object.keys(files).length === 0) {
      files['index.html'] = response;
    }

    return files;
  }

  /**
   * Process images (same as original generator)
   */
  async processImages(photos, outputDir) {
    const processed = [];

    for (const photo of photos) {
      try {
        const filename = `${photo.id}.jpg`;
        const outputPath = join(outputDir, 'images', filename);

        await sharp(photo.path)
          .resize(1200, 800, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 85 })
          .toFile(outputPath);

        const thumbPath = join(outputDir, 'images', `${photo.id}_thumb.jpg`);
        await sharp(photo.path)
          .resize(400, 300, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 80 })
          .toFile(thumbPath);

        processed.push({
          ...photo,
          webPath: `images/${filename}`,
          thumbPath: `images/${photo.id}_thumb.jpg`
        });
      } catch (error) {
        console.error(`Failed to process image ${photo.path}:`, error);
      }
    }

    return processed;
  }

  /**
   * Inject Google Maps (same as original)
   */
  injectGoogleMap(html, address) {
    const apiKey = config.google.mapsApiKey;
    const encodedAddress = encodeURIComponent(address);

    const mapCSS = `
<style>
#google-map {
  width: 100%;
  height: 300px;
  border-radius: 8px;
  overflow: hidden;
  margin: 20px 0;
}
#google-map iframe {
  width: 100%;
  height: 100%;
  border: 0;
}
@media (min-width: 768px) {
  #google-map {
    height: 400px;
  }
}
</style>`;

    const mapIframe = `<iframe
  loading="lazy"
  allowfullscreen
  referrerpolicy="no-referrer-when-downgrade"
  src="https://www.google.com/maps/embed/v1/place?key=${apiKey}&q=${encodedAddress}">
</iframe>`;

    if (html.includes('</head>')) {
      html = html.replace('</head>', mapCSS + '\n</head>');
    }

    if (html.includes('id="google-map"')) {
      html = html.replace(/<div[^>]*id="google-map"[^>]*>[\s\S]*?<\/div>/i,
        `<div id="google-map">${mapIframe}</div>`);
    } else {
      const mapSection = `
<div id="google-map" style="max-width: 1200px; margin: 0 auto; padding: 20px;">
  ${mapIframe}
</div>`;
      if (html.includes('</footer>')) {
        html = html.replace('</footer>', mapSection + '\n</footer>');
      } else if (html.includes('</main>')) {
        html = html.replace('</main>', mapSection + '\n</main>');
      }
    }

    return html;
  }

  /**
   * Inject ordering system (same as original)
   */
  injectOrderingSystem(html, restaurantId) {
    const cartCSS = `
<style>
/* Cart - Functional CSS only */
#cart-fab { position: fixed; bottom: 24px; right: 24px; z-index: 1000; cursor: pointer; }
#cart-count:empty, #cart-count[data-count="0"] { display: none; }
#cart-overlay { position: fixed; inset: 0; z-index: 1001; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
#cart-overlay.open { opacity: 1; visibility: visible; }
#cart-panel { position: fixed; top: 0; right: 0; height: 100%; z-index: 1002; transform: translateX(100%); transition: transform 0.3s cubic-bezier(0.23, 1, 0.32, 1); }
#cart-panel.open { transform: translateX(0); }
#cart-items { flex: 1; overflow-y: auto; }
#checkout-btn:disabled { opacity: 0.5; cursor: not-allowed; }
#cart-toast { position: fixed; bottom: 100px; right: 24px; z-index: 1003; opacity: 0; transform: translateY(10px); transition: opacity 0.3s, transform 0.3s; pointer-events: none; }
#cart-toast.show { opacity: 1; transform: translateY(0); }
</style>`;

    const cartHTML = `
<div id="cart-overlay" onclick="closeCart()"></div>
<div id="cart-panel">
  <div id="cart-header">
    <h2>Your Order</h2>
    <button id="cart-close" onclick="closeCart()">&times;</button>
  </div>
  <div id="cart-items">
    <div id="cart-empty">Your cart is empty</div>
  </div>
  <div id="cart-footer">
    <div class="cart-subtotal">
      <span class="cart-subtotal-label">Subtotal</span>
      <span class="cart-subtotal-value" id="cart-subtotal">$0.00</span>
    </div>
    <button id="checkout-btn" onclick="checkout()" disabled>
      <span>Checkout</span>
      <span>🔒</span>
    </button>
  </div>
</div>
<div id="cart-fab" onclick="toggleCart()">
  🛒
  <span id="cart-count" data-count="0"></span>
</div>
<div id="cart-toast"></div>`;

    const cartJS = `
<script src="https://js.stripe.com/v3/"></script>
<script>
(function() {
  const RESTAURANT_ID = '${restaurantId}';
  const STORAGE_KEY = 'cart_' + RESTAURANT_ID;
  let cart = [];

  function loadCart() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      cart = saved ? JSON.parse(saved) : [];
    } catch (e) { cart = []; }
    renderCart();
  }

  function saveCart() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }

  window.addToCart = function(id, name, price) {
    const existing = cart.find(item => item.id === id);
    if (existing) { existing.quantity++; }
    else { cart.push({ id, name, price: parseFloat(price), quantity: 1 }); }
    saveCart();
    renderCart();
    showToast(name + ' added to cart');
    const btn = document.querySelector('[data-item-id="' + id + '"]');
    if (btn) {
      btn.classList.add('added');
      btn.textContent = 'Added!';
      setTimeout(() => { btn.classList.remove('added'); btn.textContent = 'Add to Cart'; }, 1000);
    }
  };

  window.removeFromCart = function(id) {
    cart = cart.filter(item => item.id !== id);
    saveCart();
    renderCart();
  };

  window.updateQuantity = function(id, delta) {
    const item = cart.find(item => item.id === id);
    if (item) {
      item.quantity += delta;
      if (item.quantity <= 0) { removeFromCart(id); }
      else { saveCart(); renderCart(); }
    }
  };

  function getSubtotal() { return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0); }
  function getItemCount() { return cart.reduce((sum, item) => sum + item.quantity, 0); }

  function renderCart() {
    const container = document.getElementById('cart-items');
    const subtotalEl = document.getElementById('cart-subtotal');
    const countEl = document.getElementById('cart-count');
    const checkoutBtn = document.getElementById('checkout-btn');

    if (cart.length === 0) {
      container.innerHTML = '<div id="cart-empty">Your cart is empty</div>';
      subtotalEl.textContent = '$0.00';
      countEl.textContent = '';
      countEl.dataset.count = '0';
      checkoutBtn.disabled = true;
      return;
    }

    let html = '';
    cart.forEach(item => {
      const itemTotal = (item.price * item.quantity).toFixed(2);
      html += '<div class="cart-item"><div class="cart-item-info"><div class="cart-item-name">' + escapeHtml(item.name) + '</div><div class="cart-item-price">$' + item.price.toFixed(2) + ' each</div></div><div class="cart-item-controls"><button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', -1)">−</button><span class="cart-item-qty">' + item.quantity + '</span><button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', 1)">+</button><span class="cart-item-total">$' + itemTotal + '</span><button class="cart-item-remove" onclick="removeFromCart(\\'' + item.id + '\\')">&times;</button></div></div>';
    });

    container.innerHTML = html;
    subtotalEl.textContent = '$' + getSubtotal().toFixed(2);
    const count = getItemCount();
    countEl.textContent = count;
    countEl.dataset.count = count;
    checkoutBtn.disabled = false;
  }

  function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }

  window.toggleCart = function() {
    document.getElementById('cart-panel').classList.toggle('open');
    document.getElementById('cart-overlay').classList.toggle('open');
  };

  window.closeCart = function() {
    document.getElementById('cart-panel').classList.remove('open');
    document.getElementById('cart-overlay').classList.remove('open');
  };

  function showToast(message) {
    const toast = document.getElementById('cart-toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  window.checkout = async function() {
    if (cart.length === 0) return;
    const checkoutBtn = document.getElementById('checkout-btn');
    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML = '<span>Processing...</span>';
    try {
      const response = await fetch('/api/orders/' + RESTAURANT_ID + '/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart, successUrl: window.location.origin + window.location.pathname, cancelUrl: window.location.href })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      localStorage.removeItem(STORAGE_KEY);
      window.location.href = data.url;
    } catch (error) {
      console.error('Checkout error:', error);
      showToast('Checkout failed. Please try again.');
      checkoutBtn.disabled = false;
      checkoutBtn.innerHTML = '<span>Checkout</span><span>🔒</span>';
    }
  };

  function checkOrderConfirmation() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('order');
    if (sessionId) {
      const url = new URL(window.location);
      url.searchParams.delete('order');
      window.history.replaceState({}, '', url);
      showOrderConfirmation(sessionId);
    }
  }

  function showOrderConfirmation(sessionId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
    modal.innerHTML = '<div style="background:white;padding:40px;border-radius:16px;text-align:center;max-width:400px;margin:20px;"><div style="font-size:48px;margin-bottom:16px;">✅</div><h2 style="margin:0 0 12px;color:#111;">Order Confirmed!</h2><p style="color:#6b7280;margin:0 0 24px;">Thank you for your order. You will receive a confirmation email shortly.</p><button onclick="this.closest(\\'div\\').parentElement.remove()" style="padding:12px 32px;background:var(--primary-color,#2563eb);color:white;border:none;border-radius:8px;font-size:1rem;cursor:pointer;">Continue</button></div>';
    document.body.appendChild(modal);
  }

  function initAddToCartButtons() {
    document.body.addEventListener('click', function(e) {
      const btn = e.target.closest('.add-to-cart-btn');
      if (btn) {
        e.stopPropagation();
        const id = btn.dataset.itemId;
        const name = btn.dataset.name;
        const price = btn.dataset.price;
        if (id && name && price) { addToCart(id, name, price); }
      }
    }, true);
  }

  document.addEventListener('DOMContentLoaded', function() {
    loadCart();
    initAddToCartButtons();
    checkOrderConfirmation();
  });
})();
</script>`;

    if (html.includes('</head>')) {
      html = html.replace('</head>', cartCSS + '\n</head>');
    }

    if (html.includes('</body>')) {
      html = html.replace('</body>', cartHTML + '\n' + cartJS + '\n</body>');
    }

    return html;
  }

  /**
   * Inject analytics
   */
  injectAnalytics(html, restaurantId) {
    const snippet = analyticsSnippet.generate(restaurantId);

    if (html.includes('</body>')) {
      html = html.replace('</body>', snippet + '\n</body>');
    } else {
      html = html.replace('</html>', snippet + '\n</html>');
    }

    return html;
  }

  /**
   * Format HTML
   */
  async formatHTML(html) {
    try {
      return await prettier.format(html, {
        parser: 'html',
        printWidth: 120,
        tabWidth: 2,
        useTabs: false
      });
    } catch (error) {
      console.warn('HTML formatting failed:', error.message);
      return html;
    }
  }
}

/**
 * Quick evaluation without full generation
 * Useful for evaluating existing websites
 */
export async function evaluateExistingWebsite(restaurantId) {
  const evaluator = new UIEvaluator();

  try {
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error('Restaurant not found');
    }

    const websitePath = join(config.paths.websites, restaurantId);
    const indexPath = join(websitePath, 'index.html');
    const menuPath = join(websitePath, 'menu.html');

    const results = {};

    // Evaluate index.html
    try {
      const indexHtml = await fs.readFile(indexPath, 'utf-8');
      results.index = await evaluator.evaluate(
        indexHtml,
        restaurant,
        join(websitePath, 'eval_screenshots', 'index')
      );
    } catch (e) {
      results.index = { error: e.message };
    }

    // Evaluate menu.html
    try {
      const menuHtml = await fs.readFile(menuPath, 'utf-8');
      results.menu = await evaluator.evaluate(
        menuHtml,
        restaurant,
        join(websitePath, 'eval_screenshots', 'menu')
      );
    } catch (e) {
      results.menu = { error: e.message };
    }

    return results;

  } finally {
    await evaluator.close();
  }
}
