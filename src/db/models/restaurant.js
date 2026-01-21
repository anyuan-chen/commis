import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const RestaurantModel = {
  create(data = {}) {
    const id = data.id || uuidv4();
    const stmt = db.prepare(`
      INSERT INTO restaurants (id, name, tagline, description, cuisine_type, address, phone, email, website_url, hours_json, primary_image_path, logo_path, style_theme, primary_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name || null,
      data.tagline || null,
      data.description || null,
      data.cuisineType || null,
      data.address || null,
      data.phone || null,
      data.email || null,
      data.websiteUrl || null,
      data.hours ? JSON.stringify(data.hours) : null,
      data.primaryImagePath || null,
      data.logoPath || null,
      data.styleTheme || 'modern',
      data.primaryColor || '#2563eb'
    );

    return this.getById(id);
  },

  getById(id) {
    const stmt = db.prepare('SELECT * FROM restaurants WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return {
      ...row,
      hours: row.hours_json ? JSON.parse(row.hours_json) : null
    };
  },

  update(id, data) {
    const fields = [];
    const values = [];

    const fieldMap = {
      name: 'name',
      tagline: 'tagline',
      description: 'description',
      cuisineType: 'cuisine_type',
      address: 'address',
      phone: 'phone',
      email: 'email',
      websiteUrl: 'website_url',
      hours: 'hours_json',
      primaryImagePath: 'primary_image_path',
      logoPath: 'logo_path',
      styleTheme: 'style_theme',
      primaryColor: 'primary_color'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(key === 'hours' ? JSON.stringify(data[key]) : data[key]);
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`UPDATE restaurants SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(id);
  },

  delete(id) {
    const stmt = db.prepare('DELETE FROM restaurants WHERE id = ?');
    return stmt.run(id);
  },

  getAll() {
    const stmt = db.prepare('SELECT * FROM restaurants ORDER BY created_at DESC');
    return stmt.all().map(row => ({
      ...row,
      hours: row.hours_json ? JSON.parse(row.hours_json) : null
    }));
  },

  getFullData(id) {
    const restaurant = this.getById(id);
    if (!restaurant) return null;

    const categories = db.prepare(`
      SELECT * FROM menu_categories
      WHERE restaurant_id = ?
      ORDER BY display_order
    `).all(id);

    const items = db.prepare(`
      SELECT mi.* FROM menu_items mi
      JOIN menu_categories mc ON mi.category_id = mc.id
      WHERE mc.restaurant_id = ?
      ORDER BY mi.display_order
    `).all(id);

    const photos = db.prepare(`
      SELECT * FROM photos
      WHERE restaurant_id = ?
      ORDER BY display_order
    `).all(id);

    const materials = db.prepare(`
      SELECT * FROM generated_materials
      WHERE restaurant_id = ?
      ORDER BY created_at DESC
    `).all(id);

    // Organize items by category
    const menuByCategory = categories.map(cat => ({
      ...cat,
      items: items
        .filter(item => item.category_id === cat.id)
        .map(item => ({
          ...item,
          dietaryTags: item.dietary_tags_json ? JSON.parse(item.dietary_tags_json) : []
        }))
    }));

    return {
      ...restaurant,
      menu: menuByCategory,
      photos,
      materials
    };
  }
};
