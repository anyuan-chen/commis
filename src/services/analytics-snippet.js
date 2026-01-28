/**
 * Analytics Snippet Generator
 * Generates JavaScript tracking code to inject into generated websites
 */
export class AnalyticsSnippet {
  constructor(options = {}) {
    this.cookieDays = options.cookieDays || 30;
    this.apiBase = options.apiBase || '/api/analytics';
  }

  /**
   * Generate the full analytics snippet for a restaurant website
   * @param {string} restaurantId - Restaurant ID
   * @returns {string} JavaScript code to inject
   */
  generate(restaurantId) {
    return `
<!-- Pique Analytics -->
<script>
(function() {
  const RESTAURANT_ID = '${restaurantId}';
  const API_BASE = '${this.apiBase}';
  const COOKIE_DAYS = ${this.cookieDays};

  // Session management
  function getSessionId() {
    let sessionId = sessionStorage.getItem('pique_session');
    if (!sessionId) {
      sessionId = 'ses_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      sessionStorage.setItem('pique_session', sessionId);
    }
    return sessionId;
  }

  // Variant cookie management (cookie is set server-side by variant middleware)
  function getVariantId() {
    const match = document.cookie.match(/pique_variant_${restaurantId}=([^;]+)/);
    return match ? match[1] : null;
  }

  // Event queue for batching
  let eventQueue = [];
  let flushTimeout = null;

  // Track event
  function track(eventType, eventData = {}) {
    const event = {
      restaurantId: RESTAURANT_ID,
      sessionId: getSessionId(),
      variantId: getVariantId(),
      eventType: eventType,
      eventData: eventData,
      timestamp: Date.now()
    };

    eventQueue.push(event);

    // Debounce flush
    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(flushEvents, 1000);
  }

  // Flush events to server
  async function flushEvents() {
    if (eventQueue.length === 0) return;

    const events = eventQueue.splice(0, eventQueue.length);

    try {
      // Use sendBeacon for reliability
      const data = JSON.stringify({ events: events });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(API_BASE + '/event', data);
      } else {
        fetch(API_BASE + '/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
          keepalive: true
        });
      }
    } catch (e) {
      console.debug('Pique: event flush failed', e);
    }
  }

  // Scroll tracking
  let scrollMilestones = { 25: false, 50: false, 75: false, 100: false };

  function trackScroll() {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight <= 0) return;

    const scrollPercent = Math.round((scrollTop / docHeight) * 100);

    for (const milestone of [25, 50, 75, 100]) {
      if (scrollPercent >= milestone && !scrollMilestones[milestone]) {
        scrollMilestones[milestone] = true;
        track('scroll', { depth: milestone });
      }
    }
  }

  // Time on page tracking
  const pageLoadTime = Date.now();

  function trackTimeOnPage() {
    const seconds = Math.round((Date.now() - pageLoadTime) / 1000);
    track('time_on_page', { seconds: seconds });
    flushEvents(); // Immediate flush on unload
  }

  // Click tracking
  function trackClick(event) {
    const target = event.target.closest('a, button, [role="button"]');
    if (!target) return;

    const data = {
      tagName: target.tagName,
      text: (target.textContent || '').trim().slice(0, 100),
      href: target.href || null,
      classes: target.className || null
    };

    // Detect CTA buttons
    const text = data.text.toLowerCase();
    if (text.includes('order') || text.includes('buy') || text.includes('add to cart') ||
        text.includes('checkout') || text.includes('reserve') || text.includes('book')) {
      data.isCta = true;
    }

    track('click', data);
  }

  // Cart tracking - wrap existing addToCart if present
  function wrapCartFunctions() {
    if (window.addToCart) {
      const originalAddToCart = window.addToCart;
      window.addToCart = function(id, name, price) {
        track('cart_add', { itemId: id, name: name, price: price });
        return originalAddToCart.apply(this, arguments);
      };
    }
  }

  // Order tracking via postMessage (from checkout iframe/redirect)
  function handleOrderMessage(event) {
    if (event.data && event.data.type === 'pique_order') {
      track('order', {
        orderId: event.data.orderId,
        total: event.data.total,
        itemCount: event.data.itemCount
      });
      flushEvents();
    }
  }

  // Initialize
  function init() {
    // Variant is assigned server-side via cookie (no async needed)

    // Track pageview
    track('pageview', {
      url: window.location.href,
      referrer: document.referrer || null,
      page: window.location.pathname
    });

    // Scroll tracking (throttled)
    let scrollThrottle = false;
    window.addEventListener('scroll', function() {
      if (scrollThrottle) return;
      scrollThrottle = true;
      requestAnimationFrame(function() {
        trackScroll();
        scrollThrottle = false;
      });
    }, { passive: true });

    // Click tracking
    document.addEventListener('click', trackClick, true);

    // Time on page
    window.addEventListener('beforeunload', trackTimeOnPage);
    window.addEventListener('pagehide', trackTimeOnPage);

    // Cart wrapping (wait for page load)
    if (document.readyState === 'complete') {
      wrapCartFunctions();
    } else {
      window.addEventListener('load', wrapCartFunctions);
    }

    // Order messages
    window.addEventListener('message', handleOrderMessage);

    // Check URL for order confirmation
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('order_success')) {
      track('order', {
        orderId: urlParams.get('order_id') || 'unknown',
        fromCheckout: true
      });
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for manual tracking
  window.piqueAnalytics = { track: track, flush: flushEvents };
})();
</script>`;
  }

  /**
   * Generate minimal CSS for any analytics UI elements (if needed in future)
   * @returns {string} CSS code
   */
  generateCSS() {
    return `
<style>
/* Pique Analytics - No visible UI elements */
</style>`;
  }
}

export const analyticsSnippet = new AnalyticsSnippet();
