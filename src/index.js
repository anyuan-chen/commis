import express from 'express';
import { createServer } from 'http';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { config } from './config.js';

// Import routes
import uploadRoutes from './routes/upload.js';
import previewRoutes from './routes/preview.js';
import deployRoutes from './routes/deploy.js';
import downloadRoutes from './routes/download.js';
import graphicsRoutes from './routes/graphics.js';
import shortsRoutes from './routes/shorts.js';
import youtubeAuthRoutes from './routes/youtube-auth.js';
import googleAdsAuthRoutes from './routes/google-ads-auth.js';
import ordersRoutes from './routes/orders.js';
import debugRoutes from './routes/debug.js';
import chatRoutes from './routes/chat.js';
import reviewsRoutes from './routes/reviews.js';
import analyticsRoutes from './routes/analytics.js';
import evaluateRoutes from './routes/evaluate.js';
import { setupVoiceWebSocket } from './routes/voice.js';
import { setupMcp } from './mcp/index.js';
import { startDigestScheduler } from './jobs/digest-scheduler.js';
import { startOptimizerScheduler } from './jobs/optimizer-scheduler.js';
import { variantServerMiddleware } from './middleware/variant-server.js';

// Create Express app
const app = express();
const server = createServer(app);

// Ensure directories exist
const directories = [
  config.paths.uploads,
  config.paths.websites,
  config.paths.brochures,
  config.paths.images,
  config.paths.shorts,
  config.paths.db
];

for (const dir of directories) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Raw body parsing for Stripe webhooks (must be before express.json())
app.use('/api/orders/webhook', express.raw({ type: 'application/json' }));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Static files
app.use(express.static(config.paths.public));

// Serve generated website previews with A/B variant support
app.use(variantServerMiddleware);
app.use('/preview-static', express.static(config.paths.websites));

// Serve uploaded images
app.use('/images', express.static(config.paths.images));

// API Routes
app.use('/api/upload', uploadRoutes);
app.use('/api', previewRoutes);
app.use('/api/deploy', deployRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/graphics', graphicsRoutes);
app.use('/api/shorts', shortsRoutes);
app.use('/api/youtube', youtubeAuthRoutes);
app.use('/api/google-ads', googleAdsAuthRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/evaluate', evaluateRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MCP (Model Context Protocol) server for AI agent integration
setupMcp(app);

// Setup WebSocket for voice
setupVoiceWebSocket(server);

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start digest scheduler for review aggregation
startDigestScheduler();

// Start A/B optimizer scheduler
startOptimizerScheduler();

// Start server
const PORT = config.port;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                       Pique Server                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                  ║
║  API endpoints:                                            ║
║    POST /api/upload/video    - Upload restaurant video     ║
║    GET  /api/upload/status/:id - Check processing status   ║
║    GET  /api/restaurant/:id  - Get restaurant data         ║
║    POST /api/deploy/generate/website/:id - Generate site   ║
║    POST /api/deploy/generate/brochure/:id - Gen brochure   ║
║    POST /api/deploy/cloudflare/:id - Deploy to CF Pages    ║
║    WS   /api/voice?restaurantId=X - Voice interface        ║
║                                                            ║
║  Shorts endpoints:                                         ║
║    POST /api/shorts/check-cooking - Check cooking frame    ║
║    POST /api/shorts/process       - Process video to Short ║
║    GET  /api/shorts/status/:id    - Get job status         ║
║    GET  /api/shorts/preview/:id   - Preview video          ║
║    POST /api/shorts/upload-youtube/:id - Upload to YouTube ║
║    GET  /api/youtube/auth         - YouTube OAuth          ║
║                                                            ║
║  Google Ads endpoints:                                     ║
║    GET  /api/google-ads/auth      - Start OAuth flow       ║
║    GET  /api/google-ads/status    - Check connection       ║
║    POST /api/google-ads/customer-id - Set customer ID      ║
║                                                            ║
║  Orders endpoints:                                         ║
║    POST /api/orders/:id/create-checkout - Create checkout  ║
║    POST /api/orders/webhook       - Stripe webhook         ║
║    GET  /api/orders/:restaurantId/:orderId - Get order     ║
║                                                            ║
║  Reviews endpoints:                                        ║
║    GET  /api/reviews/:id          - List reviews           ║
║    POST /api/reviews/:id/fetch    - Fetch from Google      ║
║    POST /api/reviews/:id/link-google - Link Place ID       ║
║    GET  /api/reviews/:id/digests  - List digests           ║
║    POST /api/reviews/:id/digests/generate - Generate digest║
║                                                            ║
║  A/B Testing & Analytics:                                  ║
║    POST /api/analytics/event      - Track events           ║
║    GET  /api/analytics/metrics/:id - Website metrics       ║
║    GET  /api/analytics/optimizer/:id - Optimizer status    ║
║    POST /api/analytics/optimizer/:id/toggle - Enable/disable║
║    POST /api/analytics/optimizer/:id/run - Trigger optimize║
║                                                            ║
║  UI Evaluation:                                            ║
║    GET  /api/evaluate/:id         - Evaluate website UI    ║
║    POST /api/evaluate/:id/regenerate - Regenerate w/ evals ║
║    GET  /api/evaluate/:id/debug   - View iteration debug   ║
║                                                            ║
║  Debug:                                                    ║
║    GET  /debug.html               - Pipeline debug viewer  ║
║                                                            ║
║  MCP (Model Context Protocol):                             ║
║    GET  /mcp                      - SSE connection         ║
║    POST /mcp/messages             - MCP messages           ║
║    GET  /mcp/tools                - List available tools   ║
║    POST /mcp/call                 - Direct tool call       ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export default app;
