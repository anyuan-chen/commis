/**
 * Tailwind CSS design skill for restaurant websites.
 * Provides beautiful component examples that the AI model can reference
 * and customize for each restaurant's brand.
 */

// Tailwind CDN script tag (v3 via Play CDN)
export const tailwindCDN = `<script src="https://cdn.tailwindcss.com"></script>`;

/**
 * Generate a Tailwind config snippet customized for the restaurant
 */
export function tailwindConfig(restaurant) {
  const brandColor = restaurant.primary_color || '#2563eb';
  return `<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: '${brandColor}',
      }
    }
  }
}
</script>`;
}

/**
 * Design skill: beautiful Tailwind component examples.
 * The AI model uses these as a reference and customizes them.
 */
export const designSkill = `
TAILWIND COMPONENT REFERENCE — use these as starting points, customize for the restaurant's brand:

--- NAVBAR (identical on both pages) ---
<header class="fixed top-0 w-full bg-white/95 backdrop-blur-sm z-50 border-b border-gray-100">
  <nav class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
    <a href="index.html" class="text-xl font-bold tracking-tight text-gray-900">[RESTAURANT NAME]</a>
    <div class="flex items-center gap-8">
      <a href="index.html" class="text-sm font-medium text-gray-600 hover:text-brand transition-colors">Home</a>
      <a href="menu.html" class="text-sm font-medium text-gray-600 hover:text-brand transition-colors">Menu</a>
      <span id="header-cart-placeholder"></span>
    </div>
  </nav>
</header>

--- HERO (index.html, with photo) ---
<section class="relative min-h-[70vh] flex items-center justify-center overflow-hidden">
  <img src="[PHOTO_PATH]" alt="" class="absolute inset-0 w-full h-full object-cover">
  <div class="absolute inset-0 bg-gradient-to-b from-black/40 via-black/50 to-black/70"></div>
  <div class="relative z-10 text-center px-4 max-w-3xl">
    <h1 class="text-5xl md:text-7xl font-bold text-white tracking-tight mb-4">[NAME]</h1>
    <p class="text-lg md:text-xl text-white/90 mb-8 font-light">[TAGLINE]</p>
    <a href="menu.html" class="inline-block bg-brand hover:bg-brand/90 text-white px-8 py-3 rounded-full text-sm font-semibold tracking-wide uppercase transition-all hover:shadow-lg hover:shadow-brand/25">View Menu</a>
  </div>
</section>

--- HERO (index.html, NO photo — use gradient) ---
<section class="relative min-h-[70vh] flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-brand/80">
  <div class="absolute inset-0 opacity-10" style="background-image: url('data:image/svg+xml,...')"></div>
  <div class="relative z-10 text-center px-4 max-w-3xl">
    <h1 class="text-5xl md:text-7xl font-bold text-white tracking-tight mb-4">[NAME]</h1>
    <p class="text-lg md:text-xl text-white/80 mb-8 font-light">[TAGLINE]</p>
    <a href="menu.html" class="inline-block bg-white text-gray-900 px-8 py-3 rounded-full text-sm font-semibold tracking-wide uppercase transition-all hover:shadow-xl">View Menu</a>
  </div>
</section>

--- MENU CATEGORY HEADER ---
<div data-category="[CATEGORY]" class="mb-12">
  <div class="flex items-center gap-4 mb-8">
    <h2 class="text-2xl md:text-3xl font-bold text-gray-900 whitespace-nowrap">[CATEGORY]</h2>
    <div class="h-px bg-gray-200 flex-1"></div>
  </div>
  <!-- items go here -->
</div>

--- MENU ITEM CARD (clean, no images) ---
<div class="menu-item group flex items-start justify-between gap-4 py-4 border-b border-gray-100 last:border-0">
  <div class="flex-1 min-w-0">
    <div class="flex items-baseline gap-2">
      <h3 class="font-semibold text-gray-900 group-hover:text-brand transition-colors">[NAME]</h3>
      <span class="text-sm font-bold text-brand">$[PRICE]</span>
    </div>
    <p class="text-sm text-gray-500 mt-1 line-clamp-2">[DESCRIPTION]</p>
  </div>
  <button class="add-to-cart-btn shrink-0 bg-gray-900 hover:bg-brand text-white text-xs font-semibold px-4 py-2 rounded-full transition-all hover:shadow-md"
    data-item-id="[SLUG]" data-name="[NAME]" data-price="[PRICE]">
    Add
  </button>
</div>

--- ALTERNATIVE: MENU GRID CARDS (for shorter menus) ---
<div class="menu-item bg-white rounded-xl border border-gray-100 p-5 hover:shadow-md hover:border-brand/20 transition-all">
  <div class="flex items-start justify-between mb-3">
    <h3 class="font-semibold text-gray-900 leading-tight">[NAME]</h3>
    <span class="text-sm font-bold text-brand ml-2 whitespace-nowrap">$[PRICE]</span>
  </div>
  <p class="text-sm text-gray-500 mb-4 line-clamp-2">[DESCRIPTION]</p>
  <button class="add-to-cart-btn w-full bg-gray-900 hover:bg-brand text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
    data-item-id="[SLUG]" data-name="[NAME]" data-price="[PRICE]">
    Add to Cart
  </button>
</div>

--- ABOUT SECTION ---
<section class="py-16 md:py-24 bg-white">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
    <h2 class="text-3xl md:text-4xl font-bold text-gray-900 mb-6">Our Story</h2>
    <p class="text-lg text-gray-600 leading-relaxed">[DESCRIPTION]</p>
  </div>
</section>

--- FOOTER ---
<footer class="bg-gray-900 text-gray-400 py-12">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center">
      <h3 class="text-white text-lg font-bold mb-2">[NAME]</h3>
      <p class="text-sm">[ADDRESS] · [PHONE]</p>
      <p class="text-xs mt-4 text-gray-500">© ${new Date().getFullYear()} [NAME]. All rights reserved.</p>
    </div>
  </div>
</footer>
`;
