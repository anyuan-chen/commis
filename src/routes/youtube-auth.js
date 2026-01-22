import { Router } from 'express';
import { YouTubeUploader } from '../services/youtube-uploader.js';
import { config } from '../config.js';

const router = Router();
const youtubeUploader = new YouTubeUploader();

/**
 * GET /api/youtube/auth
 * Start OAuth flow - returns authorization URL
 */
router.get('/auth', (req, res) => {
  try {
    // Check if YouTube credentials are configured
    if (!config.youtube.clientId || !config.youtube.clientSecret) {
      return res.status(500).json({
        error: 'YouTube API not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env'
      });
    }

    const authUrl = youtubeUploader.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('YouTube auth error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/youtube/callback
 * OAuth callback - exchanges code for tokens
 * Redirects back to frontend with tokens in URL fragment
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.redirect(`/shorts.html#auth_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect('/shorts.html#auth_error=no_code');
    }

    const tokens = await youtubeUploader.getTokensFromCode(code);

    // Redirect to frontend with tokens in URL fragment (not query params for security)
    // Frontend will extract and store in localStorage
    const tokenData = encodeURIComponent(JSON.stringify(tokens));
    res.redirect(`/shorts.html#youtube_tokens=${tokenData}`);
  } catch (error) {
    console.error('YouTube callback error:', error);
    res.redirect(`/shorts.html#auth_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * POST /api/youtube/refresh
 * Refresh access token
 */
router.post('/refresh', async (req, res) => {
  try {
    const { tokens } = req.body;

    if (!tokens || !tokens.refresh_token) {
      return res.status(400).json({ error: 'No refresh token provided' });
    }

    const freshTokens = await youtubeUploader.refreshTokenIfNeeded(tokens);
    res.json({ tokens: freshTokens });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/youtube/channel
 * Get connected YouTube channel info
 */
router.get('/channel', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No tokens provided' });
    }

    const tokens = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());
    const channelInfo = await youtubeUploader.getChannelInfo(tokens);
    res.json(channelInfo);
  } catch (error) {
    console.error('Channel info error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/youtube/disconnect
 * Disconnect YouTube account (client-side token removal)
 * This endpoint just confirms the action; actual token removal is client-side
 */
router.post('/disconnect', (req, res) => {
  // Client handles token removal from localStorage
  res.json({ success: true, message: 'Disconnected' });
});

export default router;
