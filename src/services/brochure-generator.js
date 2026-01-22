import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { promises as fs } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel } from '../db/models/index.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class BrochureGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  /**
   * Generate brochure for a restaurant using Gemini
   */
  async generate(restaurantId, options = {}) {
    const { layout = 'portrait' } = options;

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error('Restaurant not found');
    }

    // Create output directory
    const outputDir = join(config.paths.brochures, restaurantId);
    await fs.mkdir(outputDir, { recursive: true });

    // Prepare image data
    const imageData = await this.prepareImageData(restaurant);

    // Generate HTML with Gemini
    const html = await this.generateBrochureHTML(restaurant, imageData, layout);

    // Save HTML
    const htmlPath = join(outputDir, `brochure_${layout}.html`);
    await fs.writeFile(htmlPath, html);

    // Generate PDF
    const pdfPath = join(outputDir, `brochure_${layout}.pdf`);
    await this.generatePDF(htmlPath, pdfPath, layout);

    // Generate PNG
    const imagePath = join(outputDir, `brochure_${layout}.png`);
    await this.generateImage(htmlPath, imagePath, layout);

    // Track materials
    const pdfMaterial = MaterialModel.create(restaurantId, {
      type: 'brochure_pdf',
      filePath: pdfPath
    });

    const imageMaterial = MaterialModel.create(restaurantId, {
      type: 'brochure_image',
      filePath: imagePath
    });

    return {
      pdfPath,
      imagePath,
      pdfMaterialId: pdfMaterial.id,
      imageMaterialId: imageMaterial.id
    };
  }

  /**
   * Prepare images as base64 for embedding
   */
  async prepareImageData(restaurant) {
    const images = { primary: null, food: [] };

    // Get primary photo
    const primaryPhoto = restaurant.photos.find(p => p.isPrimary);
    if (primaryPhoto) {
      try {
        const buffer = await sharp(primaryPhoto.path)
          .resize(800, 600, { fit: 'cover' })
          .jpeg({ quality: 90 })
          .toBuffer();
        images.primary = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      } catch (error) {
        console.error('Failed to process primary image:', error);
      }
    }

    // Get food photos
    const foodPhotos = restaurant.photos.filter(p => p.type === 'food').slice(0, 4);
    for (const photo of foodPhotos) {
      try {
        const buffer = await sharp(photo.path)
          .resize(300, 225, { fit: 'cover' })
          .jpeg({ quality: 85 })
          .toBuffer();
        images.food.push({
          data: `data:image/jpeg;base64,${buffer.toString('base64')}`,
          caption: photo.caption
        });
      } catch (error) {
        console.error('Failed to process food photo:', error);
      }
    }

    return images;
  }

  /**
   * Generate brochure HTML using Gemini
   */
  async generateBrochureHTML(restaurant, images, layout) {
    const isLandscape = layout === 'landscape';
    const pageSize = isLandscape ? '11in x 8.5in' : '8.5in x 11in';

    // Get featured menu items
    const featuredItems = [];
    for (const category of restaurant.menu) {
      for (const item of category.items.slice(0, 2)) {
        featuredItems.push({ ...item, category: category.name });
        if (featuredItems.length >= 6) break;
      }
      if (featuredItems.length >= 6) break;
    }

    const prompt = `You are a professional graphic designer. Create a stunning print-ready brochure/flyer HTML for this restaurant.

RESTAURANT:
- Name: ${restaurant.name || 'Restaurant'}
- Tagline: ${restaurant.tagline || ''}
- Description: ${restaurant.description || ''}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Address: ${restaurant.address || ''}
- Phone: ${restaurant.phone || ''}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

FEATURED MENU ITEMS:
${JSON.stringify(featuredItems, null, 2)}

IMAGES AVAILABLE (base64 data URIs - use these exact values):
- Primary Image: ${images.primary ? 'Available as: ' + images.primary.substring(0, 50) + '...' : 'None'}
- Food Photos: ${images.food.length} available

LAYOUT: ${layout.toUpperCase()} (${pageSize})

REQUIREMENTS:
1. Generate a COMPLETE HTML file with embedded CSS
2. Design for PRINT - use @page CSS, exact dimensions (${pageSize})
3. Single page only - everything must fit
4. Match the cuisine/vibe:
   - Italian: warm terracotta, olive greens, elegant serif fonts
   - Japanese: minimal, lots of white space, clean sans-serif
   - Mexican: bold colors, festive patterns, fun fonts
   - American BBQ: rustic textures, bold, smoky feel
   - Fine dining: dark sophisticated, gold accents, luxury feel
5. Include: Restaurant name prominently, tagline, brief description, 4-6 featured dishes with prices, contact info
6. Use the primary image as hero/background if available
7. Typography should be bold and readable at print size
8. Use the brand color as primary accent
9. Add subtle design elements (borders, dividers, shapes) that match the cuisine style
10. Make it look like a professional marketing piece you'd pick up at a restaurant

${images.primary ? `PRIMARY IMAGE (use this exact data URI for the hero image):
${images.primary}` : ''}

${images.food.length > 0 ? `FOOD IMAGES (use these exact data URIs):
${images.food.map((img, i) => `Image ${i + 1}: ${img.data}`).join('\n')}` : ''}

OUTPUT: Return ONLY the complete HTML code. No markdown, no explanation. Start with <!DOCTYPE html>.`;

    const result = await this.model.generateContent(prompt);
    let html = result.response.text();

    // Clean up
    html = html.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    if (!html.toLowerCase().startsWith('<!doctype')) {
      html = '<!DOCTYPE html>\n' + html;
    }

    return html;
  }

  /**
   * Generate PDF from HTML
   */
  async generatePDF(htmlPath, pdfPath, layout) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

      await page.pdf({
        path: pdfPath,
        format: 'Letter',
        landscape: layout === 'landscape',
        printBackground: true,
        preferCSSPageSize: true
      });
    } finally {
      await browser.close();
    }
  }

  /**
   * Generate PNG from HTML
   */
  async generateImage(htmlPath, imagePath, layout) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

      const width = layout === 'landscape' ? 1056 : 816;
      const height = layout === 'landscape' ? 816 : 1056;

      await page.setViewport({
        width,
        height,
        deviceScaleFactor: 2
      });

      await page.screenshot({
        path: imagePath,
        fullPage: false,
        type: 'png'
      });
    } finally {
      await browser.close();
    }
  }
}
