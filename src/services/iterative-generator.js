import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import prettier from 'prettier';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel, NoteModel } from '../db/models/index.js';
import { analyticsSnippet } from './analytics-snippet.js';
import { UIEvaluator } from './ui-evaluator.js';
import { structuralCSS, generateStylePrompt } from './base-styles.js';
import { tailwindCDN, tailwindConfig, designSkill } from './tailwind-skill.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Iterative Website Generator
 * Generates HTML, evaluates it visually, and refines in a loop until quality passes
 */
export class IterativeWebsiteGenerator {
  constructor(options = {}) {
    // Use Pro for generation (better design quality), Flash for evaluation
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    this.evaluator = new UIEvaluator();
    this.maxIterations = options.maxIterations || 3;
    this.qualityThreshold = options.qualityThreshold || 65; // out of 100
    this.debugMode = options.debugMode || false;
  }

  /**
   * Generate website with iterative refinement
   * @param {string} restaurantId - Restaurant ID
   * @param {Object} options - Options
   * @param {Function} options.onProgress - Progress callback (progress, stage)
   */
  async generate(restaurantId, { onProgress = null } = {}) {
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

    // Progress ranges:
    // 0-20%: Image processing
    // 20-70%: Iterations (scaled dynamically)
    // 70-95%: Post-processing (injecting systems, writing files)
    // 95-100%: Saving material
    const ITERATION_START = 20;
    const ITERATION_END = 70;
    const iterationRange = ITERATION_END - ITERATION_START; // 50%
    const progressPerIteration = iterationRange / this.maxIterations;

    // 0-20% - Processing images
    onProgress?.(10, 'processing_images');
    const processedPhotos = await this.processImages(restaurant.photos, outputDir);

    // Iteration tracking
    const iterations = [];
    let currentFiles = null;
    let bestFiles = null;
    let bestMenuScore = -1;
    let feedback = null;
    let finalEvaluation = null;

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        const iterationNum = i + 1;
        console.log(`[IterativeGenerator] Iteration ${iterationNum}/${this.maxIterations}`);

        // Calculate progress for this iteration
        const iterProgress = Math.round(ITERATION_START + (i * progressPerIteration));
        onProgress?.(iterProgress, `generating_iteration_${iterationNum}`);

        // Generate HTML (pass previous files for refinement on iteration 2+)
        currentFiles = await this.generateHTML(
          restaurant,
          processedPhotos,
          feedback,
          iterationNum,
          currentFiles  // Pass previous iteration's output
        );

        // Get the menu.html for evaluation (most complex page)
        const htmlToEvaluate = currentFiles['menu.html'] || currentFiles['index.html'];

        // Evaluate the design
        const evalProgress = Math.round(ITERATION_START + (i * progressPerIteration) + (progressPerIteration * 0.6));
        onProgress?.(evalProgress, `evaluating_iteration_${iterationNum}`);

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
          menuFound: evaluation.menuCheck?.foundCount,
          menuTotal: evaluation.menuCheck?.totalExpected,
          summary: evaluation.visualEvaluation?.summary
        });

        console.log(`[IterativeGenerator] Iteration ${iterationNum} score: ${evaluation.combinedScore}/100, menu: ${evaluation.menuCheck?.foundCount}/${evaluation.menuCheck?.totalExpected}`);

        // Track best file set — never regress on menu completeness
        // Restore ALL files together so index.html and menu.html stay visually consistent
        const menuScore = evaluation.menuCheck?.score || 0;
        if (menuScore > bestMenuScore) {
          bestMenuScore = menuScore;
          bestFiles = { ...currentFiles };
        } else if (menuScore < bestMenuScore && bestFiles) {
          console.log(`[IterativeGenerator] Menu regression (${menuScore} < ${bestMenuScore}), restoring best file set`);
          currentFiles = { ...bestFiles };
        }

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

      // 75% - Injecting systems
      onProgress?.(75, 'injecting_systems');

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

      // 85% - Writing files complete
      onProgress?.(85, 'writing_files');

      // 95% - Saving material
      onProgress?.(95, 'saving');
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
   * On iteration 2+, modifies existing HTML instead of regenerating
   */
  async generateHTML(restaurant, photos, feedback, iterationNum, previousFiles = null) {
    // Include usable photos — ambiance/interior/exterior can be shown inline (not as hero bg)
    // "menu" type are photos of the physical menu board — useless for the website
    const usablePhotos = photos.filter(p => ['ambiance', 'interior', 'exterior', 'food'].includes(p.type));
    const photoDescriptions = usablePhotos.map(p => ({
      path: p.webPath,
      type: p.type,
      caption: p.caption
    }));

    // Get reviews for richer website copy
    let reviewSnippets = '';
    try {
      const { ReviewModel } = await import('../db/models/index.js');
      const reviews = ReviewModel.getByRestaurant(restaurant.id, { limit: 10 });
      const goodReviews = reviews.filter(r => r.rating >= 4 && r.text?.length > 30);
      if (goodReviews.length > 0) {
        reviewSnippets = `\nCUSTOMER REVIEWS (use these to write authentic, compelling copy — quote or paraphrase the best parts):\n${goodReviews.map(r => `- ${r.rating}★: "${r.text}"`).join('\n')}`;
      }
    } catch (e) {
      // Reviews not available, that's fine
    }

    const menuData = restaurant.menu.map(cat => ({
      category: cat.name,
      items: cat.items.map(item => ({
        name: item.name,
        description: item.description,
        price: item.price
      }))
    }));

    const activeNotes = NoteModel.getActive(restaurant.id);
    const stylePrompt = generateStylePrompt(restaurant);

    const totalItems = menuData.reduce((sum, cat) => sum + cat.items.length, 0);

    let prompt;

    if (iterationNum === 1 || !previousFiles) {
      // ITERATION 1: Generate from scratch
      prompt = `Create a stunning restaurant website using Tailwind CSS. The site should feel like a $50k custom build.

RESTAURANT:
- Name: ${restaurant.name || 'Restaurant'}
- Tagline: ${restaurant.tagline || ''}
- Description: ${restaurant.description || ''}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Address: ${restaurant.address || ''}
- Phone: ${restaurant.phone || ''}
- Hours: ${JSON.stringify(restaurant.hours || {})}

MENU (${totalItems} items total — you MUST include ALL ${totalItems} items, do not omit or abbreviate any):
${JSON.stringify(menuData, null, 2)}

${photoDescriptions.length > 0 ? `PHOTOS — these are restaurant/ambiance shots (not individual dish photos). You may use them on index.html in an about or gallery section at their natural aspect ratio (NOT as full-bleed hero backgrounds). Do NOT use on menu.html:
${JSON.stringify(photoDescriptions, null, 2)}` : 'NO PHOTOS AVAILABLE — design with typography, color, and layout only.'}
${reviewSnippets}

${activeNotes.length > 0 ? `ANNOUNCEMENTS: ${activeNotes.map(n => n.content).join(' | ')}` : ''}

${designSkill}

INSTRUCTIONS:
- Use Tailwind CSS utility classes (CDN is already in the <head>)
- Use the component reference above as starting points — customize colors, fonts, spacing to match the restaurant brand
- You may add a <style> block for custom fonts (@import Google Fonts) and any styles that can't be expressed in Tailwind utilities
- The navbar HTML must be IDENTICAL on both pages (same structure, same classes)
- Include <span id="header-cart-placeholder"></span> in the nav — cart icon gets injected there
- Semantic HTML (header, nav, main, section, footer)
- Responsive: mobile-first, looks great on all screen sizes
- For menus with many items (like this one with ${totalItems}), use the compact list layout (not grid cards)
- Touch targets minimum 44x44px

PAGES:

index.html:
- Hero with gradient or solid color background (restaurant name, tagline, CTA)
${photoDescriptions.length > 0 ? '- About section — can include a photo at natural size alongside text' : '- About section'}
${reviewSnippets ? '- Testimonials/quotes section with real customer review snippets' : ''}
- Hours/location with <div id="google-map"></div>
- Footer

menu.html (equal design quality to index):
- Same navbar
- Category sections with data-category="[name]"
- Each item: class="menu-item", name, description (if exists), price
- Each item: <button class="add-to-cart-btn" data-item-id="[slug]" data-name="[name]" data-price="[price]">Add</button>
- Footer

STRICT RULES:
- ONLY use data from MENU and RESTAURANT above — no invented quantities, serving sizes, dietary labels
- No food images on menu items (we have no dish photos)
- NEVER use unsplash.com, pexels.com, or any external image URLs
- menu.html must have ZERO <img> tags — no images on the menu page at all
${photoDescriptions.length > 0 ? '- Photos can be used on index.html only, at natural aspect ratio (not as full-bleed backgrounds)' : '- No images on any page'}
- Don't add cart UI — it's injected automatically

OUTPUT (no markdown, no code fences):
===FILE:index.html===
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${restaurant.name || 'Restaurant'}</title>
  ${tailwindCDN}
  ${tailwindConfig(restaurant)}
  <style>/* Google Fonts + custom styles here */</style>
</head>
<body>
  <!-- Your HTML here using Tailwind classes -->
</body>
</html>
===FILE:menu.html===
<!DOCTYPE html>
<html lang="en">
...
</html>`;

    } else {
      // ITERATION 2+: Refine existing HTML based on feedback
      prompt = `Here's a restaurant website that needs some improvements.

${feedback}

CURRENT index.html:
\`\`\`html
${previousFiles['index.html']}
\`\`\`

CURRENT menu.html:
\`\`\`html
${previousFiles['menu.html'] || ''}
\`\`\`

Consider the feedback above and implement changes. Keep the Tailwind CSS approach and overall design intact.

CRITICAL RULES:
- Keep ALL ${totalItems} menu items — do not remove, truncate, or summarize any
- Keep the navbar IDENTICAL on both pages
- No external image URLs (no unsplash, pexels, placeholder)
- No invented data (quantities, serving sizes, dietary labels)
- Copy every menu item, only changing Tailwind classes/styling

OUTPUT the complete improved files (no markdown, no code fences around the output):
===FILE:index.html===
[improved HTML here]
===FILE:menu.html===
[improved HTML here]`;
    }

    const result = await this.model.generateContent(prompt);
    let response = result.response.text();

    // Clean up any markdown
    response = response.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    // Parse files
    const files = this.parseMultipleFiles(response);

    // Post-process: inject structural CSS and ensure proper structure
    for (const [filename, content] of Object.entries(files)) {
      let html = content;

      // Ensure DOCTYPE
      if (!html.toLowerCase().startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }

      // Inject structural CSS (cart system, grid utilities) at end of <style> or before </head>
      // This ensures cart works without overriding AI's visual styles
      // Skip if already injected (e.g. model copied it from previous iteration)
      if (!html.includes('STRUCTURAL (injected)')) {
        if (html.includes('</style>')) {
          html = html.replace('</style>', `\n/* === STRUCTURAL (injected) === */\n${structuralCSS}\n</style>`);
        } else if (html.includes('</head>')) {
          html = html.replace('</head>', `<style>\n${structuralCSS}\n</style>\n</head>`);
        }
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
          .resize(1600, 1067, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 92, mozjpeg: true })
          .toFile(outputPath);

        const thumbPath = join(outputDir, 'images', `${photo.id}_thumb.jpg`);
        await sharp(photo.path)
          .resize(400, 300, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 85, mozjpeg: true })
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
    // Cart HTML - responsive: bottom bar on mobile, header icon on desktop
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
      <span>Subtotal</span>
      <span id="cart-subtotal">$0.00</span>
    </div>
    <button id="checkout-btn" onclick="checkout()" disabled>Checkout</button>
  </div>
</div>
<div id="cart-bottom-bar" onclick="toggleCart()" data-empty="true">
  <span>View Cart</span>
  <span class="cart-count" data-count="0"></span>
</div>
<div id="cart-toast"></div>`;

    // Header cart button - injected into nav if placeholder exists
    const headerCartBtn = `<button id="cart-header-btn" onclick="toggleCart()">🛒 <span class="cart-count" data-count="0"></span></button>`;

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
      const original = btn.textContent;
      btn.classList.add('added');
      btn.textContent = 'Added!';
      setTimeout(() => { btn.classList.remove('added'); btn.textContent = original; }, 1000);
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
    const checkoutBtn = document.getElementById('checkout-btn');
    const bottomBar = document.getElementById('cart-bottom-bar');
    const count = getItemCount();
    const subtotal = getSubtotal();

    // Update all cart count badges
    document.querySelectorAll('.cart-count').forEach(el => {
      el.textContent = count || '';
      el.dataset.count = count;
    });

    // Update bottom bar visibility
    if (bottomBar) {
      bottomBar.dataset.empty = cart.length === 0 ? 'true' : 'false';
      const barText = bottomBar.querySelector('span:first-child');
      if (barText) barText.textContent = 'View Cart (' + count + ' items) — $' + subtotal.toFixed(2);
    }

    if (cart.length === 0) {
      container.innerHTML = '<div id="cart-empty">Your cart is empty</div>';
      if (subtotalEl) subtotalEl.textContent = '$0.00';
      if (checkoutBtn) checkoutBtn.disabled = true;
      return;
    }

    let html = '';
    cart.forEach(item => {
      const itemTotal = (item.price * item.quantity).toFixed(2);
      html += '<div class="cart-item"><div class="cart-item-info"><div class="cart-item-name">' + escapeHtml(item.name) + '</div><div class="cart-item-price">$' + item.price.toFixed(2) + ' each</div></div><div class="cart-item-controls"><button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', -1)">−</button><span class="cart-item-qty">' + item.quantity + '</span><button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', 1)">+</button><span class="cart-item-total">$' + itemTotal + '</span><button class="cart-item-remove" onclick="removeFromCart(\\'' + item.id + '\\')">&times;</button></div></div>';
    });

    container.innerHTML = html;
    if (subtotalEl) subtotalEl.textContent = '$' + subtotal.toFixed(2);
    if (checkoutBtn) checkoutBtn.disabled = false;
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
    checkoutBtn.textContent = 'Processing...';
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
      checkoutBtn.textContent = 'Checkout';
    }
  };

  function checkOrderConfirmation() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('order');
    if (sessionId) {
      const url = new URL(window.location);
      url.searchParams.delete('order');
      window.history.replaceState({}, '', url);
      showOrderConfirmation();
    }
  }

  function showOrderConfirmation() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
    modal.innerHTML = '<div style="background:white;padding:40px;border-radius:16px;text-align:center;max-width:400px;margin:20px;"><div style="font-size:48px;margin-bottom:16px;">✅</div><h2 style="margin:0 0 12px;color:#111;">Order Confirmed!</h2><p style="color:#6b7280;margin:0 0 24px;">Thank you for your order.</p><button onclick="this.closest(\\'div\\').parentElement.remove()" style="padding:12px 32px;background:#111;color:white;border:none;border-radius:8px;font-size:1rem;cursor:pointer;">Continue</button></div>';
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

    // Inject header cart button — prefer the placeholder, fall back to end of nav
    if (html.includes('id="header-cart-placeholder"')) {
      html = html.replace(/<span[^>]*id="header-cart-placeholder"[^>]*><\/span>/i, () => headerCartBtn);
    } else if (html.includes('</nav>')) {
      html = html.replace('</nav>', () => headerCartBtn + '</nav>');
    } else if (html.includes('</header>')) {
      html = html.replace('</header>', () => headerCartBtn + '</header>');
    }

    // Inject cart panel, bottom bar, and JS before </body>
    // Note: Must use function to avoid $' being interpreted as "text after match"
    if (html.includes('</body>')) {
      html = html.replace('</body>', () => cartHTML + '\n' + cartJS + '\n</body>');
    }

    return html;
  }

  /**
   * Inject analytics
   */
  injectAnalytics(html, restaurantId) {
    const snippet = analyticsSnippet.generate(restaurantId);

    // Use arrow functions to avoid $ special replacement chars in JS snippets
    if (html.includes('</body>')) {
      html = html.replace('</body>', () => snippet + '\n</body>');
    } else {
      html = html.replace('</html>', () => snippet + '\n</html>');
    }

    return html;
  }

  /**
   * Format HTML
   * Note: Prettier's HTML parser corrupts embedded JavaScript (mangles $ characters),
   * so we skip formatting. The AI-generated HTML is already reasonably formatted.
   */
  async formatHTML(html) {
    // Skip prettier - it corrupts the injected cart JavaScript
    // (specifically, '$' characters in strings get mangled)
    return html;
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
    const results = {};

    for (const page of ['index', 'menu']) {
      try {
        const html = await fs.readFile(join(websitePath, `${page}.html`), 'utf-8');
        results[page] = await evaluator.evaluate(
          html,
          restaurant,
          join(websitePath, 'eval_screenshots', page)
        );
      } catch (e) {
        results[page] = { error: e.message };
      }
    }

    return results;

  } finally {
    await evaluator.close();
  }
}
