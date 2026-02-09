import { Router } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { RestaurantModel } from '../db/models/index.js';
import { UIEvaluator } from '../services/ui-evaluator.js';
import { IterativeWebsiteGenerator, evaluateExistingWebsite } from '../services/iterative-generator.js';

const router = Router();

/**
 * GET /api/evaluate/:restaurantId
 * Evaluate an existing website's UI quality
 */
router.get('/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const results = await evaluateExistingWebsite(restaurantId);

    res.json({
      restaurantId,
      restaurantName: restaurant.name,
      index: results.index,
      menu: results.menu,
      overallAssessment: {
        averageScore: Math.round(
          ((results.index.combinedScore || 0) + (results.menu.combinedScore || 0)) / 2
        ),
        passesQualityBar: results.index.passesQualityBar && results.menu.passesQualityBar
      }
    });
  } catch (error) {
    console.error('Evaluation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/evaluate/:restaurantId/screenshot
 * Capture screenshots of a website at multiple viewports
 */
router.post('/:restaurantId/screenshot', async (req, res) => {
  const evaluator = new UIEvaluator();

  try {
    const { restaurantId } = req.params;
    const { page = 'index' } = req.body;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const websitePath = join(config.paths.websites, restaurantId);
    const htmlPath = join(websitePath, `${page}.html`);

    const html = await fs.readFile(htmlPath, 'utf-8');

    const screenshotDir = join(websitePath, 'screenshots', page);
    const { screenshots } = await evaluator.captureScreenshots(html, screenshotDir);

    res.json({
      restaurantId,
      page,
      screenshots: screenshots.map(s => ({
        viewport: s.viewport,
        width: s.width,
        height: s.height,
        path: `/restaurants/${restaurantId}/screenshots/${page}/screenshot_${s.viewport}.png`
      }))
    });
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    await evaluator.close();
  }
});

/**
 * POST /api/evaluate/html
 * Evaluate arbitrary HTML (useful for testing)
 */
router.post('/html', async (req, res) => {
  const evaluator = new UIEvaluator();

  try {
    const { html, restaurantContext = {} } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'HTML is required' });
    }

    const evaluation = await evaluator.evaluate(html, restaurantContext);

    res.json(evaluation);
  } catch (error) {
    console.error('HTML evaluation error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    await evaluator.close();
  }
});

/**
 * POST /api/evaluate/:restaurantId/regenerate
 * Regenerate website with iterative refinement
 */
router.post('/:restaurantId/regenerate', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      maxIterations = 3,
      qualityThreshold = 70,
      deploy = false
    } = req.body;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const generator = new IterativeWebsiteGenerator({
      maxIterations,
      qualityThreshold,
      debugMode: true
    });

    const result = await generator.generate(restaurantId);

    const response = {
      restaurantId,
      restaurantName: restaurant.name,
      localPath: result.path,
      iterations: result.iterations,
      finalScore: result.finalScore,
      passedQualityBar: result.passed,
      evaluation: result.evaluation
    };

    if (deploy) {
      const { CloudflareDeployer } = await import('../services/cloudflare-deploy.js');
      const deployer = new CloudflareDeployer();
      const { url, projectName } = await deployer.deploy(restaurantId);
      response.websiteUrl = url;
      response.projectName = projectName;
    }

    res.json(response);
  } catch (error) {
    console.error('Regeneration error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/evaluate/:restaurantId/debug
 * Get debug info from iterative generation (screenshots, evaluations per iteration)
 */
router.get('/:restaurantId/debug', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const debugDir = join(config.paths.websites, restaurantId, 'debug');

    try {
      const iterations = await fs.readdir(debugDir);

      const debugData = await Promise.all(
        iterations
          .filter(d => d.startsWith('iteration_'))
          .sort()
          .map(async (iterDir) => {
            const iterPath = join(debugDir, iterDir);
            const evalPath = join(iterPath, 'evaluation.json');

            try {
              const evaluation = JSON.parse(await fs.readFile(evalPath, 'utf-8'));
              return {
                iteration: iterDir,
                evaluation,
                screenshots: [
                  `screenshot_mobile.png`,
                  `screenshot_tablet.png`,
                  `screenshot_desktop.png`
                ].map(f => `/restaurants/${restaurantId}/debug/${iterDir}/${f}`)
              };
            } catch {
              return { iteration: iterDir, error: 'No evaluation data' };
            }
          })
      );

      res.json({
        restaurantId,
        restaurantName: restaurant.name,
        iterations: debugData
      });
    } catch {
      res.json({
        restaurantId,
        restaurantName: restaurant.name,
        iterations: [],
        message: 'No debug data available. Run regenerate with debugMode enabled.'
      });
    }
  } catch (error) {
    console.error('Debug info error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
