import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { promises as fs } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { config } from '../config.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const fileManager = new GoogleAIFileManager(config.geminiApiKey);

export class VoiceoverGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  /**
   * Generate a voiceover script by watching the actual video
   * @param {string} clipPath - Path to video clip
   * @param {object} clipAnalysis - Analysis data (for duration info)
   * @param {object} options - Generation options
   * @returns {Promise<string>} - Generated script
   */
  async generateScript(clipPath, clipAnalysis = {}, options = {}) {
    const {
      style = 'casual', // casual, professional, enthusiastic
      duration = clipAnalysis.duration || 30
    } = options;

    // Upload video to Gemini
    console.log('Uploading clip to Gemini for script generation...');
    const uploadResult = await fileManager.uploadFile(clipPath, {
      mimeType: this._getMimeType(clipPath),
      displayName: 'cooking-clip'
    });

    // Wait for processing
    let file = uploadResult.file;
    while (file.state === 'PROCESSING') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      file = await fileManager.getFile(file.name);
    }

    if (file.state === 'FAILED') {
      throw new Error('Video processing failed');
    }

    const styleGuides = {
      casual: 'friendly and conversational, like talking to a friend',
      professional: 'polished and informative, like a cooking show host',
      enthusiastic: 'excited and energetic, like a food vlogger'
    };

    const prompt = `Watch this cooking video and write a voiceover script for it.

DURATION: ${Math.round(duration)} seconds
STYLE: ${styleGuides[style] || styleGuides.casual}

Write a script that:
- Matches the video's pacing and timing
- Narrates what's happening without over-describing the obvious
- Has a hook at the start, describes the action, ends with a satisfying conclusion
- Sounds natural when spoken aloud
- Is about ${Math.round(duration * 2.5)} words (~150 words/minute speaking pace)

Return ONLY the script. No formatting, no timestamps, no stage directions.`;

    const result = await this.model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      prompt
    ]);

    // Clean up
    await fileManager.deleteFile(file.name).catch(() => {});

    return result.response.text().trim();
  }

  _getMimeType(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const types = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
    return types[ext] || 'video/mp4';
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
   * Generate YouTube metadata by watching the video
   * @param {string} clipPath - Path to the video clip
   * @param {string} script - Voiceover script (optional, for context)
   * @returns {Promise<{title: string, description: string, tags: string[]}>}
   */
  async generateMetadata(clipPath, script = '') {
    // Upload video
    const uploadResult = await fileManager.uploadFile(clipPath, {
      mimeType: this._getMimeType(clipPath),
      displayName: 'cooking-clip-metadata'
    });

    let file = uploadResult.file;
    while (file.state === 'PROCESSING') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      file = await fileManager.getFile(file.name);
    }

    if (file.state === 'FAILED') {
      throw new Error('Video processing failed');
    }

    const prompt = `Watch this cooking video and generate YouTube Shorts metadata.

${script ? `VOICEOVER SCRIPT: ${script}` : ''}

Return JSON only:
{
  "title": "Catchy title under 70 chars with cooking keywords",
  "description": "2-3 sentences with hashtags",
  "tags": ["relevant", "tags", "max", "10"]
}`;

    const result = await this.model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      prompt
    ]);

    await fileManager.deleteFile(file.name).catch(() => {});

    const text = result.response.text();
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return {
        title: 'Quick Cooking Moment',
        description: 'A delicious cooking moment. #cooking #shorts #food',
        tags: ['cooking', 'shorts', 'food', 'recipe', 'kitchen']
      };
    }
  }
}
