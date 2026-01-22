import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { config } from '../config.js';
import { VideoProcessor } from './video-processor.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class ClipSelector {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3.0-flash-preview' });
  }

  /**
   * Check if a single frame contains cooking-related content
   * @param {string} framePath - Path to frame image
   * @returns {Promise<{isCooking: boolean, confidence: number, description: string}>}
   */
  async checkCookingContent(framePath) {
    const imageData = await fs.readFile(framePath);
    const base64Image = imageData.toString('base64');
    const mimeType = framePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `Analyze this image and determine if it shows cooking-related content.

Look for:
- Food being prepared, cooked, or served
- Kitchen equipment (stove, pots, pans, cutting boards, knives)
- Ingredients being chopped, mixed, or processed
- A person cooking or preparing food
- A finished dish or meal

Return JSON only:
{
  "isCooking": true/false,
  "confidence": 0.0-1.0,
  "description": "brief description of what you see"
}`;

    const result = await this.model.generateContent([
      { inlineData: { mimeType, data: base64Image } },
      prompt
    ]);

    const text = result.response.text();
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return { isCooking: false, confidence: 0, description: 'Failed to analyze' };
    }
  }

  /**
   * Score frames for visual appeal, action, and composition
   * @param {string[]} framePaths - Array of frame paths
   * @param {number[]} timestamps - Corresponding timestamps
   * @returns {Promise<Array<{timestamp: number, score: number, features: object}>>}
   */
  async scoreFrames(framePaths, timestamps) {
    const scores = [];
    const batchSize = 10; // Process in batches to avoid token limits

    for (let i = 0; i < framePaths.length; i += batchSize) {
      const batch = framePaths.slice(i, i + batchSize);
      const batchTimestamps = timestamps.slice(i, i + batchSize);
      const batchScores = await this._scoreBatch(batch, batchTimestamps);
      scores.push(...batchScores);
    }

    return scores;
  }

  async _scoreBatch(framePaths, timestamps) {
    const imageParts = await Promise.all(
      framePaths.map(async (path) => {
        const data = await fs.readFile(path);
        return {
          inlineData: {
            mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
            data: data.toString('base64')
          }
        };
      })
    );

    const prompt = `Analyze these ${framePaths.length} cooking video frames and score each for Shorts potential.

For each frame (in order), evaluate:
1. Visual Appeal (0-10): Is this visually interesting? Good lighting, colors, composition?
2. Action Level (0-10): Is something happening? Movement, cooking action, transformation?
3. Narrative Value (0-10): Could this be part of a story? Setup, climax, or resolution moment?

Return JSON array in order:
[
  {
    "frameIndex": 0,
    "timestamp": ${timestamps[0]},
    "visualAppeal": 8,
    "actionLevel": 7,
    "narrativeValue": 6,
    "overallScore": 7.0,
    "isHighlight": true/false,
    "description": "brief description"
  },
  ...
]

Only return the JSON array, no other text.`;

    const result = await this.model.generateContent([...imageParts, prompt]);
    const text = result.response.text();

    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      // Ensure timestamps are correct
      return parsed.map((item, idx) => ({
        ...item,
        timestamp: timestamps[idx] ?? item.timestamp
      }));
    } catch {
      // Fallback: return default scores
      return timestamps.map((timestamp, idx) => ({
        frameIndex: idx,
        timestamp,
        visualAppeal: 5,
        actionLevel: 5,
        narrativeValue: 5,
        overallScore: 5,
        isHighlight: false,
        description: 'Analysis failed'
      }));
    }
  }

  /**
   * Find the best contiguous clip for a Short
   * @param {Array} frameScores - Scored frames from scoreFrames()
   * @param {object} options - Selection options
   * @returns {{startTime: number, endTime: number, score: number, highlights: Array}}
   */
  findBestClip(frameScores, options = {}) {
    const {
      minDuration = 15, // Minimum 15 seconds
      maxDuration = 60, // Maximum 60 seconds
      targetDuration = 30, // Prefer around 30 seconds
      frameInterval = 1 // Seconds between frames
    } = options;

    // Handle empty or very short videos
    if (!frameScores || frameScores.length === 0) {
      return {
        startTime: 0,
        endTime: minDuration,
        score: 0,
        highlights: [],
        frameAnalysis: []
      };
    }

    const minFrames = Math.ceil(minDuration / frameInterval);
    const maxFrames = Math.ceil(maxDuration / frameInterval);

    let bestWindow = null;
    let bestScore = -Infinity;

    // If video is shorter than minDuration, use whole video
    if (frameScores.length < minFrames) {
      return {
        startTime: frameScores[0].timestamp,
        endTime: frameScores[frameScores.length - 1].timestamp + frameInterval,
        score: 0,
        highlights: frameScores.filter(f => f.isHighlight).map(f => f.timestamp),
        frameAnalysis: frameScores
      };
    }

    // Sliding window approach
    for (let windowSize = minFrames; windowSize <= maxFrames; windowSize++) {
      for (let start = 0; start <= frameScores.length - windowSize; start++) {
        const window = frameScores.slice(start, start + windowSize);
        const score = this._calculateWindowScore(window, targetDuration, frameInterval);

        if (score > bestScore) {
          bestScore = score;
          bestWindow = {
            startIndex: start,
            endIndex: start + windowSize - 1,
            frames: window
          };
        }
      }
    }

    if (!bestWindow) {
      // Fallback: use the whole video or first maxDuration seconds
      const endIdx = Math.min(frameScores.length - 1, maxFrames - 1);
      return {
        startTime: frameScores[0]?.timestamp || 0,
        endTime: frameScores[endIdx]?.timestamp + frameInterval || maxDuration,
        score: 0,
        highlights: [],
        frameAnalysis: frameScores.slice(0, endIdx + 1)
      };
    }

    const highlights = bestWindow.frames
      .filter(f => f.isHighlight || f.overallScore >= 7)
      .map(f => f.timestamp);

    return {
      startTime: frameScores[bestWindow.startIndex].timestamp,
      endTime: frameScores[bestWindow.endIndex].timestamp + frameInterval,
      score: bestScore,
      highlights,
      frameAnalysis: bestWindow.frames
    };
  }

  _calculateWindowScore(frames, targetDuration, frameInterval) {
    // Average visual quality
    const avgVisual = frames.reduce((sum, f) => sum + f.visualAppeal, 0) / frames.length;

    // Average action level
    const avgAction = frames.reduce((sum, f) => sum + f.actionLevel, 0) / frames.length;

    // Narrative arc bonus: look for buildup to payoff
    const narrativeArc = this._calculateNarrativeArc(frames);

    // Duration preference: prefer clips closer to target
    const duration = frames.length * frameInterval;
    const durationScore = 10 - Math.abs(duration - targetDuration) * 0.2;

    // Highlight density: prefer clips with highlight moments
    const highlightDensity = frames.filter(f => f.isHighlight).length / frames.length;

    // Combined score with weights
    return (
      avgVisual * 0.25 +
      avgAction * 0.25 +
      narrativeArc * 0.2 +
      durationScore * 0.15 +
      highlightDensity * 10 * 0.15
    );
  }

  _calculateNarrativeArc(frames) {
    // Look for buildup (increasing action) followed by payoff (high point)
    // Then optional resolution (calming down)

    if (frames.length < 5) return 5; // Too short to evaluate

    const third = Math.floor(frames.length / 3);
    const firstThird = frames.slice(0, third);
    const middleThird = frames.slice(third, third * 2);
    const lastThird = frames.slice(third * 2);

    const avgFirst = firstThird.reduce((sum, f) => sum + f.actionLevel, 0) / firstThird.length;
    const avgMiddle = middleThird.reduce((sum, f) => sum + f.actionLevel, 0) / middleThird.length;
    const avgLast = lastThird.reduce((sum, f) => sum + f.actionLevel, 0) / lastThird.length;

    // Ideal: buildup in first third, peak in middle, resolution in last
    // Or: steady buildup to climax at end
    let arcScore = 5;

    if (avgMiddle > avgFirst && avgMiddle >= avgLast) {
      // Classic arc: buildup → climax → resolution
      arcScore = 8 + (avgMiddle - avgFirst) * 0.5;
    } else if (avgLast > avgMiddle && avgMiddle > avgFirst) {
      // Rising action: buildup → climax at end
      arcScore = 7 + (avgLast - avgFirst) * 0.3;
    }

    return Math.min(10, arcScore);
  }

  /**
   * Full analysis pipeline: extract frames, score, and find best clip
   * @param {string} videoPath - Path to video file
   * @param {object} options - Analysis options
   * @returns {Promise<{startTime: number, endTime: number, score: number, ...}>}
   */
  async analyzeAndSelectClip(videoPath, options = {}) {
    // Extract frames at 1-second intervals
    const { paths, timestamps, duration } = await VideoProcessor.extractFramesForAnalysis(videoPath, {
      interval: options.frameInterval || 1
    });

    // Score all frames
    const frameScores = await this.scoreFrames(paths, timestamps);

    // Find best clip
    const bestClip = this.findBestClip(frameScores, {
      ...options,
      frameInterval: options.frameInterval || 1
    });

    // Clean up temporary frames
    if (!options.keepFrames) {
      const framesDir = paths[0]?.split('/').slice(0, -1).join('/');
      if (framesDir) {
        await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    return {
      ...bestClip,
      videoDuration: duration,
      framesAnalyzed: paths.length
    };
  }
}
