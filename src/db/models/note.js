import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const NoteModel = {
  create(restaurantId, data) {
    const id = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO notes (id, restaurant_id, content, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(id, restaurantId, data.content, data.expiresAt || null);
    return this.getById(id);
  },

  getById(id) {
    return db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  },

  /**
   * Get all active (non-expired) notes for a restaurant
   */
  getActive(restaurantId) {
    const now = new Date().toISOString();
    return db.prepare(`
      SELECT * FROM notes
      WHERE restaurant_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
    `).all(restaurantId, now);
  },

  /**
   * Get all notes including expired
   */
  getAll(restaurantId) {
    return db.prepare(
      'SELECT * FROM notes WHERE restaurant_id = ? ORDER BY created_at DESC'
    ).all(restaurantId);
  },

  update(id, data) {
    const fields = [];
    const values = [];

    if (data.content !== undefined) {
      fields.push('content = ?');
      values.push(data.content);
    }
    if (data.expiresAt !== undefined) {
      fields.push('expires_at = ?');
      values.push(data.expiresAt);
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    db.prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  },

  /**
   * Delete by content match (fuzzy)
   */
  deleteByContent(restaurantId, searchText) {
    const note = db.prepare(`
      SELECT * FROM notes
      WHERE restaurant_id = ? AND LOWER(content) LIKE LOWER(?)
      LIMIT 1
    `).get(restaurantId, `%${searchText}%`);

    if (note) {
      this.delete(note.id);
      return note;
    }
    return null;
  },

  /**
   * Clean up expired notes
   */
  deleteExpired(restaurantId) {
    const now = new Date().toISOString();
    return db.prepare(`
      DELETE FROM notes
      WHERE restaurant_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(restaurantId, now);
  }
};
