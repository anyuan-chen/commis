import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const PhotoModel = {
  create(restaurantId, data) {
    const id = uuidv4();
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(display_order), -1) + 1 as next FROM photos WHERE restaurant_id = ?'
    ).get(restaurantId).next;

    // If setting as primary, unset existing primary
    if (data.isPrimary) {
      db.prepare('UPDATE photos SET is_primary = 0 WHERE restaurant_id = ?').run(restaurantId);
    }

    const stmt = db.prepare(`
      INSERT INTO photos (id, restaurant_id, path, caption, type, is_primary, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      restaurantId,
      data.path,
      data.caption || null,
      data.type || 'food',
      data.isPrimary ? 1 : 0,
      data.displayOrder ?? maxOrder
    );

    return this.getById(id);
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, isPrimary: !!row.is_primary };
  },

  getByRestaurant(restaurantId) {
    return db.prepare(
      'SELECT * FROM photos WHERE restaurant_id = ? ORDER BY display_order'
    ).all(restaurantId).map(row => ({ ...row, isPrimary: !!row.is_primary }));
  },

  getByType(restaurantId, type) {
    return db.prepare(
      'SELECT * FROM photos WHERE restaurant_id = ? AND type = ? ORDER BY display_order'
    ).all(restaurantId, type).map(row => ({ ...row, isPrimary: !!row.is_primary }));
  },

  getPrimary(restaurantId) {
    const row = db.prepare(
      'SELECT * FROM photos WHERE restaurant_id = ? AND is_primary = 1'
    ).get(restaurantId);
    if (!row) return null;
    return { ...row, isPrimary: true };
  },

  update(id, data) {
    const photo = this.getById(id);
    if (!photo) return null;

    // If setting as primary, unset existing primary first
    if (data.isPrimary) {
      db.prepare('UPDATE photos SET is_primary = 0 WHERE restaurant_id = ?').run(photo.restaurant_id);
    }

    const fields = [];
    const values = [];

    const fieldMap = {
      path: 'path',
      caption: 'caption',
      type: 'type',
      isPrimary: 'is_primary',
      displayOrder: 'display_order'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(key === 'isPrimary' ? (data[key] ? 1 : 0) : data[key]);
      }
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    db.prepare(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  },

  setPrimary(id) {
    const photo = this.getById(id);
    if (!photo) return null;

    db.prepare('UPDATE photos SET is_primary = 0 WHERE restaurant_id = ?').run(photo.restaurant_id);
    db.prepare('UPDATE photos SET is_primary = 1 WHERE id = ?').run(id);

    return this.getById(id);
  }
};
