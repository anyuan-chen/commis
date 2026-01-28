import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import prettier from 'prettier';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel, NoteModel } from '../db/models/index.js';
import { analyticsSnippet } from './analytics-snippet.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class WebsiteGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  /**
   * Generate website for a restaurant using Gemini
   */
  async generate(restaurantId) {
    // Get full restaurant data
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error('Restaurant not found');
    }

    // Create output directory
    const outputDir = join(config.paths.websites, restaurantId);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(join(outputDir, 'images'), { recursive: true });

    // Process and copy images
    const processedPhotos = await this.processImages(restaurant.photos, outputDir);

    // Generate HTML files with Gemini
    const files = await this.generateHTML(restaurant, processedPhotos);

    // Write all HTML files (formatted)
    for (const [filename, html] of Object.entries(files)) {
      const formatted = await this.formatHTML(html);
      await fs.writeFile(join(outputDir, filename), formatted);
    }

    // Track generated material
    const material = MaterialModel.create(restaurantId, {
      type: 'website',
      filePath: outputDir
    });

    return {
      path: outputDir,
      materialId: material.id
    };
  }

  /**
   * Generate complete HTML using Gemini
   */
  async generateHTML(restaurant, photos) {
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

    // Get active notes (auto-filters expired ones)
    const activeNotes = NoteModel.getActive(restaurant.id);

    const prompt = `You are an elite web designer known for creating stunning, award-winning restaurant websites. You have complete creative freedom.

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

CREATE TWO FILES:

===FILE:index.html===
A stunning landing page that captures the restaurant's soul.
- Must include: <div id="google-map"></div> somewhere in contact area
- Link to menu.html with compelling CTA

===FILE:menu.html===
Beautiful menu with ordering. Each item needs:
<button class="add-to-cart-btn" data-item-id="[unique]" data-name="[name]" data-price="[price]">Add to Cart</button>

DESIGN FREEDOM:
- Choose any Google Fonts that fit the vibe
- Create your own color palette based on the brand color
- Design unique animations and micro-interactions
- Experiment with layout (asymmetric grids, overlapping elements, creative whitespace)
- Add CSS-only flourishes (gradients, blend modes, clip-paths, backdrop-filter)
- Make it feel like a $50k custom website

TECHNICAL REQUIREMENTS:
- All CSS inline in <style> tags (no external files)
- Fully responsive (mobile-first)
- Smooth animations with @keyframes and transitions
- prefers-reduced-motion support
- Semantic HTML5
- NO JavaScript (cart JS will be injected)

CART ELEMENTS TO STYLE (these IDs will exist, make them beautiful):
#cart-fab - floating action button (bottom-right)
#cart-count - item count badge on FAB
#cart-panel - slide-in panel from right
#cart-overlay - backdrop behind panel
#cart-header, #cart-items, #cart-footer - panel sections
.cart-item, .cart-item-name, .cart-item-price - item rows
.qty-btn - quantity +/- buttons
#checkout-btn - checkout CTA
#cart-toast - "added to cart" notification

Be bold. Be creative. Make something that would win a design award.

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

    // Parse multiple files from response
    const files = this.parseMultipleFiles(response);

    // Process each file
    for (const [filename, content] of Object.entries(files)) {
      let html = content;

      // Ensure it starts with doctype
      if (!html.toLowerCase().startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }

      // Only inject cart on menu.html
      if (filename === 'menu.html') {
        html = this.injectOrderingSystem(html, restaurant.id);
      }

      // Inject Google Maps on index.html (where contact section is)
      if (filename === 'index.html' && restaurant.address && config.google?.mapsApiKey) {
        html = this.injectGoogleMap(html, restaurant.address);
      }

      // Inject analytics tracking on all pages
      html = this.injectAnalytics(html, restaurant.id);

      files[filename] = html;
    }

    return files;
  }

  /**
   * Parse multiple files from Gemini response
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

    // Fallback: if no files parsed, treat entire response as index.html
    if (Object.keys(files).length === 0) {
      files['index.html'] = response;
    }

    return files;
  }

  /**
   * Inject Google Maps embed
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

    // Inject CSS before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', mapCSS + '\n</head>');
    }

    // Replace the placeholder div with the iframe
    if (html.includes('id="google-map"')) {
      html = html.replace(/<div[^>]*id="google-map"[^>]*>[\s\S]*?<\/div>/i,
        `<div id="google-map">${mapIframe}</div>`);
    } else {
      // If no placeholder, try to inject before </footer> or </body>
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
   * Inject ordering system (cart UI and Stripe checkout)
   * Only injects minimal HTML structure and JS - Gemini styles everything
   */
  injectOrderingSystem(html, restaurantId) {
    // Minimal CSS - only z-index and state transitions that JS depends on
    // All visual styling done by Gemini
    const cartCSS = `
<style>
/* Cart - Functional CSS only (visual styling by Gemini) */
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

    // Cart HTML
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

    // Cart JavaScript
    const cartJS = `
<script src="https://js.stripe.com/v3/"></script>
<script>
(function() {
  const RESTAURANT_ID = '${restaurantId}';
  const STORAGE_KEY = 'cart_' + RESTAURANT_ID;

  // Cart state
  let cart = [];

  // Load cart from localStorage
  function loadCart() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      cart = saved ? JSON.parse(saved) : [];
    } catch (e) {
      cart = [];
    }
    renderCart();
  }

  // Save cart to localStorage
  function saveCart() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }

  // Add item to cart
  window.addToCart = function(id, name, price) {
    const existing = cart.find(item => item.id === id);
    if (existing) {
      existing.quantity++;
    } else {
      cart.push({ id, name, price: parseFloat(price), quantity: 1 });
    }
    saveCart();
    renderCart();
    showToast(name + ' added to cart');

    // Visual feedback on button
    const btn = document.querySelector('[data-item-id="' + id + '"]');
    if (btn) {
      btn.classList.add('added');
      btn.textContent = 'Added!';
      setTimeout(() => {
        btn.classList.remove('added');
        btn.textContent = 'Add to Cart';
      }, 1000);
    }
  };

  // Remove item from cart
  window.removeFromCart = function(id) {
    cart = cart.filter(item => item.id !== id);
    saveCart();
    renderCart();
  };

  // Update quantity
  window.updateQuantity = function(id, delta) {
    const item = cart.find(item => item.id === id);
    if (item) {
      item.quantity += delta;
      if (item.quantity <= 0) {
        removeFromCart(id);
      } else {
        saveCart();
        renderCart();
      }
    }
  };

  // Get cart total
  function getSubtotal() {
    return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  }

  // Get total item count
  function getItemCount() {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  }

  // Render cart
  function renderCart() {
    const container = document.getElementById('cart-items');
    const subtotalEl = document.getElementById('cart-subtotal');
    const countEl = document.getElementById('cart-count');
    const checkoutBtn = document.getElementById('checkout-btn');
    const emptyEl = document.getElementById('cart-empty');

    if (cart.length === 0) {
      container.innerHTML = '<div id="cart-empty">Your cart is empty</div>';
      subtotalEl.textContent = '$$0.00';
      countEl.textContent = '';
      countEl.dataset.count = '0';
      checkoutBtn.disabled = true;
      return;
    }

    let html = '';
    cart.forEach(item => {
      const itemTotal = (item.price * item.quantity).toFixed(2);
      html += '<div class="cart-item">' +
        '<div class="cart-item-info">' +
          '<div class="cart-item-name">' + escapeHtml(item.name) + '</div>' +
          '<div class="cart-item-price">$$' + item.price.toFixed(2) + ' each</div>' +
        '</div>' +
        '<div class="cart-item-controls">' +
          '<button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', -1)">−</button>' +
          '<span class="cart-item-qty">' + item.quantity + '</span>' +
          '<button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', 1)">+</button>' +
          '<span class="cart-item-total">$$' + itemTotal + '</span>' +
          '<button class="cart-item-remove" onclick="removeFromCart(\\'' + item.id + '\\')">&times;</button>' +
        '</div>' +
      '</div>';
    });

    container.innerHTML = html;
    subtotalEl.textContent = '$$' + getSubtotal().toFixed(2);

    const count = getItemCount();
    countEl.textContent = count;
    countEl.dataset.count = count;
    checkoutBtn.disabled = false;
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Toggle cart panel
  window.toggleCart = function() {
    const panel = document.getElementById('cart-panel');
    const overlay = document.getElementById('cart-overlay');
    panel.classList.toggle('open');
    overlay.classList.toggle('open');
  };

  // Close cart
  window.closeCart = function() {
    document.getElementById('cart-panel').classList.remove('open');
    document.getElementById('cart-overlay').classList.remove('open');
  };

  // Show toast
  function showToast(message) {
    const toast = document.getElementById('cart-toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // Checkout
  window.checkout = async function() {
    if (cart.length === 0) return;

    const checkoutBtn = document.getElementById('checkout-btn');
    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML = '<span>Processing...</span>';

    try {
      const response = await fetch('/api/orders/' + RESTAURANT_ID + '/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          successUrl: window.location.origin + window.location.pathname,
          cancelUrl: window.location.href
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Clear cart before redirect
      localStorage.removeItem(STORAGE_KEY);

      // Redirect to Stripe Checkout
      window.location.href = data.url;
    } catch (error) {
      console.error('Checkout error:', error);
      showToast('Checkout failed. Please try again.');
      checkoutBtn.disabled = false;
      checkoutBtn.innerHTML = '<span>Checkout</span><span>🔒</span>';
    }
  };

  // Check for order confirmation
  function checkOrderConfirmation() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('order');
    if (sessionId) {
      // Remove order param from URL
      const url = new URL(window.location);
      url.searchParams.delete('order');
      window.history.replaceState({}, '', url);

      // Show confirmation
      showOrderConfirmation(sessionId);
    }
  }

  function showOrderConfirmation(sessionId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
    modal.innerHTML = '<div style="background:white;padding:40px;border-radius:16px;text-align:center;max-width:400px;margin:20px;">' +
      '<div style="font-size:48px;margin-bottom:16px;">✅</div>' +
      '<h2 style="margin:0 0 12px;color:#111;">Order Confirmed!</h2>' +
      '<p style="color:#6b7280;margin:0 0 24px;">Thank you for your order. You will receive a confirmation email shortly.</p>' +
      '<button onclick="this.closest(\\'div\\').parentElement.remove()" style="padding:12px 32px;background:var(--primary-color,#2563eb);color:white;border:none;border-radius:8px;font-size:1rem;cursor:pointer;">Continue</button>' +
    '</div>';
    document.body.appendChild(modal);
  }

  // Wire up Add to Cart buttons using event delegation
  // This ensures our handler works even if Gemini added its own handlers
  function initAddToCartButtons() {
    document.body.addEventListener('click', function(e) {
      const btn = e.target.closest('.add-to-cart-btn');
      if (btn) {
        e.stopPropagation();
        const id = btn.dataset.itemId;
        const name = btn.dataset.name;
        const price = btn.dataset.price;
        if (id && name && price) {
          addToCart(id, name, price);
        }
      }
    }, true); // Use capture phase to run first
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', function() {
    loadCart();
    initAddToCartButtons();
    checkOrderConfirmation();
  });
})();
</script>`;

    // Inject CSS before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', cartCSS + '\n</head>');
    }

    // Inject HTML and JS before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', cartHTML + '\n' + cartJS + '\n</body>');
    }

    return html;
  }

  /**
   * Inject analytics tracking snippet
   */
  injectAnalytics(html, restaurantId) {
    const snippet = analyticsSnippet.generate(restaurantId);

    // Inject before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', snippet + '\n</body>');
    } else {
      // If no body closing tag, append at end
      html = html.replace('</html>', snippet + '\n</html>');
    }

    return html;
  }

  /**
   * Process and optimize images
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

        // Also create thumbnail
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
   * Format HTML with prettier for consistent output
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
      console.warn('HTML formatting failed, using raw HTML:', error.message);
      return html;
    }
  }
}
