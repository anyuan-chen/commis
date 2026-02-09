import { Router } from 'express';
import {
  RestaurantModel,
  ExperimentModel,
  VariantModel,
  AnalyticsEventModel,
  OptimizerStateModel
} from '../db/models/index.js';
import { abOptimizer } from '../services/ab-optimizer.js';
import { statisticalEngine } from '../services/statistical-engine.js';

const router = Router();

/**
 * Check if experiment should auto-graduate based on Thompson Sampling probability
 * Called after every conversion to enable real-time winner detection
 */
async function checkAutoGraduate(restaurantId) {
  const experiment = ExperimentModel.getActive(restaurantId);
  if (!experiment) return null;

  const variants = VariantModel.getByExperiment(experiment.id);
  if (variants.length < 2) return null;

  const control = variants.find(v => v.isControl);
  const treatment = variants.find(v => !v.isControl);
  if (!control || !treatment) return null;

  // Need minimum samples before graduating
  const minSamples = 100;
  if (control.visitors < minSamples || treatment.visitors < minSamples) {
    return null;
  }

  // Calculate Thompson Sampling probabilities
  const probs = statisticalEngine.thompsonSamplingProbabilities([
    { visitors: control.visitors, conversions: control.conversions },
    { visitors: treatment.visitors, conversions: treatment.conversions }
  ]);

  const controlProb = probs[0];
  const treatmentProb = probs[1];

  // Auto-graduate if >95% probability of being best
  const graduationThreshold = 0.95;

  if (treatmentProb >= graduationThreshold) {
    // Treatment wins - promote it
    console.log(`[AutoGraduate] Treatment wins with ${(treatmentProb * 100).toFixed(1)}% probability`);
    await abOptimizer.applyWinner(restaurantId, experiment, treatment, {
      revenue: { lift: 0 }  // Revenue lift calculated separately
    });

    OptimizerStateModel.addLearning(restaurantId, {
      hypothesis: experiment.hypothesis,
      changeType: experiment.changeType,
      result: 'auto_graduated_winner',
      probability: treatmentProb,
      controlRate: control.conversionRate,
      treatmentRate: treatment.conversionRate
    });

    return { graduated: true, winner: 'treatment', probability: treatmentProb };
  }

  if (controlProb >= graduationThreshold) {
    // Control wins - revert
    console.log(`[AutoGraduate] Control wins with ${(controlProb * 100).toFixed(1)}% probability`);
    await abOptimizer.revertToControl(restaurantId, experiment);

    OptimizerStateModel.addLearning(restaurantId, {
      hypothesis: experiment.hypothesis,
      changeType: experiment.changeType,
      result: 'auto_graduated_control',
      probability: controlProb
    });

    return { graduated: true, winner: 'control', probability: controlProb };
  }

  return { graduated: false, controlProb, treatmentProb };
}

/**
 * POST /api/analytics/event
 * Receive tracking events from website
 */
router.post('/event', async (req, res) => {
  try {
    const { events } = req.body;

    if (!events || !Array.isArray(events)) {
      // Single event format
      const event = req.body;
      if (!event.restaurantId || !event.sessionId || !event.eventType) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      AnalyticsEventModel.create({
        restaurantId: event.restaurantId,
        sessionId: event.sessionId,
        variantId: event.variantId || null,
        eventType: event.eventType,
        eventData: event.eventData || null
      });

      return res.json({ success: true, count: 1 });
    }

    // Batch event format
    let count = 0;
    for (const event of events) {
      if (event.restaurantId && event.sessionId && event.eventType) {
        AnalyticsEventModel.create({
          restaurantId: event.restaurantId,
          sessionId: event.sessionId,
          variantId: event.variantId || null,
          eventType: event.eventType,
          eventData: event.eventData || null
        });
        count++;
      }
    }

    res.json({ success: true, count });
  } catch (error) {
    console.error('Analytics event error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/variant/:restaurantId
 * Get current variant from cookie (assignment happens via middleware)
 */
router.get('/variant/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    // Parse variant from cookie
    const cookies = parseCookies(req.headers.cookie || '');
    const variantId = cookies[`commis_variant_${restaurantId}`];

    if (!variantId) {
      return res.json({ variantId: null });
    }

    const variant = VariantModel.getById(variantId);
    if (!variant) {
      return res.json({ variantId: null });
    }

    res.json({
      variantId: variant.id,
      experimentId: variant.experimentId,
      isControl: variant.isControl
    });
  } catch (error) {
    console.error('Get variant error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simple cookie parser
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  });

  return cookies;
}

/**
 * GET /api/analytics/metrics/:restaurantId
 * Get website analytics metrics
 */
router.get('/metrics/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { days = 14 } = req.query;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const analytics = abOptimizer.getAnalytics(restaurantId, parseInt(days));

    res.json(analytics);
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/optimizer/:restaurantId
 * Get optimizer status
 */
router.get('/optimizer/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const status = abOptimizer.getStatus(restaurantId);

    res.json(status);
  } catch (error) {
    console.error('Get optimizer status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/analytics/optimizer/:restaurantId/toggle
 * Enable/disable optimizer
 */
router.post('/optimizer/:restaurantId/toggle', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { enabled } = req.body;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const state = OptimizerStateModel.toggle(restaurantId, enabled);

    res.json({
      success: true,
      enabled: state.enabled
    });
  } catch (error) {
    console.error('Toggle optimizer error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/analytics/optimizer/:restaurantId/run
 * Manually trigger optimization cycle
 */
router.post('/optimizer/:restaurantId/run', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Temporarily enable if disabled (for manual runs)
    const state = OptimizerStateModel.getOrCreate(restaurantId);
    const wasDisabled = !state.enabled;

    if (wasDisabled) {
      OptimizerStateModel.enable(restaurantId);
    }

    const result = await abOptimizer.optimize(restaurantId);

    // Restore original state if it was disabled
    if (wasDisabled) {
      OptimizerStateModel.disable(restaurantId);
    }

    res.json(result);
  } catch (error) {
    console.error('Run optimizer error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/experiments/:restaurantId
 * List experiments for a restaurant
 */
router.get('/experiments/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, limit = 20 } = req.query;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const experiments = ExperimentModel.getByRestaurant(restaurantId, {
      status,
      limit: parseInt(limit)
    });

    // Add variant details to each experiment
    const experimentsWithVariants = experiments.map(exp => {
      const withVariants = ExperimentModel.getWithVariants(exp.id);
      return withVariants;
    });

    res.json({ experiments: experimentsWithVariants });
  } catch (error) {
    console.error('List experiments error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/experiments/:restaurantId/:experimentId
 * Get experiment details
 */
router.get('/experiments/:restaurantId/:experimentId', async (req, res) => {
  try {
    const { restaurantId, experimentId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const experiment = ExperimentModel.getWithVariants(experimentId);
    if (!experiment || experiment.restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Experiment not found' });
    }

    res.json(experiment);
  } catch (error) {
    console.error('Get experiment error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/analytics/experiments/:restaurantId/:experimentId
 * Cancel/delete an experiment
 */
router.delete('/experiments/:restaurantId/:experimentId', async (req, res) => {
  try {
    const { restaurantId, experimentId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const experiment = ExperimentModel.getById(experimentId);
    if (!experiment || experiment.restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Experiment not found' });
    }

    // If running, revert changes first
    if (experiment.status === 'running') {
      await abOptimizer.revertToControl(restaurantId, experiment);
    }

    ExperimentModel.delete(experimentId);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete experiment error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/analytics/record-conversion/:restaurantId
 * Record a conversion (called from checkout success)
 */
router.post('/record-conversion/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { sessionId, variantId, orderId, total } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    // Get variant from cookie if not provided
    let effectiveVariantId = variantId;
    if (!effectiveVariantId) {
      const cookies = parseCookies(req.headers.cookie || '');
      effectiveVariantId = cookies[`commis_variant_${restaurantId}`] || null;
    }

    // Record the order event
    AnalyticsEventModel.create({
      restaurantId,
      sessionId,
      variantId: effectiveVariantId,
      eventType: 'order',
      eventData: { orderId, total }
    });

    // Increment conversion count and add revenue for variant
    if (effectiveVariantId) {
      VariantModel.incrementConversions(effectiveVariantId);
      if (total) {
        VariantModel.addRevenue(effectiveVariantId, parseFloat(total) || 0);
      }
    }

    // Real-time graduation check - auto-graduate if clear winner emerges
    let graduationResult = null;
    let newExperiment = null;
    try {
      graduationResult = await checkAutoGraduate(restaurantId);
      if (graduationResult?.graduated) {
        console.log(`[RealTime] Auto-graduated experiment: ${graduationResult.winner} wins`);

        // Auto-start next experiment from queue (marathon mode)
        const state = OptimizerStateModel.getOrCreate(restaurantId);
        if (state.enabled) {
          newExperiment = await abOptimizer.createExperimentFromQueue(restaurantId);
          if (newExperiment?.action === 'created') {
            console.log(`[RealTime] Auto-started next experiment: ${newExperiment.hypothesis}`);
          }
        }
      }
    } catch (e) {
      console.error('[RealTime] Graduation check failed:', e.message);
    }

    res.json({
      success: true,
      variantId: effectiveVariantId,
      graduated: graduationResult?.graduated || false,
      winner: graduationResult?.winner || null
    });
  } catch (error) {
    console.error('Record conversion error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
