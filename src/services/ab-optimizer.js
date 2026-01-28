import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import {
  RestaurantModel,
  ExperimentModel,
  VariantModel,
  AnalyticsEventModel,
  OptimizerStateModel,
  ExperimentQueueModel
} from '../db/models/index.js';
import { statisticalEngine } from './statistical-engine.js';
import { WebsiteUpdater } from './website-updater.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * A/B Optimizer - Autonomous AI Agent
 * Features:
 * - Thompson Sampling for traffic allocation
 * - Revenue + conversion optimization
 * - Anomaly detection and auto-pause
 * - Experiment queue with pre-generated hypotheses
 * - Compound learning from multiple wins
 */
export class ABOptimizer {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    this.websiteUpdater = new WebsiteUpdater();
    this.maxExperimentsPerWeek = 3;
    this.minDataDays = 7;
    this.queueSize = 5; // Pre-generate this many hypotheses
  }

  // ============ MAIN OPTIMIZATION LOOP ============

  /**
   * Main optimization loop - called every 4 hours
   */
  async optimize(restaurantId) {
    const state = OptimizerStateModel.getOrCreate(restaurantId);

    if (!state.enabled) {
      return { skipped: true, reason: 'Optimizer disabled' };
    }

    // Update baseline metrics periodically
    await this.updateBaselineMetrics(restaurantId);

    // Check for active experiment
    const activeExperiment = ExperimentModel.getActive(restaurantId);

    if (activeExperiment) {
      // Check for anomalies first
      const anomalyCheck = await this.checkForAnomalies(restaurantId, activeExperiment);
      if (anomalyCheck.shouldPause) {
        return await this.pauseExperiment(restaurantId, activeExperiment, anomalyCheck.reason);
      }

      // Update traffic allocation using Thompson Sampling
      await this.updateTrafficAllocation(activeExperiment);

      // Analyze ongoing experiment
      return await this.analyzeExperiment(restaurantId, activeExperiment);
    } else {
      // Ensure queue has hypotheses
      await this.ensureQueueFilled(restaurantId);

      // Try to create new experiment from queue
      return await this.createExperimentFromQueue(restaurantId);
    }
  }

  // ============ EXPERIMENT ANALYSIS ============

  /**
   * Analyze an active experiment with revenue data
   */
  async analyzeExperiment(restaurantId, experiment) {
    const experimentWithVariants = ExperimentModel.getWithVariants(experiment.id);
    const variants = experimentWithVariants.variants;

    const control = variants.find(v => v.isControl);
    const treatment = variants.find(v => !v.isControl);

    if (!control || !treatment) {
      return { error: 'Invalid experiment setup' };
    }

    // Get updated stats from analytics (including revenue)
    const controlMetrics = AnalyticsEventModel.getVariantMetrics(control.id);
    const treatmentMetrics = AnalyticsEventModel.getVariantMetrics(treatment.id);

    // Update variant stats with revenue
    VariantModel.updateStats(control.id, controlMetrics.visitors, controlMetrics.conversions, controlMetrics.revenue);
    VariantModel.updateStats(treatment.id, treatmentMetrics.visitors, treatmentMetrics.conversions, treatmentMetrics.revenue);

    // Get experiment status with revenue analysis
    const status = statisticalEngine.getExperimentStatus(
      { visitors: controlMetrics.visitors, conversions: controlMetrics.conversions },
      { visitors: treatmentMetrics.visitors, conversions: treatmentMetrics.conversions }
    );

    // Also analyze revenue
    const revenueAnalysis = statisticalEngine.analyzeExperimentWithRevenue(
      { visitors: controlMetrics.visitors, conversions: controlMetrics.conversions, revenue: controlMetrics.revenue },
      { visitors: treatmentMetrics.visitors, conversions: treatmentMetrics.conversions, revenue: treatmentMetrics.revenue }
    );

    OptimizerStateModel.updateLastOptimization(restaurantId);

    if (status.recommendation === 'continue') {
      return {
        action: 'continue',
        experimentId: experiment.id,
        status: status.status,
        message: status.message,
        control: { ...controlMetrics, conversionRate: control.conversionRate },
        treatment: { ...treatmentMetrics, conversionRate: treatment.conversionRate },
        revenue: revenueAnalysis.revenue,
        trafficAllocation: {
          control: control.trafficAllocation,
          treatment: treatment.trafficAllocation
        }
      };
    }

    // Use combined winner (considers both conversion and revenue)
    const combinedWinner = revenueAnalysis.combinedWinner;

    if (combinedWinner.winner === 'treatment') {
      await this.applyWinner(restaurantId, experiment, treatment, revenueAnalysis);

      const learning = {
        hypothesis: experiment.hypothesis,
        changeType: experiment.changeType,
        changeDescription: treatment.changeDescription,
        result: 'success',
        conversionLift: status.analysis?.relativeLift || 0,
        revenueLift: revenueAnalysis.revenue.lift,
        pValue: status.analysis?.pValue,
        confidence: combinedWinner.confidence
      };
      OptimizerStateModel.addLearning(restaurantId, learning);

      // Track compound changes
      this.trackCompoundChange(restaurantId, treatment);

      return {
        action: 'applied',
        experimentId: experiment.id,
        winner: 'treatment',
        conversionLift: status.analysis?.relativeLift,
        revenueLift: revenueAnalysis.revenue.lift,
        message: `Applied winning variant: ${treatment.changeDescription}`,
        confidence: combinedWinner.confidence
      };
    }

    if (combinedWinner.winner === 'control' || status.recommendation === 'end_experiment') {
      await this.revertToControl(restaurantId, experiment);

      const learning = {
        hypothesis: experiment.hypothesis,
        changeType: experiment.changeType,
        result: combinedWinner.winner === 'control' ? 'control_won' : 'no_effect',
        pValue: status.analysis?.pValue,
        reason: combinedWinner.reason
      };
      OptimizerStateModel.addLearning(restaurantId, learning);

      return {
        action: 'reverted',
        experimentId: experiment.id,
        reason: combinedWinner.reason,
        message: status.message
      };
    }

    return { action: 'continue', status: 'analyzing' };
  }

  // ============ THOMPSON SAMPLING ============

  /**
   * Update traffic allocation using Thompson Sampling
   */
  async updateTrafficAllocation(experiment) {
    const variants = VariantModel.getByExperiment(experiment.id);

    if (variants.length < 2) return;

    // Get Thompson Sampling allocations
    const variantStats = variants.map(v => ({
      conversions: v.conversions,
      visitors: v.visitors
    }));

    const allocations = statisticalEngine.getTrafficAllocation(variantStats);

    // Update each variant's allocation
    VariantModel.updateAllAllocations(experiment.id, allocations);

    return allocations;
  }

  // ============ ANOMALY DETECTION ============

  /**
   * Check for anomalies that should pause the experiment
   */
  async checkForAnomalies(restaurantId, experiment) {
    const state = OptimizerStateModel.getByRestaurant(restaurantId);
    const baselineMetrics = state?.baselineMetrics || {};
    const historicalRate = baselineMetrics.conversionRate || 0;

    if (!historicalRate) {
      return { shouldPause: false };
    }

    const variants = VariantModel.getByExperiment(experiment.id);
    const control = variants.find(v => v.isControl);
    const treatment = variants.find(v => !v.isControl);

    if (!control || !treatment) {
      return { shouldPause: false };
    }

    const controlMetrics = AnalyticsEventModel.getVariantMetrics(control.id);
    const treatmentMetrics = AnalyticsEventModel.getVariantMetrics(treatment.id);

    return statisticalEngine.shouldPauseExperiment(
      { visitors: controlMetrics.visitors, conversions: controlMetrics.conversions },
      { visitors: treatmentMetrics.visitors, conversions: treatmentMetrics.conversions },
      historicalRate
    );
  }

  /**
   * Pause an experiment due to anomaly
   */
  async pauseExperiment(restaurantId, experiment, reason) {
    // Revert to control immediately
    await this.revertToControl(restaurantId, experiment);

    // Update experiment status
    ExperimentModel.update(experiment.id, {
      status: 'paused',
      pauseReason: reason
    });

    // Record learning
    OptimizerStateModel.addLearning(restaurantId, {
      hypothesis: experiment.hypothesis,
      changeType: experiment.changeType,
      result: 'paused_anomaly',
      reason
    });

    return {
      action: 'paused',
      experimentId: experiment.id,
      reason,
      message: `Experiment paused due to anomaly: ${reason}`
    };
  }

  // ============ EXPERIMENT QUEUE ============

  /**
   * Ensure queue has enough pre-generated hypotheses
   */
  async ensureQueueFilled(restaurantId) {
    const currentCount = ExperimentQueueModel.getCount(restaurantId);

    if (currentCount >= this.queueSize) {
      return; // Queue is full
    }

    const needed = this.queueSize - currentCount;
    const metrics = await this.getMetricsForHypothesis(restaurantId);

    if (!metrics.hasEnoughData) {
      return; // Not enough data to generate hypotheses
    }

    const state = OptimizerStateModel.getByRestaurant(restaurantId);
    const learnings = state?.learnings || [];
    const existingQueue = ExperimentQueueModel.getByRestaurant(restaurantId);

    // Generate multiple hypotheses at once
    const hypotheses = await this.generateMultipleHypotheses(
      restaurantId,
      metrics,
      learnings,
      existingQueue,
      needed
    );

    if (hypotheses && hypotheses.length > 0) {
      ExperimentQueueModel.addBatch(restaurantId, hypotheses);
    }
  }

  /**
   * Create experiment from queue
   */
  async createExperimentFromQueue(restaurantId) {
    if (!OptimizerStateModel.canRunExperiment(restaurantId, this.maxExperimentsPerWeek)) {
      return {
        skipped: true,
        reason: `Rate limit: max ${this.maxExperimentsPerWeek} experiments per week`
      };
    }

    // Get next hypothesis from queue
    const queueItem = ExperimentQueueModel.getNext(restaurantId);

    if (!queueItem) {
      // Fallback to generating on-the-fly
      return await this.createExperiment(restaurantId);
    }

    // Get baseline conversion rate
    const historical = AnalyticsEventModel.getHistoricalConversionRate(restaurantId, 30);

    // Create experiment
    const experiment = ExperimentModel.create(restaurantId, {
      hypothesis: queueItem.hypothesis,
      changeType: queueItem.changeType,
      baselineConversionRate: historical.conversionRate
    });

    // Create variants
    VariantModel.create(experiment.id, {
      name: 'control',
      isControl: true,
      changeDescription: 'Original version'
    });

    VariantModel.create(experiment.id, {
      name: 'variant_a',
      isControl: false,
      changePrompt: queueItem.variantPrompt,
      changeDescription: queueItem.variantDescription
    });

    // Generate variant HTML (separate file, doesn't modify original)
    const treatment = VariantModel.getByExperiment(experiment.id).find(v => !v.isControl);
    try {
      await this.websiteUpdater.generateVariant(restaurantId, treatment.id, queueItem.variantPrompt);
    } catch (error) {
      console.error('Failed to generate variant:', error);
      ExperimentModel.delete(experiment.id);
      ExperimentQueueModel.remove(queueItem.id);
      return { error: 'Failed to generate variant HTML', details: error.message };
    }

    // Remove from queue and start
    ExperimentQueueModel.remove(queueItem.id);
    ExperimentModel.start(experiment.id);

    OptimizerStateModel.incrementExperimentCount(restaurantId);
    OptimizerStateModel.updateLastOptimization(restaurantId);

    return {
      action: 'created',
      experimentId: experiment.id,
      hypothesis: queueItem.hypothesis,
      changeType: queueItem.changeType,
      variantDescription: queueItem.variantDescription,
      source: queueItem.source
    };
  }

  /**
   * Legacy: Create experiment on-the-fly (fallback)
   */
  async createExperiment(restaurantId) {
    const metrics = await this.getMetricsForHypothesis(restaurantId);

    if (!metrics.hasEnoughData) {
      return { skipped: true, reason: 'Not enough analytics data' };
    }

    const state = OptimizerStateModel.getByRestaurant(restaurantId);
    const hypothesis = await this.generateHypothesis(restaurantId, metrics, state?.learnings || []);

    if (!hypothesis) {
      return { skipped: true, reason: 'No hypothesis generated' };
    }

    const historical = AnalyticsEventModel.getHistoricalConversionRate(restaurantId, 30);

    const experiment = ExperimentModel.create(restaurantId, {
      hypothesis: hypothesis.hypothesis,
      changeType: hypothesis.changeType,
      baselineConversionRate: historical.conversionRate
    });

    VariantModel.create(experiment.id, {
      name: 'control',
      isControl: true,
      changeDescription: 'Original version'
    });

    VariantModel.create(experiment.id, {
      name: 'variant_a',
      isControl: false,
      changePrompt: hypothesis.variantPrompt,
      changeDescription: hypothesis.variantDescription
    });

    // Generate variant HTML
    const treatment = VariantModel.getByExperiment(experiment.id).find(v => !v.isControl);
    try {
      await this.websiteUpdater.generateVariant(restaurantId, treatment.id, hypothesis.variantPrompt);
    } catch (error) {
      ExperimentModel.delete(experiment.id);
      return { error: 'Failed to generate variant HTML', details: error.message };
    }

    ExperimentModel.start(experiment.id);
    OptimizerStateModel.incrementExperimentCount(restaurantId);
    OptimizerStateModel.updateLastOptimization(restaurantId);

    return {
      action: 'created',
      experimentId: experiment.id,
      hypothesis: hypothesis.hypothesis,
      changeType: hypothesis.changeType,
      variantDescription: hypothesis.variantDescription
    };
  }

  // ============ COMPOUND LEARNING ============

  /**
   * Track winning change for compound effects
   */
  trackCompoundChange(restaurantId, winningVariant) {
    const state = OptimizerStateModel.getByRestaurant(restaurantId);
    const compoundChanges = state?.compoundChanges || [];

    compoundChanges.push({
      changeType: winningVariant.changeType,
      description: winningVariant.changeDescription,
      appliedAt: new Date().toISOString()
    });

    // Keep last 20 changes
    const trimmed = compoundChanges.slice(-20);

    OptimizerStateModel.updateCompoundChanges(restaurantId, trimmed);
  }

  /**
   * Update baseline metrics for anomaly detection
   */
  async updateBaselineMetrics(restaurantId) {
    const historical = AnalyticsEventModel.getHistoricalConversionRate(restaurantId, 30);

    if (historical.visitors >= 100) {
      OptimizerStateModel.updateBaselineMetrics(restaurantId, {
        conversionRate: historical.conversionRate,
        visitors: historical.visitors,
        conversions: historical.conversions,
        updatedAt: new Date().toISOString()
      });
    }
  }

  // ============ HYPOTHESIS GENERATION ============

  /**
   * Generate multiple hypotheses for queue
   */
  async generateMultipleHypotheses(restaurantId, metrics, learnings, existingQueue, count) {
    const restaurant = RestaurantModel.getFullData(restaurantId);

    const existingHypotheses = [
      ...learnings.map(l => l.hypothesis),
      ...existingQueue.map(q => q.hypothesis)
    ];

    const prompt = `You are an A/B testing expert. Generate ${count} DIFFERENT hypotheses for testing.

RESTAURANT: ${restaurant.name} (${restaurant.cuisine_type})

METRICS:
- Conversion Rate: ${(metrics.conversionRate * 100).toFixed(2)}%
- Add to Cart: ${(metrics.addToCartRate * 100).toFixed(2)}%
- Avg Time: ${metrics.avgTimeOnPage?.toFixed(0) || 0}s

ALREADY TESTED/QUEUED (avoid these):
${existingHypotheses.slice(-10).join('\n')}

Return JSON array (no markdown):
[
  {
    "hypothesis": "...",
    "changeType": "cta|hero|layout|copy|color|menu",
    "variantPrompt": "Specific change instruction",
    "variantDescription": "Human-readable description",
    "priority": 1-10
  }
]

Prioritize by expected impact. Focus on different aspects of the site.`;

    try {
      const result = await this.model.generateContent(prompt);
      let response = result.response.text().trim();
      response = response.replace(/^```json\n?/i, '').replace(/\n?```$/i, '').trim();
      return JSON.parse(response);
    } catch (error) {
      console.error('Multi-hypothesis generation failed:', error);
      return null;
    }
  }

  /**
   * Generate single hypothesis (legacy)
   */
  async generateHypothesis(restaurantId, metrics, learnings) {
    const restaurant = RestaurantModel.getFullData(restaurantId);
    const pastExperiments = learnings.slice(-10).map(l => ({
      hypothesis: l.hypothesis,
      result: l.result,
      lift: l.lift
    }));

    const benchmarks = {
      restaurantConversionRate: 0.02,
      addToCartRate: 0.08,
      cartToOrderRate: 0.25
    };

    const gaps = [];
    if (metrics.conversionRate < benchmarks.restaurantConversionRate) {
      gaps.push(`Low conversion rate (${(metrics.conversionRate * 100).toFixed(2)}%)`);
    }
    if (metrics.addToCartRate < benchmarks.addToCartRate) {
      gaps.push(`Low add-to-cart rate (${(metrics.addToCartRate * 100).toFixed(2)}%)`);
    }
    if (metrics.avgTimeOnPage < 30) {
      gaps.push(`Low engagement (${metrics.avgTimeOnPage?.toFixed(0) || 0}s)`);
    }

    const prompt = `Generate ONE A/B test hypothesis for "${restaurant.name}" (${restaurant.cuisine_type}).

GAPS: ${gaps.join(', ') || 'None identified'}
PAST TESTS: ${JSON.stringify(pastExperiments)}

Return JSON only:
{
  "hypothesis": "...",
  "changeType": "cta|hero|layout|copy|color|menu",
  "variantPrompt": "Specific change instruction",
  "variantDescription": "Human description"
}`;

    try {
      const result = await this.model.generateContent(prompt);
      let response = result.response.text().trim();
      response = response.replace(/^```json\n?/i, '').replace(/\n?```$/i, '').trim();
      return JSON.parse(response);
    } catch (error) {
      console.error('Hypothesis generation failed:', error);
      return null;
    }
  }

  // ============ EXPERIMENT ACTIONS ============

  async applyWinner(restaurantId, experiment, treatment, analysis) {
    // Promote variant HTML to main (replaces original with winning variant)
    await this.websiteUpdater.promoteVariant(restaurantId, treatment.id);

    ExperimentModel.conclude(experiment.id, treatment.id);
    ExperimentModel.markApplied(experiment.id);

    // Update total revenue lift
    if (analysis?.revenue?.lift) {
      OptimizerStateModel.addRevenueLift(restaurantId, analysis.revenue.lift);
    }
  }

  async revertToControl(restaurantId, experiment) {
    const variants = VariantModel.getByExperiment(experiment.id);
    const treatment = variants.find(v => !v.isControl);
    const control = variants.find(v => v.isControl);

    // Delete variant HTML files (control/original remains untouched)
    if (treatment) {
      await this.websiteUpdater.deleteVariant(restaurantId, treatment.id);
    }

    ExperimentModel.conclude(experiment.id, control?.id);
  }

  // ============ METRICS & STATUS ============

  async getMetricsForHypothesis(restaurantId) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 14);

    const metrics = AnalyticsEventModel.getMetrics(restaurantId, {
      startDate: startDate.toISOString()
    });

    const pageviews = metrics.eventCounts.pageview || 0;
    const orders = metrics.eventCounts.order || 0;
    const cartAdds = metrics.eventCounts.cart_add || 0;

    return {
      hasEnoughData: pageviews >= 50,
      pageviews,
      uniqueSessions: metrics.uniqueSessions,
      orders,
      cartAdds,
      conversionRate: pageviews > 0 ? orders / pageviews : 0,
      cartToOrderRate: cartAdds > 0 ? orders / cartAdds : 0,
      addToCartRate: pageviews > 0 ? cartAdds / pageviews : 0,
      avgTimeOnPage: metrics.avgTimeOnPage,
      scrollDepths: metrics.scrollDepths
    };
  }

  getStatus(restaurantId) {
    const state = OptimizerStateModel.getOrCreate(restaurantId);
    const activeExperiment = ExperimentModel.getActive(restaurantId);
    const recentExperiments = ExperimentModel.getByRestaurant(restaurantId, { limit: 10 });
    const queueCount = ExperimentQueueModel.getCount(restaurantId);

    let activeDetails = null;
    if (activeExperiment) {
      const withVariants = ExperimentModel.getWithVariants(activeExperiment.id);
      const control = withVariants.variants.find(v => v.isControl);
      const treatment = withVariants.variants.find(v => !v.isControl);

      if (control && treatment) {
        const status = statisticalEngine.getExperimentStatus(
          { visitors: control.visitors, conversions: control.conversions },
          { visitors: treatment.visitors, conversions: treatment.conversions }
        );

        activeDetails = {
          id: activeExperiment.id,
          hypothesis: activeExperiment.hypothesis,
          changeType: activeExperiment.changeType,
          startedAt: activeExperiment.startedAt,
          control: {
            visitors: control.visitors,
            conversions: control.conversions,
            revenue: control.revenue,
            conversionRate: control.conversionRate,
            trafficAllocation: control.trafficAllocation
          },
          treatment: {
            visitors: treatment.visitors,
            conversions: treatment.conversions,
            revenue: treatment.revenue,
            conversionRate: treatment.conversionRate,
            trafficAllocation: treatment.trafficAllocation,
            description: treatment.changeDescription
          },
          status: status.status,
          message: status.message
        };
      }
    }

    return {
      enabled: state.enabled,
      experimentsThisWeek: state.experimentsThisWeek,
      maxExperimentsPerWeek: this.maxExperimentsPerWeek,
      totalExperiments: state.totalExperiments || 0,
      totalRevenueLift: state.totalRevenueLift || 0,
      lastOptimizationAt: state.lastOptimizationAt,
      learningsCount: state.learnings?.length || 0,
      queuedHypotheses: queueCount,
      activeExperiment: activeDetails,
      recentExperiments: recentExperiments.map(e => ({
        id: e.id,
        hypothesis: e.hypothesis,
        status: e.status,
        startedAt: e.startedAt,
        endedAt: e.endedAt
      }))
    };
  }

  getAnalytics(restaurantId, days = 14) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const metrics = AnalyticsEventModel.getMetrics(restaurantId, {
      startDate: startDate.toISOString()
    });

    const pageviews = metrics.eventCounts.pageview || 0;
    const orders = metrics.eventCounts.order || 0;
    const cartAdds = metrics.eventCounts.cart_add || 0;

    return {
      period: { days, startDate: startDate.toISOString() },
      pageviews,
      uniqueSessions: metrics.uniqueSessions,
      orders,
      cartAdds,
      clicks: metrics.eventCounts.click || 0,
      conversionRate: pageviews > 0 ? orders / pageviews : 0,
      addToCartRate: pageviews > 0 ? cartAdds / pageviews : 0,
      cartToOrderRate: cartAdds > 0 ? orders / cartAdds : 0,
      avgTimeOnPage: metrics.avgTimeOnPage,
      scrollDepths: metrics.scrollDepths
    };
  }
}

export const abOptimizer = new ABOptimizer();
