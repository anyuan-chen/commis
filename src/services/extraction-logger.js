import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';

/**
 * Structured logging for video extraction pipeline.
 * Captures prompts, responses, timing, and errors at each step.
 */
export class ExtractionLogger {
  constructor(runId = null) {
    this.runId = runId || uuidv4();
    this.startTime = Date.now();
    this.steps = [];
    this.metadata = {};
    this.status = 'running';
    this.error = null;
  }

  setMetadata(data) {
    this.metadata = { ...this.metadata, ...data };
  }

  /**
   * Start a new step and return a step tracker
   */
  startStep(name, details = {}) {
    const step = {
      id: uuidv4(),
      name,
      status: 'running',
      startTime: Date.now(),
      endTime: null,
      duration: null,
      input: details.input || null,
      prompt: details.prompt || null,
      model: details.model || null,
      output: null,
      error: null,
      warnings: [],
      metadata: details.metadata || {}
    };

    this.steps.push(step);

    return {
      setPrompt: (prompt) => {
        step.prompt = prompt;
      },
      setOutput: (output) => {
        step.output = output;
      },
      addWarning: (warning) => {
        step.warnings.push(warning);
      },
      complete: (output = null) => {
        step.status = 'completed';
        step.endTime = Date.now();
        step.duration = step.endTime - step.startTime;
        if (output !== null) step.output = output;
      },
      fail: (error) => {
        step.status = 'failed';
        step.endTime = Date.now();
        step.duration = step.endTime - step.startTime;
        step.error = error instanceof Error ? error.message : String(error);
      }
    };
  }

  /**
   * Mark the run as complete
   */
  complete(result = null) {
    this.status = 'completed';
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.result = result;

    // Assess quality if we have a result
    if (result) {
      this.quality = this.assessQuality(result);
    }
  }

  /**
   * Mark the run as failed
   */
  fail(error) {
    this.status = 'failed';
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.error = error instanceof Error ? error.message : String(error);
  }

  /**
   * Assess quality of extraction results
   */
  assessQuality(result) {
    const issues = [];
    const scores = {};

    // Menu quality
    const menuItems = result?.menuItems?.items || [];
    const menuCount = menuItems.length;
    const needsReviewCount = menuItems.filter(i => i.needsReview).length;
    const avgConfidence = menuCount > 0
      ? menuItems.reduce((sum, i) => sum + (i.confidence || 0), 0) / menuCount
      : 0;
    const itemsWithPrice = menuItems.filter(i => i.price != null).length;

    scores.menu = Math.min(1, menuCount / 5) * 0.4 +  // Expect at least 5 items
                  (1 - needsReviewCount / Math.max(menuCount, 1)) * 0.3 +
                  avgConfidence * 0.3;

    if (menuCount === 0) {
      issues.push({ type: 'critical', category: 'menu', message: 'No menu items found' });
    } else if (menuCount < 3) {
      issues.push({ type: 'warning', category: 'menu', message: `Only ${menuCount} menu items found` });
    }
    if (menuCount > 0 && needsReviewCount === menuCount) {
      issues.push({ type: 'warning', category: 'menu', message: 'All menu items need review' });
    }
    if (menuCount > 0 && avgConfidence < 0.6) {
      issues.push({ type: 'warning', category: 'menu', message: `Low average confidence: ${(avgConfidence * 100).toFixed(0)}%` });
    }
    if (menuCount > 0 && itemsWithPrice === 0) {
      issues.push({ type: 'warning', category: 'menu', message: 'No prices detected on any items' });
    }

    // Restaurant info quality
    const info = result?.restaurantInfo || {};
    const hasName = !!info.name;
    const nameConfidence = info.confidence?.name || 0;
    const hasCuisine = !!info.cuisineType && info.cuisineType !== 'Restaurant';
    const hasDescription = !!info.description && info.description.length > 20;

    scores.restaurantInfo = (hasName ? 0.4 : 0) +
                            (hasCuisine ? 0.3 : 0) +
                            (hasDescription ? 0.3 : 0);

    if (!hasName) {
      issues.push({ type: 'warning', category: 'info', message: 'Restaurant name not detected' });
    } else if (nameConfidence < 0.7) {
      issues.push({ type: 'warning', category: 'info', message: `Low confidence on restaurant name: ${(nameConfidence * 100).toFixed(0)}%` });
    }
    if (!hasCuisine) {
      issues.push({ type: 'warning', category: 'info', message: 'Cuisine type not identified' });
    }

    // Frames quality
    const frames = result?.frames || [];
    const frameTypes = new Set(frames.map(f => f.type));
    const hasFood = frameTypes.has('food');
    const hasExterior = frameTypes.has('exterior');
    const hasInterior = frameTypes.has('interior');
    const hasMenu = frameTypes.has('menu');
    const highPriorityFrames = frames.filter(f => f.priority === 'high').length;

    scores.frames = (frames.length >= 8 ? 0.3 : frames.length / 8 * 0.3) +
                    (hasFood ? 0.2 : 0) +
                    (hasExterior ? 0.15 : 0) +
                    (hasInterior ? 0.15 : 0) +
                    (highPriorityFrames >= 3 ? 0.2 : highPriorityFrames / 3 * 0.2);

    if (frames.length === 0) {
      issues.push({ type: 'critical', category: 'frames', message: 'No frames extracted' });
    } else if (frames.length < 5) {
      issues.push({ type: 'warning', category: 'frames', message: `Only ${frames.length} frames extracted` });
    }
    if (!hasFood) {
      issues.push({ type: 'warning', category: 'frames', message: 'No food photos detected' });
    }
    if (!hasExterior && !hasInterior) {
      issues.push({ type: 'warning', category: 'frames', message: 'No exterior or interior shots' });
    }

    // Style quality
    const style = result?.style || {};
    const isDefaultStyle = style.primaryColor === '#2563eb' && style.theme === 'modern';

    scores.style = isDefaultStyle ? 0.3 : 1;

    if (isDefaultStyle) {
      issues.push({ type: 'warning', category: 'style', message: 'Using default styling (no brand colors detected)' });
    }

    // Overall score
    const overall = (scores.menu * 0.35 + scores.restaurantInfo * 0.25 + scores.frames * 0.25 + scores.style * 0.15);

    // Quality rating
    let rating;
    if (issues.some(i => i.type === 'critical')) {
      rating = 'poor';
    } else if (overall >= 0.8 && issues.length === 0) {
      rating = 'good';
    } else if (overall >= 0.6) {
      rating = 'fair';
    } else {
      rating = 'poor';
    }

    return {
      rating,
      overall: parseFloat(overall.toFixed(2)),
      scores: {
        menu: parseFloat(scores.menu.toFixed(2)),
        restaurantInfo: parseFloat(scores.restaurantInfo.toFixed(2)),
        frames: parseFloat(scores.frames.toFixed(2)),
        style: parseFloat(scores.style.toFixed(2))
      },
      issues,
      summary: {
        menuItems: menuCount,
        menuNeedsReview: needsReviewCount,
        menuAvgConfidence: parseFloat(avgConfidence.toFixed(2)),
        framesExtracted: frames.length,
        frameTypes: [...frameTypes],
        hasRestaurantName: hasName,
        isDefaultStyle
      }
    };
  }

  /**
   * Get the full log object
   */
  toJSON() {
    return {
      runId: this.runId,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.duration,
      metadata: this.metadata,
      steps: this.steps,
      result: this.result,
      quality: this.quality,
      error: this.error
    };
  }

  /**
   * Save log to disk
   */
  async save() {
    const logsDir = join(config.paths.output, 'extraction-logs');
    await fs.mkdir(logsDir, { recursive: true });

    const filename = `${this.runId}.json`;
    const filepath = join(logsDir, filename);

    await fs.writeFile(filepath, JSON.stringify(this.toJSON(), null, 2));

    // Also update the index
    await this.updateIndex(logsDir);

    return filepath;
  }

  /**
   * Update the runs index file
   */
  async updateIndex(logsDir) {
    const indexPath = join(logsDir, 'index.json');

    let index = [];
    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      index = JSON.parse(data);
    } catch {
      // Index doesn't exist yet
    }

    // Remove existing entry for this run if present
    index = index.filter(r => r.runId !== this.runId);

    // Add current run summary
    index.unshift({
      runId: this.runId,
      status: this.status,
      startTime: this.startTime,
      duration: this.duration,
      videoPath: this.metadata.videoPath,
      stepCount: this.steps.length,
      failedSteps: this.steps.filter(s => s.status === 'failed').length,
      quality: this.quality ? {
        rating: this.quality.rating,
        overall: this.quality.overall,
        issueCount: this.quality.issues.length
      } : null,
      error: this.error
    });

    // Keep only last 100 runs
    index = index.slice(0, 100);

    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * Load a run from disk
   */
  static async load(runId) {
    const logsDir = join(config.paths.output, 'extraction-logs');
    const filepath = join(logsDir, `${runId}.json`);
    const data = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(data);
  }

  /**
   * List all runs
   */
  static async listRuns() {
    const logsDir = join(config.paths.output, 'extraction-logs');
    const indexPath = join(logsDir, 'index.json');

    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}
