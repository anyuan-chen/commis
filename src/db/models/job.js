import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const JobModel = {
  create(data) {
    const id = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO processing_jobs (id, restaurant_id, video_path, status, progress, missing_fields_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.restaurantId || null,
      data.videoPath,
      'pending',
      0,
      null
    );

    return this.getById(id);
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM processing_jobs WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      missingFields: row.missing_fields_json ? JSON.parse(row.missing_fields_json) : []
    };
  },

  updateStatus(id, status, progress = null) {
    const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [status];

    if (progress !== null) {
      fields.push('progress = ?');
      values.push(progress);
    }

    values.push(id);
    db.prepare(`UPDATE processing_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  updateProgress(id, progress) {
    db.prepare('UPDATE processing_jobs SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(progress, id);
    return this.getById(id);
  },

  setRestaurantId(id, restaurantId) {
    db.prepare('UPDATE processing_jobs SET restaurant_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(restaurantId, id);
    return this.getById(id);
  },

  setMissingFields(id, missingFields) {
    db.prepare('UPDATE processing_jobs SET missing_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(missingFields), id);
    return this.getById(id);
  },

  setError(id, errorMessage) {
    db.prepare('UPDATE processing_jobs SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('failed', errorMessage, id);
    return this.getById(id);
  },

  complete(id) {
    db.prepare('UPDATE processing_jobs SET status = ?, progress = 100, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('completed', id);
    return this.getById(id);
  },

  getRecent(limit = 10) {
    return db.prepare(
      'SELECT * FROM processing_jobs ORDER BY created_at DESC LIMIT ?'
    ).all(limit).map(row => ({
      ...row,
      missingFields: row.missing_fields_json ? JSON.parse(row.missing_fields_json) : []
    }));
  }
};
