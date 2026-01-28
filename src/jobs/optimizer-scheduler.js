import { OptimizerStateModel, AnalyticsEventModel } from '../db/models/index.js';
import { abOptimizer } from '../services/ab-optimizer.js';
import db from '../db/database.js';

const OPTIMIZE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const WEEKLY_RESET_CHECK_MS = 60 * 60 * 1000; // 1 hour
const EVENTS_RETENTION_DAYS = 90;

let optimizeIntervalId = null;
let cleanupIntervalId = null;
let weeklyResetIntervalId = null;

/**
 * Run optimization cycle for all enabled restaurants
 */
async function runOptimizationCycle() {
  console.log('[OptimizerScheduler] Starting optimization cycle...');

  try {
    // Get all enabled optimizers
    const enabledStates = OptimizerStateModel.getAllEnabled();
    console.log(`[OptimizerScheduler] Found ${enabledStates.length} enabled optimizers`);

    for (const state of enabledStates) {
      try {
        console.log(`[OptimizerScheduler] Optimizing restaurant ${state.restaurantId}...`);
        const result = await abOptimizer.optimize(state.restaurantId);

        if (result.action) {
          console.log(`[OptimizerScheduler] ${state.restaurantId}: ${result.action} - ${result.message || JSON.stringify(result)}`);
        } else if (result.skipped) {
          console.log(`[OptimizerScheduler] ${state.restaurantId}: Skipped - ${result.reason}`);
        } else if (result.error) {
          console.error(`[OptimizerScheduler] ${state.restaurantId}: Error - ${result.error}`);
        }
      } catch (error) {
        console.error(`[OptimizerScheduler] Error optimizing ${state.restaurantId}:`, error.message);
      }

      // Small delay between restaurants to avoid overloading
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('[OptimizerScheduler] Optimization cycle complete');
  } catch (error) {
    console.error('[OptimizerScheduler] Error in optimization cycle:', error);
  }
}

/**
 * Clean up old analytics events
 */
async function cleanupOldEvents() {
  console.log('[OptimizerScheduler] Starting event cleanup...');

  try {
    const deleted = AnalyticsEventModel.purgeOlderThan(EVENTS_RETENTION_DAYS);
    console.log(`[OptimizerScheduler] Purged ${deleted} events older than ${EVENTS_RETENTION_DAYS} days`);
  } catch (error) {
    console.error('[OptimizerScheduler] Error in cleanup:', error);
  }
}

/**
 * Check for weekly reset (Sunday midnight)
 */
async function checkWeeklyReset() {
  const now = new Date();

  // Sunday (0) at midnight hour (0)
  if (now.getDay() === 0 && now.getHours() === 0) {
    console.log('[OptimizerScheduler] Weekly reset - resetting experiment counts');

    try {
      OptimizerStateModel.resetWeeklyCounts();
      console.log('[OptimizerScheduler] Weekly counts reset complete');
    } catch (error) {
      console.error('[OptimizerScheduler] Error in weekly reset:', error);
    }
  }
}

/**
 * Start the optimizer scheduler
 */
export function startOptimizerScheduler() {
  console.log('[OptimizerScheduler] Starting scheduler...');
  console.log(`[OptimizerScheduler] Optimization interval: ${OPTIMIZE_INTERVAL_MS / 1000 / 60 / 60} hours`);
  console.log(`[OptimizerScheduler] Cleanup interval: ${CLEANUP_INTERVAL_MS / 1000 / 60 / 60} hours`);

  // Run initial optimization after a short delay
  setTimeout(() => {
    runOptimizationCycle();
  }, 30000); // 30 seconds after startup

  // Schedule periodic optimization
  optimizeIntervalId = setInterval(runOptimizationCycle, OPTIMIZE_INTERVAL_MS);

  // Schedule daily cleanup
  cleanupIntervalId = setInterval(cleanupOldEvents, CLEANUP_INTERVAL_MS);

  // Schedule weekly reset check
  weeklyResetIntervalId = setInterval(checkWeeklyReset, WEEKLY_RESET_CHECK_MS);

  return {
    stop: stopOptimizerScheduler
  };
}

/**
 * Stop the optimizer scheduler
 */
export function stopOptimizerScheduler() {
  console.log('[OptimizerScheduler] Stopping scheduler...');

  if (optimizeIntervalId) {
    clearInterval(optimizeIntervalId);
    optimizeIntervalId = null;
  }

  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  if (weeklyResetIntervalId) {
    clearInterval(weeklyResetIntervalId);
    weeklyResetIntervalId = null;
  }
}

/**
 * Manually trigger an optimization cycle (for testing)
 */
export async function triggerOptimization() {
  return runOptimizationCycle();
}

/**
 * Manually trigger cleanup (for testing)
 */
export async function triggerCleanup() {
  return cleanupOldEvents();
}

/**
 * Optimize a single restaurant (for manual triggering)
 */
export async function optimizeRestaurant(restaurantId) {
  console.log(`[OptimizerScheduler] Manual optimization for ${restaurantId}`);
  return abOptimizer.optimize(restaurantId);
}
