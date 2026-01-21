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
import { setupVoiceWebSocket } from './routes/voice.js';

// Create Express app
const app = express();
const server = createServer(app);

// Ensure directories exist
const directories = [
  config.paths.uploads,
  config.paths.websites,
  config.paths.brochures,
  config.paths.images,
  config.paths.db
];

for (const dir of directories) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

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

// Serve generated website previews
app.use('/preview-static', express.static(config.paths.websites));

// Serve uploaded images
app.use('/images', express.static(config.paths.images));

// API Routes
app.use('/api/upload', uploadRoutes);
app.use('/api', previewRoutes);
app.use('/api/deploy', deployRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/graphics', graphicsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Setup WebSocket for voice
setupVoiceWebSocket(server);

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
const PORT = config.port;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                     VideoResto Server                      ║
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
╚═══════════════════════════════════════════════════════════╝
  `);
});

export default app;
