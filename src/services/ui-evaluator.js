import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { analyzeLayout } from './layout-analyzer.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * UI Evaluation Service
 * Takes screenshots of generated HTML and uses AI to evaluate visual quality,
 * providing specific feedback for iterative improvement.
 */
export class UIEvaluator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
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
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 10000 });

        // Wait for fonts to load
        await page.evaluate(() => document.fonts.ready);

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
   * Checks for common issues without AI
   */
  analyzeStatic(html) {
    const issues = [];
    const warnings = [];

    // Check for basic structure
    if (!html.includes('<!DOCTYPE html>') && !html.includes('<!doctype html>')) {
      issues.push('Missing DOCTYPE declaration');
    }

    if (!html.includes('<meta name="viewport"')) {
      issues.push('Missing viewport meta tag - site may not be mobile responsive');
    }

    if (!html.includes('charset')) {
      warnings.push('Missing charset declaration');
    }

    // Check for semantic HTML
    const hasHeader = html.includes('<header');
    const hasMain = html.includes('<main');
    const hasFooter = html.includes('<footer');
    const hasNav = html.includes('<nav');

    if (!hasHeader && !hasMain && !hasFooter) {
      warnings.push('Missing semantic HTML structure (header/main/footer)');
    }

    // Check for accessibility basics
    const imgTags = html.match(/<img[^>]*>/gi) || [];
    const imgsWithoutAlt = imgTags.filter(img => !img.includes('alt='));
    if (imgsWithoutAlt.length > 0) {
      issues.push(`${imgsWithoutAlt.length} image(s) missing alt attributes`);
    }

    // Check for responsive patterns
    const hasMediaQueries = html.includes('@media');
    const hasFlexbox = html.includes('display: flex') || html.includes('display:flex');
    const hasGrid = html.includes('display: grid') || html.includes('display:grid');

    if (!hasMediaQueries) {
      issues.push('No media queries found - layout may not be responsive');
    }

    if (!hasFlexbox && !hasGrid) {
      warnings.push('No flexbox or grid detected - may have layout issues');
    }

    // Check for color contrast issues (basic)
    const hasWhiteOnLight = /#fff.*background.*#[ef]/i.test(html) ||
      /color:\s*white.*background.*#[ef]/i.test(html);
    if (hasWhiteOnLight) {
      warnings.push('Potential contrast issue: light text on light background detected');
    }

    // Check for prefers-reduced-motion
    if (!html.includes('prefers-reduced-motion')) {
      warnings.push('Missing prefers-reduced-motion support');
    }

    // Check CSS specifics
    const hasFontFamily = html.includes('font-family');
    if (!hasFontFamily) {
      issues.push('No font-family declarations found');
    }

    // Check for common broken patterns
    if (html.includes('undefined') || html.includes('null')) {
      issues.push('Possible template error: "undefined" or "null" found in output');
    }

    // Check for z-index issues (z-index without position)
    const zIndexMatches = html.match(/z-index:\s*\d+/g) || [];
    if (zIndexMatches.length > 10) {
      warnings.push('Excessive z-index usage may indicate layering issues');
    }

    return {
      issues,
      warnings,
      hasSemanticHTML: hasHeader || hasMain || hasFooter,
      hasResponsivePatterns: hasMediaQueries,
      hasModernLayout: hasFlexbox || hasGrid,
      score: Math.max(0, 100 - (issues.length * 15) - (warnings.length * 5))
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

    return JSON.parse(response);
  }

  /**
   * Full evaluation: static analysis + layout analysis + visual evaluation
   */
  async evaluate(html, restaurantContext, outputDir = null) {
    // Run static analysis (basic HTML checks)
    const staticAnalysis = this.analyzeStatic(html);

    // Capture screenshots AND run layout analysis (measures actual rendered layout)
    const { screenshots, layoutAnalysis } = await this.captureScreenshots(html, outputDir);

    // Run AI visual evaluation
    const visualEval = await this.evaluateVisuals(screenshots, restaurantContext);

    // Get mobile layout issues (most important for responsive)
    const mobileLayout = layoutAnalysis.mobile || { score: 100, issues: [] };

    // Combine scores: static (20%) + layout (30%) + visual (50%)
    const combinedScore = Math.round(
      (staticAnalysis.score * 0.2) +
      (mobileLayout.score * 0.3) +
      (visualEval.overallScore * 10 * 0.5)
    );

    // Collect all layout issues from all viewports
    const layoutIssues = Object.entries(layoutAnalysis).flatMap(([viewport, analysis]) =>
      (analysis.issues || []).map(issue => ({
        ...issue,
        viewport,
        type: 'layout'
      }))
    );

    return {
      staticAnalysis,
      layoutAnalysis: {
        mobile: mobileLayout,
        tablet: layoutAnalysis.tablet,
        desktop: layoutAnalysis.desktop
      },
      visualEvaluation: visualEval,
      combinedScore,
      passesQualityBar: visualEval.passesQualityBar &&
                        staticAnalysis.issues.length === 0 &&
                        mobileLayout.issues.filter(i => i.severity === 'error').length === 0,
      allIssues: [
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
    lines.push(`Overall Score: ${evaluation.combinedScore}/100 (needs ${evaluation.passesQualityBar ? 'minor' : 'significant'} improvements)`);
    lines.push('');

    if (evaluation.visualEvaluation.criticalIssues.length > 0) {
      lines.push('CRITICAL ISSUES (must fix):');
      evaluation.visualEvaluation.criticalIssues.forEach((issue, i) => {
        lines.push(`${i + 1}. ${issue}`);
      });
      lines.push('');
    }

    // Add layout issues from actual rendered measurement
    if (evaluation.layoutAnalysis) {
      const mobileErrors = evaluation.layoutAnalysis.mobile?.issues?.filter(i => i.severity === 'error') || [];
      const mobileWarnings = evaluation.layoutAnalysis.mobile?.issues?.filter(i => i.severity === 'warning') || [];

      if (mobileErrors.length > 0) {
        lines.push('MOBILE LAYOUT ERRORS (measured from actual render):');
        mobileErrors.forEach(issue => {
          lines.push(`- ${issue.message}`);
        });
        lines.push('');
      }

      if (mobileWarnings.length > 0) {
        lines.push('LAYOUT WARNINGS:');
        mobileWarnings.slice(0, 5).forEach(issue => {
          lines.push(`- ${issue.message}`);
        });
        lines.push('');
      }
    }

    if (evaluation.staticAnalysis.issues.length > 0) {
      lines.push('TECHNICAL ISSUES:');
      evaluation.staticAnalysis.issues.forEach((issue, i) => {
        lines.push(`- ${issue}`);
      });
      lines.push('');
    }

    const lowScoreCategories = Object.entries(evaluation.visualEvaluation.scores)
      .filter(([_, v]) => v.score < 7)
      .sort((a, b) => a[1].score - b[1].score);

    if (lowScoreCategories.length > 0) {
      lines.push('AREAS NEEDING IMPROVEMENT:');
      lowScoreCategories.forEach(([category, data]) => {
        lines.push(`\n${category} (score: ${data.score}/10):`);
        data.issues.forEach(issue => {
          lines.push(`  - ${issue}`);
        });
      });
      lines.push('');
    }

    if (evaluation.improvements.length > 0) {
      lines.push('SPECIFIC IMPROVEMENTS TO MAKE:');
      evaluation.improvements.forEach((imp, i) => {
        lines.push(`${i + 1}. ${imp}`);
      });
    }

    return lines.join('\n');
  }
}

/**
 * Design principles and patterns for restaurant websites
 * Used to augment the generation prompt with proven patterns
 */
export const designPatterns = {
  hero: {
    patterns: [
      'Full-bleed hero image with dark gradient overlay for text legibility',
      'Split hero: image on one side, compelling copy on the other',
      'Video background hero with centered logo and tagline',
      'Parallax hero with layered elements creating depth'
    ],
    tips: [
      'Hero text should be large (min 48px on desktop) with strong contrast',
      'Include a clear CTA button within the first viewport',
      'Use backdrop-filter: blur() for text overlays on busy images'
    ]
  },
  typography: {
    patterns: [
      'Display font for headings (Playfair Display, Cormorant, DM Serif) + clean sans-serif for body (Inter, DM Sans)',
      'All-serif elegant approach (Cormorant Garamond) for fine dining',
      'Modern sans approach (Outfit, Space Grotesk) for casual/trendy',
      'Script accent font for flourishes (only for decorative elements)'
    ],
    tips: [
      'Body text minimum 16px, ideally 18px for restaurants',
      'Line height 1.5-1.6 for readability',
      'Maximum 2-3 font families total',
      'Use font-weight variations instead of more fonts'
    ]
  },
  colorPalette: {
    patterns: [
      'Brand color + neutral (white/black) + one accent',
      'Warm palette (cream, terracotta, burgundy) for comfort food',
      'Cool palette (navy, sage, cream) for seafood/modern',
      'Earthy palette (olive, rust, cream) for farm-to-table'
    ],
    tips: [
      'Ensure 4.5:1 contrast ratio for text',
      'Use color for hierarchy, not decoration',
      'Dark mode should be intentional, not default',
      'Test colors with the restaurant photos'
    ]
  },
  layout: {
    patterns: [
      'Generous whitespace (padding: clamp(2rem, 5vw, 6rem))',
      'Asymmetric grids for visual interest',
      'Card-based menu layout with hover effects',
      'Full-width sections alternating with contained content'
    ],
    tips: [
      'Mobile: single column with clear hierarchy',
      'Tablet: 2-column layouts work well',
      'Desktop: use max-width containers (1200-1400px)',
      'Gap > margin for consistent spacing'
    ]
  },
  menu: {
    patterns: [
      'Clean list format with prices right-aligned',
      'Card grid with item images',
      'Tabbed categories with smooth transitions',
      'Accordion sections for long menus'
    ],
    tips: [
      'Prices should be easy to scan (align right or use dot leaders)',
      'Item names should be prominent, descriptions secondary',
      'Add to cart buttons should be obvious but not overwhelming',
      'Group items logically (apps, mains, desserts)'
    ]
  }
};

/**
 * Generate a design brief to include in prompts
 */
export function generateDesignBrief(restaurant) {
  const vibeMap = {
    'fine-dining': { typography: 'serif', colors: 'elegant', layout: 'spacious' },
    'casual': { typography: 'modern-sans', colors: 'warm', layout: 'friendly' },
    'trendy': { typography: 'display', colors: 'bold', layout: 'asymmetric' },
    'family': { typography: 'rounded', colors: 'warm', layout: 'clear' },
    'fast-casual': { typography: 'clean', colors: 'energetic', layout: 'efficient' },
    'modern': { typography: 'geometric-sans', colors: 'minimal', layout: 'grid' }
  };

  const vibe = vibeMap[restaurant.style_theme] || vibeMap['modern'];

  return `
DESIGN BRIEF:
Restaurant Style: ${restaurant.style_theme || 'modern'}
Recommended Approach:
- Typography: ${vibe.typography} approach (see patterns below)
- Colors: ${vibe.colors} palette extending from brand color ${restaurant.primary_color || '#2563eb'}
- Layout: ${vibe.layout} structure

PROVEN PATTERNS:
Hero: ${designPatterns.hero.patterns[Math.floor(Math.random() * designPatterns.hero.patterns.length)]}
Typography: ${designPatterns.typography.patterns[Math.floor(Math.random() * designPatterns.typography.patterns.length)]}
Colors: ${designPatterns.colorPalette.patterns[Math.floor(Math.random() * designPatterns.colorPalette.patterns.length)]}
Menu: ${designPatterns.menu.patterns[Math.floor(Math.random() * designPatterns.menu.patterns.length)]}

KEY TIPS:
${designPatterns.typography.tips.slice(0, 2).map(t => `- ${t}`).join('\n')}
${designPatterns.layout.tips.slice(0, 2).map(t => `- ${t}`).join('\n')}
${designPatterns.colorPalette.tips.slice(0, 2).map(t => `- ${t}`).join('\n')}
`;
}
