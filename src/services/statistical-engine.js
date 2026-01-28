/**
 * Statistical Engine for A/B Testing
 * Implements Z-test, Thompson Sampling, revenue optimization, and anomaly detection
 */
export class StatisticalEngine {
  constructor(options = {}) {
    this.confidenceLevel = options.confidenceLevel || 0.95;
    this.minSampleSize = options.minSampleSize || 100;
    this.futilityMultiplier = options.futilityMultiplier || 4;
    this.anomalyThreshold = options.anomalyThreshold || 0.5; // 50% drop triggers anomaly
  }

  // ============ THOMPSON SAMPLING ============

  /**
   * Sample from Beta distribution using Box-Muller approximation
   * For Thompson Sampling bandit allocation
   */
  sampleBeta(alpha, beta) {
    // Use normal approximation for large alpha+beta
    if (alpha + beta > 30) {
      const mean = alpha / (alpha + beta);
      const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
      return Math.max(0, Math.min(1, this.sampleNormal(mean, Math.sqrt(variance))));
    }

    // Direct sampling for small values
    const x = this.sampleGamma(alpha, 1);
    const y = this.sampleGamma(beta, 1);
    return x / (x + y);
  }

  /**
   * Sample from Gamma distribution
   */
  sampleGamma(shape, scale) {
    if (shape < 1) {
      return this.sampleGamma(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x, v;
      do {
        x = this.sampleNormal(0, 1);
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * (x * x) * (x * x)) {
        return d * v * scale;
      }

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v * scale;
      }
    }
  }

  /**
   * Sample from Normal distribution (Box-Muller)
   */
  sampleNormal(mean, std) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + std * z;
  }

  /**
   * Thompson Sampling: Get probability of each variant being best
   * @param {Array} variants - [{ conversions, visitors }, ...]
   * @param {number} samples - Number of Monte Carlo samples
   * @returns {Array} Probability each variant is best
   */
  thompsonSamplingProbabilities(variants, samples = 10000) {
    const wins = new Array(variants.length).fill(0);

    for (let i = 0; i < samples; i++) {
      let bestIdx = 0;
      let bestSample = -1;

      for (let j = 0; j < variants.length; j++) {
        // Beta(successes + 1, failures + 1) prior
        const alpha = variants[j].conversions + 1;
        const beta = variants[j].visitors - variants[j].conversions + 1;
        const sample = this.sampleBeta(alpha, beta);

        if (sample > bestSample) {
          bestSample = sample;
          bestIdx = j;
        }
      }

      wins[bestIdx]++;
    }

    return wins.map(w => w / samples);
  }

  /**
   * Get recommended traffic allocation using Thompson Sampling
   * @param {Array} variants - [{ conversions, visitors }, ...]
   * @returns {Array} Recommended traffic proportion for each variant
   */
  getTrafficAllocation(variants) {
    const probabilities = this.thompsonSamplingProbabilities(variants);

    // Ensure minimum 10% traffic to each variant (exploration)
    const minAllocation = 0.1;
    const totalMin = minAllocation * variants.length;

    if (totalMin >= 1) {
      // Equal split if too many variants
      return variants.map(() => 1 / variants.length);
    }

    const remaining = 1 - totalMin;
    return probabilities.map(p => minAllocation + p * remaining);
  }

  // ============ REVENUE OPTIMIZATION ============

  /**
   * Analyze experiment with revenue data
   * @param {Object} control - { visitors, conversions, revenue }
   * @param {Object} treatment - { visitors, conversions, revenue }
   * @returns {Object} Analysis including revenue metrics
   */
  analyzeExperimentWithRevenue(control, treatment) {
    const baseAnalysis = this.analyzeExperiment(control, treatment);

    // Revenue per visitor
    const controlRPV = control.visitors > 0 ? control.revenue / control.visitors : 0;
    const treatmentRPV = treatment.visitors > 0 ? treatment.revenue / treatment.visitors : 0;

    // Average order value
    const controlAOV = control.conversions > 0 ? control.revenue / control.conversions : 0;
    const treatmentAOV = treatment.conversions > 0 ? treatment.revenue / treatment.conversions : 0;

    // Revenue lift
    const revenueLift = controlRPV > 0 ? (treatmentRPV - controlRPV) / controlRPV : 0;

    // T-test for revenue (Welch's t-test approximation)
    const revenueSignificant = this.isRevenueDifferenceSignificant(control, treatment);

    return {
      ...baseAnalysis,
      revenue: {
        control: {
          total: control.revenue,
          perVisitor: controlRPV,
          avgOrderValue: controlAOV
        },
        treatment: {
          total: treatment.revenue,
          perVisitor: treatmentRPV,
          avgOrderValue: treatmentAOV
        },
        lift: revenueLift,
        significant: revenueSignificant
      },
      // Combined recommendation considers both conversion and revenue
      combinedWinner: this.getCombinedWinner(baseAnalysis, revenueLift, revenueSignificant)
    };
  }

  /**
   * Check if revenue difference is significant using bootstrap approximation
   */
  isRevenueDifferenceSignificant(control, treatment) {
    if (control.visitors < 30 || treatment.visitors < 30) return false;

    const controlRPV = control.revenue / control.visitors;
    const treatmentRPV = treatment.revenue / treatment.visitors;

    // Approximate variance (assuming revenue follows exponential-ish distribution)
    const controlVar = (controlRPV * controlRPV) / control.visitors;
    const treatmentVar = (treatmentRPV * treatmentRPV) / treatment.visitors;

    const se = Math.sqrt(controlVar + treatmentVar);
    if (se === 0) return false;

    const zScore = (treatmentRPV - controlRPV) / se;
    const pValue = this.calculatePValue(zScore);

    return pValue < (1 - this.confidenceLevel);
  }

  /**
   * Get combined winner considering both conversion and revenue
   */
  getCombinedWinner(conversionAnalysis, revenueLift, revenueSignificant) {
    const conversionWinner = conversionAnalysis.winner;
    const conversionLift = conversionAnalysis.relativeLift;

    // If both agree, clear winner
    if (conversionWinner === 'treatment' && revenueLift > 0) {
      return { winner: 'treatment', confidence: 'high', reason: 'Both conversion and revenue favor treatment' };
    }
    if (conversionWinner === 'control' && revenueLift < 0) {
      return { winner: 'control', confidence: 'high', reason: 'Both conversion and revenue favor control' };
    }

    // If they disagree, prioritize revenue if significant
    if (revenueSignificant) {
      return {
        winner: revenueLift > 0 ? 'treatment' : 'control',
        confidence: 'medium',
        reason: 'Revenue significant, prioritizing revenue over conversion rate'
      };
    }

    // Fall back to conversion
    if (conversionWinner) {
      return {
        winner: conversionWinner,
        confidence: 'medium',
        reason: 'Conversion significant, revenue not yet conclusive'
      };
    }

    return { winner: null, confidence: 'low', reason: 'No significant differences detected' };
  }

  // ============ ANOMALY DETECTION ============

  /**
   * Detect anomalies in conversion rate
   * @param {number} currentRate - Current conversion rate
   * @param {number} historicalRate - Historical baseline rate
   * @param {number} sampleSize - Current sample size
   * @returns {Object} Anomaly detection result
   */
  detectAnomaly(currentRate, historicalRate, sampleSize) {
    if (sampleSize < 50 || historicalRate === 0) {
      return { isAnomaly: false, reason: 'Insufficient data' };
    }

    // Calculate expected standard error
    const se = Math.sqrt(historicalRate * (1 - historicalRate) / sampleSize);
    const zScore = (currentRate - historicalRate) / se;

    // Check for significant drop (one-tailed, 99% confidence)
    if (zScore < -2.33) {
      const dropPercent = ((historicalRate - currentRate) / historicalRate) * 100;

      if (dropPercent > this.anomalyThreshold * 100) {
        return {
          isAnomaly: true,
          severity: 'critical',
          dropPercent,
          zScore,
          reason: `Conversion rate dropped ${dropPercent.toFixed(1)}% below baseline`
        };
      }

      return {
        isAnomaly: true,
        severity: 'warning',
        dropPercent,
        zScore,
        reason: `Conversion rate is ${dropPercent.toFixed(1)}% below baseline`
      };
    }

    return { isAnomaly: false };
  }

  /**
   * Check if experiment should be paused due to anomaly
   */
  shouldPauseExperiment(control, treatment, historicalRate) {
    // Check control group for anomalies (shouldn't change much)
    const controlRate = control.visitors > 0 ? control.conversions / control.visitors : 0;
    const controlAnomaly = this.detectAnomaly(controlRate, historicalRate, control.visitors);

    if (controlAnomaly.isAnomaly && controlAnomaly.severity === 'critical') {
      return {
        shouldPause: true,
        reason: 'Control group showing unexpected drop - possible external factor',
        anomaly: controlAnomaly
      };
    }

    // Check if treatment is catastrophically worse
    const treatmentRate = treatment.visitors > 0 ? treatment.conversions / treatment.visitors : 0;
    if (treatment.visitors >= 100 && treatmentRate < historicalRate * 0.3) {
      return {
        shouldPause: true,
        reason: 'Treatment causing severe conversion drop (>70%)',
        anomaly: { treatmentRate, historicalRate, dropPercent: ((historicalRate - treatmentRate) / historicalRate) * 100 }
      };
    }

    return { shouldPause: false };
  }

  /**
   * Calculate Z-score for two proportions
   * @param {number} p1 - Conversion rate of variant 1 (control)
   * @param {number} p2 - Conversion rate of variant 2 (treatment)
   * @param {number} n1 - Sample size of variant 1
   * @param {number} n2 - Sample size of variant 2
   * @returns {number} Z-score
   */
  calculateZScore(p1, p2, n1, n2) {
    // Pooled proportion
    const pPooled = (p1 * n1 + p2 * n2) / (n1 + n2);

    // Standard error
    const se = Math.sqrt(pPooled * (1 - pPooled) * (1/n1 + 1/n2));

    if (se === 0) return 0;

    // Z-score
    return (p2 - p1) / se;
  }

  /**
   * Calculate p-value from Z-score (two-tailed)
   * Using approximation of normal CDF
   * @param {number} z - Z-score
   * @returns {number} p-value
   */
  calculatePValue(z) {
    // Approximation of normal CDF
    const absZ = Math.abs(z);
    const t = 1 / (1 + 0.2316419 * absZ);
    const d = 0.3989423 * Math.exp(-absZ * absZ / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

    // Two-tailed p-value
    return 2 * p;
  }

  /**
   * Calculate required sample size per variant
   * @param {number} baseline - Baseline conversion rate (e.g., 0.05 for 5%)
   * @param {number} mde - Minimum detectable effect (relative, e.g., 0.2 for 20% improvement)
   * @param {number} alpha - Significance level (default 0.05)
   * @param {number} power - Statistical power (default 0.8)
   * @returns {number} Required sample size per variant
   */
  calculateSampleSize(baseline, mde, alpha = 0.05, power = 0.8) {
    // Z-scores for alpha and power
    const zAlpha = this.getZScore(1 - alpha / 2);
    const zBeta = this.getZScore(power);

    // Expected conversion rate for treatment
    const p1 = baseline;
    const p2 = baseline * (1 + mde);

    // Pooled variance
    const pBar = (p1 + p2) / 2;

    // Sample size formula
    const n = 2 * Math.pow(zAlpha + zBeta, 2) * pBar * (1 - pBar) / Math.pow(p2 - p1, 2);

    return Math.ceil(n);
  }

  /**
   * Get Z-score for a given percentile
   * @param {number} p - Percentile (0-1)
   * @returns {number} Z-score
   */
  getZScore(p) {
    // Approximation of inverse normal CDF
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;

    const a1 = -3.969683028665376e1;
    const a2 = 2.209460984245205e2;
    const a3 = -2.759285104469687e2;
    const a4 = 1.383577518672690e2;
    const a5 = -3.066479806614716e1;
    const a6 = 2.506628277459239e0;

    const b1 = -5.447609879822406e1;
    const b2 = 1.615858368580409e2;
    const b3 = -1.556989798598866e2;
    const b4 = 6.680131188771972e1;
    const b5 = -1.328068155288572e1;

    const c1 = -7.784894002430293e-3;
    const c2 = -3.223964580411365e-1;
    const c3 = -2.400758277161838e0;
    const c4 = -2.549732539343734e0;
    const c5 = 4.374664141464968e0;
    const c6 = 2.938163982698783e0;

    const d1 = 7.784695709041462e-3;
    const d2 = 3.224671290700398e-1;
    const d3 = 2.445134137142996e0;
    const d4 = 3.754408661907416e0;

    const pLow = 0.02425;
    const pHigh = 1 - pLow;

    let q, r;

    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
             ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    } else if (p <= pHigh) {
      q = p - 0.5;
      r = q * q;
      return (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
             (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
              ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    }
  }

  /**
   * Analyze experiment results
   * @param {Object} control - { visitors, conversions }
   * @param {Object} treatment - { visitors, conversions }
   * @returns {Object} Analysis results
   */
  analyzeExperiment(control, treatment) {
    const p1 = control.visitors > 0 ? control.conversions / control.visitors : 0;
    const p2 = treatment.visitors > 0 ? treatment.conversions / treatment.visitors : 0;

    const zScore = this.calculateZScore(p1, p2, control.visitors, treatment.visitors);
    const pValue = this.calculatePValue(zScore);

    const significant = pValue < (1 - this.confidenceLevel);
    const winner = significant ? (p2 > p1 ? 'treatment' : 'control') : null;

    // Calculate lift
    const relativeLift = p1 > 0 ? (p2 - p1) / p1 : 0;
    const absoluteLift = p2 - p1;

    // Calculate confidence interval for the difference (95%)
    const se = Math.sqrt((p1 * (1 - p1) / control.visitors) + (p2 * (1 - p2) / treatment.visitors));
    const z95 = 1.96;
    const ciLower = absoluteLift - z95 * se;
    const ciUpper = absoluteLift + z95 * se;

    return {
      control: {
        visitors: control.visitors,
        conversions: control.conversions,
        conversionRate: p1
      },
      treatment: {
        visitors: treatment.visitors,
        conversions: treatment.conversions,
        conversionRate: p2
      },
      zScore,
      pValue,
      significant,
      winner,
      relativeLift,
      absoluteLift,
      confidenceInterval: { lower: ciLower, upper: ciUpper },
      confidenceLevel: this.confidenceLevel
    };
  }

  /**
   * Check if experiment has enough data
   * @param {Object} control - { visitors, conversions }
   * @param {Object} treatment - { visitors, conversions }
   * @returns {boolean}
   */
  hasMinimumSample(control, treatment) {
    return control.visitors >= this.minSampleSize &&
           treatment.visitors >= this.minSampleSize;
  }

  /**
   * Check for early stopping (futility)
   * @param {Object} control - { visitors, conversions }
   * @param {Object} treatment - { visitors, conversions }
   * @returns {Object} { shouldStop, reason }
   */
  checkFutility(control, treatment) {
    const minRequired = this.minSampleSize * this.futilityMultiplier;

    // Need at least 4x minimum sample to check futility
    if (control.visitors < minRequired || treatment.visitors < minRequired) {
      return { shouldStop: false, reason: null };
    }

    const analysis = this.analyzeExperiment(control, treatment);

    // If p-value > 0.5, the effect is clearly in the wrong direction or negligible
    if (analysis.pValue > 0.5) {
      return {
        shouldStop: true,
        reason: 'futility',
        message: 'No significant effect detected after extended sampling period'
      };
    }

    return { shouldStop: false, reason: null };
  }

  /**
   * Get experiment status and recommendation
   * @param {Object} control - { visitors, conversions }
   * @param {Object} treatment - { visitors, conversions }
   * @returns {Object} Status and recommendation
   */
  getExperimentStatus(control, treatment) {
    // Check minimum sample
    if (!this.hasMinimumSample(control, treatment)) {
      return {
        status: 'collecting',
        message: `Need more data. Control: ${control.visitors}/${this.minSampleSize}, Treatment: ${treatment.visitors}/${this.minSampleSize}`,
        recommendation: 'continue'
      };
    }

    // Check for significance
    const analysis = this.analyzeExperiment(control, treatment);

    if (analysis.significant) {
      return {
        status: 'significant',
        message: `${analysis.winner === 'treatment' ? 'Treatment' : 'Control'} wins with ${(analysis.relativeLift * 100).toFixed(1)}% lift (p=${analysis.pValue.toFixed(4)})`,
        recommendation: analysis.winner === 'treatment' ? 'apply_treatment' : 'keep_control',
        analysis
      };
    }

    // Check for futility
    const futility = this.checkFutility(control, treatment);
    if (futility.shouldStop) {
      return {
        status: 'futile',
        message: futility.message,
        recommendation: 'end_experiment',
        analysis
      };
    }

    return {
      status: 'running',
      message: `Not yet significant (p=${analysis.pValue.toFixed(4)}). Continue collecting data.`,
      recommendation: 'continue',
      analysis
    };
  }
}

export const statisticalEngine = new StatisticalEngine();
