/**
 * Debug UI routes - view pipeline lifecycle
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ExtractionLogger } from '../services/extraction-logger.js';

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

// ============================================
// Extraction Pipeline Debug Routes
// ============================================

// List all extraction runs
router.get('/extraction/runs', async (req, res) => {
  try {
    const runs = await ExtractionLogger.listRuns();
    res.json({ runs });
  } catch (error) {
    console.error('List runs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific run by ID
router.get('/extraction/runs/:runId', async (req, res) => {
  try {
    const run = await ExtractionLogger.load(req.params.runId);
    res.json({ run });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Run not found' });
    }
    console.error('Get run error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific step from a run
router.get('/extraction/runs/:runId/steps/:stepIndex', async (req, res) => {
  try {
    const run = await ExtractionLogger.load(req.params.runId);
    const stepIndex = parseInt(req.params.stepIndex);
    const step = run.steps[stepIndex];

    if (!step) {
      return res.status(404).json({ error: 'Step not found' });
    }

    res.json({ step });
  } catch (error) {
    console.error('Get step error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
