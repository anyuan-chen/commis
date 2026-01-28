import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const AnalyticsEventModel = {
  /**
   * Create a new analytics event
   */
  create(data) {
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO analytics_events (
        id, restaurant_id, session_id, variant_id, event_type, event_data_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.restaurantId,
      data.sessionId,
      data.variantId || null,
      data.eventType,
      data.eventData ? JSON.stringify(data.eventData) : null
    );

    return this.getById(id);
  },

  /**
   * Batch create events
   */
  createBatch(events) {
    const stmt = db.prepare(`
      INSERT INTO analytics_events (
        id, restaurant_id, session_id, variant_id, event_type, event_data_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const event of events) {
      stmt.run(
        uuidv4(),
        event.restaurantId,
        event.sessionId,
        event.variantId || null,
        event.eventType,
        event.eventData ? JSON.stringify(event.eventData) : null
      );
    }

    return events.length;
  },

  /**
   * Get event by ID
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM analytics_events WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return this.formatEvent(row);
  },

  /**
   * Get events by restaurant
   */
  getByRestaurant(restaurantId, options = {}) {
    const { eventType, startDate, endDate, limit = 1000 } = options;

    let sql = 'SELECT * FROM analytics_events WHERE restaurant_id = ?';
    const params = [restaurantId];

    if (eventType) {
      sql += ' AND event_type = ?';
      params.push(eventType);
    }

    if (startDate) {
      sql += ' AND created_at >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND created_at <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(sql);
    return stmt.all(...params).map(row => this.formatEvent(row));
  },

  /**
   * Get events by variant
   */
  getByVariant(variantId, options = {}) {
    const { eventType, limit = 1000 } = options;

    let sql = 'SELECT * FROM analytics_events WHERE variant_id = ?';
    const params = [variantId];

    if (eventType) {
      sql += ' AND event_type = ?';
      params.push(eventType);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(sql);
    return stmt.all(...params).map(row => this.formatEvent(row));
  },

  /**
   * Get aggregated metrics for a restaurant
   */
  getMetrics(restaurantId, options = {}) {
    const { startDate, endDate } = options;

    let whereClause = 'WHERE restaurant_id = ?';
    const params = [restaurantId];

    if (startDate) {
      whereClause += ' AND created_at >= ?';
      params.push(startDate);
    }

    if (endDate) {
      whereClause += ' AND created_at <= ?';
      params.push(endDate);
    }

    // Get event counts by type
    const countStmt = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM analytics_events
      ${whereClause}
      GROUP BY event_type
    `);
    const eventCounts = countStmt.all(...params);

    // Get unique sessions
    const sessionStmt = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as unique_sessions
      FROM analytics_events
      ${whereClause}
    `);
    const sessionRow = sessionStmt.get(...params);

    // Get scroll depth distribution
    const scrollStmt = db.prepare(`
      SELECT
        json_extract(event_data_json, '$.depth') as depth,
        COUNT(*) as count
      FROM analytics_events
      ${whereClause} AND event_type = 'scroll'
      GROUP BY depth
    `);
    const scrollDepths = scrollStmt.all(...params);

    // Get average time on page
    const timeStmt = db.prepare(`
      SELECT AVG(json_extract(event_data_json, '$.seconds')) as avg_time
      FROM analytics_events
      ${whereClause} AND event_type = 'time_on_page'
    `);
    const timeRow = timeStmt.get(...params);

    return {
      eventCounts: eventCounts.reduce((acc, row) => {
        acc[row.event_type] = row.count;
        return acc;
      }, {}),
      uniqueSessions: sessionRow?.unique_sessions || 0,
      scrollDepths: scrollDepths.reduce((acc, row) => {
        if (row.depth) acc[row.depth] = row.count;
        return acc;
      }, {}),
      avgTimeOnPage: timeRow?.avg_time || 0
    };
  },

  /**
   * Get variant-level metrics including revenue
   */
  getVariantMetrics(variantId) {
    const params = [variantId];

    // Get unique visitors (sessions with pageview)
    const visitorStmt = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as visitors
      FROM analytics_events
      WHERE variant_id = ? AND event_type = 'pageview'
    `);
    const visitorRow = visitorStmt.get(...params);

    // Get conversions (unique sessions with order event)
    const conversionStmt = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as conversions
      FROM analytics_events
      WHERE variant_id = ? AND event_type = 'order'
    `);
    const conversionRow = conversionStmt.get(...params);

    // Get cart additions
    const cartStmt = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as cart_adds
      FROM analytics_events
      WHERE variant_id = ? AND event_type = 'cart_add'
    `);
    const cartRow = cartStmt.get(...params);

    // Get total revenue from order events
    const revenueStmt = db.prepare(`
      SELECT SUM(json_extract(event_data_json, '$.total')) as total_revenue
      FROM analytics_events
      WHERE variant_id = ? AND event_type = 'order'
    `);
    const revenueRow = revenueStmt.get(...params);

    return {
      visitors: visitorRow?.visitors || 0,
      conversions: conversionRow?.conversions || 0,
      cartAdds: cartRow?.cart_adds || 0,
      revenue: revenueRow?.total_revenue || 0
    };
  },

  /**
   * Get historical conversion rate for a restaurant (for baseline/anomaly detection)
   */
  getHistoricalConversionRate(restaurantId, daysBack = 30, excludeVariantId = null) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    let sql = `
      SELECT
        COUNT(DISTINCT CASE WHEN event_type = 'pageview' THEN session_id END) as visitors,
        COUNT(DISTINCT CASE WHEN event_type = 'order' THEN session_id END) as conversions
      FROM analytics_events
      WHERE restaurant_id = ? AND created_at >= ?
    `;
    const params = [restaurantId, startDate.toISOString()];

    if (excludeVariantId) {
      sql += ' AND (variant_id IS NULL OR variant_id != ?)';
      params.push(excludeVariantId);
    }

    const stmt = db.prepare(sql);
    const row = stmt.get(...params);

    const visitors = row?.visitors || 0;
    const conversions = row?.conversions || 0;

    return {
      visitors,
      conversions,
      conversionRate: visitors > 0 ? conversions / visitors : 0
    };
  },

  /**
   * Check if session has a variant assigned
   */
  getSessionVariant(restaurantId, sessionId) {
    const stmt = db.prepare(`
      SELECT variant_id FROM analytics_events
      WHERE restaurant_id = ? AND session_id = ? AND variant_id IS NOT NULL
      LIMIT 1
    `);
    const row = stmt.get(restaurantId, sessionId);
    return row?.variant_id || null;
  },

  /**
   * Purge old events
   */
  purgeOlderThan(daysAgo) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysAgo);

    const stmt = db.prepare(`
      DELETE FROM analytics_events
      WHERE created_at < ?
    `);
    const result = stmt.run(cutoffDate.toISOString());
    return result.changes;
  },

  /**
   * Format database row to API response
   */
  formatEvent(row) {
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      sessionId: row.session_id,
      variantId: row.variant_id,
      eventType: row.event_type,
      eventData: row.event_data_json ? JSON.parse(row.event_data_json) : null,
      createdAt: row.created_at
    };
  }
};
