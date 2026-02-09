/**
 * Layout Analyzer - Uses Puppeteer to measure actual rendered layout
 * Focused on high-signal checks that indicate real problems
 */

/**
 * Analyze layout issues by running checks in the actual browser context
 * @param {Page} page - Puppeteer page with content loaded
 * @returns {Promise<object>} Analysis results
 */
export async function analyzeLayout(page) {
  return await page.evaluate(() => {
    const issues = [];

    // 1. Check for horizontal overflow (causes mobile scroll issues) - HIGH VALUE
    const docWidth = document.documentElement.clientWidth;
    let overflowElements = 0;
    const overflowExamples = [];

    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();

      // Skip elements fully outside viewport (e.g., off-screen slide panels)
      // These are intentionally positioned off-screen, not overflow
      if (rect.left >= docWidth) return;

      // Skip zero-size or invisible elements
      if (rect.width === 0 || rect.height === 0) return;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') return;

      // Check if element extends past viewport
      if (rect.right > docWidth + 5) { // 5px tolerance
        overflowElements++;
        // Capture first few examples for debugging
        if (overflowExamples.length < 3) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${el.className.split(' ')[0]}` : '';
          overflowExamples.push(`${tag}${id || cls || ''}`);
        }
      }
    });

    if (overflowElements > 0) {
      const examples = overflowExamples.length > 0 ? ` (${overflowExamples.join(', ')})` : '';
      issues.push({
        type: 'overflow',
        severity: 'error',
        message: `${overflowElements} element(s) overflow viewport width${examples}`
      });
    }

    // 2. Check text contrast - HIGH VALUE for accessibility
    const contrastIssues = [];
    document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, li').forEach(el => {
      const style = getComputedStyle(el);
      const color = style.color;
      const bgColor = style.backgroundColor;

      const parseRgb = (str) => {
        const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return match ? { r: +match[1], g: +match[2], b: +match[3] } : null;
      };

      const fg = parseRgb(color);
      const bg = parseRgb(bgColor);

      // Only check if element has explicit background (not transparent)
      if (fg && bg && (bg.r > 0 || bg.g > 0 || bg.b > 0)) {
        const fgLum = (0.299 * fg.r + 0.587 * fg.g + 0.114 * fg.b) / 255;
        const bgLum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
        const contrast = Math.abs(fgLum - bgLum);

        if (contrast < 0.3) { // More lenient threshold
          const text = el.textContent?.slice(0, 30)?.trim();
          if (text && text.length > 2) {
            contrastIssues.push(text);
          }
        }
      }
    });

    if (contrastIssues.length > 0) {
      issues.push({
        type: 'contrast',
        severity: 'error',
        message: `Low contrast text: "${contrastIssues[0]}..."`,
        count: contrastIssues.length
      });
    }

    // 3. Check critical touch targets - only buttons and primary CTAs
    document.querySelectorAll('button, [type="submit"], .btn, .add-to-cart-btn').forEach(el => {
      const rect = el.getBoundingClientRect();
      // Only flag very small targets (< 40px) - 44px is ideal but 40px is acceptable
      if (rect.width > 0 && rect.height > 0 && (rect.width < 40 || rect.height < 40)) {
        issues.push({
          type: 'touch-target',
          severity: 'warning',
          message: `Button too small (${Math.round(rect.width)}x${Math.round(rect.height)}px): ${el.textContent?.slice(0, 15) || 'button'}`
        });
      }
    });

    // 4. Check images in viewport have reasonable sizes (not broken)
    document.querySelectorAll('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      // Flag images that rendered at 0 size (broken) or very tiny
      if (rect.width > 0 && rect.width < 20 && rect.height < 20) {
        issues.push({
          type: 'broken-image',
          severity: 'warning',
          message: `Possibly broken image: ${img.src?.split('/').pop() || 'unknown'}`
        });
      }
    });

    // Calculate score - simpler weights
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;

    const score = Math.max(0, 100 - (errorCount * 25) - (warningCount * 10));

    return {
      score,
      issues,
      counts: { error: errorCount, warning: warningCount }
    };
  });
}

