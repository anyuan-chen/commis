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
        .outputOptions(['-frames:v', '1', '-q:v', '2'])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
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
  /**
   * Burn subtitles into video using ASS subtitle file
   * @param {string} inputPath - Path to input video
   * @param {string} subtitlePath - Path to ASS subtitle file
   * @param {string} outputPath - Path for output video
   * @returns {Promise<string>} - Path to video with burned subtitles
   */
  static async burnSubtitles(inputPath, subtitlePath, outputPath) {
    // Escape special characters in path for ffmpeg filter
    const escapedSubPath = subtitlePath
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', `ass='${escapedSubPath}'`,
          '-c:v', 'libx264',
          '-c:a', 'copy',
          '-preset', 'fast',
          '-crf', '23'
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Subtitle burn failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Reduce speech frequencies for ASMR effect
   * Splits audio into low (rumble) and high (sizzle/crackle) bands,
   * cutting out the middle frequencies where speech lives (100Hz-3kHz)
   * @param {string} inputPath - Path to input video
   * @param {string} outputPath - Path for output video with reduced speech
   * @returns {Promise<string>} - Path to processed video
   */
  static async reduceSpeech(inputPath, outputPath) {
    // Split audio into two bands and recombine, cutting out speech frequencies:
    // - Low band: below 100Hz (rumble, sizzling bass)
    // - High band: above 3500Hz (crackling, crunching, high sizzle)
    // Speech fundamentals (85-255Hz) and formants (up to 3kHz) are removed
    const complexFilter = [
      '[0:a]asplit=2[low][high]',
      '[low]lowpass=f=100,volume=2[lowout]',
      '[high]highpass=f=3500,volume=1.5[highout]',
      '[lowout][highout]amix=inputs=2:duration=first[aout]'
    ].join(';');

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .complexFilter(complexFilter)
        .outputOptions([
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac'
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Speech reduction failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Create a thumbnail image from a video
   * @param {string} videoPath - Path to video file
   * @param {string} outputPath - Path for output thumbnail
   * @param {object} options - Thumbnail options
   * @returns {Promise<string>} - Path to thumbnail
   */
  static async createThumbnail(videoPath, outputPath, options = {}) {
    const {
      width = 1080,
      height = 1920,
      timestamp = 1
    } = options;

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions([
          '-frames:v', '1',
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
          '-q:v', '2'
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`Thumbnail creation failed: ${err.message}`)))
        .run();
    });
  }

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

}
