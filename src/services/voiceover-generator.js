import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { config } from '../config.js';
import { VideoProcessor } from './video-processor.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class VoiceoverGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3.0-flash-preview' });
  }

  /**
   * Generate a voiceover script based on clip analysis
   * @param {string} clipPath - Path to video clip
   * @param {object} clipAnalysis - Analysis data from clip selector
   * @param {object} options - Generation options
   * @returns {Promise<string>} - Generated script
   */
  async generateScript(clipPath, clipAnalysis = {}, options = {}) {
    const {
      style = 'casual', // casual, professional, enthusiastic
      duration = 30 // Target duration in seconds
    } = options;

    // Extract a few frames from the clip for context
    const { paths: framePaths } = await VideoProcessor.extractFramesForAnalysis(clipPath, {
      interval: Math.max(2, Math.floor(duration / 8)) // Get ~8 frames
    });

    const selectedFrames = framePaths.slice(0, 6);

    const imageParts = await Promise.all(
      selectedFrames.map(async (path) => {
        const data = await fs.readFile(path);
        return {
          inlineData: {
            mimeType: 'image/jpeg',
            data: data.toString('base64')
          }
        };
      })
    );

    const styleGuides = {
      casual: 'friendly, conversational, like talking to a friend. Use casual language and humor when appropriate.',
      professional: 'informative and polished, like a cooking show host. Clear and educational.',
      enthusiastic: 'excited and energetic, like a food vlogger. Use exclamations and vivid descriptions.'
    };

    const prompt = `You're creating a voiceover script for a YouTube Shorts cooking video (${duration} seconds).

STYLE: ${styleGuides[style] || styleGuides.casual}

CLIP ANALYSIS:
${JSON.stringify(clipAnalysis.frameAnalysis?.slice(0, 5) || [], null, 2)}

Looking at these frames from the cooking video, write a voiceover script that:
1. Matches the pacing of a ${duration}-second video
2. Highlights what's visually interesting
3. Creates a narrative arc (intro → cooking action → satisfying conclusion)
4. Feels natural when spoken aloud
5. Doesn't over-describe what viewers can see

The script should be approximately ${Math.round(duration * 2.5)} words (average speaking pace is ~150 words/minute).

Return ONLY the script text, no formatting, no stage directions, no timestamps. Just the words to be spoken.`;

    const result = await this.model.generateContent([...imageParts, prompt]);
    const script = result.response.text().trim();

    // Clean up temp frames
    const framesDir = framePaths[0]?.split('/').slice(0, -1).join('/');
    if (framesDir) {
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }

    return script;
  }

  /**
   * Generate audio from script using Gemini Live TTS
   * @param {string} script - Text to convert to speech
   * @param {string} outputPath - Path for output audio file
   * @returns {Promise<string>} - Path to generated audio
   */
  async generateAudio(script, outputPath) {
    const audioChunks = [];

    return new Promise((resolve, reject) => {
      const url = `${config.geminiLive.wsEndpoint}?key=${config.geminiApiKey}`;
      const ws = new WebSocket(url);

      let setupComplete = false;
      let resolved = false;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      ws.on('open', () => {
        // Send setup message for audio output
        const setupMessage = {
          setup: {
            model: config.geminiLive.model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: config.geminiLive.voiceName
                  }
                }
              }
            }
          }
        };
        ws.send(JSON.stringify(setupMessage));
      });

      ws.on('message', async (data) => {
        const message = JSON.parse(data.toString());

        if (message.setupComplete) {
          setupComplete = true;
          // Send text to be spoken
          const textMessage = {
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{ text: `Please read this script naturally, as a voiceover for a cooking video:\n\n${script}` }]
              }],
              turnComplete: true
            }
          };
          ws.send(JSON.stringify(textMessage));
        }

        if (message.serverContent?.modelTurn) {
          for (const part of message.serverContent.modelTurn.parts || []) {
            if (part.inlineData) {
              const audioData = Buffer.from(part.inlineData.data, 'base64');
              audioChunks.push(audioData);
            }
          }
        }

        if (message.serverContent?.turnComplete) {
          ws.close();
        }
      });

      ws.on('close', async () => {
        cleanup();
        if (resolved) return;
        resolved = true;

        if (audioChunks.length === 0) {
          reject(new Error('No audio data received'));
          return;
        }

        try {
          // Combine all audio chunks
          const combinedPcm = Buffer.concat(audioChunks);

          // Convert PCM to WAV
          const wavBuffer = this._pcmToWav(combinedPcm, config.audio.outputSampleRate);

          // Ensure output directory exists
          const outputDir = outputPath.split('/').slice(0, -1).join('/');
          await fs.mkdir(outputDir, { recursive: true });

          // Write WAV file
          await fs.writeFile(outputPath, wavBuffer);
          resolve(outputPath);
        } catch (err) {
          reject(new Error(`Failed to save audio: ${err.message}`));
        }
      });

      ws.on('error', (error) => {
        cleanup();
        if (resolved) return;
        resolved = true;
        reject(new Error(`WebSocket error: ${error.message}`));
      });

      // Timeout after 60 seconds
      timeoutId = setTimeout(() => {
        if (!resolved && ws.readyState === WebSocket.OPEN) {
          resolved = true;
          ws.close();
          reject(new Error('Audio generation timeout'));
        }
      }, 60000);
    });
  }

  /**
   * Convert raw PCM data to WAV format
   * @param {Buffer} pcmBuffer - Raw PCM audio data
   * @param {number} sampleRate - Sample rate of the audio
   * @returns {Buffer} - WAV formatted audio
   */
  _pcmToWav(pcmBuffer, sampleRate) {
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const buffer = Buffer.alloc(totalSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(totalSize - 8, 4);
    buffer.write('WAVE', 8);

    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(buffer, 44);

    return buffer;
  }

  /**
   * Full pipeline: generate script and audio
   * @param {string} clipPath - Path to video clip
   * @param {object} clipAnalysis - Analysis data from clip selector
   * @param {string} outputDir - Directory for output files
   * @param {object} options - Generation options
   * @returns {Promise<{script: string, audioPath: string}>}
   */
  async generate(clipPath, clipAnalysis, outputDir, options = {}) {
    // Generate script
    const script = await this.generateScript(clipPath, clipAnalysis, options);

    // Generate audio
    const audioPath = join(outputDir, 'voiceover.wav');
    await this.generateAudio(script, audioPath);

    return { script, audioPath };
  }

  /**
   * Generate YouTube metadata (title, description, tags)
   * @param {string} script - Voiceover script
   * @param {object} clipAnalysis - Clip analysis data
   * @returns {Promise<{title: string, description: string, tags: string[]}>}
   */
  async generateMetadata(script, clipAnalysis = {}) {
    const prompt = `Generate YouTube Shorts metadata for this cooking video.

VOICEOVER SCRIPT:
${script}

CLIP HIGHLIGHTS:
${JSON.stringify(clipAnalysis.frameAnalysis?.filter(f => f.isHighlight)?.slice(0, 3) || [], null, 2)}

Generate metadata optimized for YouTube Shorts discovery:

Return JSON only:
{
  "title": "Catchy title under 70 chars, include cooking-related keywords",
  "description": "2-3 sentence description with relevant hashtags",
  "tags": ["array", "of", "relevant", "tags", "max", "10"]
}`;

    const result = await this.model.generateContent(prompt);
    const text = result.response.text();

    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      // Fallback metadata
      return {
        title: 'Quick Cooking Moment',
        description: 'A delicious cooking moment captured on video. #cooking #shorts #food',
        tags: ['cooking', 'shorts', 'food', 'recipe', 'kitchen', 'homemade']
      };
    }
  }
}
