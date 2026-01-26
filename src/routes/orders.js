import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { OrderModel, RestaurantModel } from '../db/models/index.js';
import db from '../db/database.js';

const router = Router();

// Initialize Stripe
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

/**
 * POST /api/orders/:restaurantId/create-checkout
 * Create a Stripe Checkout Session
 */
router.post('/:restaurantId/create-checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured' });
    }

    const { restaurantId } = req.params;
    const { items, successUrl, cancelUrl } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items are required' });
    }

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'Success and cancel URLs are required' });
    }

    // Verify restaurant exists
    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Create order in database first
    const order = OrderModel.create(restaurantId, {
      items,
      customerEmail: null,
      stripeSessionId: null
    });

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: items.map(item => ({
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.name,
            description: item.description || undefined
          },
          unit_amount: Math.round(item.price * 100)
        },
        quantity: item.quantity
      })),
      metadata: {
        restaurantId,
        orderId: order.id
      },
      success_url: successUrl + (successUrl.includes('?') ? '&' : '?') + 'order={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl
    });

    // Update order with session ID
    const stmt = db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?');
    stmt.run(session.id, order.id);

    res.json({
      sessionId: session.id,
      url: session.url,
      orderId: order.id
    });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/orders/webhook
 * Handle Stripe webhooks
 */
router.post('/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (config.stripe.webhookSecret) {
      // Verify signature in production
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        config.stripe.webhookSecret
      );
    } else {
      // Development mode - parse without verification
      console.warn('WARNING: Webhook signature verification disabled (no STRIPE_WEBHOOK_SECRET)');
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { orderId } = session.metadata;

      if (orderId) {
        // Update order status
        OrderModel.updateStatus(orderId, 'paid', session.payment_intent);

        // Update customer info if available
        if (session.customer_details) {
          OrderModel.updateCustomerInfo(orderId, {
            email: session.customer_details.email,
            name: session.customer_details.name
          });
        }

        console.log(`Order ${orderId} marked as paid`);
      }
      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object;
      const { orderId } = session.metadata;

      if (orderId) {
        OrderModel.updateStatus(orderId, 'expired');
        console.log(`Order ${orderId} marked as expired`);
      }
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

/**
 * GET /api/orders/session/:sessionId
 * Get order by Stripe session ID (used after checkout redirect)
 */
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const order = OrderModel.getByStripeSession(sessionId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      id: order.id,
      restaurantId: order.restaurant_id,
      status: order.status,
      items: order.items,
      subtotal: order.subtotal / 100,
      total: order.total / 100,
      customerEmail: order.customer_email,
      customerName: order.customer_name,
      createdAt: order.created_at
    });
  } catch (error) {
    console.error('Get order by session error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/orders/:restaurantId/:orderId
 * Get order details
 */
router.get('/:restaurantId/:orderId', async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;

    const order = OrderModel.getById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.restaurant_id !== restaurantId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      id: order.id,
      status: order.status,
      items: order.items,
      subtotal: order.subtotal / 100, // Convert cents to dollars
      total: order.total / 100,
      customerEmail: order.customer_email,
      customerName: order.customer_name,
      createdAt: order.created_at
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/orders/:restaurantId
 * Get all orders for a restaurant
 */
router.get('/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const orders = OrderModel.getByRestaurant(restaurantId, limit);

    res.json(orders.map(order => ({
      id: order.id,
      status: order.status,
      items: order.items,
      subtotal: order.subtotal / 100,
      total: order.total / 100,
      customerEmail: order.customer_email,
      customerName: order.customer_name,
      createdAt: order.created_at
    })));
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
