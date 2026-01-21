import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const MaterialModel = {
  create(restaurantId, data) {
    const id = uuidv4();

    // Get next version for this type
    const currentVersion = db.prepare(
      'SELECT COALESCE(MAX(version), 0) + 1 as next FROM generated_materials WHERE restaurant_id = ? AND type = ?'
    ).get(restaurantId, data.type).next;

    const stmt = db.prepare(`
      INSERT INTO generated_materials (id, restaurant_id, type, file_path, cloudflare_url, version)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      restaurantId,
      data.type,
      data.filePath || null,
      data.cloudflareUrl || null,
      currentVersion
    );

    return this.getById(id);
  },

  getById(id) {
    return db.prepare('SELECT * FROM generated_materials WHERE id = ?').get(id);
  },

  getByRestaurant(restaurantId) {
    return db.prepare(
      'SELECT * FROM generated_materials WHERE restaurant_id = ? ORDER BY created_at DESC'
    ).all(restaurantId);
  },

  getLatestByType(restaurantId, type) {
    return db.prepare(`
      SELECT * FROM generated_materials
      WHERE restaurant_id = ? AND type = ?
      ORDER BY version DESC LIMIT 1
    `).get(restaurantId, type);
  },

  updateCloudflareUrl(id, url) {
    db.prepare('UPDATE generated_materials SET cloudflare_url = ? WHERE id = ?').run(url, id);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM generated_materials WHERE id = ?').run(id);
  }
};
