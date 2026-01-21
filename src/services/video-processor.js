import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';

// Set ffmpeg path from npm package
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export class VideoProcessor {
  /**
   * Extract frames from a video file at specified intervals
   * @param {string} videoPath - Path to the video file
   * @param {object} options - Extraction options
   * @returns {Promise<string[]>} - Array of paths to extracted frames
   */
  static async extractFrames(videoPath, options = {}) {
    const {
      interval = 2, // Extract a frame every N seconds
      maxFrames = 30, // Maximum number of frames to extract
      outputDir = null
    } = options;

    const framesDir = outputDir || join(config.paths.images, uuidv4());
    await fs.mkdir(framesDir, { recursive: true });

    return new Promise((resolve, reject) => {
      const frames = [];

      // First, get video duration
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to probe video: ${err.message}`));
          return;
        }

        const duration = metadata.format.duration;
        const frameCount = Math.min(Math.ceil(duration / interval), maxFrames);
        let processedCount = 0;

        ffmpeg(videoPath)
          .outputOptions([
            `-vf fps=1/${interval}`, // Extract 1 frame every N seconds
            '-frames:v', String(frameCount)
          ])
          .output(join(framesDir, 'frame_%04d.jpg'))
          .on('end', async () => {
            // Read directory to get all frame paths
            const files = await fs.readdir(framesDir);
            const framePaths = files
              .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
              .sort()
              .map(f => join(framesDir, f));

            resolve(framePaths);
          })
          .on('error', (err) => {
            reject(new Error(`Frame extraction failed: ${err.message}`));
          })
          .run();
      });
    });
  }

  /**
   * Extract key frames that are visually distinct
   * Uses scene change detection for better frame selection
   */
  static async extractKeyFrames(videoPath, options = {}) {
    const {
      maxFrames = 20,
      threshold = 0.3, // Scene change threshold
      outputDir = null
    } = options;

    const framesDir = outputDir || join(config.paths.images, uuidv4());
    await fs.mkdir(framesDir, { recursive: true });

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          `-vf select='gt(scene,${threshold})',showinfo`,
          '-vsync vfr',
          '-frames:v', String(maxFrames)
        ])
        .output(join(framesDir, 'keyframe_%04d.jpg'))
        .on('end', async () => {
          const files = await fs.readdir(framesDir);
          const framePaths = files
            .filter(f => f.startsWith('keyframe_') && f.endsWith('.jpg'))
            .sort()
            .map(f => join(framesDir, f));

          resolve(framePaths);
        })
        .on('error', (err) => {
          reject(new Error(`Key frame extraction failed: ${err.message}`));
        })
        .run();
    });
  }

  /**
   * Get video metadata
   */
  static async getMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to get video metadata: ${err.message}`));
          return;
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration,
          width: videoStream?.width,
          height: videoStream?.height,
          fps: videoStream?.r_frame_rate,
          codec: videoStream?.codec_name,
          hasAudio: !!audioStream,
          size: metadata.format.size
        });
      });
    });
  }

  /**
   * Extract a single frame at a specific timestamp
   */
  static async extractFrameAt(videoPath, timestamp, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions(['-frames:v', '1'])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Create a thumbnail from the video
   */
  static async createThumbnail(videoPath, outputPath, options = {}) {
    const { width = 320, height = 180, timestamp = 1 } = options;

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions([
          '-frames:v', '1',
          `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Thumbnail creation failed: ${err.message}`)))
        .run();
    });
  }
}
