import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const OptimizerStateModel = {
  /**
   * Get or create optimizer state for a restaurant
   */
  getOrCreate(restaurantId) {
    let state = this.getByRestaurant(restaurantId);
    if (state) return state;

    const id = uuidv4();
    const weekStart = this.getWeekStart();

    const stmt = db.prepare(`
      INSERT INTO optimizer_state (
        id, restaurant_id, enabled, experiments_this_week, week_start, learnings_json
      ) VALUES (?, ?, 0, 0, ?, '[]')
    `);
    stmt.run(id, restaurantId, weekStart);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Get optimizer state by restaurant
   */
  getByRestaurant(restaurantId) {
    const stmt = db.prepare('SELECT * FROM optimizer_state WHERE restaurant_id = ?');
    const row = stmt.get(restaurantId);
    if (!row) return null;

    return this.formatState(row);
  },

  /**
   * Get all enabled optimizers
   */
  getAllEnabled() {
    const stmt = db.prepare('SELECT * FROM optimizer_state WHERE enabled = 1');
    return stmt.all().map(row => this.formatState(row));
  },

  /**
   * Enable optimizer for a restaurant
   */
  enable(restaurantId) {
    this.getOrCreate(restaurantId);

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET enabled = 1, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Disable optimizer for a restaurant
   */
  disable(restaurantId) {
    this.getOrCreate(restaurantId);

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET enabled = 0, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Toggle optimizer state
   */
  toggle(restaurantId, enabled) {
    return enabled ? this.enable(restaurantId) : this.disable(restaurantId);
  },

  /**
   * Increment experiment count for current week
   */
  incrementExperimentCount(restaurantId) {
    const state = this.getOrCreate(restaurantId);
    const currentWeekStart = this.getWeekStart();

    // Reset count if new week
    if (state.weekStart !== currentWeekStart) {
      const stmt = db.prepare(`
        UPDATE optimizer_state
        SET experiments_this_week = 1, week_start = ?, updated_at = CURRENT_TIMESTAMP
        WHERE restaurant_id = ?
      `);
      stmt.run(currentWeekStart, restaurantId);
    } else {
      const stmt = db.prepare(`
        UPDATE optimizer_state
        SET experiments_this_week = experiments_this_week + 1, updated_at = CURRENT_TIMESTAMP
        WHERE restaurant_id = ?
      `);
      stmt.run(restaurantId);
    }

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Reset weekly experiment count (for all restaurants)
   */
  resetWeeklyCounts() {
    const weekStart = this.getWeekStart();

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET experiments_this_week = 0, week_start = ?, updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(weekStart);
  },

  /**
   * Add a learning from a completed experiment
   */
  addLearning(restaurantId, learning) {
    const state = this.getOrCreate(restaurantId);
    const learnings = state.learnings || [];

    learnings.push({
      ...learning,
      addedAt: new Date().toISOString()
    });

    // Keep only last 50 learnings
    const trimmedLearnings = learnings.slice(-50);

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET learnings_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(JSON.stringify(trimmedLearnings), restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Update last optimization timestamp
   */
  updateLastOptimization(restaurantId) {
    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET last_optimization_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Check if can run new experiment (rate limit)
   */
  canRunExperiment(restaurantId, maxPerWeek = 3) {
    const state = this.getOrCreate(restaurantId);
    const currentWeekStart = this.getWeekStart();

    // Reset count if new week
    if (state.weekStart !== currentWeekStart) {
      return true;
    }

    return state.experimentsThisWeek < maxPerWeek;
  },

  /**
   * Get the start of the current week (Sunday)
   */
  getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek);
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.toISOString().split('T')[0];
  },

  /**
   * Update compound changes (accumulated winning changes)
   */
  updateCompoundChanges(restaurantId, changes) {
    this.getOrCreate(restaurantId);

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET compound_changes_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(JSON.stringify(changes), restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Update baseline metrics for anomaly detection
   */
  updateBaselineMetrics(restaurantId, metrics) {
    this.getOrCreate(restaurantId);

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET baseline_metrics_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(JSON.stringify(metrics), restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Add revenue lift from a successful experiment
   */
  addRevenueLift(restaurantId, lift) {
    this.getOrCreate(restaurantId);

    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET total_revenue_lift = total_revenue_lift + ?,
          total_experiments = total_experiments + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(lift, restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Update last digest timestamp
   */
  updateLastDigest(restaurantId) {
    const stmt = db.prepare(`
      UPDATE optimizer_state
      SET last_digest_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE restaurant_id = ?
    `);
    stmt.run(restaurantId);

    return this.getByRestaurant(restaurantId);
  },

  /**
   * Get performance summary for a restaurant
   */
  getPerformanceSummary(restaurantId) {
    const state = this.getByRestaurant(restaurantId);
    if (!state) return null;

    return {
      enabled: state.enabled,
      totalExperiments: state.totalExperiments,
      totalRevenueLift: state.totalRevenueLift,
      experimentsThisWeek: state.experimentsThisWeek,
      compoundChangesCount: state.compoundChanges.length,
      learningsCount: state.learnings.length,
      lastOptimizationAt: state.lastOptimizationAt
    };
  },

  /**
   * Format database row to API response
   */
  formatState(row) {
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      enabled: row.enabled === 1,
      experimentsThisWeek: row.experiments_this_week,
      weekStart: row.week_start,
      learnings: row.learnings_json ? JSON.parse(row.learnings_json) : [],
      compoundChanges: row.compound_changes_json ? JSON.parse(row.compound_changes_json) : [],
      baselineMetrics: row.baseline_metrics_json ? JSON.parse(row.baseline_metrics_json) : null,
      totalExperiments: row.total_experiments || 0,
      totalRevenueLift: row.total_revenue_lift || 0,
      lastOptimizationAt: row.last_optimization_at,
      lastDigestAt: row.last_digest_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
};
