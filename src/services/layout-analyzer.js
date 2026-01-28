/**
 * Layout Analyzer - Uses Puppeteer to measure actual rendered layout
 * Much more reliable than parsing CSS because it sees computed values
 */

/**
 * Analyze layout issues by running checks in the actual browser context
 * @param {Page} page - Puppeteer page with content loaded
 * @returns {Promise<object>} Analysis results
 */
export async function analyzeLayout(page) {
  return await page.evaluate(() => {
    const issues = [];

    // 1. Check button consistency - do buttons with same class have same size?
    const buttonGroups = {};
    document.querySelectorAll('button, .btn, [class*="btn"], [role="button"]').forEach(btn => {
      const rect = btn.getBoundingClientRect();
      const style = getComputedStyle(btn);
      const key = btn.className || 'button';

      if (!buttonGroups[key]) buttonGroups[key] = [];
      buttonGroups[key].push({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        padding: style.padding,
        fontSize: style.fontSize
      });
    });

    // Find inconsistent button sizes within same class
    for (const [className, buttons] of Object.entries(buttonGroups)) {
      if (buttons.length < 2) continue;

      const heights = [...new Set(buttons.map(b => b.height))];
      const widths = [...new Set(buttons.map(b => b.width))];

      if (heights.length > 1) {
        issues.push({
          type: 'button-alignment',
          severity: 'warning',
          message: `Buttons with class "${className}" have inconsistent heights: ${heights.join(', ')}px`
        });
      }
    }

    // 2. Check for elements that might cause layout shift (no explicit dimensions)
    document.querySelectorAll('img').forEach(img => {
      if (!img.hasAttribute('width') && !img.hasAttribute('height')) {
        const style = getComputedStyle(img);
        if (style.width === 'auto' || style.height === 'auto') {
          issues.push({
            type: 'layout-shift',
            severity: 'warning',
            message: `Image without dimensions: ${img.src?.slice(-30) || 'unknown'}`,
            fix: 'Add width/height attributes or CSS aspect-ratio'
          });
        }
      }
    });

    // 3. Check touch target sizes (44x44 minimum for mobile)
    document.querySelectorAll('button, a, [onclick], input[type="submit"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) {
        // Only flag if it's actually visible
        if (rect.width > 0 && rect.height > 0) {
          issues.push({
            type: 'touch-target',
            severity: 'info',
            message: `Small touch target (${Math.round(rect.width)}x${Math.round(rect.height)}px): ${el.textContent?.slice(0, 20) || el.className}`
          });
        }
      }
    });

    // 4. Check text contrast using computed colors
    const contrastIssues = [];
    document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, td').forEach(el => {
      const style = getComputedStyle(el);
      const color = style.color;
      const bgColor = style.backgroundColor;

      // Parse rgb values
      const parseRgb = (str) => {
        const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return match ? { r: +match[1], g: +match[2], b: +match[3] } : null;
      };

      const fg = parseRgb(color);
      const bg = parseRgb(bgColor);

      if (fg && bg && bg.r !== 0 && bg.g !== 0 && bg.b !== 0) { // Has non-transparent bg
        // Simple luminance check
        const fgLum = (0.299 * fg.r + 0.587 * fg.g + 0.114 * fg.b) / 255;
        const bgLum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
        const contrast = Math.abs(fgLum - bgLum);

        if (contrast < 0.2) {
          const text = el.textContent?.slice(0, 30);
          if (text?.trim()) {
            contrastIssues.push(`"${text}..."`);
          }
        }
      }
    });

    if (contrastIssues.length > 0) {
      issues.push({
        type: 'contrast',
        severity: 'error',
        message: `Low contrast text detected`,
        elements: contrastIssues.slice(0, 3)
      });
    }

    // 5. Check for horizontal overflow (causes mobile scroll issues)
    const docWidth = document.documentElement.clientWidth;
    let overflowElements = 0;
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > docWidth + 5) { // 5px tolerance
        overflowElements++;
      }
    });

    if (overflowElements > 0) {
      issues.push({
        type: 'overflow',
        severity: 'error',
        message: `${overflowElements} element(s) overflow viewport width (causes horizontal scroll)`
      });
    }

    // 6. Check flex/grid alignment - are items in a row actually aligned?
    document.querySelectorAll('[style*="flex"], [style*="grid"]').forEach(container => {
      const children = container.children;
      if (children.length < 2) return;

      const tops = [];
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        if (rect.height > 0) tops.push(Math.round(rect.top));
      }

      // If they're supposed to be in a row, tops should be similar
      const uniqueTops = [...new Set(tops)];
      if (uniqueTops.length > 1 && uniqueTops.length < tops.length) {
        // Some items aligned, some not
        const maxDiff = Math.max(...uniqueTops) - Math.min(...uniqueTops);
        if (maxDiff > 5 && maxDiff < 50) { // Slight misalignment, not intentional wrapping
          issues.push({
            type: 'alignment',
            severity: 'warning',
            message: `Flex items misaligned by ${maxDiff}px in container`
          });
        }
      }
    });

    // 7. Check for consistent spacing (margin/padding)
    const spacings = new Map();
    document.querySelectorAll('section, article, .container, main > *').forEach(el => {
      const style = getComputedStyle(el);
      ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom'].forEach(prop => {
        const val = parseInt(style[prop]);
        if (val > 0) {
          spacings.set(val, (spacings.get(val) || 0) + 1);
        }
      });
    });

    if (spacings.size > 8) {
      issues.push({
        type: 'spacing',
        severity: 'info',
        message: `${spacings.size} different spacing values - consider using a spacing scale`,
        values: [...spacings.keys()].sort((a,b) => a-b).slice(0, 8).map(v => v + 'px')
      });
    }

    // 8. Check z-index stacking (look for absurdly high values)
    let maxZIndex = 0;
    document.querySelectorAll('*').forEach(el => {
      const z = parseInt(getComputedStyle(el).zIndex);
      if (!isNaN(z) && z > maxZIndex) maxZIndex = z;
    });

    if (maxZIndex > 9999) {
      issues.push({
        type: 'z-index',
        severity: 'info',
        message: `High z-index detected (${maxZIndex}) - may indicate stacking issues`
      });
    }

    // Calculate score
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const infoCount = issues.filter(i => i.severity === 'info').length;

    const score = Math.max(0, 100 - (errorCount * 20) - (warningCount * 10) - (infoCount * 3));

    return {
      score,
      issues,
      counts: { error: errorCount, warning: warningCount, info: infoCount },
      meta: {
        buttonGroups: Object.keys(buttonGroups).length,
        uniqueSpacings: spacings.size,
        maxZIndex
      }
    };
  });
}

/**
 * Check for Cumulative Layout Shift using PerformanceObserver
 * Run this while the page loads to detect actual shifts
 */
export async function measureCLS(page, timeout = 3000) {
  // Inject CLS observer before loading content
  await page.evaluateOnNewDocument(() => {
    window.__clsScore = 0;
    window.__clsEntries = [];

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__clsScore += entry.value;
          window.__clsEntries.push({
            value: entry.value,
            sources: entry.sources?.map(s => s.node?.nodeName) || []
          });
        }
      }
    });

    observer.observe({ type: 'layout-shift', buffered: true });
  });

  // Wait for page to settle
  await new Promise(r => setTimeout(r, timeout));

  // Get CLS results
  return await page.evaluate(() => ({
    clsScore: window.__clsScore || 0,
    entries: window.__clsEntries || [],
    rating: window.__clsScore < 0.1 ? 'good' : window.__clsScore < 0.25 ? 'needs-improvement' : 'poor'
  }));
}
