import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const MenuCategoryModel = {
  create(restaurantId, data) {
    const id = uuidv4();
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(display_order), -1) + 1 as next FROM menu_categories WHERE restaurant_id = ?'
    ).get(restaurantId).next;

    const stmt = db.prepare(`
      INSERT INTO menu_categories (id, restaurant_id, name, display_order)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(id, restaurantId, data.name, data.displayOrder ?? maxOrder);
    return this.getById(id);
  },

  getById(id) {
    return db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(id);
  },

  getByRestaurant(restaurantId) {
    return db.prepare(
      'SELECT * FROM menu_categories WHERE restaurant_id = ? ORDER BY display_order'
    ).all(restaurantId);
  },

  update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.displayOrder !== undefined) {
      fields.push('display_order = ?');
      values.push(data.displayOrder);
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    db.prepare(`UPDATE menu_categories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM menu_categories WHERE id = ?').run(id);
  }
};

export const MenuItemModel = {
  create(categoryId, data) {
    const id = uuidv4();
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(display_order), -1) + 1 as next FROM menu_items WHERE category_id = ?'
    ).get(categoryId).next;

    const stmt = db.prepare(`
      INSERT INTO menu_items (id, category_id, name, description, price, image_path, is_featured, dietary_tags_json, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      categoryId,
      data.name,
      data.description || null,
      data.price || null,
      data.imagePath || null,
      data.isFeatured ? 1 : 0,
      data.dietaryTags ? JSON.stringify(data.dietaryTags) : null,
      data.displayOrder ?? maxOrder
    );

    return this.getById(id);
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      isFeatured: !!row.is_featured,
      dietaryTags: row.dietary_tags_json ? JSON.parse(row.dietary_tags_json) : []
    };
  },

  getByCategory(categoryId) {
    return db.prepare(
      'SELECT * FROM menu_items WHERE category_id = ? ORDER BY display_order'
    ).all(categoryId).map(row => ({
      ...row,
      isFeatured: !!row.is_featured,
      dietaryTags: row.dietary_tags_json ? JSON.parse(row.dietary_tags_json) : []
    }));
  },

  findByName(restaurantId, name) {
    const row = db.prepare(`
      SELECT mi.* FROM menu_items mi
      JOIN menu_categories mc ON mi.category_id = mc.id
      WHERE mc.restaurant_id = ? AND LOWER(mi.name) LIKE LOWER(?)
    `).get(restaurantId, `%${name}%`);

    if (!row) return null;
    return {
      ...row,
      isFeatured: !!row.is_featured,
      dietaryTags: row.dietary_tags_json ? JSON.parse(row.dietary_tags_json) : []
    };
  },

  update(id, data) {
    const fields = [];
    const values = [];

    const fieldMap = {
      name: 'name',
      description: 'description',
      price: 'price',
      imagePath: 'image_path',
      isFeatured: 'is_featured',
      dietaryTags: 'dietary_tags_json',
      displayOrder: 'display_order',
      categoryId: 'category_id'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        if (key === 'isFeatured') {
          values.push(data[key] ? 1 : 0);
        } else if (key === 'dietaryTags') {
          values.push(JSON.stringify(data[key]));
        } else {
          values.push(data[key]);
        }
      }
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    db.prepare(`UPDATE menu_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  }
};
