import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';

const execAsync = promisify(exec);

export class SubtitleGenerator {
  constructor() {
    this.whisperPath = 'whisper-cli';
    this.modelPath = '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin';
  }

  /**
   * Transcribe audio using whisper.cpp with word-level timestamps
   * @param {string} audioPath - Path to audio file (must be 16kHz mono WAV)
   * @returns {Promise<{words: Array<{word: string, start: number, end: number}>}>}
   */
  async transcribeWithTimestamps(audioPath) {
    // whisper.cpp needs 16kHz mono WAV, convert if needed
    const wavPath = audioPath.endsWith('.wav') ? audioPath : await this.convertToWav(audioPath);

    // Run whisper-cli with JSON output and word timestamps
    const outputBase = wavPath.replace(/\.[^.]+$/, '');

    try {
      const { stdout, stderr } = await execAsync(
        `${this.whisperPath} -m "${this.modelPath}" -f "${wavPath}" -oj -ml 1 --output-file "${outputBase}"`,
        { timeout: 60000 }
      );

      // Read the JSON output
      const jsonPath = `${outputBase}.json`;
      const jsonContent = await fs.readFile(jsonPath, 'utf-8');
      const result = JSON.parse(jsonContent);

      // Clean up JSON file
      await fs.unlink(jsonPath).catch(() => {});

      // Extract words with timestamps
      // With -ml 1 flag, each segment is a single word/token
      const rawTokens = [];
      for (const segment of result.transcription || []) {
        const text = segment.text;
        if (text && segment.offsets) {
          rawTokens.push({
            word: text,
            start: segment.offsets.from / 1000,
            end: segment.offsets.to / 1000
          });
        }
      }

      // Merge tokens into words (tokens starting with space begin new words)
      const words = this.mergeTokensToWords(rawTokens);

      return {
        text: words.map(w => w.word).join(' '),
        words
      };
    } catch (err) {
      throw new Error(`Whisper transcription failed: ${err.message}`);
    }
  }

  /**
   * Convert audio to 16kHz mono WAV for whisper
   */
  async convertToWav(inputPath) {
    const outputPath = inputPath.replace(/\.[^.]+$/, '_16k.wav');

    await execAsync(
      `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}"`,
      { timeout: 30000 }
    );

    return outputPath;
  }

  /**
   * Generate ASS subtitle file with styled captions
   * @param {Array<{word: string, start: number, end: number}>} words - Word timestamps
   * @param {string} outputPath - Path for output ASS file
   * @param {object} options - Styling options
   */
  async generateSubtitleFile(words, outputPath, options = {}) {
    const {
      wordsPerGroup = 3,
      fontName = 'Montserrat ExtraBold',
      fontSize = 48,
      primaryColor = '&H00FFFFFF', // White
      outlineColor = '&H00000000', // Black outline
      outlineWidth = 4,
      shadowDepth = 2,
      marginV = 120,
      uppercase = true
    } = options;

    // Group words into subtitle segments
    const segments = this.groupWords(words, wordsPerGroup);

    // Generate ASS file content
    const assContent = this.generateASS(segments, {
      fontName,
      fontSize,
      primaryColor,
      outlineColor,
      outlineWidth,
      shadowDepth,
      marginV,
      uppercase
    });

    await fs.writeFile(outputPath, assContent);
    return outputPath;
  }

  /**
   * Merge tokens into words (whisper outputs tokens, not always complete words)
   * Tokens starting with a space indicate a new word
   */
  mergeTokensToWords(tokens) {
    const words = [];
    let currentWord = null;

    for (const token of tokens) {
      const text = token.word;

      // Skip empty tokens or punctuation-only tokens
      if (!text || /^[.,!?;:'"-]+$/.test(text.trim())) {
        continue;
      }

      // If token starts with space, it's a new word
      if (text.startsWith(' ')) {
        if (currentWord) {
          words.push(currentWord);
        }
        currentWord = {
          word: text.trim(),
          start: token.start,
          end: token.end
        };
      } else if (currentWord) {
        // Append to current word (e.g., "to" + "asted" -> "toasted")
        currentWord.word += text;
        currentWord.end = token.end;
      } else {
        // First token (no leading space)
        currentWord = {
          word: text.trim(),
          start: token.start,
          end: token.end
        };
      }
    }

    // Don't forget the last word
    if (currentWord && currentWord.word) {
      words.push(currentWord);
    }

    return words;
  }

  /**
   * Group words into subtitle segments
   */
  groupWords(words, wordsPerGroup) {
    const segments = [];

    for (let i = 0; i < words.length; i += wordsPerGroup) {
      const group = words.slice(i, i + wordsPerGroup);
      if (group.length > 0) {
        segments.push({
          text: group.map(w => w.word).join(' '),
          start: group[0].start,
          end: group[group.length - 1].end
        });
      }
    }

    return segments;
  }

  /**
   * Generate ASS file content
   */
  generateASS(segments, options) {
    const {
      fontName,
      fontSize,
      primaryColor,
      outlineColor,
      outlineWidth,
      shadowDepth,
      marginV,
      uppercase
    } = options;

    const header = `[Script Info]
Title: Auto-generated Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF,${outlineColor},&H00000000,-1,0,0,0,100,100,0,0,1,${outlineWidth},${shadowDepth},2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const events = segments.map(seg => {
      const startTime = this.formatASSTime(seg.start);
      const endTime = this.formatASSTime(seg.end);
      const text = uppercase ? seg.text.toUpperCase() : seg.text;
      return `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}`;
    }).join('\n');

    return header + events + '\n';
  }

  /**
   * Format time for ASS format (H:MM:SS.CC)
   */
  formatASSTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds * 100) % 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  /**
   * Full pipeline: transcribe and generate subtitle file
   */
  async generate(audioPath, outputPath, options = {}) {
    console.log('Transcribing audio with whisper.cpp...');
    const { words } = await this.transcribeWithTimestamps(audioPath);

    if (words.length === 0) {
      console.warn('No words detected in audio');
      return null;
    }

    console.log(`Generating subtitles for ${words.length} words...`);
    await this.generateSubtitleFile(words, outputPath, options);

    return outputPath;
  }
}
