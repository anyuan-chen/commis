import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { analyzeLayout } from './layout-analyzer.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Remediation skills - injected into feedback when specific issues are detected
 * These give the AI actionable patterns to fix common problems
 */
const REMEDIATION_SKILLS = {
  'nav-overflow': {
    pattern: (issues) => issues.some(i =>
      i.type === 'layout' &&
      i.severity === 'error' &&
      i.message.includes('overflow') &&
      (i.message.includes('nav') || i.message.includes('ul') || i.message.includes('li'))
    ),
    guidance: `
MOBILE NAVIGATION FIX:
Your navigation overflows on mobile. Implement a hamburger menu:

CSS:
.nav-toggle { display: block; background: none; border: none; font-size: 1.5rem; cursor: pointer; padding: 8px; }
nav ul { display: none; position: absolute; top: 100%; left: 0; right: 0; background: white; flex-direction: column; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
nav ul.open { display: flex; }
nav li { margin: 0; border-bottom: 1px solid #eee; }
nav a { display: block; padding: 12px 20px; }
@media (min-width: 768px) {
  .nav-toggle { display: none; }
  nav ul { display: flex; position: static; flex-direction: row; box-shadow: none; }
  nav li { margin-left: 20px; border: none; }
}

HTML: Add <button class="nav-toggle" onclick="document.querySelector('nav ul').classList.toggle('open')">☰</button> before the <ul>
`
  },

  'touch-targets': {
    pattern: (issues) => issues.some(i =>
      i.type === 'layout' &&
      i.message.includes('too small')
    ),
    guidance: `
TOUCH TARGET FIX:
Buttons and interactive elements must be at least 44x44px for touch accessibility.

CSS fix:
button, .btn, a.button, [role="button"] {
  min-height: 44px;
  min-width: 44px;
  padding: 12px 24px;
}

For icon-only buttons (like close buttons), use:
.icon-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
}
`
  },

  'text-contrast': {
    pattern: (issues) => issues.some(i =>
      (i.type === 'layout' && i.message.includes('contrast')) ||
      (i.type === 'visual' && i.message.toLowerCase().includes('contrast'))
    ),
    guidance: `
TEXT CONTRAST FIX:
Text must have sufficient contrast (4.5:1 ratio minimum).

For text on images, always use an overlay:
.hero { position: relative; }
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0,0,0,0.4), rgba(0,0,0,0.7));
}
.hero-content { position: relative; z-index: 1; color: white; }

For general text:
- Light backgrounds (#fff, #f5f5f5): use dark text (#111, #333)
- Dark backgrounds (#1a1a2e, #111): use light text (#fff, #f5f5f5)
`
  },

  'overflow-general': {
    pattern: (issues) => issues.some(i =>
      i.type === 'layout' &&
      i.severity === 'error' &&
      i.message.includes('overflow') &&
      !i.message.includes('nav') && !i.message.includes('ul')
    ),
    guidance: `
OVERFLOW FIX:
Elements are wider than the viewport, causing horizontal scroll.

Common fixes:
1. Add to your reset: *, *::before, *::after { box-sizing: border-box; }
2. Constrain containers: .container { max-width: 100%; overflow-x: hidden; }
3. Make images responsive: img { max-width: 100%; height: auto; }
4. Check for fixed widths: Replace width: 500px with max-width: 500px; width: 100%;
5. Flex children: Add min-width: 0 to flex children that might overflow
`
  },

  'missing-responsive': {
    pattern: (issues) => issues.some(i =>
      i.type === 'static' &&
      i.message.includes('No media queries')
    ),
    guidance: `
RESPONSIVE DESIGN FIX:
Add media queries for different screen sizes. Use mobile-first approach:

/* Mobile base styles (default) */
.container { padding: 16px; }
.grid { display: flex; flex-direction: column; gap: 16px; }

/* Tablet and up */
@media (min-width: 768px) {
  .container { padding: 24px; }
  .grid { flex-direction: row; flex-wrap: wrap; }
  .grid > * { flex: 1 1 300px; }
}

/* Desktop */
@media (min-width: 1024px) {
  .container { padding: 32px; max-width: 1200px; margin: 0 auto; }
}
`
  }
};

/**
 * UI Evaluation Service
 * Takes screenshots of generated HTML and uses AI to evaluate visual quality,
 * providing specific feedback for iterative improvement.
 */
export class UIEvaluator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    this.browser = null;
  }

  /**
   * Initialize Puppeteer browser
   */
  async init() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  /**
   * Close browser when done
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Capture screenshots at multiple viewport sizes and run layout analysis
   * Returns { screenshots, layoutAnalysis }
   */
  async captureScreenshots(html, outputDir = null) {
    await this.init();

    const viewports = [
      { name: 'mobile', width: 375, height: 812 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1440, height: 900 }
    ];

    const screenshots = [];
    const layoutResults = {};
    const page = await this.browser.newPage();

    try {
      for (const vp of viewports) {
        await page.setViewport({ width: vp.width, height: vp.height });
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });

        // Wait briefly for fonts (don't block on external resources)
        await page.evaluate(() => Promise.race([
          document.fonts.ready,
          new Promise(r => setTimeout(r, 2000))
        ]));

        // Run layout analysis while page is rendered (measures actual computed styles)
        const layoutAnalysis = await analyzeLayout(page);
        layoutResults[vp.name] = layoutAnalysis;

        // Capture full page screenshot
        const buffer = await page.screenshot({
          fullPage: true,
          type: 'png'
        });

        const base64 = buffer.toString('base64');

        screenshots.push({
          viewport: vp.name,
          width: vp.width,
          height: vp.height,
          buffer,
          base64
        });

        // Save to disk if output directory provided
        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          await fs.writeFile(
            join(outputDir, `screenshot_${vp.name}.png`),
            buffer
          );
        }
      }
    } finally {
      await page.close();
    }

    return { screenshots, layoutAnalysis: layoutResults };
  }

  /**
   * Run static HTML/CSS analysis
   * Focused on high-signal checks that indicate real problems
   */
  analyzeStatic(html) {
    const issues = [];
    const warnings = [];

    // Critical: DOCTYPE
    if (!html.includes('<!DOCTYPE html>') && !html.includes('<!doctype html>')) {
      issues.push('Missing DOCTYPE declaration');
    }

    // Critical: Viewport meta for mobile
    if (!html.includes('<meta name="viewport"')) {
      issues.push('Missing viewport meta tag - site will not be mobile responsive');
    }

    // Important: Image accessibility
    const imgTags = html.match(/<img[^>]*>/gi) || [];
    const imgsWithoutAlt = imgTags.filter(img => !img.includes('alt='));
    if (imgsWithoutAlt.length > 0) {
      issues.push(`${imgsWithoutAlt.length} image(s) missing alt attributes`);
    }

    // Important: Responsive CSS
    const hasMediaQueries = html.includes('@media');
    if (!hasMediaQueries) {
      issues.push('No media queries - layout may break on mobile');
    }

    // Important: Template errors
    if (html.includes('>undefined<') || html.includes('>null<')) {
      issues.push('Template error: "undefined" or "null" rendered in output');
    }

    // Warnings: Nice to have
    const hasSemanticHTML = html.includes('<header') || html.includes('<main') || html.includes('<footer');
    if (!hasSemanticHTML) {
      warnings.push('No semantic HTML structure (header/main/footer)');
    }

    if (!html.includes('charset')) {
      warnings.push('Missing charset declaration');
    }

    return {
      issues,
      warnings,
      score: Math.max(0, 100 - (issues.length * 20) - (warnings.length * 5))
    };
  }

  /**
   * Use AI to evaluate visual quality from screenshots
   */
  async evaluateVisuals(screenshots, restaurantContext) {
    // Prepare images for Gemini
    const imageParts = screenshots.map(s => ({
      inlineData: {
        mimeType: 'image/png',
        data: s.base64
      }
    }));

    const prompt = `You are a senior UI/UX designer evaluating a restaurant website.

RESTAURANT CONTEXT:
- Name: ${restaurantContext.name || 'Restaurant'}
- Cuisine: ${restaurantContext.cuisine_type || 'Restaurant'}
- Vibe: ${restaurantContext.style_theme || 'modern'}
- Brand Color: ${restaurantContext.primary_color || '#2563eb'}

I'm showing you ${screenshots.length} screenshots of the same website at different viewport sizes:
${screenshots.map((s, i) => `${i + 1}. ${s.viewport} (${s.width}x${s.height})`).join('\n')}

Evaluate the design critically and honestly. Rate each category 1-10 and explain issues.

Return JSON only (no markdown):
{
  "scores": {
    "visualHierarchy": {
      "score": 1-10,
      "issues": ["specific issue 1", "specific issue 2"]
    },
    "typography": {
      "score": 1-10,
      "issues": ["e.g., font sizes too small", "poor font pairing"]
    },
    "colorAndContrast": {
      "score": 1-10,
      "issues": ["e.g., text hard to read", "colors don't match brand"]
    },
    "spacing": {
      "score": 1-10,
      "issues": ["e.g., elements too cramped", "inconsistent padding"]
    },
    "responsiveness": {
      "score": 1-10,
      "issues": ["e.g., mobile layout broken", "text overflow"]
    },
    "overallAesthetic": {
      "score": 1-10,
      "issues": ["e.g., looks dated", "doesn't match restaurant vibe"]
    }
  },
  "criticalIssues": [
    "Most severe issue that must be fixed",
    "Second most severe issue"
  ],
  "improvements": [
    "Specific actionable improvement with CSS/HTML guidance",
    "Another specific improvement"
  ],
  "overallScore": 1-10,
  "passesQualityBar": true/false,
  "summary": "One sentence overall assessment"
}

Be critical. A score of 7+ should mean it genuinely looks professional.
A score below 6 means it needs significant work before going live.`;

    const result = await this.model.generateContent([prompt, ...imageParts]);
    let response = result.response.text().trim();

    // Clean up markdown if present
    response = response.replace(/^```json\n?/i, '').replace(/\n?```$/i, '').trim();

    try {
      return JSON.parse(response);
    } catch (parseError) {
      console.error('Failed to parse visual evaluation JSON:', parseError.message);
      console.error('Raw response:', response.substring(0, 500));

      // Return a fallback evaluation so the system can continue
      return {
        scores: {
          visualHierarchy: { score: 5, issues: ['Unable to parse AI evaluation'] },
          typography: { score: 5, issues: [] },
          colorAndContrast: { score: 5, issues: [] },
          spacing: { score: 5, issues: [] },
          responsiveness: { score: 5, issues: [] },
          overallAesthetic: { score: 5, issues: [] }
        },
        criticalIssues: ['AI evaluation returned invalid JSON - manual review recommended'],
        improvements: ['Re-run evaluation or manually review the generated website'],
        overallScore: 5,
        passesQualityBar: false,
        summary: 'Evaluation failed to parse - defaulting to neutral scores'
      };
    }
  }

  /**
   * Deterministic menu completeness check
   * Compares rendered HTML against DB menu items to find missing/hallucinated content
   */
  checkMenuCompleteness(html, restaurantContext) {
    const menu = restaurantContext.menu || [];
    if (menu.length === 0) return { missing: [], hallucinated: [], score: 100 };

    // Build list of expected items from DB
    const expectedItems = [];
    for (const category of menu) {
      for (const item of category.items) {
        expectedItems.push({
          name: item.name,
          price: item.price,
          category: category.name
        });
      }
    }

    // Normalize HTML for searching (collapse whitespace, lowercase)
    const normalizedHtml = html.replace(/\s+/g, ' ').toLowerCase();

    // Check which items are missing from HTML
    const missing = [];
    const found = [];
    for (const item of expectedItems) {
      const normalizedName = item.name.toLowerCase().trim();
      if (normalizedHtml.includes(normalizedName)) {
        found.push(item);
      } else {
        // Try a more lenient match — check without special chars
        const simpleName = normalizedName.replace(/[^a-z0-9\s]/g, '');
        if (simpleName.length > 3 && normalizedHtml.includes(simpleName)) {
          found.push(item);
        } else {
          missing.push(item);
        }
      }
    }

    // Check for hallucinated prices: extract all data-price values and compare to DB prices
    const hallucinated = [];
    const dbPrices = new Set(expectedItems.map(i => String(i.price)));
    const dbNames = new Set(expectedItems.map(i => i.name.toLowerCase().trim()));
    const priceMatches = html.matchAll(/data-name="([^"]*)"[^>]*data-price="([^"]*)"/g);
    for (const match of priceMatches) {
      const btnName = match[1].toLowerCase().trim();
      const btnPrice = match[2];
      if (!dbNames.has(btnName)) {
        hallucinated.push({ name: match[1], price: btnPrice, reason: 'item not in database' });
      }
    }

    // Check for external image URLs (hallucinated images)
    const externalImages = [];
    const imgSrcMatches = html.matchAll(/src="(https?:\/\/[^"]*)"/g);
    for (const match of imgSrcMatches) {
      const url = match[1];
      // Allow Google Fonts, Stripe, and known CDNs for fonts/scripts
      if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') ||
          url.includes('js.stripe.com') || url.includes('cdnjs.cloudflare.com')) continue;
      externalImages.push(url);
    }

    const totalExpected = expectedItems.length;
    const foundCount = found.length;
    const completenessRatio = totalExpected > 0 ? foundCount / totalExpected : 1;
    // Penalize for external images and hallucinated items
    const penalty = Math.min(50, externalImages.length + hallucinated.length * 5);
    const score = Math.max(0, Math.round(completenessRatio * 100) - penalty);

    return {
      totalExpected,
      foundCount,
      missing,
      hallucinated,
      externalImages,
      score,
      completenessRatio
    };
  }

  /**
   * Full evaluation: static analysis + layout analysis + visual evaluation + menu completeness
   */
  async evaluate(html, restaurantContext, outputDir = null) {
    // Run static analysis (basic HTML checks)
    const staticAnalysis = this.analyzeStatic(html);

    // Run deterministic menu completeness check
    const menuCheck = this.checkMenuCompleteness(html, restaurantContext);

    // Capture screenshots AND run layout analysis (measures actual rendered layout)
    const { screenshots, layoutAnalysis } = await this.captureScreenshots(html, outputDir);

    // Run AI visual evaluation
    const visualEval = await this.evaluateVisuals(screenshots, restaurantContext);

    // Get mobile layout issues (most important for responsive)
    const mobileLayout = layoutAnalysis.mobile || { score: 100, issues: [] };

    // Combine scores: static (15%) + layout (25%) + visual (40%) + menu completeness (20%)
    const combinedScore = Math.round(
      (staticAnalysis.score * 0.15) +
      (mobileLayout.score * 0.25) +
      (visualEval.overallScore * 10 * 0.4) +
      (menuCheck.score * 0.2)
    );

    // Collect all layout issues from all viewports
    const layoutIssues = Object.entries(layoutAnalysis).flatMap(([viewport, analysis]) =>
      (analysis.issues || []).map(issue => ({
        ...issue,
        viewport,
        type: 'layout'
      }))
    );

    // Build menu completeness issues
    const menuIssues = [];
    if (menuCheck.missing.length > 0) {
      const missingNames = menuCheck.missing.map(i => i.name).join(', ');
      menuIssues.push({
        type: 'menu',
        severity: 'error',
        message: `Missing ${menuCheck.missing.length} of ${menuCheck.totalExpected} menu items: ${missingNames}`
      });
    }
    if (menuCheck.hallucinated.length > 0) {
      const hallNames = menuCheck.hallucinated.map(i => `${i.name} (${i.reason})`).join(', ');
      menuIssues.push({
        type: 'menu',
        severity: 'error',
        message: `Hallucinated content: ${hallNames}`
      });
    }
    if (menuCheck.externalImages.length > 0) {
      menuIssues.push({
        type: 'menu',
        severity: 'error',
        message: `${menuCheck.externalImages.length} external image URLs found (e.g. unsplash.com). Only use provided local photo paths.`
      });
    }

    const menuHasErrors = menuCheck.missing.length > 0 || menuCheck.hallucinated.length > 0 || menuCheck.externalImages.length > 0;

    return {
      staticAnalysis,
      menuCheck,
      layoutAnalysis: {
        mobile: mobileLayout,
        tablet: layoutAnalysis.tablet,
        desktop: layoutAnalysis.desktop
      },
      visualEvaluation: visualEval,
      combinedScore,
      passesQualityBar: visualEval.passesQualityBar &&
                        staticAnalysis.issues.length === 0 &&
                        mobileLayout.issues.filter(i => i.severity === 'error').length === 0 &&
                        !menuHasErrors,
      allIssues: [
        ...menuIssues,
        ...staticAnalysis.issues.map(i => ({ type: 'static', severity: 'error', message: i })),
        ...staticAnalysis.warnings.map(w => ({ type: 'static', severity: 'warning', message: w })),
        ...layoutIssues,
        ...visualEval.criticalIssues.map(i => ({ type: 'visual', severity: 'critical', message: i })),
        ...Object.entries(visualEval.scores)
          .filter(([_, v]) => v.score < 6)
          .flatMap(([cat, v]) => v.issues.map(i => ({
            type: 'visual',
            severity: 'error',
            category: cat,
            message: i
          })))
      ],
      improvements: visualEval.improvements,
      screenshots: screenshots.map(s => ({ viewport: s.viewport, width: s.width, height: s.height }))
    };
  }

  /**
   * Generate improvement feedback for the AI generator
   * Returns a structured prompt section to include in regeneration
   */
  generateFeedback(evaluation) {
    const lines = [];

    lines.push('FEEDBACK FROM UI EVALUATION:');
    lines.push(`Overall Score: ${evaluation.combinedScore}/100`);
    lines.push('');

    // PRIORITY 0: Menu completeness (most critical — missing items = broken product)
    if (evaluation.menuCheck) {
      const mc = evaluation.menuCheck;
      if (mc.missing.length > 0) {
        lines.push(`⚠️ MENU COMPLETENESS ERROR — Missing ${mc.missing.length} of ${mc.totalExpected} menu items.`);
        lines.push('You MUST include ALL of the following items that are currently missing:');
        // Group missing items by category for clarity
        const byCategory = {};
        for (const item of mc.missing) {
          if (!byCategory[item.category]) byCategory[item.category] = [];
          byCategory[item.category].push(item);
        }
        for (const [cat, items] of Object.entries(byCategory)) {
          lines.push(`  ${cat}: ${items.map(i => `${i.name} ($${i.price})`).join(', ')}`);
        }
        lines.push('');
      }
      if (mc.hallucinated.length > 0) {
        lines.push('⚠️ HALLUCINATED CONTENT — Remove these items that are NOT in the database:');
        mc.hallucinated.forEach(h => lines.push(`  - ${h.name}: ${h.reason}`));
        lines.push('');
      }
      if (mc.externalImages?.length > 0) {
        lines.push(`⚠️ EXTERNAL IMAGES — Remove all ${mc.externalImages.length} external image URLs (unsplash.com, etc).`);
        lines.push('Only use the local photo paths provided in the PHOTOS section. Do NOT use any https:// image URLs.');
        lines.push('');
      }
    }

    // PRIORITY 1: Layout errors with remediation (most important - causes broken pages)
    const applicableSkills = this.detectApplicableSkills(evaluation);
    const layoutSkills = applicableSkills.filter(s =>
      ['nav-overflow', 'overflow-general', 'touch-targets'].includes(s.name)
    );

    if (evaluation.layoutAnalysis) {
      const mobileErrors = evaluation.layoutAnalysis.mobile?.issues?.filter(i => i.severity === 'error') || [];

      if (mobileErrors.length > 0) {
        lines.push('⚠️ LAYOUT ERRORS - FIX THESE FIRST:');
        mobileErrors.forEach(issue => {
          lines.push(`- ${issue.message}`);
        });

        // Inject relevant skills immediately after the errors they fix
        if (layoutSkills.length > 0) {
          lines.push('');
          lines.push('HOW TO FIX:');
          layoutSkills.forEach(skill => {
            lines.push(skill.guidance);
          });
        }
        lines.push('');
      }
    }

    // PRIORITY 2: Critical visual issues (brief)
    if (evaluation.visualEvaluation.criticalIssues.length > 0) {
      lines.push('VISUAL ISSUES:');
      evaluation.visualEvaluation.criticalIssues.forEach((issue, i) => {
        lines.push(`${i + 1}. ${issue}`);
      });
      lines.push('');
    }

    // PRIORITY 3: Specific improvements (actionable)
    if (evaluation.improvements.length > 0) {
      lines.push('IMPROVEMENTS:');
      evaluation.improvements.slice(0, 2).forEach((imp, i) => {
        lines.push(`${i + 1}. ${imp}`);
      });
      lines.push('');
    }

    // Skip verbose category breakdowns - they add noise and contradict each other

    return lines.join('\n');
  }

  /**
   * Detect which remediation skills apply based on evaluation issues
   */
  detectApplicableSkills(evaluation) {
    const allIssues = evaluation.allIssues || [];
    const applicable = [];

    for (const [name, skill] of Object.entries(REMEDIATION_SKILLS)) {
      if (skill.pattern(allIssues)) {
        applicable.push({
          name,
          guidance: skill.guidance
        });
      }
    }

    return applicable;
  }
}
