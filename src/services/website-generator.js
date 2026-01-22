import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel, NoteModel } from '../db/models/index.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class WebsiteGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3.0-flash-preview' });
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
6. Use Google Fonts that match the restaurant's vibe
7. Make the menu section beautiful and easy to read with prices aligned
8. If there's a primary photo, use it as a hero background
9. Include meta tags for SEO
10. Add schema.org structured data for local business
11. Make phone numbers and email clickable

ANIMATION CLASSES (these are pre-loaded - USE THEM for professional animations):
- Hero section: Add "animate-hero" to main hero heading, "animate-hero-delayed" to tagline, "animate-hero-delayed-2" to CTA buttons
- Content sections: Add "animate-fade-up" to section containers (About, Menu, Contact, etc.)
- Gallery/Cards: Add "animate-scale-in" to gallery items or cards. Use "stagger-1", "stagger-2", etc. for sequential reveal
- Menu items: Add "animate-fade-up" with stagger classes for nice sequential appearance
- Buttons: Add "hover-press" class for tactile click feedback
- Cards: Add "hover-lift" for subtle lift on hover
- Gallery images: Wrap in div with "hover-zoom" class for zoom effect
- Links: Add "hover-underline" for animated underline effect

DO NOT write your own @keyframes or scroll animation CSS - the animation stylesheet handles this automatically.
The animations are triggered when elements scroll into view. Just add the classes above.

OUTPUT: Return ONLY the complete HTML code, no markdown code blocks, no explanation. Start with <!DOCTYPE html> and end with </html>.`;

    const result = await this.model.generateContent(prompt);
    let html = result.response.text();

    // Clean up any markdown if Gemini added it
    html = html.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    // Ensure it starts with doctype
    if (!html.toLowerCase().startsWith('<!doctype')) {
      html = '<!DOCTYPE html>\n' + html;
    }

    // Inject animation stylesheet and script
    html = this.injectAnimations(html);

    return html;
  }

  /**
   * Inject animation CSS and Intersection Observer script into generated HTML
   */
  injectAnimations(html) {
    // Animation CSS to inject
    const animationCSS = `
<style>
/* Animation Utilities - Based on Emil Kowalski's best practices */
:root {
  --ease-out-quad: cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
  --ease-out-quart: cubic-bezier(0.165, 0.84, 0.44, 1);
  --ease-out-quint: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out-cubic: cubic-bezier(0.645, 0.045, 0.355, 1);
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
}

/* Scroll-triggered animations */
.animate-fade-up { opacity: 0; transform: translateY(20px); transition: opacity var(--duration-slow) var(--ease-out-quart), transform var(--duration-slow) var(--ease-out-quart); }
.animate-fade-up.is-visible { opacity: 1; transform: translateY(0); }
.animate-fade-in { opacity: 0; transition: opacity var(--duration-slow) var(--ease-out-cubic); }
.animate-fade-in.is-visible { opacity: 1; }
.animate-scale-in { opacity: 0; transform: scale(0.95); transition: opacity var(--duration-normal) var(--ease-out-quart), transform var(--duration-normal) var(--ease-out-quart); }
.animate-scale-in.is-visible { opacity: 1; transform: scale(1); }
.animate-slide-left { opacity: 0; transform: translateX(-30px); transition: opacity var(--duration-slow) var(--ease-out-quart), transform var(--duration-slow) var(--ease-out-quart); }
.animate-slide-left.is-visible { opacity: 1; transform: translateX(0); }
.animate-slide-right { opacity: 0; transform: translateX(30px); transition: opacity var(--duration-slow) var(--ease-out-quart), transform var(--duration-slow) var(--ease-out-quart); }
.animate-slide-right.is-visible { opacity: 1; transform: translateX(0); }

/* Stagger delays */
.stagger-1 { transition-delay: 50ms; }
.stagger-2 { transition-delay: 100ms; }
.stagger-3 { transition-delay: 150ms; }
.stagger-4 { transition-delay: 200ms; }
.stagger-5 { transition-delay: 250ms; }
.stagger-6 { transition-delay: 300ms; }

/* Hover effects */
.hover-press { transition: transform var(--duration-fast) var(--ease-out-cubic); will-change: transform; }
@media (hover: hover) and (pointer: fine) { .hover-press:hover { transform: scale(1.02); } }
.hover-press:active { transform: scale(0.97); }
.hover-lift { transition: transform var(--duration-normal) var(--ease-out-cubic), box-shadow var(--duration-normal) ease; will-change: transform; }
@media (hover: hover) and (pointer: fine) { .hover-lift:hover { transform: translateY(-4px); box-shadow: 0 12px 24px rgba(0,0,0,0.15); } }
.hover-zoom { overflow: hidden; }
.hover-zoom img { transition: transform var(--duration-slow) var(--ease-out-cubic); will-change: transform; }
@media (hover: hover) and (pointer: fine) { .hover-zoom:hover img { transform: scale(1.05); } }
.hover-underline { position: relative; text-decoration: none; }
.hover-underline::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 100%; height: 2px; background: currentColor; transform: scaleX(0); transform-origin: right; transition: transform var(--duration-normal) var(--ease-out-cubic); }
@media (hover: hover) and (pointer: fine) { .hover-underline:hover::after { transform: scaleX(1); transform-origin: left; } }

/* Hero animations */
@keyframes hero-fade-in { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
.animate-hero { animation: hero-fade-in 800ms var(--ease-out-quint) forwards; }
.animate-hero-delayed { opacity: 0; animation: hero-fade-in 800ms var(--ease-out-quint) 200ms forwards; }
.animate-hero-delayed-2 { opacity: 0; animation: hero-fade-in 800ms var(--ease-out-quint) 400ms forwards; }

/* Smooth scroll */
html { scroll-behavior: smooth; }

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
  .animate-fade-up, .animate-fade-in, .animate-scale-in, .animate-slide-left, .animate-slide-right { opacity: 1; transform: none; }
}
</style>`;

    // Intersection Observer script to trigger animations
    const animationScript = `
<script>
// Intersection Observer for scroll animations
document.addEventListener('DOMContentLoaded', function() {
  const animatedElements = document.querySelectorAll('.animate-fade-up, .animate-fade-in, .animate-scale-in, .animate-slide-left, .animate-slide-right');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    animatedElements.forEach(function(el) { observer.observe(el); });
  } else {
    // Fallback for older browsers
    animatedElements.forEach(function(el) { el.classList.add('is-visible'); });
  }
});
</script>`;

    // Inject CSS before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', animationCSS + '\n</head>');
    } else {
      // If no head tag, inject after doctype
      html = html.replace(/(<html[^>]*>)/i, '$1\n<head>' + animationCSS + '</head>');
    }

    // Inject script before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', animationScript + '\n</body>');
    } else {
      // If no body closing tag, append at end
      html = html.replace('</html>', animationScript + '\n</html>');
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
