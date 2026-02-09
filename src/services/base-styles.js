/**
 * Minimal structural CSS - just the stuff that MUST work (cart system)
 * Everything else: let AI generate, let analyzers catch problems
 */

export const structuralCSS = `
/* Reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { max-width: 100%; height: auto; display: block; }

/* Cart triggers - responsive show/hide */
#cart-header-btn {
  display: none;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.25rem;
  padding: 0.5rem;
  min-width: 44px;
  min-height: 44px;
}
#cart-bottom-bar {
  display: flex;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  background: #111;
  color: #fff;
  padding: 1rem 1.5rem;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  font-weight: 500;
}
#cart-bottom-bar:empty, #cart-bottom-bar[data-empty="true"] { display: none; }

@media (min-width: 768px) {
  #cart-header-btn { display: flex; }
  #cart-bottom-bar { display: none; }
  body { padding-bottom: 0; }
}
@media (max-width: 767px) {
  body { padding-bottom: 70px; }
}

/* Cart count badge */
.cart-count {
  background: #e53e3e;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
  min-width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cart-count:empty, .cart-count[data-count="0"] { display: none; }

/* Cart panel (slide-in from right) */
#cart-overlay {
  position: fixed;
  inset: 0;
  z-index: 1001;
  background: rgba(0,0,0,0.5);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.3s, visibility 0.3s;
}
#cart-overlay.open { opacity: 1; visibility: visible; }
#cart-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 100%;
  max-width: 400px;
  height: 100%;
  z-index: 1002;
  background: #fff;
  transform: translateX(100%);
  transition: transform 0.3s ease;
  display: flex;
  flex-direction: column;
}
#cart-panel.open { transform: translateX(0); }
#cart-header { padding: 1rem; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
#cart-header h2 { margin: 0; font-size: 1.25rem; }
#cart-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; min-width: 44px; min-height: 44px; }
#cart-items { flex: 1; overflow-y: auto; padding: 1rem; }
#cart-empty { color: #888; text-align: center; padding: 2rem; }
#cart-footer { padding: 1rem; border-top: 1px solid #eee; }
.cart-subtotal { display: flex; justify-content: space-between; margin-bottom: 1rem; font-weight: 500; }
#checkout-btn { width: 100%; padding: 1rem; background: #111; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
#checkout-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cart-item { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #eee; }
.cart-item-info { flex: 1; }
.cart-item-name { font-weight: 500; }
.cart-item-price { color: #666; font-size: 0.875rem; }
.cart-item-controls { display: flex; align-items: center; gap: 0.5rem; }
.qty-btn { width: 32px; height: 32px; border: 1px solid #ddd; background: #fff; border-radius: 4px; cursor: pointer; }
.cart-item-qty { min-width: 1.5rem; text-align: center; }
.cart-item-total { min-width: 3.5rem; text-align: right; font-weight: 500; }
.cart-item-remove { background: none; border: none; color: #999; cursor: pointer; font-size: 1.25rem; }

/* Toast notification */
#cart-toast {
  position: fixed;
  bottom: 5rem;
  left: 50%;
  transform: translateX(-50%) translateY(10px);
  z-index: 1003;
  background: #333;
  color: #fff;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  opacity: 0;
  transition: opacity 0.3s, transform 0.3s;
  pointer-events: none;
}
#cart-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
@media (min-width: 768px) {
  #cart-toast { bottom: 2rem; left: auto; right: 2rem; transform: translateY(10px); }
  #cart-toast.show { transform: translateY(0); }
}

/* Accessibility */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;

/**
 * Simple style prompt - gives AI direction without locking it down
 */
export function generateStylePrompt(restaurant) {
  const style = restaurant.style_theme || 'modern';
  const color = restaurant.primary_color || '#2563eb';

  const vibes = {
    'fine-dining': 'elegant and sophisticated - think high-end, luxurious, refined',
    'casual': 'warm and welcoming - friendly, approachable, comfortable',
    'trendy': 'bold and contemporary - instagram-worthy, high contrast, creative',
    'rustic': 'earthy and cozy - farm-to-table, handcrafted feel, natural',
    'modern': 'clean and minimal - professional, uncluttered, functional',
    'fast-casual': 'energetic and efficient - bold, quick to scan, appetizing'
  };

  return `
STYLE DIRECTION:
Vibe: ${vibes[style] || vibes['modern']}
Brand color: ${color} (use this prominently)

Design a unique website that feels ${style}. Be creative with:
- Typography (pick Google Fonts that match the vibe)
- Color palette (build from the brand color)
- Layout and spacing
- Card/menu item design
- Hero section
- Hover effects and animations

TECHNICAL REQUIREMENTS:
- All CSS in <style> tags
- Mobile-first responsive (use @media queries)
- Viewport meta tag required
- Images need alt attributes
- Buttons minimum 44x44px for touch
- Hero text needs contrast (overlay on images)
`;
}
