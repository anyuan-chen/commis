import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import prettier from 'prettier';
import { config } from '../config.js';
import { RestaurantModel } from '../db/models/index.js';
import db from '../db/database.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Multi-step website modification pipeline
 * Flow: Classify → SQL → Identify Chunks → Regenerate
 */
export class WebsiteUpdater {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  /**
   * Main entry point - update website based on natural language prompt
   */
  async update(restaurantId, prompt) {
    const html = await this.readHTML(restaurantId);
    const restaurant = RestaurantModel.getFullData(restaurantId);

    if (!restaurant) {
      throw new Error(`Restaurant not found: ${restaurantId}`);
    }

    // Step 1: Classify the request
    const classification = await this.classifyRequest(prompt, restaurant);

    // Step 2: Generate and execute SQL if data change
    let sqlResults = [];
    if (classification.hasDataChange) {
      const sqlStatements = await this.generateSQL(prompt, restaurant);
      sqlResults = await this.executeSQL(sqlStatements);

      // Refresh restaurant data after SQL changes
      const updatedRestaurant = RestaurantModel.getFullData(restaurantId);
      Object.assign(restaurant, updatedRestaurant);
    }

    // Step 3: Identify HTML chunks to modify
    const chunks = await this.identifyChunks(prompt, html, classification);

    // Step 4: Regenerate each chunk
    let updatedHTML = html;
    for (const chunk of chunks) {
      updatedHTML = await this.regenerateChunk(updatedHTML, chunk, prompt, restaurant);
    }

    // Write updated HTML
    await this.writeHTML(restaurantId, updatedHTML);

    return {
      success: true,
      classification,
      sqlExecuted: sqlResults,
      chunksModified: chunks.length
    };
  }

  /**
   * Step 1: Classify the modification request
   */
  async classifyRequest(prompt, restaurant) {
    const menuItems = restaurant.menu
      .flatMap(c => c.items.map(i => i.name))
      .join(', ');

    const classifyPrompt = `Classify this website modification request:
"${prompt}"

Restaurant: ${restaurant.name}
Menu items: ${menuItems}

Return JSON only (no markdown):
{
  "hasDataChange": true/false,  // Changes stored data (prices, hours, phone, text in database)
  "hasStyleChange": true/false, // Changes appearance/CSS (colors, fonts, layout)
  "hasContentChange": true/false, // Changes displayed text in HTML
  "summary": "Brief description of what will change"
}`;

    const result = await this.model.generateContent(classifyPrompt);
    let response = result.response.text().trim();

    // Clean up markdown if present
    response = response.replace(/^```json\n?/i, '').replace(/\n?```$/i, '').trim();

    return JSON.parse(response);
  }

  /**
   * Step 2: Generate SQL for data changes
   */
  async generateSQL(prompt, restaurant) {
    const menuItemsData = restaurant.menu.flatMap(c =>
      c.items.map(i => ({ id: i.id, name: i.name, price: i.price, category: c.name }))
    );

    const sqlPrompt = `Generate SQL for this change:
"${prompt}"

SCHEMA:
- restaurants(id, name, tagline, description, phone, email, address, hours_json, primary_color)
- menu_categories(id, restaurant_id, name)
- menu_items(id, category_id, name, description, price)
- notes(id, restaurant_id, content, expires_at)

CURRENT DATA:
Restaurant ID: ${restaurant.id}
Restaurant Name: ${restaurant.name}
Phone: ${restaurant.phone || 'NULL'}
Email: ${restaurant.email || 'NULL'}
Address: ${restaurant.address || 'NULL'}
Hours: ${JSON.stringify(restaurant.hours || {})}

Menu items: ${JSON.stringify(menuItemsData)}

Return ONLY the SQL statement(s), one per line. Use actual IDs from data above.
Do NOT include any explanation or markdown. Just raw SQL.
If no SQL is needed, return: -- NO SQL NEEDED`;

    const result = await this.model.generateContent(sqlPrompt);
    let response = result.response.text().trim();

    // Clean up markdown if present
    response = response.replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();

    // Filter out comments and empty lines
    const statements = response
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));

    return statements;
  }

  /**
   * Execute SQL statements safely
   */
  async executeSQL(statements) {
    const results = [];

    for (const sql of statements) {
      try {
        // Basic SQL injection protection - only allow UPDATE, INSERT, DELETE
        const upperSQL = sql.toUpperCase().trim();
        if (!upperSQL.startsWith('UPDATE') &&
            !upperSQL.startsWith('INSERT') &&
            !upperSQL.startsWith('DELETE')) {
          console.warn('Skipping non-DML statement:', sql);
          continue;
        }

        db.exec(sql);
        results.push(sql);
      } catch (error) {
        console.error('SQL execution error:', error.message, 'SQL:', sql);
        // Continue with other statements
      }
    }

    return results;
  }

  /**
   * Step 3: Identify HTML chunks that need modification
   */
  async identifyChunks(prompt, html, classification) {
    const identifyPrompt = `Identify HTML chunks that need modification.

REQUEST: "${prompt}"
CHANGE TYPE: ${JSON.stringify(classification)}

HTML (with line numbers for reference):
${html.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n')}

Return JSON array only (no markdown):
[
  {
    "startLine": 123,
    "endLine": 145,
    "type": "content-only" | "style-only" | "full-regen",
    "description": "What this chunk contains and what needs to change"
  }
]

RULES:
- Use line numbers (1-indexed)
- Select minimal chunks (just what needs to change)
- content-only: same HTML structure/styling, update text values
- style-only: same text content, update CSS/classes
- full-regen: both structure and content need to change
- Return empty array [] if no HTML changes needed
- Prefer smaller, targeted chunks over large sections`;

    const result = await this.model.generateContent(identifyPrompt);
    let response = result.response.text().trim();

    // Clean up markdown if present
    response = response.replace(/^```json\n?/i, '').replace(/\n?```$/i, '').trim();

    const lineChunks = JSON.parse(response);

    // Convert line numbers to character positions
    const lines = html.split('\n');
    const lineStarts = [];
    let pos = 0;
    for (const line of lines) {
      lineStarts.push(pos);
      pos += line.length + 1; // +1 for newline
    }

    return lineChunks.map(chunk => ({
      startIndex: lineStarts[chunk.startLine - 1] || 0,
      endIndex: (lineStarts[chunk.endLine] || html.length),
      type: chunk.type,
      description: chunk.description
    }));
  }

  /**
   * Step 4: Regenerate a single HTML chunk
   */
  async regenerateChunk(html, chunk, prompt, restaurant) {
    const original = html.substring(chunk.startIndex, chunk.endIndex);
    const context = {
      before: html.substring(Math.max(0, chunk.startIndex - 500), chunk.startIndex),
      after: html.substring(chunk.endIndex, Math.min(html.length, chunk.endIndex + 500))
    };

    const typePrompts = {
      'content-only': 'Update CONTENT only. Keep all HTML structure, classes, and styling identical. Only change text values.',
      'style-only': 'Update STYLING only. Keep all text content identical. Modify classes or inline styles.',
      'full-regen': 'Update both content and styling as needed to fulfill the request.'
    };

    const menuData = restaurant.menu.map(cat => ({
      category: cat.name,
      items: cat.items.map(i => ({ name: i.name, price: i.price, description: i.description }))
    }));

    const regenPrompt = `Regenerate this HTML chunk.

INSTRUCTION: ${typePrompts[chunk.type]}
REQUEST: "${prompt}"
CHUNK DESCRIPTION: ${chunk.description}

ORIGINAL CHUNK:
${original}

CONTEXT (HTML before this chunk):
${context.before}

CONTEXT (HTML after this chunk):
${context.after}

RESTAURANT DATA:
- Name: ${restaurant.name}
- Tagline: ${restaurant.tagline || ''}
- Phone: ${restaurant.phone || ''}
- Email: ${restaurant.email || ''}
- Address: ${restaurant.address || ''}
- Hours: ${JSON.stringify(restaurant.hours || {})}
- Primary Color: ${restaurant.primary_color || '#2563eb'}

MENU DATA:
${JSON.stringify(menuData, null, 2)}

Return ONLY the regenerated HTML chunk. No markdown, no explanation.
The output must fit seamlessly with the surrounding context.
Preserve exact indentation and formatting style of the original.`;

    const result = await this.model.generateContent(regenPrompt);
    let response = result.response.text().trim();

    // Clean up markdown if present
    response = response.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    return html.substring(0, chunk.startIndex) + response + html.substring(chunk.endIndex);
  }

  /**
   * Read current HTML for a restaurant
   */
  async readHTML(restaurantId) {
    const indexPath = join(config.paths.websites, restaurantId, 'index.html');

    try {
      return await fs.readFile(indexPath, 'utf-8');
    } catch (error) {
      throw new Error(`Website not found for restaurant ${restaurantId}. Generate one first using create_website.`);
    }
  }

  /**
   * Write updated HTML for a restaurant
   */
  async writeHTML(restaurantId, html) {
    const outputDir = join(config.paths.websites, restaurantId);
    const indexPath = join(outputDir, 'index.html');

    await fs.mkdir(outputDir, { recursive: true });
    const formatted = await this.formatHTML(html);
    await fs.writeFile(indexPath, formatted);
  }

  /**
   * Format HTML with prettier for consistent output
   */
  async formatHTML(html) {
    try {
      return await prettier.format(html, {
        parser: 'html',
        printWidth: 120,
        tabWidth: 2,
        useTabs: false
      });
    } catch (error) {
      console.warn('HTML formatting failed, using raw HTML:', error.message);
      return html;
    }
  }

  /**
   * Read menu.html for a restaurant
   */
  async readMenuHTML(restaurantId) {
    const menuPath = join(config.paths.websites, restaurantId, 'menu.html');

    try {
      return await fs.readFile(menuPath, 'utf-8');
    } catch (error) {
      return null; // Menu page may not exist
    }
  }

  /**
   * Write updated menu.html for a restaurant
   */
  async writeMenuHTML(restaurantId, html) {
    const outputDir = join(config.paths.websites, restaurantId);
    const menuPath = join(outputDir, 'menu.html');

    await fs.mkdir(outputDir, { recursive: true });
    const formatted = await this.formatHTML(html);
    await fs.writeFile(menuPath, formatted);
  }

  /**
   * Generate a variant-specific HTML file for A/B testing
   * Does NOT modify the original - creates a separate variant file
   */
  async generateVariant(restaurantId, variantId, prompt) {
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error(`Restaurant not found: ${restaurantId}`);
    }

    // Step 1: Classify
    const classification = await this.classifyRequest(prompt, restaurant);

    // Step 2: SQL if needed (this affects the database, so be careful)
    // For A/B tests, we typically DON'T want to change database - just HTML
    // Skip SQL for variant generation to keep data consistent

    // Generate variant of index.html
    const indexHTML = await this.readHTML(restaurantId);
    const indexChunks = await this.identifyChunks(prompt, indexHTML, classification);
    let variantIndex = indexHTML;
    for (const chunk of indexChunks) {
      variantIndex = await this.regenerateChunk(variantIndex, chunk, prompt, restaurant);
    }
    await this.writeVariantHTML(restaurantId, variantId, 'index.html', variantIndex);

    // Generate variant of menu.html if it exists
    const menuHTML = await this.readMenuHTML(restaurantId);
    if (menuHTML) {
      const menuChunks = await this.identifyChunks(prompt, menuHTML, classification);
      let variantMenu = menuHTML;
      for (const chunk of menuChunks) {
        variantMenu = await this.regenerateChunk(variantMenu, chunk, prompt, restaurant);
      }
      await this.writeVariantHTML(restaurantId, variantId, 'menu.html', variantMenu);
    }

    return {
      success: true,
      variantId,
      classification,
      chunksModified: {
        index: indexChunks.length,
        menu: menuHTML ? indexChunks.length : 0
      }
    };
  }

  /**
   * Write variant-specific HTML file
   */
  async writeVariantHTML(restaurantId, variantId, filename, html) {
    const outputDir = join(config.paths.websites, restaurantId, 'variants', variantId);
    const filePath = join(outputDir, filename);

    await fs.mkdir(outputDir, { recursive: true });
    const formatted = await this.formatHTML(html);
    await fs.writeFile(filePath, formatted);
  }

  /**
   * Delete variant files (when experiment concludes)
   */
  async deleteVariant(restaurantId, variantId) {
    const variantDir = join(config.paths.websites, restaurantId, 'variants', variantId);

    try {
      await fs.rm(variantDir, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      console.warn(`Failed to delete variant ${variantId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Promote variant to main (copy variant files to main)
   */
  async promoteVariant(restaurantId, variantId) {
    const variantDir = join(config.paths.websites, restaurantId, 'variants', variantId);
    const mainDir = join(config.paths.websites, restaurantId);

    try {
      // Copy variant index.html to main
      const variantIndex = join(variantDir, 'index.html');
      const mainIndex = join(mainDir, 'index.html');

      try {
        const content = await fs.readFile(variantIndex, 'utf-8');
        await fs.writeFile(mainIndex, content);
      } catch (e) {
        // Variant index doesn't exist, skip
      }

      // Copy variant menu.html to main if exists
      const variantMenu = join(variantDir, 'menu.html');
      const mainMenu = join(mainDir, 'menu.html');

      try {
        const content = await fs.readFile(variantMenu, 'utf-8');
        await fs.writeFile(mainMenu, content);
      } catch (e) {
        // Variant menu doesn't exist, skip
      }

      // Clean up variant directory
      await this.deleteVariant(restaurantId, variantId);

      return { success: true };
    } catch (error) {
      console.error(`Failed to promote variant ${variantId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a variant exists
   */
  async variantExists(restaurantId, variantId) {
    const variantPath = join(config.paths.websites, restaurantId, 'variants', variantId, 'index.html');

    try {
      await fs.access(variantPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update both index.html and menu.html if the change affects both
   */
  async updateAll(restaurantId, prompt) {
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error(`Restaurant not found: ${restaurantId}`);
    }

    // Step 1: Classify
    const classification = await this.classifyRequest(prompt, restaurant);

    // Step 2: SQL if needed
    let sqlResults = [];
    if (classification.hasDataChange) {
      const sqlStatements = await this.generateSQL(prompt, restaurant);
      sqlResults = await this.executeSQL(sqlStatements);

      // Refresh restaurant data
      const updatedRestaurant = RestaurantModel.getFullData(restaurantId);
      Object.assign(restaurant, updatedRestaurant);
    }

    // Update index.html
    const indexHTML = await this.readHTML(restaurantId);
    const indexChunks = await this.identifyChunks(prompt, indexHTML, classification);
    let updatedIndex = indexHTML;
    for (const chunk of indexChunks) {
      updatedIndex = await this.regenerateChunk(updatedIndex, chunk, prompt, restaurant);
    }
    await this.writeHTML(restaurantId, updatedIndex);

    // Update menu.html if it exists
    let menuChunksModified = 0;
    const menuHTML = await this.readMenuHTML(restaurantId);
    if (menuHTML) {
      const menuChunks = await this.identifyChunks(prompt, menuHTML, classification);
      let updatedMenu = menuHTML;
      for (const chunk of menuChunks) {
        updatedMenu = await this.regenerateChunk(updatedMenu, chunk, prompt, restaurant);
      }
      await this.writeMenuHTML(restaurantId, updatedMenu);
      menuChunksModified = menuChunks.length;
    }

    return {
      success: true,
      classification,
      sqlExecuted: sqlResults,
      chunksModified: {
        index: indexChunks.length,
        menu: menuChunksModified
      }
    };
  }
}
