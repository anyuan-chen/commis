import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const ExperimentQueueModel = {
  /**
   * Add a hypothesis to the queue
   */
  add(restaurantId, data) {
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO experiment_queue (
        id, restaurant_id, hypothesis, change_type, variant_prompt,
        variant_description, priority, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      restaurantId,
      data.hypothesis,
      data.changeType || null,
      data.variantPrompt || null,
      data.variantDescription || null,
      data.priority || 0,
      data.source || 'ai'
    );

    return this.getById(id);
  },

  /**
   * Add multiple hypotheses at once
   */
  addBatch(restaurantId, hypotheses) {
    const stmt = db.prepare(`
      INSERT INTO experiment_queue (
        id, restaurant_id, hypothesis, change_type, variant_prompt,
        variant_description, priority, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const added = [];
    for (const data of hypotheses) {
      const id = uuidv4();
      stmt.run(
        id,
        restaurantId,
        data.hypothesis,
        data.changeType || null,
        data.variantPrompt || null,
        data.variantDescription || null,
        data.priority || 0,
        data.source || 'ai'
      );
      added.push(id);
    }

    return added.length;
  },

  /**
   * Get by ID
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM experiment_queue WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;
    return this.formatQueueItem(row);
  },

  /**
   * Get next hypothesis from queue (highest priority, oldest first)
   */
  getNext(restaurantId) {
    const stmt = db.prepare(`
      SELECT * FROM experiment_queue
      WHERE restaurant_id = ?
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `);
    const row = stmt.get(restaurantId);
    if (!row) return null;
    return this.formatQueueItem(row);
  },

  /**
   * Get all queued hypotheses for a restaurant
   */
  getByRestaurant(restaurantId, limit = 10) {
    const stmt = db.prepare(`
      SELECT * FROM experiment_queue
      WHERE restaurant_id = ?
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `);
    return stmt.all(restaurantId, limit).map(row => this.formatQueueItem(row));
  },

  /**
   * Get queue count for a restaurant
   */
  getCount(restaurantId) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM experiment_queue
      WHERE restaurant_id = ?
    `);
    const row = stmt.get(restaurantId);
    return row?.count || 0;
  },

  /**
   * Remove item from queue (after starting experiment)
   */
  remove(id) {
    const stmt = db.prepare('DELETE FROM experiment_queue WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Clear old queue items (keep queue fresh)
   */
  clearOld(restaurantId, daysOld = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const stmt = db.prepare(`
      DELETE FROM experiment_queue
      WHERE restaurant_id = ? AND created_at < ?
    `);
    return stmt.run(restaurantId, cutoff.toISOString());
  },

  /**
   * Update priority
   */
  updatePriority(id, priority) {
    const stmt = db.prepare(`
      UPDATE experiment_queue SET priority = ? WHERE id = ?
    `);
    stmt.run(priority, id);
    return this.getById(id);
  },

  /**
   * Format database row
   */
  formatQueueItem(row) {
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      hypothesis: row.hypothesis,
      changeType: row.change_type,
      variantPrompt: row.variant_prompt,
      variantDescription: row.variant_description,
      priority: row.priority,
      source: row.source,
      createdAt: row.created_at
    };
  }
};
