#!/usr/bin/env node
/**
 * Pipeline Debugger - Step-by-step testing of the video-to-website pipeline
 *
 * Usage:
 *   node --env-file=.env tests/pipeline-debug.js <video-path>
 *   node --env-file=.env tests/pipeline-debug.js <video-path> --step=2
 *   node --env-file=.env tests/pipeline-debug.js --restaurant=<id> --step=4
 *
 * Steps:
 *   1. Frame Extraction - Extract frames from video
 *   2. Video Analysis - Analyze frames with Gemini Vision
 *   3. Database Storage - Save to database
 *   4. Website Generation - Generate HTML with Gemini
 *   5. Full Pipeline - Run everything and compare
 */

import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { config } from '../src/config.js';
import { VideoProcessor } from '../src/services/video-processor.js';
import { GeminiVision } from '../src/services/gemini-vision.js';
import { WebsiteGenerator } from '../src/services/website-generator.js';
import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel } from '../src/db/models/index.js';

const DEBUG_DIR = join(config.paths.root, 'debug-output');

// Colors for terminal
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = '') { console.log(color + msg + C.reset); }
function header(msg) { log(`\n${'═'.repeat(60)}\n${msg}\n${'═'.repeat(60)}`, C.bright + C.cyan); }
function success(msg) { log(`✓ ${msg}`, C.green); }
function warn(msg) { log(`⚠ ${msg}`, C.yellow); }
function error(msg) { log(`✗ ${msg}`, C.red); }
function info(msg) { log(`  ${msg}`, C.dim); }

async function ensureDebugDir(subdir = '') {
  const dir = subdir ? join(DEBUG_DIR, subdir) : DEBUG_DIR;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function saveJson(filename, data, subdir = '') {
  const dir = await ensureDebugDir(subdir);
  const path = join(dir, filename);
  await fs.writeFile(path, JSON.stringify(data, null, 2));
  return path;
}

// ============================================
// STEP 1: Frame Extraction
// ============================================
async function step1_extractFrames(videoPath) {
  header('STEP 1: Frame Extraction');

  const sessionId = Date.now().toString();
  const outputDir = await ensureDebugDir(`session-${sessionId}/frames`);

  log(`Video: ${videoPath}`);
  log(`Output: ${outputDir}`);

  // Get video metadata
  log('\nGetting video metadata...');
  const metadata = await VideoProcessor.getMetadata(videoPath);
  log(`  Duration: ${metadata.duration.toFixed(1)}s`);
  log(`  Resolution: ${metadata.width}x${metadata.height}`);
  log(`  FPS: ${metadata.fps}`);

  // Extract frames
  log('\nExtracting frames (1 per 2 seconds)...');
  const startTime = Date.now();
  const { paths: framePaths } = await VideoProcessor.extractFramesForAnalysis(videoPath, {
    interval: 2,
    outputDir
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  success(`Extracted ${framePaths.length} frames in ${duration}s`);

  // Show frame list
  log('\nFrames:');
  framePaths.slice(0, 10).forEach((p, i) => info(`${i + 1}. ${basename(p)}`));
  if (framePaths.length > 10) info(`... and ${framePaths.length - 10} more`);

  // Quality check
  log('\nQuality Check:');
  const expectedFrames = Math.floor(metadata.duration / 2);
  if (framePaths.length >= expectedFrames * 0.8) {
    success(`Frame count OK (${framePaths.length}/${expectedFrames} expected)`);
  } else {
    warn(`Low frame count (${framePaths.length}/${expectedFrames} expected)`);
  }

  // Save metadata in UI-compatible format
  const result = {
    sessionId,
    videoPath,
    metadata,
    frameCount: framePaths.length,
    framePaths,
    outputDir,
    // UI fields
    success: true,
    framesExtracted: framePaths.length,
    videoDuration: metadata.duration,
    resolution: `${metadata.width}x${metadata.height}`,
    avgBrightness: 60 // placeholder - could calculate from frames
  };
  const jsonPath = await saveJson('step-1.json', result, `session-${sessionId}`);
  info(`Results saved to: ${jsonPath}`);

  return result;
}

// ============================================
// STEP 2: Video Analysis (Gemini Vision)
// ============================================
async function step2_analyzeVideo(framesData) {
  header('STEP 2: Video Analysis (Gemini Vision)');

  const sessionId = framesData.sessionId;
  const framePaths = framesData.framePaths;

  log(`Analyzing ${framePaths.length} frames with Gemini...`);

  const vision = new GeminiVision();
  const startTime = Date.now();

  let extractedData;
  try {
    extractedData = await vision.extractRestaurantData(framePaths);
  } catch (err) {
    error(`Analysis failed: ${err.message}`);
    const errorResult = { sessionId, error: err.message, raw: err.toString() };
    await saveJson('step2-analysis-ERROR.json', errorResult, `session-${sessionId}`);
    throw err;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  success(`Analysis complete in ${duration}s`);

  // Display extracted data
  log('\n--- EXTRACTED DATA ---\n');

  log('Restaurant Info:', C.bright);
  log(`  Name: ${extractedData.restaurantName || '(not found)'}`);
  log(`  Cuisine: ${extractedData.cuisineType || '(not found)'}`);
  log(`  Style: ${extractedData.styleTheme || '(not found)'}`);
  log(`  Color: ${extractedData.primaryColor || '(not found)'}`);
  log(`  Tagline: ${extractedData.tagline || '(not found)'}`);

  log('\nDescription:', C.bright);
  log(`  ${extractedData.description || '(none)'}`);

  log('\nMenu Items:', C.bright);
  if (extractedData.menuItems?.length > 0) {
    extractedData.menuItems.forEach((item, i) => {
      log(`  ${i + 1}. ${item.name} - ${item.category} - $${item.estimatedPrice || '?'}`);
      if (item.description) info(`     ${item.description}`);
    });
  } else {
    warn('  No menu items extracted');
  }

  log('\nPhotos Identified:', C.bright);
  if (extractedData.photos?.length > 0) {
    const byType = {};
    extractedData.photos.forEach(p => {
      byType[p.type] = (byType[p.type] || 0) + 1;
    });
    Object.entries(byType).forEach(([type, count]) => {
      log(`  ${type}: ${count}`);
    });
  } else {
    warn('  No photos identified');
  }

  log('\nDetected Text:', C.bright);
  if (extractedData.detectedText?.length > 0) {
    extractedData.detectedText.slice(0, 10).forEach(t => info(`  "${t}"`));
    if (extractedData.detectedText.length > 10) {
      info(`  ... and ${extractedData.detectedText.length - 10} more`);
    }
  } else {
    warn('  No text detected');
  }

  log('\nFeatures:', C.bright);
  if (extractedData.features?.length > 0) {
    extractedData.features.forEach(f => info(`  - ${f}`));
  } else {
    info('  None identified');
  }

  // Quality assessment
  log('\n--- QUALITY ASSESSMENT ---\n');
  const issues = [];

  if (!extractedData.restaurantName) issues.push('Missing restaurant name');
  if (!extractedData.cuisineType) issues.push('Missing cuisine type');
  if (!extractedData.menuItems || extractedData.menuItems.length < 3) {
    issues.push(`Low menu item count (${extractedData.menuItems?.length || 0})`);
  }
  if (!extractedData.description) issues.push('Missing description');

  const menuWithPrices = extractedData.menuItems?.filter(m => m.estimatedPrice) || [];
  if (menuWithPrices.length < extractedData.menuItems?.length * 0.5) {
    issues.push('Most menu items missing prices');
  }

  if (issues.length === 0) {
    success('Analysis quality: GOOD');
  } else {
    warn(`Analysis quality: NEEDS IMPROVEMENT`);
    issues.forEach(issue => warn(`  - ${issue}`));
  }

  // Save results in UI-compatible format
  const result = {
    sessionId,
    extractedData,
    qualityIssues: issues,
    analysisTime: duration,
    // UI fields
    success: true,
    restaurant: {
      name: extractedData.restaurantName,
      cuisineType: extractedData.cuisineType,
      atmosphere: extractedData.styleTheme,
      priceRange: extractedData.priceRange || 'Moderate',
      menu: extractedData.menuItems || []
    },
    quality: {
      nameConfidence: extractedData.restaurantName ? 0.9 : 0.3,
      menuItemsCount: extractedData.menuItems?.length || 0,
      hasContactInfo: !!(extractedData.phone || extractedData.address),
      hasHours: !!extractedData.hours
    }
  };
  const jsonPath = await saveJson('step-2.json', result, `session-${sessionId}`);
  info(`\nResults saved to: ${jsonPath}`);

  // Also save summary for session list
  await saveJson('summary.json', {
    restaurant: result.restaurant,
    steps: ['step-1', 'step-2']
  }, `session-${sessionId}`);

  return { ...framesData, ...result };
}

// ============================================
// STEP 3: Database Storage
// ============================================
async function step3_saveToDatabase(analysisData) {
  header('STEP 3: Database Storage');

  const sessionId = analysisData.sessionId;
  const data = analysisData.extractedData;

  log('Creating restaurant record...');

  // Create restaurant
  const restaurant = RestaurantModel.create({
    name: data.restaurantName || 'Unknown Restaurant',
    tagline: data.tagline,
    description: data.description,
    cuisineType: data.cuisineType,
    styleTheme: data.styleTheme || 'modern',
    primaryColor: data.primaryColor || '#2563eb'
  });

  success(`Restaurant created: ${restaurant.id}`);
  log(`  Name: ${restaurant.name}`);

  // Create menu categories and items
  log('\nCreating menu items...');
  const categoriesCreated = new Set();
  const categoryMap = {};
  let itemCount = 0;

  for (const item of (data.menuItems || [])) {
    const categoryName = item.category || 'Other';

    if (!categoryMap[categoryName]) {
      const category = MenuCategoryModel.create(restaurant.id, {
        name: categoryName,
        displayOrder: categoriesCreated.size
      });
      categoryMap[categoryName] = category.id;
      categoriesCreated.add(categoryName);
    }

    MenuItemModel.create(categoryMap[categoryName], {
      name: item.name,
      description: item.description,
      price: item.estimatedPrice
    });
    itemCount++;
  }

  success(`Created ${categoriesCreated.size} categories, ${itemCount} items`);

  // Save photos
  log('\nSaving photo references...');
  let photoCount = 0;
  for (const photo of (data.photos || [])) {
    const framePath = analysisData.framePaths[photo.frameIndex];
    if (framePath) {
      PhotoModel.create(restaurant.id, {
        path: framePath,
        type: photo.type,
        caption: photo.description,
        isPrimary: photoCount === 0 && photo.type === 'food'
      });
      photoCount++;
    }
  }
  success(`Saved ${photoCount} photos`);

  // Verify
  log('\nVerifying stored data...');
  const fullData = RestaurantModel.getFullData(restaurant.id);
  log(`  Menu categories: ${fullData.menu.length}`);
  log(`  Total menu items: ${fullData.menu.reduce((s, c) => s + c.items.length, 0)}`);
  log(`  Photos: ${fullData.photos.length}`);

  // Save results in UI-compatible format
  const result = {
    sessionId,
    restaurantId: restaurant.id,
    categoriesCreated: Array.from(categoriesCreated),
    itemCount,
    photoCount,
    fullData,
    // UI fields
    success: true,
    recordsCreated: 1 + categoriesCreated.size + itemCount + photoCount,
    menuItemsSaved: itemCount
  };
  const jsonPath = await saveJson('step-3.json', result, `session-${sessionId}`);
  info(`\nResults saved to: ${jsonPath}`);

  // Update summary
  await saveJson('summary.json', {
    restaurant: { name: fullData.name, cuisineType: fullData.cuisine_type },
    steps: ['step-1', 'step-2', 'step-3']
  }, `session-${sessionId}`);

  return { ...analysisData, ...result };
}

// ============================================
// STEP 4: Website Generation
// ============================================
async function step4_generateWebsite(dbData) {
  header('STEP 4: Website Generation');

  const sessionId = dbData.sessionId;
  const restaurantId = dbData.restaurantId;

  log(`Generating website for restaurant: ${restaurantId}`);

  const generator = new WebsiteGenerator();
  const startTime = Date.now();

  let result;
  try {
    result = await generator.generate(restaurantId);
  } catch (err) {
    error(`Generation failed: ${err.message}`);
    await saveJson('step4-website-ERROR.json', { error: err.message }, `session-${sessionId}`);
    throw err;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  success(`Website generated in ${duration}s`);
  log(`  Output: ${result.path}`);

  // Analyze generated HTML
  const htmlPath = join(result.path, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf-8');

  log('\n--- WEBSITE ANALYSIS ---\n');

  const stats = {
    size: (html.length / 1024).toFixed(1) + ' KB',
    lines: html.split('\n').length,
  };
  log(`Size: ${stats.size}, ${stats.lines} lines`);

  // Check for expected elements
  const checks = [
    { name: 'DOCTYPE', test: html.includes('<!DOCTYPE') },
    { name: 'Restaurant name in content', test: html.includes(dbData.fullData.name) || html.toLowerCase().includes(dbData.fullData.name?.toLowerCase() || '') },
    { name: 'Menu section', test: html.toLowerCase().includes('menu') },
    { name: 'Contact section', test: html.toLowerCase().includes('contact') || html.includes('phone') || html.includes('address') },
    { name: 'Cart button', test: html.includes('cart-fab') },
    { name: 'Checkout function', test: html.includes('checkout()') },
    { name: 'Add to cart buttons', test: html.includes('add-to-cart-btn') },
    { name: 'Animations CSS', test: html.includes('animate-fade') },
    { name: 'Google Maps', test: html.includes('maps/embed') || !config.google?.mapsApiKey },
    { name: 'Responsive meta', test: html.includes('viewport') },
    { name: 'Has prices ($)', test: html.includes('$') },
  ];

  log('Element Checks:');
  let passed = 0;
  checks.forEach(check => {
    if (check.test) {
      success(`  ${check.name}`);
      passed++;
    } else {
      warn(`  ${check.name}`);
    }
  });

  log(`\nScore: ${passed}/${checks.length}`);

  // Count menu items in HTML
  const cartBtnCount = (html.match(/add-to-cart-btn/g) || []).length;
  log(`\nMenu items with cart buttons: ${cartBtnCount}`);
  if (cartBtnCount < dbData.itemCount * 0.5) {
    warn(`Expected ~${dbData.itemCount} buttons based on database`);
  }

  // Save results in UI-compatible format
  const finalResult = {
    sessionId,
    restaurantId,
    websitePath: result.path,
    htmlPath,
    stats,
    checksRaw: checks.map(c => ({ name: c.name, passed: c.test })),
    score: `${passed}/${checks.length}`,
    generationTime: parseFloat(duration),
    // UI fields
    success: passed >= checks.length * 0.7,
    htmlSize: html.length,
    checks: {
      hasDoctype: html.includes('<!DOCTYPE'),
      hasMenu: html.toLowerCase().includes('menu'),
      hasContact: html.toLowerCase().includes('contact'),
      hasCart: html.includes('cart-fab'),
      hasCheckout: html.includes('checkout()'),
      hasAddToCart: html.includes('add-to-cart-btn'),
      hasAnimations: html.includes('animate-fade'),
      hasMap: html.includes('maps/embed'),
      hasResponsive: html.includes('viewport'),
      hasPrices: html.includes('$')
    }
  };
  const jsonPath = await saveJson('step-4.json', finalResult, `session-${sessionId}`);
  info(`\nResults saved to: ${jsonPath}`);

  // Copy generated HTML for preview
  await fs.copyFile(htmlPath, join(DEBUG_DIR, `session-${sessionId}`, 'generated-website.html'));

  // Update summary
  await saveJson('summary.json', {
    restaurant: { name: dbData.fullData?.name || 'Unknown' },
    steps: ['step-1', 'step-2', 'step-3', 'step-4']
  }, `session-${sessionId}`);

  // Summary
  header('PIPELINE COMPLETE');
  log(`Session: ${sessionId}`);
  log(`Restaurant ID: ${restaurantId}`);
  log(`Website: file://${htmlPath}`);
  log(`Debug files: ${DEBUG_DIR}/session-${sessionId}/`);

  return finalResult;
}

// ============================================
// MAIN
// ============================================
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Pipeline Debugger - Test video-to-website pipeline step by step

Usage:
  node --env-file=.env tests/pipeline-debug.js <video-path> [options]

Options:
  --step=N         Run only step N (1-4)
  --restaurant=ID  Use existing restaurant (skip steps 1-3)
  --session=ID     Resume from existing session

Steps:
  1. Frame Extraction
  2. Video Analysis (Gemini Vision)
  3. Database Storage
  4. Website Generation

Examples:
  # Full pipeline
  node --env-file=.env tests/pipeline-debug.js ./video.mp4

  # Only frame extraction
  node --env-file=.env tests/pipeline-debug.js ./video.mp4 --step=1

  # Only website generation for existing restaurant
  node --env-file=.env tests/pipeline-debug.js --restaurant=abc-123 --step=4
`);
    process.exit(0);
  }

  // Parse arguments
  let videoPath = null;
  let stepOnly = null;
  let restaurantId = null;
  let sessionId = null;

  for (const arg of args) {
    if (arg.startsWith('--step=')) {
      stepOnly = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--restaurant=')) {
      restaurantId = arg.split('=')[1];
    } else if (arg.startsWith('--session=')) {
      sessionId = arg.split('=')[1];
    } else if (!arg.startsWith('--')) {
      videoPath = arg;
    }
  }

  try {
    // If only step 4 with existing restaurant
    if (stepOnly === 4 && restaurantId) {
      const dbData = {
        sessionId: sessionId || Date.now().toString(),
        restaurantId,
        fullData: RestaurantModel.getFullData(restaurantId),
        itemCount: 0
      };
      if (!dbData.fullData) {
        error(`Restaurant not found: ${restaurantId}`);
        process.exit(1);
      }
      dbData.itemCount = dbData.fullData.menu.reduce((s, c) => s + c.items.length, 0);
      await step4_generateWebsite(dbData);
      return;
    }

    // Need video for other steps
    if (!videoPath) {
      error('Video path required');
      process.exit(1);
    }

    // Check video exists
    await fs.access(videoPath);

    // Run pipeline
    let data = { sessionId: sessionId || Date.now().toString() };

    if (!stepOnly || stepOnly === 1) {
      data = await step1_extractFrames(videoPath);
      if (stepOnly === 1) return;
    }

    if (!stepOnly || stepOnly === 2) {
      if (!data.framePaths) {
        error('Need step 1 data. Run without --step or use --step=1 first');
        process.exit(1);
      }
      data = await step2_analyzeVideo(data);
      if (stepOnly === 2) return;
    }

    if (!stepOnly || stepOnly === 3) {
      if (!data.extractedData) {
        error('Need step 2 data. Run without --step or run steps 1-2 first');
        process.exit(1);
      }
      data = await step3_saveToDatabase(data);
      if (stepOnly === 3) return;
    }

    if (!stepOnly || stepOnly === 4) {
      if (!data.restaurantId) {
        error('Need step 3 data. Run without --step or run steps 1-3 first');
        process.exit(1);
      }
      await step4_generateWebsite(data);
    }

  } catch (err) {
    error(`\nFatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
