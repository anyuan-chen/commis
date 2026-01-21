import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel, NoteModel } from '../db/models/index.js';

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

    // Generate HTML with Gemini
    const html = await this.generateHTML(restaurant, processedPhotos);

    // Write HTML file
    await fs.writeFile(join(outputDir, 'index.html'), html);

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

    const prompt = `You are a world-class web designer. Generate a complete, production-ready single-page HTML website for this restaurant.

RESTAURANT DATA:
- Name: ${restaurant.name || 'Restaurant'}
- Tagline: ${restaurant.tagline || ''}
- Description: ${restaurant.description || ''}
- Cuisine Type: ${restaurant.cuisine_type || 'Restaurant'}
- Address: ${restaurant.address || ''}
- Phone: ${restaurant.phone || ''}
- Email: ${restaurant.email || ''}
- Hours: ${JSON.stringify(restaurant.hours || {})}
- Style Preference: ${restaurant.style_theme || 'modern'}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

MENU:
${JSON.stringify(menuData, null, 2)}

AVAILABLE PHOTOS (use these exact paths):
${JSON.stringify(photoDescriptions, null, 2)}

${activeNotes.length > 0 ? `SPECIAL NOTES/ANNOUNCEMENTS (display these prominently - use your judgment on how: banner, alert, notice section, etc.):
${activeNotes.map(n => `- ${n.content}`).join('\n')}
` : ''}
REQUIREMENTS:
1. Generate a COMPLETE, self-contained HTML file with embedded CSS (in <style> tags)
2. Make it mobile-first and fully responsive
3. Design should match the cuisine type and vibe:
   - Italian/French: warm, elegant, perhaps cream/burgundy tones
   - Japanese/Sushi: minimal, clean, zen aesthetic
   - Mexican: vibrant, colorful, festive
   - American/BBQ: rustic, bold, hearty feel
   - Fine dining: sophisticated, dark mode friendly, luxurious
   - Casual/Family: friendly, bright, welcoming
4. Include these sections: Hero, About, Menu, Gallery (if photos available), Contact/Hours, Footer
5. Use the provided brand color as the primary accent
6. Include smooth scroll behavior, subtle animations on scroll
7. Use Google Fonts that match the restaurant's vibe
8. Make the menu section beautiful and easy to read with prices aligned
9. If there's a primary photo, use it as a hero background
10. Include meta tags for SEO
11. Add schema.org structured data for local business
12. Make phone numbers and email clickable
13. Include a simple CSS animation or two for polish

OUTPUT: Return ONLY the complete HTML code, no markdown code blocks, no explanation. Start with <!DOCTYPE html> and end with </html>.`;

    const result = await this.model.generateContent(prompt);
    let html = result.response.text();

    // Clean up any markdown if Gemini added it
    html = html.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    // Ensure it starts with doctype
    if (!html.toLowerCase().startsWith('<!doctype')) {
      html = '<!DOCTYPE html>\n' + html;
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
}
