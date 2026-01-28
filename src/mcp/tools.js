import { join } from 'path';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { ShortsJobModel } from '../db/models/shorts-job.js';
import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel, JobModel, ReviewDigestModel } from '../db/models/index.js';
import { processShort } from '../routes/shorts.js';
import { getStoredTokens, storeTokens } from '../routes/youtube-auth.js';
import { YouTubeUploader } from '../services/youtube-uploader.js';
import { ImageGenerator } from '../services/image-generator.js';
import { WebsiteGenerator } from '../services/website-generator.js';
import { IterativeWebsiteGenerator, evaluateExistingWebsite } from '../services/iterative-generator.js';
import { UIEvaluator } from '../services/ui-evaluator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { VideoProcessor } from '../services/video-processor.js';
import { GeminiVision } from '../services/gemini-vision.js';
import { adRecommender } from '../services/ad-recommender.js';
import { WebsiteUpdater } from '../services/website-updater.js';
import { digestGenerator } from '../services/digest-generator.js';
import { abOptimizer } from '../services/ab-optimizer.js';

const youtubeUploader = new YouTubeUploader();

/**
 * Download a file from URL to local path, or copy if it's a local upload
 */
async function downloadFromUrl(url, destPath) {
  // Handle local uploads (e.g., "/uploads/abc.mp4")
  if (url.startsWith('/uploads/')) {
    const filename = url.replace('/uploads/', '');
    const sourcePath = join(config.paths.uploads, filename);

    // If source and dest are same folder, just return the source path
    if (sourcePath === destPath) {
      return sourcePath;
    }

    // Check if file exists
    try {
      await fs.access(sourcePath);
      // Copy to dest path
      await fs.copyFile(sourcePath, destPath);
      return destPath;
    } catch (err) {
      throw new Error(`Local file not found: ${sourcePath}`);
    }
  }

  // Handle remote URLs
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  const fileStream = createWriteStream(destPath);
  await pipeline(response.body, fileStream);
  return destPath;
}

/**
 * Wait for a shorts job to complete with internal polling
 */
async function waitForJob(jobId, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const job = ShortsJobModel.getById(jobId);
    if (!job) throw new Error('Job not found');
    if (job.status === 'ready' || job.status === 'uploaded') return job;
    if (job.status === 'failed') throw new Error(job.errorMessage || 'Job failed');
    await new Promise(r => setTimeout(r, 2000)); // Poll every 2s
  }
  throw new Error('Job timed out after 5 minutes');
}

/**
 * Wait for video upload job to complete
 */
async function waitForUploadJob(jobId, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const job = JobModel.getById(jobId);
    if (!job) throw new Error('Job not found');
    if (job.status === 'complete') return job;
    if (job.status === 'failed') throw new Error(job.error_message || 'Job failed');
    await new Promise(r => setTimeout(r, 2000)); // Poll every 2s
  }
  throw new Error('Job timed out after 5 minutes');
}

/**
 * Meta-tool definitions for MCP
 */
export const tools = [
  {
    name: 'create_youtube_short',
    description: 'Process a cooking video into YouTube Shorts (narrated + ASMR versions) and upload to YouTube. This is a blocking operation that takes 3-5 minutes. Returns both video URLs and YouTube video ID.',
    inputSchema: {
      type: 'object',
      properties: {
        videoUrl: {
          type: 'string',
          description: 'URL of the video to process (must be a direct video file URL)'
        },
        title: {
          type: 'string',
          description: 'Optional title override for the YouTube video'
        },
        description: {
          type: 'string',
          description: 'Optional description override for the YouTube video'
        },
        privacyStatus: {
          type: 'string',
          enum: ['private', 'unlisted', 'public'],
          description: 'YouTube video privacy status (default: private)'
        }
      },
      required: ['videoUrl']
    },
    handler: async ({ videoUrl, title, description, privacyStatus = 'private' }) => {
      // 1. Get video path (local upload or download from URL)
      let videoPath;
      if (videoUrl.startsWith('/uploads/')) {
        // Local upload - use directly
        const filename = videoUrl.replace('/uploads/', '');
        videoPath = join(config.paths.uploads, filename);
      } else {
        // Remote URL - download
        videoPath = join(config.paths.uploads, `shorts_${uuidv4()}.mp4`);
        await downloadFromUrl(videoUrl, videoPath);
      }

      // 2. Create job and start processing
      const job = ShortsJobModel.create({
        videoPath,
        title: title || null,
        description: description || null
      });

      // 3. Start async processing (don't await here)
      processShort(job.id).catch(err => {
        console.error(`MCP: Shorts processing failed for job ${job.id}:`, err);
        ShortsJobModel.setError(job.id, err.message);
      });

      // 4. Wait for completion with internal polling
      const completed = await waitForJob(job.id);

      // 5. Upload to YouTube
      const storedTokens = getStoredTokens();
      if (!storedTokens) {
        throw new Error('YouTube not connected. Please authenticate at /api/youtube/auth first.');
      }

      const tokens = {
        access_token: storedTokens.access_token,
        refresh_token: storedTokens.refresh_token,
        expiry_date: storedTokens.expiry_date,
        scope: storedTokens.scope,
        token_type: storedTokens.token_type
      };

      const { videoId, videoUrl: ytUrl, freshTokens } = await youtubeUploader.uploadVideo(
        completed.outputPath,
        {
          title: completed.title || 'Cooking Short',
          description: completed.description || '',
          tags: completed.tags || [],
          privacyStatus
        },
        tokens
      );

      // Update job with YouTube info
      ShortsJobModel.setYouTubeInfo(job.id, videoId, ytUrl);

      // Store refreshed tokens if updated
      if (freshTokens) {
        storeTokens(freshTokens);
      }

      // Set thumbnail if available
      if (completed.thumbnailPath) {
        try {
          await youtubeUploader.setThumbnail(videoId, completed.thumbnailPath, freshTokens || tokens);
        } catch (err) {
          console.warn('MCP: Failed to set thumbnail:', err.message);
        }
      }

      return {
        youtubeUrl: ytUrl,
        youtubeVideoId: videoId,
        narratedVideoUrl: `/api/shorts/preview/${job.id}`,
        asmrVideoUrl: `/api/shorts/preview-asmr/${job.id}`,
        title: completed.title,
        description: completed.description,
        tags: completed.tags
      };
    }
  },

  {
    name: 'generate_graphic',
    description: 'Generate an AI graphic for a restaurant. Can create social media posts, menu graphics, promotional materials, or custom images. Use "imagen" model for photorealistic food shots and artistic images; use "gemini" for graphics with text overlays.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to generate graphic for'
        },
        prompt: {
          type: 'string',
          description: 'Description of the graphic to generate (e.g., "Instagram post for our new ramen special")'
        },
        platform: {
          type: 'string',
          enum: ['instagram', 'facebook', 'twitter', 'story'],
          description: 'Target platform for aspect ratio optimization (default: instagram)'
        },
        type: {
          type: 'string',
          enum: ['custom', 'social', 'menu', 'promo', 'creative'],
          description: 'Type of graphic: custom/social/menu/promo use Gemini, "creative" uses Imagen 3 for photorealistic images'
        },
        model: {
          type: 'string',
          enum: ['gemini', 'imagen'],
          description: 'AI model: "gemini" for text-heavy graphics, "imagen" for photorealistic/artistic images (default: auto-selected based on type)'
        }
      },
      required: ['restaurantId', 'prompt']
    },
    handler: async ({ restaurantId, prompt, platform = 'instagram', type = 'custom', model = null }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const generator = new ImageGenerator();

      const aspectRatios = {
        instagram: '1:1',
        facebook: '16:9',
        twitter: '16:9',
        story: '9:16'
      };

      let result;

      // Creative type or explicit imagen model = use Imagen 3
      if (type === 'creative' || model === 'imagen') {
        result = await generator.generateCreative(prompt, {
          restaurantId,
          aspectRatio: aspectRatios[platform] || '1:1'
        });
      } else if (type === 'social') {
        result = await generator.generateSocialPost(restaurantId, {
          platform,
          customText: prompt
        });
      } else if (type === 'menu') {
        result = await generator.generateMenuGraphic(restaurantId, {
          style: 'elegant'
        });
      } else if (type === 'promo') {
        result = await generator.generatePromoGraphic(restaurantId, {
          promoText: prompt
        });
      } else {
        // Custom generation with restaurant context
        const enhancedPrompt = `For restaurant "${restaurant.name}" (${restaurant.cuisine_type || 'restaurant'}), brand color ${restaurant.primary_color || '#2563eb'}:\n\n${prompt}`;

        result = await generator.generate(enhancedPrompt, {
          aspectRatio: aspectRatios[platform] || '1:1',
          model: model || 'gemini'
        });
      }

      return {
        imageUrl: `/images/${result.path.split('/').pop()}`,
        imagePath: result.path,
        restaurantName: restaurant.name,
        model: result.model || 'gemini'
      };
    }
  },

  {
    name: 'create_website',
    description: 'Generate and deploy a website for a restaurant to Cloudflare Pages. Uses iterative refinement with visual evaluation to ensure high quality. Returns the live website URL and quality metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to create website for'
        },
        useIterative: {
          type: 'boolean',
          description: 'Use iterative refinement with visual evaluation (default: true). Set to false for quick generation without quality checks.'
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum iterations for refinement (default: 3). Higher = better quality but slower.'
        },
        qualityThreshold: {
          type: 'number',
          description: 'Quality score threshold 0-100 (default: 65). Higher = stricter quality requirements.'
        },
        debugMode: {
          type: 'boolean',
          description: 'Save debug info (screenshots, evaluations) for each iteration'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId, useIterative = true, maxIterations = 3, qualityThreshold = 65, debugMode = false }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      let websitePath, materialId, generationResult;

      if (useIterative) {
        // Use iterative generator with visual evaluation
        const generator = new IterativeWebsiteGenerator({
          maxIterations,
          qualityThreshold,
          debugMode
        });
        generationResult = await generator.generate(restaurantId);
        websitePath = generationResult.path;
        materialId = generationResult.materialId;
      } else {
        // Use simple one-shot generation
        const websiteGenerator = new WebsiteGenerator();
        const result = await websiteGenerator.generate(restaurantId);
        websitePath = result.path;
        materialId = result.materialId;
      }

      // Deploy to Cloudflare
      const deployer = new CloudflareDeployer();
      const { url: websiteUrl, projectName } = await deployer.deploy(restaurantId);

      const response = {
        websiteUrl,
        projectName,
        localPath: websitePath,
        materialId,
        restaurantName: restaurant.name
      };

      // Add quality metrics if iterative was used
      if (generationResult) {
        response.qualityMetrics = {
          iterations: generationResult.iterations,
          finalScore: generationResult.finalScore,
          passedQualityBar: generationResult.passed,
          evaluation: generationResult.evaluation ? {
            visualScores: generationResult.evaluation.visualEvaluation?.scores,
            staticIssues: generationResult.evaluation.staticAnalysis?.issues,
            improvements: generationResult.evaluation.improvements
          } : null
        };
      }

      return response;
    }
  },

  {
    name: 'evaluate_website',
    description: 'Evaluate an existing restaurant website for UI/UX quality. Takes screenshots at multiple viewports and uses AI to analyze visual design, accessibility, and usability.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant whose website to evaluate'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const results = await evaluateExistingWebsite(restaurantId);

      return {
        restaurantName: restaurant.name,
        indexPage: results.index.error ? { error: results.index.error } : {
          combinedScore: results.index.combinedScore,
          passesQualityBar: results.index.passesQualityBar,
          visualScores: results.index.visualEvaluation?.scores,
          criticalIssues: results.index.visualEvaluation?.criticalIssues,
          staticIssues: results.index.staticAnalysis?.issues,
          improvements: results.index.improvements
        },
        menuPage: results.menu.error ? { error: results.menu.error } : {
          combinedScore: results.menu.combinedScore,
          passesQualityBar: results.menu.passesQualityBar,
          visualScores: results.menu.visualEvaluation?.scores,
          criticalIssues: results.menu.visualEvaluation?.criticalIssues,
          staticIssues: results.menu.staticAnalysis?.issues,
          improvements: results.menu.improvements
        },
        overallAssessment: {
          averageScore: Math.round(
            ((results.index.combinedScore || 0) + (results.menu.combinedScore || 0)) / 2
          ),
          recommendation: (results.index.passesQualityBar && results.menu.passesQualityBar)
            ? 'Website meets quality standards'
            : 'Website needs improvements - consider regenerating with higher quality threshold'
        }
      };
    }
  },

  {
    name: 'regenerate_website',
    description: 'Regenerate a restaurant website with iterative refinement. Use this after evaluate_website reveals issues. Keeps the same restaurant data but creates new HTML/CSS.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant whose website to regenerate'
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum iterations for refinement (default: 3)'
        },
        qualityThreshold: {
          type: 'number',
          description: 'Quality score threshold 0-100 (default: 70). Set higher for better quality.'
        },
        deploy: {
          type: 'boolean',
          description: 'Deploy to Cloudflare after regeneration (default: true)'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId, maxIterations = 3, qualityThreshold = 70, deploy = true }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      // Regenerate with iterative generator
      const generator = new IterativeWebsiteGenerator({
        maxIterations,
        qualityThreshold,
        debugMode: true // Always save debug info for regeneration
      });

      const result = await generator.generate(restaurantId);

      const response = {
        restaurantName: restaurant.name,
        localPath: result.path,
        materialId: result.materialId,
        iterations: result.iterations,
        finalScore: result.finalScore,
        passedQualityBar: result.passed,
        evaluation: result.evaluation ? {
          visualScores: result.evaluation.visualEvaluation?.scores,
          criticalIssues: result.evaluation.visualEvaluation?.criticalIssues,
          improvements: result.evaluation.improvements
        } : null
      };

      // Deploy if requested
      if (deploy) {
        const deployer = new CloudflareDeployer();
        const { url: websiteUrl, projectName } = await deployer.deploy(restaurantId);
        response.websiteUrl = websiteUrl;
        response.projectName = projectName;
      }

      return response;
    }
  },

  {
    name: 'find_restaurant',
    description: 'Search for restaurants by name using fuzzy matching. Returns matching restaurants with their IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (restaurant name or partial name)'
        }
      },
      required: ['query']
    },
    handler: async ({ query }) => {
      const allRestaurants = RestaurantModel.getAll();

      // Simple fuzzy matching: case-insensitive contains
      const queryLower = query.toLowerCase();
      const matches = allRestaurants.filter(r => {
        const name = (r.name || '').toLowerCase();
        const cuisine = (r.cuisine_type || '').toLowerCase();
        return name.includes(queryLower) || cuisine.includes(queryLower);
      });

      return matches.map(r => ({
        id: r.id,
        name: r.name,
        cuisineType: r.cuisine_type,
        tagline: r.tagline,
        address: r.address
      }));
    }
  },

  {
    name: 'create_restaurant',
    description: 'Process a video to extract restaurant data and create a new restaurant. Analyzes the video to extract restaurant name, menu items, photos, and other details.',
    inputSchema: {
      type: 'object',
      properties: {
        videoUrl: {
          type: 'string',
          description: 'URL of the restaurant video to process'
        }
      },
      required: ['videoUrl']
    },
    handler: async ({ videoUrl }) => {
      // 1. Get video path (local upload or download from URL)
      let videoPath;
      if (videoUrl.startsWith('/uploads/')) {
        // Local upload - use directly
        const filename = videoUrl.replace('/uploads/', '');
        videoPath = join(config.paths.uploads, filename);
      } else {
        // Remote URL - download
        videoPath = join(config.paths.uploads, `${uuidv4()}.mp4`);
        await downloadFromUrl(videoUrl, videoPath);
      }

      // 2. Create a processing job
      const job = JobModel.create({ videoPath });

      // 3. Process video in background
      const gemini = new GeminiVision();

      try {
        JobModel.updateStatus(job.id, 'processing', 10);

        // Extract frames from video
        const frames = await VideoProcessor.extractFrames(videoPath, {
          interval: 2,
          maxFrames: 25
        });
        JobModel.updateProgress(job.id, 30);

        // Analyze frames with Gemini Vision
        const extractedData = await gemini.extractRestaurantData(frames);
        JobModel.updateProgress(job.id, 60);

        // Create restaurant record
        const restaurant = RestaurantModel.create({
          name: extractedData.restaurantName,
          tagline: extractedData.tagline,
          description: extractedData.description,
          cuisineType: extractedData.cuisineType,
          styleTheme: extractedData.styleTheme || 'modern',
          primaryColor: extractedData.primaryColor || '#2563eb'
        });

        JobModel.setRestaurantId(job.id, restaurant.id);
        JobModel.updateProgress(job.id, 70);

        // Create menu categories and items
        const menuItems = [];
        if (extractedData.menuItems && extractedData.menuItems.length > 0) {
          const categoriesMap = new Map();

          for (const item of extractedData.menuItems) {
            const categoryName = item.category || 'Main Dishes';

            if (!categoriesMap.has(categoryName)) {
              const category = MenuCategoryModel.create(restaurant.id, { name: categoryName });
              categoriesMap.set(categoryName, category.id);
            }

            const menuItem = MenuItemModel.create(categoriesMap.get(categoryName), {
              name: item.name,
              description: item.description,
              price: item.estimatedPrice
            });
            menuItems.push({
              name: item.name,
              description: item.description,
              price: item.estimatedPrice,
              category: categoryName
            });
          }
        }

        JobModel.updateProgress(job.id, 80);

        // Save photo references
        const photos = [];
        if (extractedData.photos && extractedData.photos.length > 0) {
          for (const photo of extractedData.photos) {
            if (photo.frameIndex < frames.length) {
              const framePath = frames[photo.frameIndex];
              const newPath = join(config.paths.images, `${restaurant.id}_${photo.type}_${Date.now()}.jpg`);
              await fs.copyFile(framePath, newPath);

              PhotoModel.create(restaurant.id, {
                path: newPath,
                type: photo.type,
                caption: photo.description,
                isPrimary: photo.type === 'exterior' || photo.type === 'interior'
              });

              photos.push({
                type: photo.type,
                caption: photo.description,
                path: `/images/${newPath.split('/').pop()}`
              });
            }
          }
        }

        JobModel.complete(job.id);

        return {
          restaurantId: restaurant.id,
          name: extractedData.restaurantName,
          cuisineType: extractedData.cuisineType,
          tagline: extractedData.tagline,
          description: extractedData.description,
          menuItems,
          photos
        };
      } catch (error) {
        JobModel.setError(job.id, error.message);
        throw error;
      }
    }
  },

  {
    name: 'suggest_google_ads',
    description: 'Generate Google Ads campaign recommendations using restaurant data and Keyword Planner insights. Returns suggested campaigns with headlines, descriptions, keywords (with search volume/CPC data), targeting, and budget recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to generate ad recommendations for'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const recommendations = await adRecommender.generateRecommendations(restaurantId);

      return {
        ...recommendations,
        keywordPlannerStatus: adRecommender.isKeywordPlannerAvailable()
          ? 'Connected - using real Keyword Planner data'
          : 'Not connected - using AI-estimated metrics. Connect at /api/google-ads/auth for real data.'
      };
    }
  },

  {
    name: 'modify_website',
    description: 'Modify restaurant website using natural language. Multi-step process: classify request → generate SQL for data changes → identify HTML chunks → regenerate chunks. Use this to update prices, hours, text, styling, or any website content.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant whose website to modify'
        },
        prompt: {
          type: 'string',
          description: 'Natural language description of the change (e.g., "change Margherita Pizza price to $25", "update phone number to 555-1234", "make the hero section background darker")'
        }
      },
      required: ['restaurantId', 'prompt']
    },
    handler: async ({ restaurantId, prompt }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const updater = new WebsiteUpdater();
      const result = await updater.updateAll(restaurantId, prompt);

      return {
        success: result.success,
        classification: result.classification,
        sqlExecuted: result.sqlExecuted,
        chunksModified: result.chunksModified,
        restaurantName: restaurant.name,
        message: `Website updated: ${result.classification.summary}`
      };
    }
  },

  {
    name: 'generate_review_digest',
    description: 'Create an AI-powered digest analyzing reviews over a time period. Includes sentiment summary, common complaints, praise themes, and suggested actions.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to generate digest for'
        },
        periodStart: {
          type: 'string',
          description: 'Start date for the period (ISO format, defaults to 7 days ago)'
        },
        periodEnd: {
          type: 'string',
          description: 'End date for the period (ISO format, defaults to now)'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId, periodStart, periodEnd }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const digest = await digestGenerator.generateDigest(restaurantId, {
        periodStart,
        periodEnd
      });

      return {
        restaurantName: restaurant.name,
        ...digest
      };
    }
  },

  {
    name: 'get_review_insights',
    description: 'Get review statistics and insights without generating a full digest. Returns stats, sentiment breakdown, rating distribution, and recent reviews.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to get insights for'
        },
        days: {
          type: 'number',
          description: 'Number of days to analyze (default: 30)'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId, days = 30 }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const insights = await digestGenerator.getInsights(restaurantId, { days });

      return {
        restaurantName: restaurant.name,
        ...insights
      };
    }
  },

  {
    name: 'get_latest_digest',
    description: 'Get the most recent review digest for a restaurant without generating a new one. Returns sentiment summary, complaints, praise themes, and suggested actions.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to get digest for'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const digest = ReviewDigestModel.getLatest(restaurantId);

      if (!digest) {
        return {
          restaurantName: restaurant.name,
          hasDigest: false,
          message: 'No digest available. Use generate_review_digest to create one.'
        };
      }

      return {
        restaurantName: restaurant.name,
        hasDigest: true,
        ...digest
      };
    }
  },

  {
    name: 'get_optimizer_status',
    description: 'Get the A/B testing optimizer status for a restaurant. Shows active experiment, recent history, and performance metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to get optimizer status for'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const status = abOptimizer.getStatus(restaurantId);

      return {
        restaurantName: restaurant.name,
        ...status
      };
    }
  },

  {
    name: 'get_website_analytics',
    description: 'Get website analytics for a restaurant including pageviews, conversions, scroll depth, time on page, and click data.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to get analytics for'
        },
        days: {
          type: 'number',
          description: 'Number of days to analyze (default: 14)'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId, days = 14 }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const analytics = abOptimizer.getAnalytics(restaurantId, days);

      return {
        restaurantName: restaurant.name,
        ...analytics
      };
    }
  },

];

/**
 * Get tool by name
 */
export function getToolByName(name) {
  return tools.find(t => t.name === name);
}
