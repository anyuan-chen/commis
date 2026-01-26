import { join } from 'path';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { ShortsJobModel } from '../db/models/shorts-job.js';
import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel, JobModel } from '../db/models/index.js';
import { processShort } from '../routes/shorts.js';
import { getStoredTokens, storeTokens } from '../routes/youtube-auth.js';
import { YouTubeUploader } from '../services/youtube-uploader.js';
import { ImageGenerator } from '../services/image-generator.js';
import { WebsiteGenerator } from '../services/website-generator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { VideoProcessor } from '../services/video-processor.js';
import { GeminiVision } from '../services/gemini-vision.js';
import { adRecommender } from '../services/ad-recommender.js';
import { WebsiteUpdater } from '../services/website-updater.js';

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
    description: 'Generate an AI graphic for a restaurant. Can create social media posts, menu graphics, promotional materials, or custom images.',
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
          enum: ['custom', 'social', 'menu', 'promo'],
          description: 'Type of graphic to generate (default: custom)'
        }
      },
      required: ['restaurantId', 'prompt']
    },
    handler: async ({ restaurantId, prompt, platform = 'instagram', type = 'custom' }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      const generator = new ImageGenerator();

      let result;
      if (type === 'social') {
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
        const aspectRatios = {
          instagram: '1:1',
          facebook: '16:9',
          twitter: '16:9',
          story: '9:16'
        };

        const enhancedPrompt = `For restaurant "${restaurant.name}" (${restaurant.cuisine_type || 'restaurant'}), brand color ${restaurant.primary_color || '#2563eb'}:\n\n${prompt}`;

        result = await generator.generate(enhancedPrompt, {
          aspectRatio: aspectRatios[platform] || '1:1'
        });
      }

      return {
        imageUrl: `/images/${result.path.split('/').pop()}`,
        imagePath: result.path,
        restaurantName: restaurant.name
      };
    }
  },

  {
    name: 'create_website',
    description: 'Generate and deploy a website for a restaurant to Cloudflare Pages. Returns the live website URL.',
    inputSchema: {
      type: 'object',
      properties: {
        restaurantId: {
          type: 'string',
          description: 'ID of the restaurant to create website for'
        }
      },
      required: ['restaurantId']
    },
    handler: async ({ restaurantId }) => {
      const restaurant = RestaurantModel.getById(restaurantId);
      if (!restaurant) {
        throw new Error(`Restaurant not found: ${restaurantId}`);
      }

      // Generate website
      const websiteGenerator = new WebsiteGenerator();
      const { path: websitePath, materialId } = await websiteGenerator.generate(restaurantId);

      // Deploy to Cloudflare
      const deployer = new CloudflareDeployer();
      const { url: websiteUrl, projectName } = await deployer.deploy(restaurantId);

      return {
        websiteUrl,
        projectName,
        localPath: websitePath,
        materialId,
        restaurantName: restaurant.name
      };
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
  }
];

/**
 * Get tool by name
 */
export function getToolByName(name) {
  return tools.find(t => t.name === name);
}
