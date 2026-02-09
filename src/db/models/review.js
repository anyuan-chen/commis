import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const ReviewModel = {
  /**
   * Create or update a review (upsert based on source + external_id)
   */
  upsert(restaurantId, data) {
    // Check if review already exists
    const existing = this.getByExternalId(restaurantId, data.source, data.externalId);

    if (existing) {
      // Update existing review
      return this.update(existing.id, data);
    }

    // Create new review
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO reviews (
        id, restaurant_id, source, external_id, author_name, author_url,
        rating, text, review_date, sentiment_score, sentiment_label, key_themes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      restaurantId,
      data.source,
      data.externalId || null,
      data.authorName || null,
      data.authorUrl || null,
      data.rating || null,
      data.text || null,
      data.reviewDate || null,
      data.sentimentScore || null,
      data.sentimentLabel || null,
      data.keyThemes ? JSON.stringify(data.keyThemes) : null
    );

    return this.getById(id);
  },

  /**
   * Update existing review
   */
  update(id, data) {
    const fields = [];
    const values = [];

    const fieldMap = {
      authorName: 'author_name',
      authorUrl: 'author_url',
      rating: 'rating',
      text: 'text',
      reviewDate: 'review_date',
      sentimentScore: 'sentiment_score',
      sentimentLabel: 'sentiment_label',
      keyThemes: 'key_themes_json'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(key === 'keyThemes' ? JSON.stringify(data[key]) : data[key]);
      }
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const stmt = db.prepare(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(id);
  },

  /**
   * Get review by ID
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM reviews WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return this.formatReview(row);
  },

  /**
   * Get review by external ID (for deduplication)
   */
  getByExternalId(restaurantId, source, externalId) {
    if (!externalId) return null;

    const stmt = db.prepare(`
      SELECT * FROM reviews
      WHERE restaurant_id = ? AND source = ? AND external_id = ?
    `);
    const row = stmt.get(restaurantId, source, externalId);
    if (!row) return null;

    return this.formatReview(row);
  },

  /**
   * Get all reviews for a restaurant
   */
  getByRestaurant(restaurantId, options = {}) {
    const { source, limit = 100, offset = 0, sentiment, startDate, endDate } = options;

    let sql = 'SELECT * FROM reviews WHERE restaurant_id = ?';
    const params = [restaurantId];

    if (source) {
      sql += ' AND source = ?';
      params.push(source);
    }

    if (sentiment) {
      sql += ' AND sentiment_label = ?';
      params.push(sentiment);
    }

    if (startDate) {
      sql += ' AND (review_date >= ? OR review_date IS NULL OR review_date = \'\')';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND (review_date <= ? OR review_date IS NULL OR review_date = \'\')';
      params.push(endDate);
    }

    sql += ' ORDER BY review_date DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    return stmt.all(...params).map(row => this.formatReview(row));
  },

  /**
   * Get reviews without sentiment analysis
   */
  getUnanalyzed(restaurantId, limit = 50) {
    const stmt = db.prepare(`
      SELECT * FROM reviews
      WHERE restaurant_id = ? AND sentiment_label IS NULL
      ORDER BY review_date DESC
      LIMIT ?
    `);
    return stmt.all(restaurantId, limit).map(row => this.formatReview(row));
  },

  /**
   * Get review stats for a restaurant
   */
  getStats(restaurantId, options = {}) {
    const { startDate, endDate, source } = options;

    let sql = `
      SELECT
        COUNT(*) as total_reviews,
        AVG(rating) as avg_rating,
        COUNT(CASE WHEN sentiment_label = 'positive' THEN 1 END) as positive_count,
        COUNT(CASE WHEN sentiment_label = 'negative' THEN 1 END) as negative_count,
        COUNT(CASE WHEN sentiment_label = 'neutral' THEN 1 END) as neutral_count,
        COUNT(CASE WHEN sentiment_label = 'mixed' THEN 1 END) as mixed_count,
        AVG(sentiment_score) as avg_sentiment
      FROM reviews
      WHERE restaurant_id = ?
    `;
    const params = [restaurantId];

    if (source) {
      sql += ' AND source = ?';
      params.push(source);
    }

    if (startDate) {
      sql += ' AND (review_date >= ? OR review_date IS NULL OR review_date = \'\')';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND (review_date <= ? OR review_date IS NULL OR review_date = \'\')';
      params.push(endDate);
    }

    const stmt = db.prepare(sql);
    return stmt.get(...params);
  },

  /**
   * Get rating distribution
   */
  getRatingDistribution(restaurantId, source = null) {
    let sql = `
      SELECT
        CAST(rating AS INTEGER) as rating_bucket,
        COUNT(*) as count
      FROM reviews
      WHERE restaurant_id = ? AND rating IS NOT NULL
    `;
    const params = [restaurantId];

    if (source) {
      sql += ' AND source = ?';
      params.push(source);
    }

    sql += ' GROUP BY rating_bucket ORDER BY rating_bucket';

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  /**
   * Delete review
   */
  delete(id) {
    const stmt = db.prepare('DELETE FROM reviews WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Format database row to API response
   */
  formatReview(row) {
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      source: row.source,
      externalId: row.external_id,
      authorName: row.author_name,
      authorUrl: row.author_url,
      rating: row.rating,
      text: row.text,
      reviewDate: row.review_date,
      sentimentScore: row.sentiment_score,
      sentimentLabel: row.sentiment_label,
      keyThemes: row.key_themes_json ? JSON.parse(row.key_themes_json) : [],
      createdAt: row.created_at
    };
  }
};

export const ReviewPlatformModel = {
  /**
   * Get or create platform tokens for a restaurant
   */
  getOrCreate(restaurantId) {
    let row = this.getByRestaurant(restaurantId);
    if (row) return row;

    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO review_platform_tokens (id, restaurant_id)
      VALUES (?, ?)
    `);
    stmt.run(id, restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Get platform tokens by restaurant
   */
  getByRestaurant(restaurantId) {
    const stmt = db.prepare('SELECT * FROM review_platform_tokens WHERE restaurant_id = ?');
    const row = stmt.get(restaurantId);
    if (!row) return null;

    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      googlePlaceId: row.google_place_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  /**
   * Link Google Place ID
   */
  linkGoogle(restaurantId, placeId) {
    this.getOrCreate(restaurantId);

    const stmt = db.prepare(`
      UPDATE review_platform_tokens
      SET google_place_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(placeId, restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Get all restaurants with linked platforms
   */
  getAllLinked() {
    const stmt = db.prepare(`
      SELECT rpt.*, r.name as restaurant_name, r.reviews_enabled
      FROM review_platform_tokens rpt
      JOIN restaurants r ON r.id = rpt.restaurant_id
      WHERE rpt.google_place_id IS NOT NULL
    `);
    return stmt.all().map(row => ({
      restaurantId: row.restaurant_id,
      restaurantName: row.restaurant_name,
      reviewsEnabled: row.reviews_enabled === 1,
      googlePlaceId: row.google_place_id
    }));
  }
};

export const DigestPreferencesModel = {
  /**
   * Get or create preferences for a restaurant
   */
  getOrCreate(restaurantId) {
    let row = this.getByRestaurant(restaurantId);
    if (row) return row;

    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO digest_preferences (id, restaurant_id)
      VALUES (?, ?)
    `);
    stmt.run(id, restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Get preferences by restaurant
   */
  getByRestaurant(restaurantId) {
    const stmt = db.prepare('SELECT * FROM digest_preferences WHERE restaurant_id = ?');
    const row = stmt.get(restaurantId);
    if (!row) return null;

    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      emailEnabled: row.email_enabled === 1,
      emailAddress: row.email_address,
      frequency: row.frequency,
      dayOfWeek: row.day_of_week,
      hourOfDay: row.hour_of_day,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  /**
   * Update preferences
   */
  update(restaurantId, data) {
    this.getOrCreate(restaurantId);

    const fields = [];
    const values = [];

    const fieldMap = {
      emailEnabled: 'email_enabled',
      emailAddress: 'email_address',
      frequency: 'frequency',
      dayOfWeek: 'day_of_week',
      hourOfDay: 'hour_of_day'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(key === 'emailEnabled' ? (data[key] ? 1 : 0) : data[key]);
      }
    }

    if (fields.length === 0) return this.getByRestaurant(restaurantId);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(restaurantId);

    const stmt = db.prepare(`
      UPDATE digest_preferences SET ${fields.join(', ')} WHERE restaurant_id = ?
    `);
    stmt.run(...values);

    return this.getByRestaurant(restaurantId);
  }
};
