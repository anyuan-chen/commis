import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { VideoProcessor } from './video-processor.js';
import { ExtractionLogger } from './extraction-logger.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/**
 * Native video understanding extractor for restaurant data.
 * Uses Gemini's native video capabilities instead of frame-based extraction.
 */
export class VideoExtractor {
  constructor() {
    this.proModel = genAI.getGenerativeModel({ model: 'gemini-3-pro-preview' });
    this.flashModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    this.fileManager = new GoogleAIFileManager(config.geminiApiKey);
    this.logger = null;
  }

  /**
   * Main extraction method - uploads video and runs multi-prompt analysis
   */
  async extract(videoPath, options = {}) {
    // Initialize logger for this run
    this.logger = new ExtractionLogger();
    this.logger.setMetadata({
      videoPath,
      options,
      models: {
        pro: 'gemini-3-pro-preview',
        flash: 'gemini-3-flash-preview'
      }
    });

    let file = null;
    try {
      // Upload video to Gemini File API
      file = await this.uploadVideo(videoPath);

      // Get metadata
      const metadataStep = this.logger.startStep('get_metadata', { input: videoPath });
      let metadata;
      try {
        metadata = await VideoProcessor.getMetadata(videoPath);
        metadataStep.complete(metadata);
      } catch (err) {
        metadataStep.fail(err);
        throw err;
      }

      this.logger.setMetadata({ videoDuration: metadata.duration, videoSize: metadata.size });

      // Run Pro model extractions in parallel
      const [frames, menuResult, info] = await Promise.all([
        this.selectKeyFrames(file, metadata.duration),
        this.extractMenuTwoPass(file),
        this.extractRestaurantInfo(file)
      ]);

      // Run Flash model for style (cheaper, faster)
      const style = await this.extractStyle(file, info);

      // Extract actual images from timestamps
      const outputDir = options.outputDir || join(config.paths.images, uuidv4());
      const extractedFrames = await this.extractFramesFromTimestamps(
        videoPath, frames, outputDir
      );

      const result = {
        frames: extractedFrames,
        menuItems: menuResult,
        restaurantInfo: info,
        style
      };

      this.logger.complete(result);
      await this.logger.save();

      return result;
    } catch (err) {
      this.logger.fail(err);
      await this.logger.save();
      throw err;
    } finally {
      if (file) {
        await this.cleanup(file).catch(() => {});
      }
    }
  }

  /**
   * Get the current run ID (for tracking)
   */
  getRunId() {
    return this.logger?.runId;
  }

  /**
   * Upload video to Gemini File API and wait for processing
   */
  async uploadVideo(videoPath) {
    const step = this.logger.startStep('upload_video', {
      input: videoPath,
      metadata: { mimeType: this._getMimeType(videoPath) }
    });

    try {
      console.log('Uploading video to Gemini File API...');

      const uploadResult = await this.fileManager.uploadFile(videoPath, {
        mimeType: this._getMimeType(videoPath),
        displayName: 'restaurant-video'
      });

      let file = uploadResult.file;
      let pollCount = 0;
      while (file.state === 'PROCESSING') {
        pollCount++;
        await new Promise(resolve => setTimeout(resolve, 2000));
        file = await this.fileManager.getFile(file.name);
      }

      if (file.state === 'FAILED') {
        throw new Error('Video processing failed in Gemini File API');
      }

      console.log('Video uploaded successfully');
      step.complete({
        fileName: file.name,
        fileUri: file.uri,
        mimeType: file.mimeType,
        state: file.state,
        pollCount
      });

      return file;
    } catch (err) {
      step.fail(err);
      throw err;
    }
  }

  /**
   * Select key frames for photos (Pro model for accuracy)
   */
  async selectKeyFrames(file, duration) {
    const prompt = `You are analyzing a restaurant walkthrough video to select the best frames for a website.

VIDEO DURATION: ${duration.toFixed(1)} seconds

TASK: Identify 10-15 key moments that would make great photos for a restaurant website.

For each frame, identify:
1. TYPE: exterior | interior | food | menu | signage | ambiance | staff | kitchen
2. TIMESTAMP: The exact second in the video
3. DESCRIPTION: What makes this frame good

PRIORITIZE:
- Sharp, well-lit shots (avoid motion blur)
- Appetizing food close-ups
- Inviting interior/exterior views
- Clear menu/signage shots
- Unique or signature elements

Return JSON only:
{
  "frames": [
    {
      "timestamp": <seconds as number>,
      "type": "<frame type>",
      "description": "<why this frame is good>",
      "priority": "high" | "medium" | "low"
    }
  ]
}

IMPORTANT:
- Timestamps must be between 0 and ${duration.toFixed(1)}
- Include at least one of each type if visible in video
- Prioritize variety over quantity`;

    const step = this.logger.startStep('select_key_frames', {
      model: 'gemini-3-pro-preview',
      prompt,
      input: { fileUri: file.uri, duration }
    });

    try {
      const result = await this.proModel.generateContent([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        },
        prompt
      ]);

      const text = result.response.text();
      step.setOutput({ rawResponse: text });

      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        const frames = parsed.frames || [];
        step.complete({
          rawResponse: text,
          parsedFrames: frames,
          frameCount: frames.length,
          frameTypes: [...new Set(frames.map(f => f.type))]
        });
        return frames;
      } catch (parseErr) {
        step.addWarning(`JSON parse failed: ${parseErr.message}`);
        console.error('Failed to parse frame selection:', text);
        // Fallback: return evenly spaced timestamps
        const frameCount = 10;
        const interval = duration / (frameCount + 1);
        const fallbackFrames = Array.from({ length: frameCount }, (_, i) => ({
          timestamp: interval * (i + 1),
          type: 'unknown',
          description: 'Auto-selected frame',
          priority: 'medium'
        }));
        step.complete({
          rawResponse: text,
          parseError: parseErr.message,
          usedFallback: true,
          parsedFrames: fallbackFrames
        });
        return fallbackFrames;
      }
    } catch (err) {
      step.fail(err);
      throw err;
    }
  }

  /**
   * Two-pass menu extraction (Pro model for accuracy)
   */
  async extractMenuTwoPass(file) {
    // Pass 1: Extract all visible menu items
    const pass1Prompt = `You are analyzing a restaurant video to extract menu information.

TASK: Find ALL menu items visible in this video. Look carefully at:
- Physical menus (printed, chalkboard, digital displays)
- Menu boards on walls
- Food being prepared or served
- Plates with visible dishes

For each item found, extract:
- name: The dish name exactly as shown/heard
- description: Any description visible or inferable
- category: Appetizers | Mains | Desserts | Drinks | Sides | Specials
- price: The price if visible (null if not)
- dietaryTags: Any visible dietary indicators [vegetarian, vegan, gluten-free, spicy, etc.]
- source: Where you saw this (menu board, printed menu, plate, etc.)
- timestamp: When in the video you saw this

Return JSON only:
{
  "items": [
    {
      "name": "string",
      "description": "string or null",
      "category": "string",
      "price": number or null,
      "dietaryTags": ["string"],
      "source": "string",
      "timestamp": number
    }
  ],
  "menuStyleNotes": "Description of how menus are displayed in this restaurant"
}`;

    const pass1Step = this.logger.startStep('menu_extraction_pass1', {
      model: 'gemini-3-pro-preview',
      prompt: pass1Prompt,
      input: { fileUri: file.uri }
    });

    let items = [];
    let menuStyleNotes = '';

    try {
      const pass1Result = await this.proModel.generateContent([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        },
        pass1Prompt
      ]);

      const text1 = pass1Result.response.text();

      try {
        const cleaned1 = text1.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed1 = JSON.parse(cleaned1);
        items = parsed1.items || [];
        menuStyleNotes = parsed1.menuStyleNotes || '';
        pass1Step.complete({
          rawResponse: text1,
          itemCount: items.length,
          categories: [...new Set(items.map(i => i.category))],
          menuStyleNotes
        });
      } catch (parseErr) {
        pass1Step.addWarning(`JSON parse failed: ${parseErr.message}`);
        pass1Step.complete({ rawResponse: text1, parseError: parseErr.message });
        console.error('Pass 1 menu extraction failed:', parseErr);
        return { items: [], verified: false };
      }
    } catch (err) {
      pass1Step.fail(err);
      throw err;
    }

    if (items.length === 0) {
      return { items: [], verified: true, menuStyleNotes };
    }

    // Pass 2: Verify items and add confidence scores
    const pass2Prompt = `You previously extracted these menu items from a restaurant video:

${JSON.stringify(items, null, 2)}

TASK: Verify each item by reviewing the video again. For each item:
1. Confirm it actually exists in the video
2. Correct any spelling or detail errors
3. Add a confidence score (0.0-1.0) based on how clearly you can see/read it
4. Flag items that need human review

Also look for any items you may have missed in the first pass.

Return JSON only:
{
  "items": [
    {
      "name": "string",
      "description": "string or null",
      "category": "string",
      "price": number or null,
      "dietaryTags": ["string"],
      "confidence": number (0.0-1.0),
      "needsReview": boolean
    }
  ]
}

Set needsReview: true if:
- Name is partially obscured or unclear
- Price is hard to read
- You're not confident about the category
- The item might be a special/seasonal item`;

    const pass2Step = this.logger.startStep('menu_extraction_pass2', {
      model: 'gemini-3-pro-preview',
      prompt: pass2Prompt,
      input: { fileUri: file.uri, pass1ItemCount: items.length }
    });

    try {
      const pass2Result = await this.proModel.generateContent([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        },
        pass2Prompt
      ]);

      const text2 = pass2Result.response.text();

      try {
        const cleaned2 = text2.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed2 = JSON.parse(cleaned2);
        const verifiedItems = parsed2.items || [];

        const needsReviewCount = verifiedItems.filter(i => i.needsReview).length;
        const avgConfidence = verifiedItems.length > 0
          ? verifiedItems.reduce((sum, i) => sum + (i.confidence || 0), 0) / verifiedItems.length
          : 0;

        pass2Step.complete({
          rawResponse: text2,
          itemCount: verifiedItems.length,
          needsReviewCount,
          avgConfidence: avgConfidence.toFixed(2),
          itemsAdded: verifiedItems.length - items.length,
          itemsRemoved: items.length - verifiedItems.length
        });

        return {
          items: verifiedItems,
          verified: true,
          menuStyleNotes
        };
      } catch (parseErr) {
        pass2Step.addWarning(`JSON parse failed: ${parseErr.message}`);
        pass2Step.complete({
          rawResponse: text2,
          parseError: parseErr.message,
          usedPass1Fallback: true
        });
        console.error('Pass 2 menu verification failed:', parseErr);
        // Return pass 1 items with default confidence
        return {
          items: items.map(item => ({
            ...item,
            confidence: 0.7,
            needsReview: true
          })),
          verified: false,
          menuStyleNotes
        };
      }
    } catch (err) {
      pass2Step.fail(err);
      // Return pass 1 items on failure
      return {
        items: items.map(item => ({
          ...item,
          confidence: 0.7,
          needsReview: true
        })),
        verified: false,
        menuStyleNotes
      };
    }
  }

  /**
   * Extract restaurant info (Pro model for accuracy)
   */
  async extractRestaurantInfo(file) {
    const prompt = `Analyze this restaurant video and extract key information.

TASK: Identify restaurant details visible or inferable from the video.

Return JSON only:
{
  "name": "Restaurant name if visible on signage (null if not visible)",
  "cuisineType": "The type of cuisine (Italian, Mexican, Asian Fusion, etc.)",
  "description": "A 2-3 sentence description of the restaurant vibe and offerings",
  "tagline": "A catchy one-liner for the restaurant (generate if not visible)",
  "ambiance": "casual | fine-dining | fast-casual | cafe | bar | family",
  "priceRange": "$ | $$ | $$$ | $$$$",
  "features": ["outdoor seating", "bar", "private dining", etc.],
  "confidence": {
    "name": 0.0-1.0,
    "cuisineType": 0.0-1.0,
    "description": 0.0-1.0
  }
}`;

    const step = this.logger.startStep('extract_restaurant_info', {
      model: 'gemini-3-pro-preview',
      prompt,
      input: { fileUri: file.uri }
    });

    try {
      const result = await this.proModel.generateContent([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        },
        prompt
      ]);

      const text = result.response.text();

      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        step.complete({
          rawResponse: text,
          parsed,
          hasName: !!parsed.name,
          cuisineType: parsed.cuisineType,
          ambiance: parsed.ambiance
        });
        return parsed;
      } catch (parseErr) {
        step.addWarning(`JSON parse failed: ${parseErr.message}`);
        const fallback = {
          name: null,
          cuisineType: 'Restaurant',
          description: 'A local restaurant.',
          tagline: 'Great food, great experience.',
          ambiance: 'casual',
          priceRange: '$$',
          features: [],
          confidence: { name: 0, cuisineType: 0.5, description: 0.5 }
        };
        step.complete({
          rawResponse: text,
          parseError: parseErr.message,
          usedFallback: true,
          parsed: fallback
        });
        console.error('Failed to parse restaurant info:', text);
        return fallback;
      }
    } catch (err) {
      step.fail(err);
      throw err;
    }
  }

  /**
   * Extract style/brand info (Flash model - cheaper, faster)
   */
  async extractStyle(file, restaurantInfo) {
    const prompt = `Analyze this restaurant video for visual branding and style.

Restaurant context: ${restaurantInfo.cuisineType || 'Restaurant'} - ${restaurantInfo.ambiance || 'casual'}

TASK: Determine the visual style for this restaurant's website.

Return JSON only:
{
  "theme": "modern" | "rustic" | "elegant" | "vibrant" | "minimalist" | "traditional",
  "primaryColor": "#hexcode (dominant brand color you see)",
  "secondaryColor": "#hexcode (accent color)",
  "mood": "warm" | "cool" | "neutral",
  "fontStyle": "serif" | "sans-serif" | "display",
  "designNotes": "Brief notes on the restaurant's visual identity"
}`;

    const step = this.logger.startStep('extract_style', {
      model: 'gemini-3-flash-preview',
      prompt,
      input: { fileUri: file.uri, restaurantContext: restaurantInfo.cuisineType }
    });

    try {
      const result = await this.flashModel.generateContent([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        },
        prompt
      ]);

      const text = result.response.text();

      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        step.complete({
          rawResponse: text,
          parsed,
          theme: parsed.theme,
          primaryColor: parsed.primaryColor
        });
        return parsed;
      } catch (parseErr) {
        step.addWarning(`JSON parse failed: ${parseErr.message}`);
        const fallback = {
          theme: 'modern',
          primaryColor: '#2563eb',
          secondaryColor: '#f59e0b',
          mood: 'warm',
          fontStyle: 'sans-serif',
          designNotes: 'Default styling applied'
        };
        step.complete({
          rawResponse: text,
          parseError: parseErr.message,
          usedFallback: true,
          parsed: fallback
        });
        console.error('Failed to parse style info:', text);
        return fallback;
      }
    } catch (err) {
      step.fail(err);
      throw err;
    }
  }

  /**
   * Extract frames at the selected timestamps
   */
  async extractFramesFromTimestamps(videoPath, frames, outputDir) {
    const step = this.logger.startStep('extract_frames', {
      input: { videoPath, outputDir, frameCount: frames.length }
    });

    try {
      await fs.mkdir(outputDir, { recursive: true });

      const extractedFrames = [];
      const failures = [];

      for (const frame of frames) {
        try {
          const filename = `${frame.type}_${frame.timestamp.toFixed(1).replace('.', '_')}.jpg`;
          const outputPath = join(outputDir, filename);

          await VideoProcessor.extractFrameAt(videoPath, frame.timestamp, outputPath);

          extractedFrames.push({
            path: outputPath,
            type: frame.type,
            description: frame.description,
            priority: frame.priority,
            timestamp: frame.timestamp
          });
        } catch (err) {
          failures.push({ timestamp: frame.timestamp, type: frame.type, error: err.message });
          console.warn(`Failed to extract frame at ${frame.timestamp}s:`, err.message);
        }
      }

      step.complete({
        requestedFrames: frames.length,
        extractedFrames: extractedFrames.length,
        failures,
        frameTypes: [...new Set(extractedFrames.map(f => f.type))]
      });

      return extractedFrames;
    } catch (err) {
      step.fail(err);
      throw err;
    }
  }

  /**
   * Clean up uploaded file from Gemini
   */
  async cleanup(file) {
    try {
      await this.fileManager.deleteFile(file.name);
      console.log('Cleaned up uploaded video file');
    } catch (err) {
      console.warn('Failed to cleanup file:', err.message);
    }
  }

  /**
   * Fallback to frame-based extraction if native fails
   */
  async extractWithFallback(videoPath, options = {}) {
    try {
      const result = await this.extract(videoPath, options);
      return { ...result, runId: this.getRunId() };
    } catch (error) {
      console.warn('Native video extraction failed, falling back to frame-based:', error.message);

      // Create a new logger for fallback
      this.logger = new ExtractionLogger();
      this.logger.setMetadata({
        videoPath,
        options,
        usedFallback: true,
        nativeError: error.message
      });

      try {
        const result = await this.extractFrameBased(videoPath, options);
        this.logger.complete(result);
        await this.logger.save();
        return { ...result, runId: this.getRunId() };
      } catch (fallbackErr) {
        this.logger.fail(fallbackErr);
        await this.logger.save();
        throw fallbackErr;
      }
    }
  }

  /**
   * Frame-based extraction fallback (original method)
   */
  async extractFrameBased(videoPath, options = {}) {
    const { GeminiVision } = await import('./gemini-vision.js');
    const gemini = new GeminiVision();

    // Extract frames using original method
    const frames = await VideoProcessor.extractFrames(videoPath, {
      interval: 2,
      maxFrames: 25
    });

    // Analyze with Gemini Vision
    const extractedData = await gemini.extractRestaurantData(frames);

    // Convert to new format
    return {
      frames: extractedData.photos?.map((photo, i) => ({
        path: frames[photo.frameIndex] || frames[i],
        type: photo.type,
        description: photo.description,
        priority: 'medium'
      })) || [],
      menuItems: {
        items: extractedData.menuItems?.map(item => ({
          name: item.name,
          description: item.description,
          category: item.category || 'Main Dishes',
          price: item.estimatedPrice,
          dietaryTags: [],
          confidence: 0.7,
          needsReview: true
        })) || [],
        verified: false
      },
      restaurantInfo: {
        name: extractedData.restaurantName,
        cuisineType: extractedData.cuisineType,
        description: extractedData.description,
        tagline: extractedData.tagline,
        ambiance: 'casual',
        priceRange: '$$',
        features: []
      },
      style: {
        theme: extractedData.styleTheme || 'modern',
        primaryColor: extractedData.primaryColor || '#2563eb',
        secondaryColor: '#f59e0b',
        mood: 'warm',
        fontStyle: 'sans-serif'
      }
    };
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
