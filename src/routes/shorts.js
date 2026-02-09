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
import { SubtitleGenerator } from '../services/subtitle-generator.js';
import { StyleResearcher } from '../services/style-researcher.js';
import { GoogleAIFileManager } from '@google/generative-ai/server';

const fileManager = new GoogleAIFileManager(config.geminiApiKey);

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
const subtitleGenerator = new SubtitleGenerator();
const styleResearcher = new StyleResearcher();

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
      createdAt: job.createdAt,
      variants: job.variants,
      // Backwards compatibility
      outputPathNarrated: job.outputPath,
      outputPathAsmr: job.outputPathAsmr,
      outputPath: job.outputPath
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
 * GET /api/shorts/preview-asmr/:jobId
 * Legacy redirect — preserved for backwards compat
 */
router.get('/preview-asmr/:jobId', (req, res) => {
  res.redirect(`/api/shorts/preview/${req.params.jobId}/asmr`);
});

/**
 * GET /api/shorts/preview/:jobId/:variant
 * Stream any variant video for preview (e.g. /preview/abc/narrated, /preview/abc/asmr)
 */
router.get('/preview/:jobId/:variant', async (req, res) => {
  try {
    const job = ShortsJobModel.getById(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const variant = job.variants.find(v => v.type === req.params.variant);
    if (!variant || !variant.outputPath) {
      return res.status(400).json({ error: `${req.params.variant} video not ready yet` });
    }

    // Check file exists
    try {
      await fs.access(variant.outputPath);
    } catch {
      return res.status(404).json({ error: `${req.params.variant} video file not found` });
    }

    const stat = statSync(variant.outputPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(variant.outputPath, { start, end });
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
      createReadStream(variant.outputPath).pipe(res);
    }
  } catch (error) {
    console.error('Variant preview error:', error);
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
 * Upload processed video to YouTube using stored tokens
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

    // Get stored YouTube tokens from database
    const { getStoredTokens } = await import('./youtube-auth.js');
    const storedTokens = getStoredTokens();

    if (!storedTokens) {
      return res.status(401).json({ error: 'YouTube not connected. Please authenticate first.' });
    }

    const tokens = {
      access_token: storedTokens.access_token,
      refresh_token: storedTokens.refresh_token,
      expiry_date: storedTokens.expiry_date,
      scope: storedTokens.scope,
      token_type: storedTokens.token_type
    };

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

    // Store refreshed tokens if they were updated
    if (freshTokens) {
      const { storeTokens } = await import('./youtube-auth.js');
      storeTokens(freshTokens);
    }

    // Set thumbnail if available
    if (job.thumbnailPath) {
      try {
        await youtubeUploader.setThumbnail(videoId, job.thumbnailPath, freshTokens || tokens);
      } catch (err) {
        console.warn('Failed to set thumbnail:', err.message);
      }
    }

    res.json({
      success: true,
      videoId,
      videoUrl
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

    // Delete associated files (including all variant outputs)
    const variantPaths = job.variants.map(v => v.outputPath).filter(Boolean);
    const filesToDelete = [
      job.videoPath,
      job.clipPath,
      job.voiceoverPath,
      job.thumbnailPath,
      ...variantPaths
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
 * Process a single style variant
 */
async function processOneStyle(jobId, outputDir, clipPath, clipFile, clipAnalysis, clipDuration, style) {
  const intermediates = [];

  if (style.hasVoiceover) {
    // 1. Generate script with style-specific prompt
    const script = await voiceoverGenerator.generateScript(clipPath, clipAnalysis, {
      duration: clipDuration,
      scriptPrompt: style.scriptPrompt,
      fileRef: clipFile
    });

    ShortsJobModel.setScript(jobId, script);

    // 2. Generate voiceover audio with style-specific voice
    const voiceoverPath = join(outputDir, `voiceover_${style.type}.wav`);
    await voiceoverGenerator.generateAudio(script, voiceoverPath, { voice: style.voice });
    intermediates.push(voiceoverPath);

    // 3. Generate subtitles (try/catch, skip on fail)
    let subtitlePath = null;
    if (style.subtitles) {
      try {
        subtitlePath = join(outputDir, `subtitles_${style.type}.ass`);
        await subtitleGenerator.generate(voiceoverPath, subtitlePath, {
          wordsPerGroup: style.subtitles.wordsPerGroup || 3,
          fontSize: style.subtitles.fontSize || 52,
          marginV: 180,
          uppercase: style.subtitles.uppercase !== false
        });
        console.log(`Subtitles generated for ${style.type}: ${subtitlePath}`);
      } catch (err) {
        console.warn(`Subtitle generation failed for ${style.type}, continuing without:`, err.message);
        subtitlePath = null;
      }
    }

    // 4. Mix audio tracks
    const mixedPath = join(outputDir, `mixed_${style.type}.mp4`);
    await VideoProcessor.mixAudioTracks(clipPath, voiceoverPath, mixedPath, {
      originalVolume: style.audioMix?.originalVolume ?? 0.3,
      voiceoverVolume: style.audioMix?.voiceoverVolume ?? 1.0
    });
    intermediates.push(mixedPath);

    // 5. Convert to shorts format (9:16)
    const shortsPath = join(outputDir, `shorts_${style.type}.mp4`);
    await VideoProcessor.convertToShortsFormat(mixedPath, shortsPath, { method: 'crop' });
    intermediates.push(shortsPath);

    // 6. Burn subtitles if available
    let finalPath;
    if (subtitlePath) {
      finalPath = join(outputDir, `final_${style.type}.mp4`);
      await VideoProcessor.burnSubtitles(shortsPath, subtitlePath, finalPath);
      intermediates.push(subtitlePath);
    } else {
      finalPath = shortsPath;
      // Don't clean up shortsPath since it IS the final output
      const idx = intermediates.indexOf(shortsPath);
      if (idx !== -1) intermediates.splice(idx, 1);
    }

    // 7. Save variant
    ShortsJobModel.addVariant(jobId, {
      type: style.type,
      label: style.label,
      outputPath: finalPath,
      script,
      voice: style.voice
    });

    // 8. Clean intermediates (keep final output)
    for (const f of intermediates) {
      if (f !== finalPath) await fs.unlink(f).catch(() => {});
    }

    return finalPath;
  } else {
    // Non-voiceover path
    let inputPath = clipPath;

    // 1. Apply audio treatment if specified
    if (style.audioTreatment === 'asmr') {
      const asmrPath = join(outputDir, `asmr_audio_${style.type}.mp4`);
      await VideoProcessor.reduceSpeech(clipPath, asmrPath);
      inputPath = asmrPath;
      intermediates.push(asmrPath);
    }

    // 2. Convert to shorts format (9:16)
    const finalPath = join(outputDir, `final_${style.type}.mp4`);
    await VideoProcessor.convertToShortsFormat(inputPath, finalPath, { method: 'crop' });

    // 3. Save variant
    ShortsJobModel.addVariant(jobId, {
      type: style.type,
      label: style.label,
      outputPath: finalPath
    });

    // 4. Clean intermediates
    for (const f of intermediates) {
      await fs.unlink(f).catch(() => {});
    }

    return finalPath;
  }
}

/**
 * Async processing pipeline for shorts creation
 */
async function processShort(jobId) {
  // === Phase 1: Shared analysis (0-40%) ===
  ShortsJobModel.updateProgress(jobId, 10, 'analyzing');

  const job = ShortsJobModel.getById(jobId);
  const outputDir = join(config.paths.shorts, jobId);
  await fs.mkdir(outputDir, { recursive: true });

  ShortsJobModel.updateStatus(jobId, 'processing', 15);

  const clipAnalysis = await clipSelector.analyzeAndSelectClip(job.videoPath, {
    minDuration: 15,
    maxDuration: 60,
    targetDuration: 30
  });

  ShortsJobModel.updateProgress(jobId, 40, 'clip_extracted');

  const clipPath = join(outputDir, 'clip.mp4');
  await VideoProcessor.extractClip(
    job.videoPath,
    clipAnalysis.startTime,
    clipAnalysis.endTime,
    clipPath
  );

  ShortsJobModel.setClipInfo(jobId, clipAnalysis.startTime, clipAnalysis.endTime, clipPath);
  const clipDuration = clipAnalysis.endTime - clipAnalysis.startTime;

  // === Phase 2: Style research (40-45%) ===
  ShortsJobModel.updateProgress(jobId, 42, 'researching_styles');

  // Upload clip to Gemini File API once — shared across style research + script gen
  console.log('Uploading clip to Gemini for style research...');
  const uploadResult = await fileManager.uploadFile(clipPath, {
    mimeType: 'video/mp4',
    displayName: 'cooking-clip-styles'
  });

  let clipFile = uploadResult.file;
  while (clipFile.state === 'PROCESSING') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    clipFile = await fileManager.getFile(clipFile.name);
  }

  if (clipFile.state === 'FAILED') {
    throw new Error('Gemini file processing failed');
  }

  const clipFileRef = { mimeType: clipFile.mimeType, uri: clipFile.uri };
  const styles = await styleResearcher.recommendStyles(clipFileRef, clipAnalysis, { clipDuration });
  console.log(`Style researcher recommended: ${styles.map(s => s.type).join(', ')}`);

  ShortsJobModel.updateProgress(jobId, 45, 'styles_ready');

  // === Phase 3: Per-style processing (45-90%) ===
  const perStyle = 45 / styles.length;
  let firstOutputPath = null;
  let successCount = 0;
  const errors = [];

  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const base = 45 + (i * perStyle);

    ShortsJobModel.updateProgress(jobId, Math.round(base), `processing_${style.type}`);

    try {
      const outputPath = await processOneStyle(
        jobId, outputDir, clipPath, clipFileRef, clipAnalysis, clipDuration, style
      );
      if (!firstOutputPath) firstOutputPath = outputPath;
      successCount++;
      console.log(`Style ${style.type} (${style.label}) complete: ${outputPath}`);
    } catch (err) {
      console.error(`Style ${style.type} failed:`, err.message);
      errors.push(`${style.type}: ${err.message}`);
    }

    ShortsJobModel.updateProgress(jobId, Math.round(base + perStyle), `done_${style.type}`);
  }

  // Fail the whole job only if ALL styles failed
  if (successCount === 0) {
    throw new Error(`All styles failed: ${errors.join('; ')}`);
  }

  // === Phase 4: Finalize (90-100%) ===
  ShortsJobModel.updateProgress(jobId, 92, 'generating_thumbnail');

  // Generate thumbnail from first successful variant
  const thumbnailPath = join(outputDir, 'thumbnail.jpg');
  const thumbnailTimestamp = Math.max(1, Math.min(clipDuration / 3, clipDuration - 1));
  await VideoProcessor.createThumbnail(firstOutputPath, thumbnailPath, {
    width: 1080,
    height: 1920,
    timestamp: thumbnailTimestamp
  });

  ShortsJobModel.setOutputPath(jobId, firstOutputPath, thumbnailPath);

  // Generate metadata
  ShortsJobModel.updateProgress(jobId, 95, 'generating_metadata');
  const metadata = await voiceoverGenerator.generateMetadata(clipPath, '', { fileRef: clipFileRef });
  ShortsJobModel.setMetadata(jobId, metadata);

  // Clean up shared Gemini file
  await fileManager.deleteFile(clipFile.name).catch(() => {});

  // 100% - Complete
  ShortsJobModel.complete(jobId);
  console.log(`Shorts processing complete for job ${jobId} — ${successCount}/${styles.length} styles succeeded`);
}

export default router;
export { processShort };
