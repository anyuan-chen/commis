import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { VideoProcessor } from '../services/video-processor.js';
import { GeminiVision } from '../services/gemini-vision.js';
import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel, JobModel } from '../db/models/index.js';
import { promises as fs } from 'fs';

const router = Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.paths.uploads);
  },
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `${uuidv4()}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, and WebM are allowed.'));
    }
  }
});

// Upload video and start processing
router.post('/video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const videoPath = req.file.path;

    // Create a processing job
    const job = JobModel.create({ videoPath });

    // Start processing in background
    processVideo(job.id, videoPath).catch(err => {
      console.error('Video processing error:', err);
      JobModel.setError(job.id, err.message);
    });

    res.json({
      jobId: job.id,
      message: 'Video uploaded successfully. Processing started.',
      status: 'processing'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get processing status
router.get('/status/:jobId', (req, res) => {
  const job = JobModel.getById(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    restaurantId: job.restaurant_id,
    missingFields: job.missingFields,
    error: job.error_message
  });
});

// Background video processing function
async function processVideo(jobId, videoPath) {
  const gemini = new GeminiVision();

  try {
    // Update status
    JobModel.updateStatus(jobId, 'processing', 10);

    // Extract frames from video
    console.log('Extracting frames...');
    const frames = await VideoProcessor.extractFrames(videoPath, {
      interval: 2,
      maxFrames: 25
    });
    JobModel.updateProgress(jobId, 30);

    // Analyze frames with Gemini Vision
    console.log('Analyzing frames with Gemini...');
    const extractedData = await gemini.extractRestaurantData(frames);
    JobModel.updateProgress(jobId, 60);

    // Create restaurant record
    const restaurant = RestaurantModel.create({
      name: extractedData.restaurantName,
      tagline: extractedData.tagline,
      description: extractedData.description,
      cuisineType: extractedData.cuisineType,
      styleTheme: extractedData.styleTheme || 'modern',
      primaryColor: extractedData.primaryColor || '#2563eb'
    });

    JobModel.setRestaurantId(jobId, restaurant.id);
    JobModel.updateProgress(jobId, 70);

    // Create menu categories and items
    if (extractedData.menuItems && extractedData.menuItems.length > 0) {
      const categoriesMap = new Map();

      for (const item of extractedData.menuItems) {
        const categoryName = item.category || 'Main Dishes';

        if (!categoriesMap.has(categoryName)) {
          const category = MenuCategoryModel.create(restaurant.id, { name: categoryName });
          categoriesMap.set(categoryName, category.id);
        }

        MenuItemModel.create(categoriesMap.get(categoryName), {
          name: item.name,
          description: item.description,
          price: item.estimatedPrice
        });
      }
    }

    JobModel.updateProgress(jobId, 80);

    // Save photo references
    if (extractedData.photos && extractedData.photos.length > 0) {
      for (const photo of extractedData.photos) {
        if (photo.frameIndex < frames.length) {
          const framePath = frames[photo.frameIndex];

          // Copy frame to images directory with a new name
          const newPath = join(config.paths.images, `${restaurant.id}_${photo.type}_${Date.now()}.jpg`);
          await fs.copyFile(framePath, newPath);

          PhotoModel.create(restaurant.id, {
            path: newPath,
            type: photo.type,
            caption: photo.description,
            isPrimary: photo.type === 'exterior' || photo.type === 'interior'
          });
        }
      }
    }

    JobModel.updateProgress(jobId, 90);

    // Identify missing fields
    const missingFields = gemini.identifyMissingFields({
      restaurantName: extractedData.restaurantName,
      address: extractedData.address,
      phone: extractedData.phone,
      menuItems: extractedData.menuItems,
      hours: extractedData.hours
    });

    JobModel.setMissingFields(jobId, missingFields);

    // Complete the job
    JobModel.complete(jobId);

    console.log(`Video processing complete for restaurant: ${restaurant.id}`);

    // Cleanup frames directory (optional)
    // await fs.rm(dirname(frames[0]), { recursive: true });

  } catch (error) {
    console.error('Processing error:', error);
    JobModel.setError(jobId, error.message);
    throw error;
  }
}

export default router;
