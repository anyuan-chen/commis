import { join } from 'path';
import { promises as fs } from 'fs';
import { config } from '../config.js';
import { ExperimentModel, VariantModel } from '../db/models/index.js';

/**
 * Real-time Thompson Sampling
 * Calculates probability each variant is best using Beta distribution sampling
 */
function thompsonSample(variants) {
  // Sample from Beta distribution for each variant
  const samples = variants.map(v => {
    const alpha = (v.conversions || 0) + 1;  // successes + prior
    const beta = (v.visitors || 0) - (v.conversions || 0) + 1;  // failures + prior
    return { variant: v, sample: sampleBeta(alpha, beta) };
  });

  // Return variant with highest sample
  samples.sort((a, b) => b.sample - a.sample);
  return samples[0].variant;
}

/**
 * Sample from Beta distribution using Gamma sampling
 */
function sampleBeta(alpha, beta) {
  const gammaA = sampleGamma(alpha);
  const gammaB = sampleGamma(beta);
  return gammaA / (gammaA + gammaB);
}

/**
 * Sample from Gamma distribution (Marsaglia and Tsang's method)
 */
function sampleGamma(shape) {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x, v;
    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }

    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/**
 * Sample from standard normal distribution (Box-Muller)
 */
function randomNormal() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Middleware to serve variant-specific HTML for A/B testing
 * Uses real-time Thompson Sampling - every visitor gets assigned based on current performance
 */
export async function variantServerMiddleware(req, res, next) {
  // Only handle requests to preview-static (generated websites)
  if (!req.path.startsWith('/preview-static/')) {
    return next();
  }

  // Parse the path to get restaurant ID and file
  const pathParts = req.path.replace('/preview-static/', '').split('/');
  const restaurantId = pathParts[0];
  let requestedFile = pathParts.slice(1).join('/') || 'index.html';

  // Skip variant logic for non-HTML files and variant subdirectories
  if (requestedFile.startsWith('variants/') ||
      (!requestedFile.endsWith('.html') && requestedFile !== '')) {
    return next();
  }

  const filename = requestedFile || 'index.html';

  try {
    // Check for variant cookie
    const cookies = parseCookies(req.headers.cookie || '');
    let variantId = cookies[`commis_variant_${restaurantId}`];

    // If no variant assigned, try to assign one
    if (!variantId) {
      const assignment = assignVariant(restaurantId);
      if (assignment.variantId) {
        variantId = assignment.variantId;

        // Set cookie for future requests
        const cookieExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        res.cookie(`commis_variant_${restaurantId}`, variantId, {
          expires: cookieExpires,
          path: '/',
          sameSite: 'Lax'
        });
      }
    }

    // If variant assigned, check if we need to serve variant file
    if (variantId) {
      const variant = VariantModel.getById(variantId);

      // Only serve variant file for non-control variants
      if (variant && !variant.isControl) {
        const variantPath = join(config.paths.websites, restaurantId, 'variants', variantId, filename);

        try {
          await fs.access(variantPath);
          // Variant file exists, serve it
          return res.sendFile(variantPath);
        } catch {
          // Variant file doesn't exist, fall through to serve original
        }
      }
    }

    // Serve original file
    next();
  } catch (error) {
    console.error('Variant server error:', error);
    next();
  }
}

/**
 * Assign variant for a restaurant using real-time Thompson Sampling
 * Every assignment uses current conversion data - no stale allocations
 */
function assignVariant(restaurantId) {
  // Get active experiment
  const experiment = ExperimentModel.getActive(restaurantId);

  if (!experiment) {
    return { variantId: null, reason: 'no_experiment' };
  }

  // Get variants with CURRENT stats
  const variants = VariantModel.getByExperiment(experiment.id);

  if (variants.length < 2) {
    return { variantId: null, reason: 'invalid_experiment' };
  }

  // Real-time Thompson Sampling - uses current visitors/conversions
  // Each visitor assignment reflects latest performance data
  const selectedVariant = thompsonSample(variants);

  // Increment visitor count (immediately affects next visitor's assignment)
  VariantModel.incrementVisitors(selectedVariant.id);

  return {
    variantId: selectedVariant.id,
    isControl: selectedVariant.isControl,
    experimentId: experiment.id
  };
}

/**
 * Simple cookie parser
 */
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
 * API endpoint to get current variant assignment (for analytics snippet)
 */
export function getVariantHandler(req, res) {
  const { restaurantId } = req.params;

  const cookies = parseCookies(req.headers.cookie || '');
  const variantId = cookies[`commis_variant_${restaurantId}`];

  if (variantId) {
    const variant = VariantModel.getById(variantId);
    return res.json({
      variantId,
      isControl: variant?.isControl || false,
      experimentId: variant?.experimentId || null
    });
  }

  res.json({ variantId: null });
}
