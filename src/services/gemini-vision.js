import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { config } from '../config.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class GeminiVision {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  /**
   * Analyze a single image
   */
  async analyzeImage(imagePath, prompt) {
    const imageData = await fs.readFile(imagePath);
    const base64Image = imageData.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const result = await this.model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64Image
        }
      },
      prompt
    ]);

    return result.response.text();
  }

  /**
   * Analyze multiple images together
   */
  async analyzeImages(imagePaths, prompt) {
    const imageParts = await Promise.all(
      imagePaths.map(async (path) => {
        const data = await fs.readFile(path);
        return {
          inlineData: {
            mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
            data: data.toString('base64')
          }
        };
      })
    );

    const result = await this.model.generateContent([...imageParts, prompt]);
    return result.response.text();
  }

  /**
   * Extract restaurant data from video frames
   */
  async extractRestaurantData(framePaths) {
    // Select a subset of frames for analysis to avoid token limits
    const maxFrames = 15;
    const selectedFrames = this.selectDistributedFrames(framePaths, maxFrames);

    const prompt = `You are analyzing frames from a video of a restaurant. Please extract the following information in JSON format:

{
  "restaurantName": "string or null - any visible signage or name",
  "cuisineType": "string or null - type of cuisine (Italian, Japanese, Mexican, etc.)",
  "description": "string - a brief description of the restaurant based on what you see",
  "tagline": "string or null - suggest a catchy tagline based on the atmosphere",
  "styleTheme": "modern | rustic | vibrant - choose based on decor and atmosphere",
  "primaryColor": "string - hex color that matches the restaurant's aesthetic",
  "menuItems": [
    {
      "name": "string - dish name if visible",
      "description": "string - description based on appearance",
      "category": "string - appetizers, mains, desserts, drinks, etc.",
      "estimatedPrice": "number or null"
    }
  ],
  "photos": [
    {
      "frameIndex": "number - which frame (0-indexed)",
      "type": "food | interior | exterior | menu",
      "description": "string - what's shown in this frame"
    }
  ],
  "detectedText": ["array of any text visible in the frames - menu text, signs, etc."],
  "ambiance": "string - describe the overall ambiance",
  "features": ["array of notable features - outdoor seating, bar, live music, etc."]
}

Analyze all frames carefully. Look for:
1. Restaurant name on signs, menus, or decor
2. Food dishes that could be menu items
3. Interior/exterior shots for atmosphere
4. Any visible menu boards or price lists
5. Style and decor elements

Return ONLY valid JSON, no markdown formatting.`;

    const response = await this.analyzeImages(selectedFrames, prompt);

    // Parse JSON response
    try {
      // Clean up response - remove any markdown code blocks
      let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Failed to parse Gemini response:', response);
      throw new Error(`Failed to parse restaurant data: ${error.message}`);
    }
  }

  /**
   * Select evenly distributed frames from an array
   */
  selectDistributedFrames(frames, maxCount) {
    if (frames.length <= maxCount) return frames;

    const step = frames.length / maxCount;
    const selected = [];

    for (let i = 0; i < maxCount; i++) {
      const index = Math.floor(i * step);
      selected.push(frames[index]);
    }

    return selected;
  }

}
