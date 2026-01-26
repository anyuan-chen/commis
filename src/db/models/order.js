import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const OrderModel = {
  create(restaurantId, { items, customerEmail, stripeSessionId }) {
    const id = uuidv4();
    const itemsJson = JSON.stringify(items);
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const total = subtotal; // Can add tax/fees here later

    const stmt = db.prepare(`
      INSERT INTO orders (id, restaurant_id, stripe_session_id, customer_email, items_json, subtotal, total, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    stmt.run(id, restaurantId, stripeSessionId, customerEmail || null, itemsJson, Math.round(subtotal * 100), Math.round(total * 100));

    return this.getById(id);
  },

  getById(orderId) {
    const stmt = db.prepare('SELECT * FROM orders WHERE id = ?');
    const row = stmt.get(orderId);
    if (!row) return null;

    return {
      ...row,
      items: row.items_json ? JSON.parse(row.items_json) : []
    };
  },

  getByStripeSession(sessionId) {
    const stmt = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?');
    const row = stmt.get(sessionId);
    if (!row) return null;

    return {
      ...row,
      items: row.items_json ? JSON.parse(row.items_json) : []
    };
  },

  updateStatus(orderId, status, paymentIntent = null) {
    const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [status];

    if (paymentIntent) {
      fields.push('stripe_payment_intent = ?');
      values.push(paymentIntent);
    }

    values.push(orderId);

    const stmt = db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(orderId);
  },

  updateCustomerInfo(orderId, { email, name }) {
    const fields = ['updated_at = CURRENT_TIMESTAMP'];
    const values = [];

    if (email) {
      fields.push('customer_email = ?');
      values.push(email);
    }
    if (name) {
      fields.push('customer_name = ?');
      values.push(name);
    }

    values.push(orderId);

    const stmt = db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(orderId);
  },

  getByRestaurant(restaurantId, limit = 50) {
    const stmt = db.prepare(`
      SELECT * FROM orders
      WHERE restaurant_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(restaurantId, limit).map(row => ({
      ...row,
      items: row.items_json ? JSON.parse(row.items_json) : []
    }));
  }
};
