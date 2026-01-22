import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { RestaurantModel, NoteModel } from '../db/models/index.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Image generator using Gemini image model
 */
export class ImageGenerator {
  constructor() {
    this.modelId = 'gemini-3-pro-image-preview';

    this.model = genAI.getGenerativeModel({
      model: this.modelId,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    });
  }

  /**
   * Generate an image from a text prompt
   */
  async generate(prompt, options = {}) {
    const {
      aspectRatio = '1:1',  // 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
      outputPath = null
    } = options;

    const fullPrompt = `${prompt}\n\nAspect ratio: ${aspectRatio}`;

    const result = await this.model.generateContent(fullPrompt);
    const response = result.response;

    // Extract image from response
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = Buffer.from(part.inlineData.data, 'base64');

        if (outputPath) {
          await fs.writeFile(outputPath, imageData);
          return { path: outputPath, mimeType: part.inlineData.mimeType };
        }

        return {
          data: imageData,
          base64: part.inlineData.data,
          mimeType: part.inlineData.mimeType
        };
      }
    }

    throw new Error('No image generated in response');
  }

  /**
   * Generate a social media graphic for a restaurant
   */
  async generateSocialPost(restaurantId, options = {}) {
    const {
      platform = 'instagram',  // instagram, facebook, twitter, story
      theme = 'promotion',     // promotion, announcement, menu-highlight, holiday
      customText = null
    } = options;

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) throw new Error('Restaurant not found');

    const activeNotes = NoteModel.getActive(restaurantId);

    const aspectRatios = {
      instagram: '1:1',
      facebook: '16:9',
      twitter: '16:9',
      story: '9:16'
    };

    const prompt = this.buildSocialPrompt(restaurant, {
      platform,
      theme,
      customText,
      notes: activeNotes
    });

    const outputPath = join(
      config.paths.images,
      `${restaurantId}_social_${platform}_${Date.now()}.png`
    );

    return this.generate(prompt, {
      aspectRatio: aspectRatios[platform] || '1:1',
      outputPath
    });
  }

  /**
   * Generate a menu image/graphic
   */
  async generateMenuGraphic(restaurantId, options = {}) {
    const {
      style = 'elegant',  // elegant, casual, bold, minimal
      includePhotos = false,
      category = null  // specific category or null for full menu
    } = options;

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) throw new Error('Restaurant not found');

    const menuItems = category
      ? restaurant.menu.filter(c => c.name.toLowerCase().includes(category.toLowerCase()))
      : restaurant.menu;

    const prompt = `Create a beautiful ${style} restaurant menu graphic for "${restaurant.name}".

RESTAURANT:
- Name: ${restaurant.name}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

MENU ITEMS:
${menuItems.map(cat => `
${cat.name}:
${cat.items.map(item => `  - ${item.name}: $${item.price || 'Market Price'}${item.description ? ` - ${item.description}` : ''}`).join('\n')}
`).join('\n')}

DESIGN REQUIREMENTS:
- Professional restaurant menu design
- Clear hierarchy with category headers
- Prices aligned and easy to read
- Match the ${style} aesthetic
- Use the brand color as accent
- High contrast, readable text
- ${restaurant.cuisine_type ? `Design should reflect ${restaurant.cuisine_type} cuisine style` : ''}`;

    const outputPath = join(
      config.paths.images,
      `${restaurantId}_menu_${style}_${Date.now()}.png`
    );

    return this.generate(prompt, {
      aspectRatio: '3:4',  // Portrait for menu
      outputPath
    });
  }

  /**
   * Generate a promotional flyer/graphic
   */
  async generatePromoGraphic(restaurantId, options = {}) {
    const {
      promoText = null,       // e.g., "20% off this weekend!"
      eventName = null,       // e.g., "Wine Wednesday"
      date = null,
      style = 'vibrant'
    } = options;

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) throw new Error('Restaurant not found');

    const prompt = `Create an eye-catching promotional graphic for "${restaurant.name}".

RESTAURANT:
- Name: ${restaurant.name}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

PROMOTION DETAILS:
${promoText ? `- Offer: ${promoText}` : ''}
${eventName ? `- Event: ${eventName}` : ''}
${date ? `- Date: ${date}` : ''}

DESIGN REQUIREMENTS:
- ${style} and attention-grabbing design
- Restaurant name prominently displayed
- Promotion/event text large and readable
- Use brand color as primary accent
- Professional but exciting
- Clear call to action
- Suitable for print and digital use`;

    const outputPath = join(
      config.paths.images,
      `${restaurantId}_promo_${Date.now()}.png`
    );

    return this.generate(prompt, {
      aspectRatio: '4:5',
      outputPath
    });
  }

  /**
   * Generate a holiday/seasonal graphic
   */
  async generateHolidayGraphic(restaurantId, options = {}) {
    const {
      holiday = 'christmas',  // christmas, thanksgiving, valentines, newyear, etc.
      message = null
    } = options;

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) throw new Error('Restaurant not found');

    const holidayThemes = {
      christmas: 'festive Christmas theme with red, green, gold accents, snowflakes or ornaments',
      thanksgiving: 'warm autumn theme with orange, brown, harvest imagery',
      valentines: 'romantic theme with red, pink, hearts',
      newyear: 'celebration theme with gold, silver, champagne, fireworks',
      halloween: 'spooky fun theme with orange, black, purple',
      easter: 'spring theme with pastels, eggs, flowers',
      july4th: 'patriotic theme with red, white, blue, stars'
    };

    const prompt = `Create a ${holiday} holiday graphic for "${restaurant.name}".

RESTAURANT:
- Name: ${restaurant.name}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

HOLIDAY STYLE:
${holidayThemes[holiday] || `${holiday} themed design`}

${message ? `MESSAGE TO INCLUDE: "${message}"` : `Include a warm ${holiday} greeting`}

DESIGN REQUIREMENTS:
- Festive and celebratory
- Restaurant name visible
- Holiday message prominent
- Blend holiday theme with restaurant brand
- Professional quality
- Suitable for social media and print`;

    const outputPath = join(
      config.paths.images,
      `${restaurantId}_${holiday}_${Date.now()}.png`
    );

    return this.generate(prompt, {
      aspectRatio: '1:1',
      outputPath
    });
  }

  /**
   * Edit/modify an existing image
   */
  async editImage(imagePath, editPrompt, options = {}) {
    const { outputPath = null } = options;

    const imageData = await fs.readFile(imagePath);
    const base64Image = imageData.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const result = await this.model.generateContent([
      { inlineData: { mimeType, data: base64Image } },
      { text: editPrompt }
    ]);

    const response = result.response;

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const newImageData = Buffer.from(part.inlineData.data, 'base64');

        if (outputPath) {
          await fs.writeFile(outputPath, newImageData);
          return { path: outputPath, mimeType: part.inlineData.mimeType };
        }

        return {
          data: newImageData,
          base64: part.inlineData.data,
          mimeType: part.inlineData.mimeType
        };
      }
    }

    throw new Error('No image generated in response');
  }

  /**
   * Build prompt for social media posts
   */
  buildSocialPrompt(restaurant, options) {
    const { platform, theme, customText, notes } = options;

    const themePrompts = {
      promotion: 'promotional post highlighting a special offer or the restaurant experience',
      announcement: `announcement post${notes.length > 0 ? ` about: ${notes[0].content}` : ''}`,
      'menu-highlight': 'post showcasing a signature dish or menu item',
      holiday: 'festive seasonal post'
    };

    return `Create a ${platform} social media graphic for "${restaurant.name}".

RESTAURANT:
- Name: ${restaurant.name}
- Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
- Tagline: ${restaurant.tagline || ''}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

POST TYPE: ${themePrompts[theme] || theme}

${customText ? `TEXT TO INCLUDE: "${customText}"` : ''}

DESIGN REQUIREMENTS:
- Optimized for ${platform}
- Eye-catching and scroll-stopping
- Restaurant name/logo area
- Professional food/restaurant photography style
- Text overlay that's readable
- Brand colors incorporated
- Modern social media aesthetic
- ${restaurant.cuisine_type ? `Reflect ${restaurant.cuisine_type} cuisine vibes` : ''}`;
  }
}

/**
 * Convenience function to get generator instance
 */
export function createImageGenerator(usePro = false) {
  return new ImageGenerator({ pro: usePro });
}
