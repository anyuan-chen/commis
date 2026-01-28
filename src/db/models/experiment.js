import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const ExperimentModel = {
  /**
   * Create a new experiment
   */
  create(restaurantId, data) {
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO experiments (
        id, restaurant_id, hypothesis, change_type, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      restaurantId,
      data.hypothesis,
      data.changeType || null,
      data.status || 'pending',
      data.startedAt || null
    );

    return this.getById(id);
  },

  /**
   * Get experiment by ID
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM experiments WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return this.formatExperiment(row);
  },

  /**
   * Get active experiment for a restaurant
   */
  getActive(restaurantId) {
    const stmt = db.prepare(`
      SELECT * FROM experiments
      WHERE restaurant_id = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get(restaurantId);
    if (!row) return null;

    return this.formatExperiment(row);
  },

  /**
   * Get all experiments for a restaurant
   */
  getByRestaurant(restaurantId, options = {}) {
    const { status, limit = 50, offset = 0 } = options;

    let sql = 'SELECT * FROM experiments WHERE restaurant_id = ?';
    const params = [restaurantId];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    return stmt.all(...params).map(row => this.formatExperiment(row));
  },

  /**
   * Count experiments this week for a restaurant
   */
  countThisWeek(restaurantId, weekStart) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM experiments
      WHERE restaurant_id = ? AND created_at >= ?
    `);
    const row = stmt.get(restaurantId, weekStart);
    return row?.count || 0;
  },

  /**
   * Update experiment
   */
  update(id, data) {
    const fields = [];
    const values = [];

    const fieldMap = {
      hypothesis: 'hypothesis',
      changeType: 'change_type',
      status: 'status',
      winningVariantId: 'winning_variant_id',
      pauseReason: 'pause_reason',
      baselineConversionRate: 'baseline_conversion_rate',
      startedAt: 'started_at',
      endedAt: 'ended_at'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(data[key]);
      }
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const stmt = db.prepare(`UPDATE experiments SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(id);
  },

  /**
   * Start an experiment
   */
  start(id) {
    return this.update(id, {
      status: 'running',
      startedAt: new Date().toISOString()
    });
  },

  /**
   * Conclude an experiment with a winner
   */
  conclude(id, winningVariantId) {
    return this.update(id, {
      status: 'concluded',
      winningVariantId,
      endedAt: new Date().toISOString()
    });
  },

  /**
   * Mark experiment as applied
   */
  markApplied(id) {
    return this.update(id, { status: 'applied' });
  },

  /**
   * Delete experiment
   */
  delete(id) {
    const stmt = db.prepare('DELETE FROM experiments WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Get experiment with variants
   */
  getWithVariants(id) {
    const experiment = this.getById(id);
    if (!experiment) return null;

    const variantStmt = db.prepare('SELECT * FROM experiment_variants WHERE experiment_id = ?');
    const variants = variantStmt.all(id).map(row => ({
      id: row.id,
      experimentId: row.experiment_id,
      name: row.name,
      isControl: row.is_control === 1,
      changePrompt: row.change_prompt,
      changeDescription: row.change_description,
      visitors: row.visitors || 0,
      conversions: row.conversions || 0,
      revenue: row.revenue || 0,
      conversionRate: row.visitors > 0 ? row.conversions / row.visitors : 0,
      revenuePerVisitor: row.visitors > 0 ? (row.revenue || 0) / row.visitors : 0,
      trafficAllocation: row.traffic_allocation || 0.5,
      createdAt: row.created_at
    }));

    return { ...experiment, variants };
  },

  /**
   * Format database row to API response
   */
  formatExperiment(row) {
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      hypothesis: row.hypothesis,
      changeType: row.change_type,
      status: row.status,
      winningVariantId: row.winning_variant_id,
      pauseReason: row.pause_reason,
      baselineConversionRate: row.baseline_conversion_rate,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at
    };
  }
};
