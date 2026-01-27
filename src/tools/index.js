import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel, NoteModel, ReviewModel, ReviewDigestModel } from '../db/models/index.js';

/**
 * Tool executor - handles all voice command tool calls
 */
export class ToolExecutor {
  constructor(restaurantId) {
    this.restaurantId = restaurantId;
    this.websiteGenerator = null;
    this.brochureGenerator = null;
    this.cloudflareDeployer = null;
    this.imageGenerator = null;
  }

  setImageGenerator(generator) {
    this.imageGenerator = generator;
  }

  setWebsiteGenerator(generator) {
    this.websiteGenerator = generator;
  }

  setBrochureGenerator(generator) {
    this.brochureGenerator = generator;
  }

  setCloudflareDeployer(deployer) {
    this.cloudflareDeployer = deployer;
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName, args) {
    const handlers = {
      updateRestaurantInfo: () => this.updateRestaurantInfo(args),
      updateHours: () => this.updateHours(args),
      addMenuItem: () => this.addMenuItem(args),
      updateMenuItem: () => this.updateMenuItem(args),
      removeMenuItem: () => this.removeMenuItem(args),
      editWebsiteStyle: () => this.editWebsiteStyle(args),
      regenerateWebsite: () => this.regenerateWebsite(),
      regenerateBrochure: () => this.regenerateBrochure(args),
      deployWebsite: () => this.deployWebsite(),
      getRestaurantInfo: () => this.getRestaurantInfo(),
      addNote: () => this.addNote(args),
      removeNote: () => this.removeNote(args),
      generateSocialGraphic: () => this.generateSocialGraphic(args),
      generatePromoGraphic: () => this.generatePromoGraphic(args),
      generateHolidayGraphic: () => this.generateHolidayGraphic(args),
      generateMenuGraphic: () => this.generateMenuGraphic(args),
      getReviewDigest: () => this.getReviewDigest(),
      getReviewStats: () => this.getReviewStats(args)
    };

    const handler = handlers[toolName];
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return handler();
  }

  /**
   * Update restaurant info field
   */
  async updateRestaurantInfo({ field, value }) {
    const fieldMap = {
      name: 'name',
      tagline: 'tagline',
      description: 'description',
      address: 'address',
      phone: 'phone',
      email: 'email',
      cuisineType: 'cuisineType'
    };

    const dbField = fieldMap[field];
    if (!dbField) {
      return { success: false, error: `Unknown field: ${field}` };
    }

    const updated = RestaurantModel.update(this.restaurantId, { [dbField]: value });

    return {
      success: true,
      message: `Updated ${field} to "${value}"`,
      restaurant: updated
    };
  }

  /**
   * Update operating hours
   */
  async updateHours({ day, hours }) {
    const restaurant = RestaurantModel.getById(this.restaurantId);
    const currentHours = restaurant.hours || {};

    currentHours[day.toLowerCase()] = hours;

    const updated = RestaurantModel.update(this.restaurantId, { hours: currentHours });

    return {
      success: true,
      message: `Updated ${day} hours to "${hours}"`,
      hours: updated.hours
    };
  }

  /**
   * Add a new menu item
   */
  async addMenuItem({ name, description, price, category }) {
    // Find or create category
    const categories = MenuCategoryModel.getByRestaurant(this.restaurantId);
    let categoryRecord = categories.find(c => c.name.toLowerCase() === category.toLowerCase());

    if (!categoryRecord) {
      categoryRecord = MenuCategoryModel.create(this.restaurantId, { name: category });
    }

    const item = MenuItemModel.create(categoryRecord.id, {
      name,
      description,
      price
    });

    return {
      success: true,
      message: `Added "${name}" to ${category} for $${price}`,
      item
    };
  }

  /**
   * Update an existing menu item
   */
  async updateMenuItem({ itemName, field, value }) {
    const item = MenuItemModel.findByName(this.restaurantId, itemName);

    if (!item) {
      return {
        success: false,
        error: `Could not find menu item matching "${itemName}"`
      };
    }

    const updateData = {};
    if (field === 'price') {
      updateData.price = parseFloat(value);
    } else {
      updateData[field] = value;
    }

    const updated = MenuItemModel.update(item.id, updateData);

    return {
      success: true,
      message: `Updated ${itemName}'s ${field} to "${value}"`,
      item: updated
    };
  }

  /**
   * Remove a menu item
   */
  async removeMenuItem({ itemName }) {
    const item = MenuItemModel.findByName(this.restaurantId, itemName);

    if (!item) {
      return {
        success: false,
        error: `Could not find menu item matching "${itemName}"`
      };
    }

    MenuItemModel.delete(item.id);

    return {
      success: true,
      message: `Removed "${item.name}" from the menu`
    };
  }

  /**
   * Edit website style
   */
  async editWebsiteStyle({ styleTheme, primaryColor }) {
    const updates = {};
    if (styleTheme) updates.styleTheme = styleTheme;
    if (primaryColor) updates.primaryColor = primaryColor;

    const updated = RestaurantModel.update(this.restaurantId, updates);

    return {
      success: true,
      message: `Updated website style${styleTheme ? ` to ${styleTheme}` : ''}${primaryColor ? ` with color ${primaryColor}` : ''}`,
      style: {
        theme: updated.style_theme,
        color: updated.primary_color
      }
    };
  }

  /**
   * Regenerate website
   */
  async regenerateWebsite() {
    if (!this.websiteGenerator) {
      return {
        success: false,
        error: 'Website generator not available'
      };
    }

    try {
      const result = await this.websiteGenerator.generate(this.restaurantId);
      return {
        success: true,
        message: 'Website regenerated successfully',
        path: result.path
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Regenerate brochure
   */
  async regenerateBrochure({ layout = 'portrait' }) {
    if (!this.brochureGenerator) {
      return {
        success: false,
        error: 'Brochure generator not available'
      };
    }

    try {
      const result = await this.brochureGenerator.generate(this.restaurantId, { layout });
      return {
        success: true,
        message: `Brochure regenerated in ${layout} layout`,
        pdfPath: result.pdfPath,
        imagePath: result.imagePath
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Deploy website to Cloudflare
   */
  async deployWebsite() {
    if (!this.cloudflareDeployer) {
      return {
        success: false,
        error: 'Cloudflare deployer not available'
      };
    }

    try {
      const result = await this.cloudflareDeployer.deploy(this.restaurantId);
      return {
        success: true,
        message: `Website deployed successfully`,
        url: result.url
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current restaurant info
   */
  async getRestaurantInfo() {
    const data = RestaurantModel.getFullData(this.restaurantId);

    if (!data) {
      return {
        success: false,
        error: 'Restaurant not found'
      };
    }

    return {
      success: true,
      restaurant: data
    };
  }

  /**
   * Add a note/announcement
   */
  async addNote({ content, expiresAt }) {
    const note = NoteModel.create(this.restaurantId, {
      content,
      expiresAt: expiresAt || null
    });

    const expiryMsg = expiresAt ? ` (expires ${expiresAt})` : '';

    return {
      success: true,
      message: `Added note: "${content}"${expiryMsg}`,
      note
    };
  }

  /**
   * Remove a note by searching its content
   */
  async removeNote({ searchText }) {
    const deleted = NoteModel.deleteByContent(this.restaurantId, searchText);

    if (!deleted) {
      return {
        success: false,
        error: `Could not find a note matching "${searchText}"`
      };
    }

    return {
      success: true,
      message: `Removed note: "${deleted.content}"`
    };
  }

  /**
   * Generate social media graphic
   */
  async generateSocialGraphic({ platform = 'instagram', theme = 'promotion', customText }) {
    if (!this.imageGenerator) {
      return { success: false, error: 'Image generator not available' };
    }

    try {
      const result = await this.imageGenerator.generateSocialPost(this.restaurantId, {
        platform,
        theme,
        customText
      });

      return {
        success: true,
        message: `Generated ${platform} ${theme} graphic`,
        path: result.path,
        url: `/images/${result.path.split('/').pop()}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate promotional graphic
   */
  async generatePromoGraphic({ promoText, eventName, date }) {
    if (!this.imageGenerator) {
      return { success: false, error: 'Image generator not available' };
    }

    try {
      const result = await this.imageGenerator.generatePromoGraphic(this.restaurantId, {
        promoText,
        eventName,
        date
      });

      return {
        success: true,
        message: `Generated promo graphic${eventName ? ` for ${eventName}` : ''}`,
        path: result.path,
        url: `/images/${result.path.split('/').pop()}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate holiday graphic
   */
  async generateHolidayGraphic({ holiday, message }) {
    if (!this.imageGenerator) {
      return { success: false, error: 'Image generator not available' };
    }

    try {
      const result = await this.imageGenerator.generateHolidayGraphic(this.restaurantId, {
        holiday,
        message
      });

      return {
        success: true,
        message: `Generated ${holiday} graphic`,
        path: result.path,
        url: `/images/${result.path.split('/').pop()}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate menu graphic
   */
  async generateMenuGraphic({ style = 'elegant', category }) {
    if (!this.imageGenerator) {
      return { success: false, error: 'Image generator not available' };
    }

    try {
      const result = await this.imageGenerator.generateMenuGraphic(this.restaurantId, {
        style,
        category
      });

      return {
        success: true,
        message: `Generated ${style} menu graphic`,
        path: result.path,
        url: `/images/${result.path.split('/').pop()}`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get the latest review digest
   */
  async getReviewDigest() {
    const digest = ReviewDigestModel.getLatest(this.restaurantId);

    if (!digest) {
      return {
        success: false,
        message: 'No review digest available yet. Reviews need to be collected and analyzed first.'
      };
    }

    return {
      success: true,
      period: `${digest.periodStart?.slice(0, 10)} to ${digest.periodEnd?.slice(0, 10)}`,
      reviewCount: digest.reviewCount,
      avgRating: digest.avgRating?.toFixed(1),
      sentimentSummary: digest.sentimentSummary,
      topComplaints: digest.commonComplaints?.slice(0, 3).map(c => ({
        issue: c.theme,
        severity: c.severity
      })),
      whatCustomersLove: digest.praiseThemes?.slice(0, 3).map(p => ({
        theme: p.theme,
        mentions: p.count
      })),
      suggestedActions: digest.suggestedActions?.slice(0, 2).map(a => ({
        action: a.action,
        priority: a.priority
      }))
    };
  }

  /**
   * Get quick review statistics
   */
  async getReviewStats({ days = 30 } = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = ReviewModel.getStats(this.restaurantId, {
      startDate: startDate.toISOString()
    });

    if (!stats || stats.total_reviews === 0) {
      return {
        success: false,
        message: 'No reviews found for this period.'
      };
    }

    return {
      success: true,
      period: `Last ${days} days`,
      totalReviews: stats.total_reviews,
      avgRating: stats.avg_rating ? parseFloat(stats.avg_rating.toFixed(2)) : null,
      sentimentBreakdown: {
        positive: stats.positive_count || 0,
        negative: stats.negative_count || 0,
        neutral: stats.neutral_count || 0,
        mixed: stats.mixed_count || 0
      },
      avgSentimentScore: stats.avg_sentiment ? parseFloat(stats.avg_sentiment.toFixed(2)) : null
    };
  }
}
