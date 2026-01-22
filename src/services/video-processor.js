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

  /**
   * Extract a clip from video between start and end times
   * @param {string} videoPath - Path to source video
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} outputPath - Path for output clip
   * @returns {Promise<string>} - Path to extracted clip
   */
  static async extractClip(videoPath, startTime, endTime, outputPath) {
    const duration = endTime - startTime;

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-preset', 'fast',
          '-crf', '23'
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Clip extraction failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Mix original video audio with voiceover audio
   * @param {string} videoPath - Path to video file
   * @param {string} voiceoverPath - Path to voiceover audio file
   * @param {string} outputPath - Path for output video
   * @param {object} options - Mix options
   * @returns {Promise<string>} - Path to mixed video
   */
  static async mixAudioTracks(videoPath, voiceoverPath, outputPath, options = {}) {
    const {
      originalVolume = 0.3, // Reduce original to 30%
      voiceoverVolume = 1.0 // Voiceover at full volume
    } = options;

    // First check if video has audio
    const metadata = await this.getMetadata(videoPath);

    return new Promise((resolve, reject) => {
      const command = ffmpeg(videoPath).input(voiceoverPath);

      if (metadata.hasAudio) {
        // Mix both audio tracks
        command
          .complexFilter([
            `[0:a]volume=${originalVolume}[a0]`,
            `[1:a]volume=${voiceoverVolume}[a1]`,
            '[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]'
          ])
          .outputOptions([
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-preset', 'fast',
            '-crf', '23',
            '-shortest'
          ]);
      } else {
        // No original audio, just use voiceover
        command
          .outputOptions([
            '-map', '0:v',
            '-map', '1:a',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-preset', 'fast',
            '-crf', '23',
            '-shortest'
          ]);
      }

      command
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Audio mixing failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Convert video to YouTube Shorts format (9:16 aspect ratio, 1080x1920)
   * @param {string} inputPath - Path to input video
   * @param {string} outputPath - Path for output video
   * @param {object} options - Conversion options
   * @returns {Promise<string>} - Path to converted video
   */
  static async convertToShortsFormat(inputPath, outputPath, options = {}) {
    const {
      width = 1080,
      height = 1920,
      method = 'crop' // 'crop' or 'pad'
    } = options;

    // Video filter for 9:16 aspect ratio
    // crop: crops the center of the video to fit
    // pad: adds black bars to fit
    const videoFilter = method === 'crop'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', videoFilter,
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-preset', 'fast',
          '-crf', '23',
          '-r', '30' // 30fps for smooth playback
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Shorts format conversion failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Extract frames at 1-second intervals for clip analysis
   * @param {string} videoPath - Path to video file
   * @param {object} options - Extraction options
   * @returns {Promise<{paths: string[], timestamps: number[]}>}
   */
  static async extractFramesForAnalysis(videoPath, options = {}) {
    const {
      interval = 1, // 1 second intervals
      outputDir = null
    } = options;

    const framesDir = outputDir || join(config.paths.images, uuidv4());
    await fs.mkdir(framesDir, { recursive: true });

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, async (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to probe video: ${err.message}`));
          return;
        }

        const duration = metadata.format.duration;

        ffmpeg(videoPath)
          .outputOptions([
            `-vf fps=1/${interval}`,
            '-q:v', '2' // High quality JPEG
          ])
          .output(join(framesDir, 'frame_%04d.jpg'))
          .on('end', async () => {
            const files = await fs.readdir(framesDir);
            const framePaths = files
              .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
              .sort();

            const timestamps = framePaths.map((_, i) => i * interval);
            const paths = framePaths.map(f => join(framesDir, f));

            resolve({ paths, timestamps, duration });
          })
          .on('error', (err) => {
            reject(new Error(`Frame extraction failed: ${err.message}`));
          })
          .run();
      });
    });
  }
}
