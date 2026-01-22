import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { createReadStream } from 'fs';
import { promises as fs, statSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { ShortsJobModel } from '../db/models/shorts-job.js';
import { ClipSelector } from '../services/clip-selector.js';
import { VoiceoverGenerator } from '../services/voiceover-generator.js';
import { VideoProcessor } from '../services/video-processor.js';
import { YouTubeUploader } from '../services/youtube-uploader.js';

const router = Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.paths.uploads);
  },
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `shorts_${uuidv4()}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    const videoTypes = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'];
    const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (videoTypes.includes(file.mimetype) || imageTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type.'));
    }
  }
});

const clipSelector = new ClipSelector();
const voiceoverGenerator = new VoiceoverGenerator();
const youtubeUploader = new YouTubeUploader();

/**
 * POST /api/shorts/check-cooking
 * Analyze a frame to check if it's cooking-related
 */
router.post('/check-cooking', upload.single('frame'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No frame uploaded' });
    }

    const result = await clipSelector.checkCookingContent(req.file.path);

    // Clean up uploaded frame
    await fs.unlink(req.file.path).catch(() => {});

    res.json(result);
  } catch (error) {
    console.error('Cooking check error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shorts/process
 * Upload video and start shorts processing job
 */
router.post('/process', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video uploaded' });
    }

    // Create job entry
    const job = ShortsJobModel.create({
      videoPath: req.file.path,
      title: req.body.title || null,
      description: req.body.description || null
    });

    // Start async processing
    processShort(job.id).catch(err => {
      console.error(`Shorts processing failed for job ${job.id}:`, err);
      ShortsJobModel.setError(job.id, err.message);
    });

    res.json({
      jobId: job.id,
      status: 'pending',
      message: 'Processing started'
    });
  } catch (error) {
    console.error('Shorts process error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shorts/status/:jobId
 * Get processing status for a job
 */
router.get('/status/:jobId', (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      progressStage: job.progressStage,
      errorMessage: job.errorMessage,
      title: job.title,
      description: job.description,
      tags: job.tags,
      clipStart: job.clipStart,
      clipEnd: job.clipEnd,
      script: job.script,
      youtubeVideoId: job.youtubeVideoId,
      youtubeUrl: job.youtubeUrl,
      createdAt: job.createdAt
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shorts/preview/:jobId
 * Stream the final video for preview
 */
router.get('/preview/:jobId', async (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!job.outputPath) {
      return res.status(400).json({ error: 'Video not ready yet' });
    }

    // Check file exists
    try {
      await fs.access(job.outputPath);
    } catch {
      return res.status(404).json({ error: 'Video file not found' });
    }

    const stat = statSync(job.outputPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(job.outputPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4'
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4'
      });
      createReadStream(job.outputPath).pipe(res);
    }
  } catch (error) {
    console.error('Preview error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shorts/thumbnail/:jobId
 * Get thumbnail image for a job
 */
router.get('/thumbnail/:jobId', async (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job || !job.thumbnailPath) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    res.sendFile(job.thumbnailPath);
  } catch (error) {
    console.error('Thumbnail error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/shorts/metadata/:jobId
 * Update video metadata before upload
 */
router.put('/metadata/:jobId', async (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { title, description, tags } = req.body;
    const updatedJob = ShortsJobModel.setMetadata(job.id, { title, description, tags });

    res.json(updatedJob);
  } catch (error) {
    console.error('Metadata update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shorts/upload-youtube/:jobId
 * Upload processed video to YouTube
 */
router.post('/upload-youtube/:jobId', async (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'ready') {
      return res.status(400).json({ error: 'Video not ready for upload' });
    }

    // Get YouTube tokens from request
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'YouTube authorization required' });
    }

    const tokens = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());

    // Upload to YouTube
    const { videoId, videoUrl, freshTokens } = await youtubeUploader.uploadVideo(
      job.outputPath,
      {
        title: job.title || 'Cooking Short',
        description: job.description || '',
        tags: job.tags || [],
        privacyStatus: req.body.privacyStatus || 'private'
      },
      tokens,
      (progress) => {
        // Could emit progress via WebSocket if needed
        console.log(`YouTube upload progress: ${progress}%`);
      }
    );

    // Update job with YouTube info
    ShortsJobModel.setYouTubeInfo(job.id, videoId, videoUrl);

    // Set thumbnail if available
    if (job.thumbnailPath) {
      try {
        await youtubeUploader.setThumbnail(videoId, job.thumbnailPath, freshTokens);
      } catch (err) {
        console.warn('Failed to set thumbnail:', err.message);
      }
    }

    res.json({
      success: true,
      videoId,
      videoUrl,
      freshTokens // Client should update stored tokens
    });
  } catch (error) {
    console.error('YouTube upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shorts/recent
 * Get recent shorts jobs
 */
router.get('/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const jobs = ShortsJobModel.getRecent(limit);
    res.json(jobs);
  } catch (error) {
    console.error('Recent jobs error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/shorts/:jobId
 * Delete a shorts job and its files
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Delete associated files
    const filesToDelete = [
      job.videoPath,
      job.clipPath,
      job.voiceoverPath,
      job.outputPath,
      job.thumbnailPath
    ].filter(Boolean);

    await Promise.all(
      filesToDelete.map(f => fs.unlink(f).catch(() => {}))
    );

    // Delete from database (would need to add delete method to model)
    // For now just mark as failed
    ShortsJobModel.setError(job.id, 'Deleted by user');

    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Async processing pipeline for shorts creation
 */
async function processShort(jobId) {
  // 10% - Start analyzing
  ShortsJobModel.updateProgress(jobId, 10, 'analyzing');

  const job = ShortsJobModel.getById(jobId);
  const outputDir = join(config.paths.shorts, jobId);
  await fs.mkdir(outputDir, { recursive: true });

  // Analyze video and find best clip (10% -> 40%)
  ShortsJobModel.updateStatus(jobId, 'processing', 15);

  const clipAnalysis = await clipSelector.analyzeAndSelectClip(job.videoPath, {
    minDuration: 15,
    maxDuration: 60,
    targetDuration: 30
  });

  // 40% - Extract clip
  ShortsJobModel.updateProgress(jobId, 40, 'clip_extracted');

  const clipPath = join(outputDir, 'clip.mp4');
  await VideoProcessor.extractClip(
    job.videoPath,
    clipAnalysis.startTime,
    clipAnalysis.endTime,
    clipPath
  );

  ShortsJobModel.setClipInfo(jobId, clipAnalysis.startTime, clipAnalysis.endTime, clipPath);

  // 55% - Generate voiceover script
  ShortsJobModel.updateProgress(jobId, 50, 'generating_script');

  const clipDuration = clipAnalysis.endTime - clipAnalysis.startTime;
  const script = await voiceoverGenerator.generateScript(clipPath, clipAnalysis, {
    style: 'casual',
    duration: clipDuration
  });

  ShortsJobModel.setScript(jobId, script);
  ShortsJobModel.updateProgress(jobId, 55, 'script_ready');

  // 75% - Generate voiceover audio
  ShortsJobModel.updateProgress(jobId, 60, 'generating_voiceover');

  const voiceoverPath = join(outputDir, 'voiceover.wav');
  await voiceoverGenerator.generateAudio(script, voiceoverPath);

  ShortsJobModel.setVoiceoverPath(jobId, voiceoverPath);
  ShortsJobModel.updateProgress(jobId, 75, 'voiceover_done');

  // 90% - Mix audio tracks
  ShortsJobModel.updateProgress(jobId, 80, 'mixing_audio');

  const mixedPath = join(outputDir, 'mixed.mp4');
  await VideoProcessor.mixAudioTracks(clipPath, voiceoverPath, mixedPath, {
    originalVolume: 0.3,
    voiceoverVolume: 1.0
  });

  ShortsJobModel.updateProgress(jobId, 90, 'audio_mixed');

  // 95% - Convert to Shorts format (9:16)
  ShortsJobModel.updateProgress(jobId, 92, 'converting_format');

  const outputPath = join(outputDir, 'final.mp4');
  await VideoProcessor.convertToShortsFormat(mixedPath, outputPath, {
    method: 'crop'
  });

  // Generate thumbnail
  const thumbnailPath = join(outputDir, 'thumbnail.jpg');
  const thumbnailTimestamp = Math.max(1, Math.min(clipDuration / 3, clipDuration - 1));
  await VideoProcessor.createThumbnail(outputPath, thumbnailPath, {
    width: 1080,
    height: 1920,
    timestamp: thumbnailTimestamp
  });

  ShortsJobModel.setOutputPath(jobId, outputPath, thumbnailPath);

  // Generate metadata
  const metadata = await voiceoverGenerator.generateMetadata(script, clipAnalysis);
  ShortsJobModel.setMetadata(jobId, metadata);

  // 100% - Complete
  ShortsJobModel.complete(jobId);

  // Clean up intermediate files
  await fs.unlink(mixedPath).catch(() => {});

  console.log(`Shorts processing complete for job ${jobId}`);
}

export default router;
