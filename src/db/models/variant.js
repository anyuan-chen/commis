import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const VariantModel = {
  /**
   * Create a new variant
   */
  create(experimentId, data) {
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO experiment_variants (
        id, experiment_id, name, is_control, change_prompt, change_description
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      experimentId,
      data.name,
      data.isControl ? 1 : 0,
      data.changePrompt || null,
      data.changeDescription || null
    );

    return this.getById(id);
  },

  /**
   * Get variant by ID
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM experiment_variants WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return this.formatVariant(row);
  },

  /**
   * Get all variants for an experiment
   */
  getByExperiment(experimentId) {
    const stmt = db.prepare(`
      SELECT * FROM experiment_variants
      WHERE experiment_id = ?
      ORDER BY is_control DESC, name
    `);
    return stmt.all(experimentId).map(row => this.formatVariant(row));
  },

  /**
   * Get control variant for an experiment
   */
  getControl(experimentId) {
    const stmt = db.prepare(`
      SELECT * FROM experiment_variants
      WHERE experiment_id = ? AND is_control = 1
      LIMIT 1
    `);
    const row = stmt.get(experimentId);
    if (!row) return null;

    return this.formatVariant(row);
  },

  /**
   * Increment visitor count
   */
  incrementVisitors(id) {
    const stmt = db.prepare(`
      UPDATE experiment_variants
      SET visitors = visitors + 1
      WHERE id = ?
    `);
    stmt.run(id);
    return this.getById(id);
  },

  /**
   * Increment conversion count
   */
  incrementConversions(id) {
    const stmt = db.prepare(`
      UPDATE experiment_variants
      SET conversions = conversions + 1
      WHERE id = ?
    `);
    stmt.run(id);
    return this.getById(id);
  },

  /**
   * Update variant stats
   */
  updateStats(id, visitors, conversions, revenue = null) {
    if (revenue !== null) {
      const stmt = db.prepare(`
        UPDATE experiment_variants
        SET visitors = ?, conversions = ?, revenue = ?
        WHERE id = ?
      `);
      stmt.run(visitors, conversions, revenue, id);
    } else {
      const stmt = db.prepare(`
        UPDATE experiment_variants
        SET visitors = ?, conversions = ?
        WHERE id = ?
      `);
      stmt.run(visitors, conversions, id);
    }
    return this.getById(id);
  },

  /**
   * Add revenue to variant
   */
  addRevenue(id, amount) {
    const stmt = db.prepare(`
      UPDATE experiment_variants
      SET revenue = revenue + ?
      WHERE id = ?
    `);
    stmt.run(amount, id);
    return this.getById(id);
  },

  /**
   * Update traffic allocation
   */
  updateTrafficAllocation(id, allocation) {
    const stmt = db.prepare(`
      UPDATE experiment_variants
      SET traffic_allocation = ?
      WHERE id = ?
    `);
    stmt.run(allocation, id);
    return this.getById(id);
  },

  /**
   * Update traffic allocations for all variants in an experiment
   */
  updateAllAllocations(experimentId, allocations) {
    const variants = this.getByExperiment(experimentId);
    for (let i = 0; i < variants.length && i < allocations.length; i++) {
      this.updateTrafficAllocation(variants[i].id, allocations[i]);
    }
  },

  /**
   * Get variant with experiment info
   */
  getWithExperiment(id) {
    const stmt = db.prepare(`
      SELECT v.*, e.restaurant_id, e.hypothesis, e.status as experiment_status
      FROM experiment_variants v
      JOIN experiments e ON e.id = v.experiment_id
      WHERE v.id = ?
    `);
    const row = stmt.get(id);
    if (!row) return null;

    return {
      ...this.formatVariant(row),
      restaurantId: row.restaurant_id,
      experimentHypothesis: row.hypothesis,
      experimentStatus: row.experiment_status
    };
  },

  /**
   * Delete variant
   */
  delete(id) {
    const stmt = db.prepare('DELETE FROM experiment_variants WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Format database row to API response
   */
  formatVariant(row) {
    const visitors = row.visitors || 0;
    const conversions = row.conversions || 0;
    const revenue = row.revenue || 0;

    return {
      id: row.id,
      experimentId: row.experiment_id,
      name: row.name,
      isControl: row.is_control === 1,
      changePrompt: row.change_prompt,
      changeDescription: row.change_description,
      visitors,
      conversions,
      revenue,
      conversionRate: visitors > 0 ? conversions / visitors : 0,
      revenuePerVisitor: visitors > 0 ? revenue / visitors : 0,
      avgOrderValue: conversions > 0 ? revenue / conversions : 0,
      trafficAllocation: row.traffic_allocation || 0.5,
      createdAt: row.created_at
    };
  }
};
