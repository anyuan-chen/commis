import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const WebsiteJobModel = {
  create(restaurantId, options = {}) {
    const id = uuidv4();
    const { useIterative = false } = options;

    const stmt = db.prepare(`
      INSERT INTO website_jobs (id, restaurant_id, status, progress, use_iterative)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, restaurantId, 'pending', 0, useIterative ? 1 : 0);

    return this.getById(id);
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM website_jobs WHERE id = ?').get(id);
    if (!row) return null;
    return this._parseRow(row);
  },

  getByRestaurant(restaurantId) {
    const rows = db.prepare(
      'SELECT * FROM website_jobs WHERE restaurant_id = ? ORDER BY created_at DESC'
    ).all(restaurantId);
    return rows.map(row => this._parseRow(row));
  },

  getPending(restaurantId) {
    const row = db.prepare(`
      SELECT * FROM website_jobs
      WHERE restaurant_id = ? AND status IN ('pending', 'processing')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(restaurantId);
    if (!row) return null;
    return this._parseRow(row);
  },

  _parseRow(row) {
    let iterations = null;
    if (row.iterations_json) {
      try {
        iterations = JSON.parse(row.iterations_json);
      } catch (e) {
        console.error('Failed to parse iterations_json:', e.message);
      }
    }

    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      status: row.status,
      progress: row.progress,
      progressStage: row.progress_stage,
      errorMessage: row.error_message,
      materialId: row.material_id,
      outputPath: row.output_path,
      deployedUrl: row.deployed_url,
      useIterative: row.use_iterative === 1,
      iterations,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  updateStatus(id, status) {
    db.prepare(`
      UPDATE website_jobs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
    return this.getById(id);
  },

  updateProgress(id, progress, progressStage = null) {
    const fields = ['progress = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [progress];

    if (progressStage) {
      fields.push('progress_stage = ?');
      values.push(progressStage);
    }

    values.push(id);
    db.prepare(`UPDATE website_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  setError(id, errorMessage) {
    db.prepare(`
      UPDATE website_jobs
      SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(errorMessage, id);
    return this.getById(id);
  },

  complete(id, materialId, outputPath, deployedUrl, iterations = null) {
    const fields = [
      'status = ?',
      'progress = 100',
      'progress_stage = ?',
      'material_id = ?',
      'output_path = ?',
      'deployed_url = ?',
      'updated_at = CURRENT_TIMESTAMP'
    ];
    const values = ['ready', 'ready', materialId, outputPath, deployedUrl];

    if (iterations) {
      fields.push('iterations_json = ?');
      values.push(JSON.stringify(iterations));
    }

    values.push(id);
    db.prepare(`UPDATE website_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  setDeployedUrl(id, deployedUrl) {
    db.prepare(`
      UPDATE website_jobs
      SET deployed_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(deployedUrl, id);
    return this.getById(id);
  },

  getRecent(limit = 10) {
    return db.prepare(
      'SELECT * FROM website_jobs ORDER BY created_at DESC LIMIT ?'
    ).all(limit).map(row => this._parseRow(row));
  },

  getByStatus(status) {
    return db.prepare(
      'SELECT * FROM website_jobs WHERE status = ? ORDER BY created_at DESC'
    ).all(status).map(row => this._parseRow(row));
  }
};
