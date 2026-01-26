/**
 * Debug UI routes - view pipeline lifecycle
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_OUTPUT_DIR = path.join(__dirname, '../../debug-output');

// List all debug sessions
router.get('/sessions', (req, res) => {
  try {
    if (!fs.existsSync(DEBUG_OUTPUT_DIR)) {
      return res.json({ sessions: [] });
    }

    const sessions = fs.readdirSync(DEBUG_OUTPUT_DIR)
      .filter(f => f.startsWith('session-'))
      .map(sessionDir => {
        const sessionPath = path.join(DEBUG_OUTPUT_DIR, sessionDir);
        const stats = fs.statSync(sessionPath);

        // Read summary if exists
        const summaryPath = path.join(sessionPath, 'summary.json');
        let summary = null;
        if (fs.existsSync(summaryPath)) {
          summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
        }

        // List step files
        const steps = fs.readdirSync(sessionPath)
          .filter(f => f.startsWith('step-'))
          .sort();

        return {
          id: sessionDir,
          created: stats.mtime,
          steps: steps.map(s => s.replace('.json', '')),
          summary
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific session details
router.get('/sessions/:sessionId', (req, res) => {
  try {
    const sessionPath = path.join(DEBUG_OUTPUT_DIR, req.params.sessionId);

    if (!fs.existsSync(sessionPath)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const files = fs.readdirSync(sessionPath);
    const data = {};

    for (const file of files) {
      if (file.endsWith('.json')) {
        const key = file.replace('.json', '');
        data[key] = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8'));
      }
    }

    // Check for frames directory
    const framesDir = path.join(sessionPath, 'frames');
    if (fs.existsSync(framesDir)) {
      data.frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get frame image
router.get('/sessions/:sessionId/frames/:filename', (req, res) => {
  const framePath = path.join(DEBUG_OUTPUT_DIR, req.params.sessionId, 'frames', req.params.filename);

  if (!fs.existsSync(framePath)) {
    return res.status(404).send('Frame not found');
  }

  res.sendFile(framePath);
});

// Get generated website HTML
router.get('/sessions/:sessionId/website', (req, res) => {
  const websitePath = path.join(DEBUG_OUTPUT_DIR, req.params.sessionId, 'generated-website.html');

  if (!fs.existsSync(websitePath)) {
    return res.status(404).send('Website not generated');
  }

  res.sendFile(websitePath);
});

export default router;
