import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { promises as fs } from 'fs';
import { config } from '../config.js';
import { VideoProcessor } from './video-processor.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const fileManager = new GoogleAIFileManager(config.geminiApiKey);

export class ClipSelector {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  /**
   * Check if a single frame contains cooking-related content
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
   * Upload video to Gemini File API and analyze with native video understanding
   */
  async analyzeAndSelectClip(videoPath, options = {}) {
    const {
      minDuration = 15,
      maxDuration = 60,
      targetDuration = 30
    } = options;

    // Get video metadata first
    const metadata = await VideoProcessor.getMetadata(videoPath);
    const videoDuration = metadata.duration;

    // Upload video to Gemini File API
    console.log('Uploading video to Gemini...');
    const uploadResult = await fileManager.uploadFile(videoPath, {
      mimeType: this._getMimeType(videoPath),
      displayName: 'cooking-video'
    });

    // Wait for file to be processed
    let file = uploadResult.file;
    while (file.state === 'PROCESSING') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      file = await fileManager.getFile(file.name);
    }

    if (file.state === 'FAILED') {
      throw new Error('Video processing failed');
    }

    console.log('Video uploaded, analyzing...');

    // Analyze with native video understanding
    const prompt = `You are analyzing a cooking video to find the best segment for a YouTube Short.

VIDEO DURATION: ${videoDuration.toFixed(1)} seconds

TASK: Find the single best ${minDuration}-${maxDuration} second segment that would make an engaging YouTube Short.

Consider:
1. HOOK: The segment should start with something visually interesting (not a static shot)
2. ACTION: Prioritize moments with cooking action (chopping, sizzling, plating, etc.)
3. NARRATIVE: Ideally has a mini arc - setup, action, payoff (like: raw ingredients → cooking → finished dish)
4. VISUAL APPEAL: Good lighting, colors, composition
5. PACING: Enough variety to keep viewers engaged

Return JSON only:
{
  "startTime": <seconds as number>,
  "endTime": <seconds as number>,
  "duration": <seconds as number>,
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation of why this segment>",
  "highlights": [<list of notable timestamps within the segment>],
  "hookDescription": "<what happens in the first 3 seconds>",
  "mainAction": "<the key cooking action in this segment>",
  "payoff": "<the satisfying conclusion, if any>"
}

IMPORTANT:
- startTime must be >= 0
- endTime must be <= ${videoDuration.toFixed(1)}
- duration must be between ${minDuration} and ${maxDuration} seconds
- Prefer segments closer to ${targetDuration} seconds if multiple good options exist`;

    const result = await this.model.generateContent([
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri
        }
      },
      prompt
    ]);

    const text = result.response.text();

    // Clean up uploaded file
    await fileManager.deleteFile(file.name).catch(() => {});

    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analysis = JSON.parse(cleaned);

      // Validate and clamp values
      const startTime = Math.max(0, analysis.startTime || 0);
      const endTime = Math.min(videoDuration, analysis.endTime || targetDuration);
      const duration = endTime - startTime;

      // If duration is outside bounds, adjust
      let finalStart = startTime;
      let finalEnd = endTime;

      if (duration < minDuration) {
        // Extend to minimum duration
        const needed = minDuration - duration;
        finalEnd = Math.min(videoDuration, finalEnd + needed);
        if (finalEnd - finalStart < minDuration) {
          finalStart = Math.max(0, finalEnd - minDuration);
        }
      } else if (duration > maxDuration) {
        // Trim to maximum duration
        finalEnd = finalStart + maxDuration;
      }

      return {
        startTime: finalStart,
        endTime: finalEnd,
        duration: finalEnd - finalStart,
        confidence: analysis.confidence || 0.8,
        reasoning: analysis.reasoning || '',
        highlights: analysis.highlights || [],
        hookDescription: analysis.hookDescription || '',
        mainAction: analysis.mainAction || '',
        payoff: analysis.payoff || '',
        videoDuration
      };
    } catch (err) {
      console.error('Failed to parse clip analysis:', text);

      // Fallback: use first portion of video
      const fallbackDuration = Math.min(targetDuration, videoDuration);
      return {
        startTime: 0,
        endTime: fallbackDuration,
        duration: fallbackDuration,
        confidence: 0,
        reasoning: 'Fallback - analysis failed',
        highlights: [],
        hookDescription: '',
        mainAction: '',
        payoff: '',
        videoDuration
      };
    }
  }

  _getMimeType(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeTypes = {
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'webm': 'video/webm',
      'mkv': 'video/x-matroska'
    };
    return mimeTypes[ext] || 'video/mp4';
  }
}
