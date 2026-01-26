import { Router } from 'express';
import { googleAdsService } from '../services/google-ads.js';
import { config } from '../config.js';
import db from '../db/database.js';

const router = Router();

// Ensure google_ads_tokens table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS google_ads_tokens (
    id INTEGER PRIMARY KEY,
    customer_id TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expiry_date INTEGER,
    scope TEXT,
    token_type TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

/**
 * Get stored Google Ads tokens
 */
export function getStoredGoogleAdsTokens() {
  return db.prepare('SELECT * FROM google_ads_tokens ORDER BY id DESC LIMIT 1').get();
}

/**
 * Store Google Ads tokens
 */
export function storeGoogleAdsTokens(tokens, customerId = null) {
  const existing = getStoredGoogleAdsTokens();
  if (existing) {
    db.prepare(`
      UPDATE google_ads_tokens SET
        customer_id = COALESCE(?, customer_id),
        access_token = ?,
        refresh_token = COALESCE(?, refresh_token),
        expiry_date = ?,
        scope = ?,
        token_type = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      customerId,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date,
      tokens.scope,
      tokens.token_type,
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO google_ads_tokens (customer_id, access_token, refresh_token, expiry_date, scope, token_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      customerId,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date,
      tokens.scope,
      tokens.token_type
    );
  }
}

/**
 * Update customer ID
 */
export function updateCustomerId(customerId) {
  const existing = getStoredGoogleAdsTokens();
  if (existing) {
    db.prepare(`
      UPDATE google_ads_tokens SET
        customer_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(customerId, existing.id);
  }
}

/**
 * GET /api/google-ads/auth
 * Start OAuth flow - returns authorization URL
 */
router.get('/auth', (req, res) => {
  try {
    if (!googleAdsService.isConfigured()) {
      return res.status(500).json({
        error: 'Google Ads API not configured. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_DEVELOPER_TOKEN in .env'
      });
    }

    const authUrl = googleAdsService.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Google Ads auth error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/google-ads/callback
 * OAuth callback - exchanges code for tokens and stores them
 */
router.get('/callback', async (req, res) => {
  console.log('Google Ads callback received:', req.query);

  try {
    const { code, error } = req.query;

    if (error) {
      console.error('Google Ads OAuth error:', error);
      return res.redirect(`/#google_ads_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      console.error('No code in callback');
      return res.redirect('/#google_ads_error=no_code');
    }

    console.log('Exchanging code for tokens...');
    const tokens = await googleAdsService.getTokensFromCode(code);
    console.log('Got tokens:', {
      ...tokens,
      access_token: '***',
      refresh_token: tokens.refresh_token ? '***' : null
    });

    // Store tokens server-side
    storeGoogleAdsTokens(tokens);
    console.log('Tokens stored in database');

    // Redirect to success page
    res.redirect('/#google_ads_connected=true');
  } catch (error) {
    console.error('Google Ads callback error:', error);
    res.redirect(`/#google_ads_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * GET /api/google-ads/status
 * Check if Google Ads is connected
 */
router.get('/status', (req, res) => {
  const tokens = getStoredGoogleAdsTokens();
  res.json({
    connected: !!tokens,
    hasRefreshToken: !!(tokens?.refresh_token),
    hasCustomerId: !!(tokens?.customer_id),
    customerId: tokens?.customer_id || null
  });
});

/**
 * POST /api/google-ads/customer-id
 * Set the Google Ads customer ID
 */
router.post('/customer-id', (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required' });
    }

    // Remove dashes if present
    const cleanCustomerId = customerId.replace(/-/g, '');

    updateCustomerId(cleanCustomerId);
    res.json({ success: true, customerId: cleanCustomerId });
  } catch (error) {
    console.error('Error setting customer ID:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/google-ads/disconnect
 * Disconnect Google Ads account
 */
router.post('/disconnect', (req, res) => {
  try {
    db.prepare('DELETE FROM google_ads_tokens').run();
    res.json({ success: true, message: 'Disconnected' });
  } catch (error) {
    console.error('Error disconnecting:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/google-ads/keyword-ideas
 * Get keyword ideas from Keyword Planner (for testing)
 */
router.post('/keyword-ideas', async (req, res) => {
  try {
    const tokens = getStoredGoogleAdsTokens();
    if (!tokens || !tokens.refresh_token) {
      return res.status(401).json({ error: 'Google Ads not connected. Please authenticate first.' });
    }

    if (!tokens.customer_id) {
      return res.status(400).json({ error: 'Customer ID not set. Please set your Google Ads customer ID.' });
    }

    const { keywords } = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Keywords array is required' });
    }

    const ideas = await googleAdsService.getKeywordIdeas(
      tokens.customer_id,
      tokens.refresh_token,
      keywords
    );

    res.json({ ideas });
  } catch (error) {
    console.error('Keyword ideas error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
