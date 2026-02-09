import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

const AVAILABLE_VOICES = {
  Puck: 'playful, youthful energy — great for fun/quirky content',
  Kore: 'calm, warm, nurturing — perfect for comfort food and tutorials',
  Charon: 'deep, authoritative — works for dramatic reveals and premium dining',
  Fenrir: 'bold, energetic — ideal for hype and fast-paced content',
  Aoede: 'smooth, storytelling quality — great for narrative and emotional content'
};

export class StyleResearcher {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  /**
   * Ask Gemini to recommend 2 short-form styles for this clip
   * @param {object} fileRef - Gemini File API reference { mimeType, uri }
   * @param {object} clipAnalysis - Analysis from clip selector
   * @param {object} options
   * @param {number} options.clipDuration - Duration in seconds
   * @returns {Promise<Array>} - Array of 2 style configs
   */
  async recommendStyles(fileRef, clipAnalysis, { clipDuration = 30 } = {}) {
    try {
      const prompt = `You are a short-form video content strategist who understands what performs well on TikTok, YouTube Shorts, and Instagram Reels.

Watch this cooking clip and recommend exactly 2 styles that would perform well as short-form content.

CLIP INFO:
- Duration: ${Math.round(clipDuration)} seconds
- Analysis: ${clipAnalysis.description || 'cooking content'}

RULES:
1. You MUST recommend exactly 1 style WITH voiceover and 1 style WITHOUT voiceover
2. Each style must have a unique "type" slug (lowercase, hyphenated, e.g. "hype-recipe", "asmr-sizzle", "cozy-tutorial")
3. For voiceover styles, pick ONE voice from this list and write a scriptPrompt that matches:
${Object.entries(AVAILABLE_VOICES).map(([name, desc]) => `   - ${name}: ${desc}`).join('\n')}

Return ONLY valid JSON — no markdown fencing, no explanation. Use this exact schema:

[
  {
    "type": "string (unique slug)",
    "label": "string (human-readable name, 2-4 words)",
    "hasVoiceover": true,
    "scriptPrompt": "string (detailed prompt for generating voiceover script — describe tone, pacing, personality, what to emphasize)",
    "voice": "string (one of: Puck, Kore, Charon, Fenrir, Aoede)",
    "audioMix": { "originalVolume": 0.15, "voiceoverVolume": 1.0 },
    "subtitles": { "fontSize": 52, "uppercase": true, "wordsPerGroup": 3 },
    "audioTreatment": null
  },
  {
    "type": "string (unique slug)",
    "label": "string (human-readable name, 2-4 words)",
    "hasVoiceover": false,
    "scriptPrompt": null,
    "voice": null,
    "audioMix": null,
    "subtitles": null,
    "audioTreatment": "asmr"
  }
]

Be creative with the voiceover style — don't just say "narrated". Think about what angle would make THIS specific clip engaging. Match the voice to the vibe.

For the non-voiceover style, audioTreatment should be "asmr" (reduces speech, keeps cooking sounds) or null (keeps original audio as-is).`;

      const result = await this.model.generateContent([
        { fileData: { mimeType: fileRef.mimeType, fileUri: fileRef.uri } },
        prompt
      ]);

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const styles = JSON.parse(cleaned);

      return this._validateStyles(styles);
    } catch (err) {
      console.warn('Style research failed, using defaults:', err.message);
      return this._getDefaultStyles();
    }
  }

  /**
   * Validate and clamp style configs from Gemini
   */
  _validateStyles(styles) {
    if (!Array.isArray(styles) || styles.length < 2) {
      console.warn('Invalid styles array, using defaults');
      return this._getDefaultStyles();
    }

    const validVoices = Object.keys(AVAILABLE_VOICES);
    const seen = new Set();

    const validated = styles.slice(0, 2).map((style, i) => {
      // Ensure unique type
      let type = String(style.type || `style-${i}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (seen.has(type)) type = `${type}-${i}`;
      seen.add(type);

      const base = {
        type,
        label: String(style.label || type).slice(0, 40),
        hasVoiceover: Boolean(style.hasVoiceover),
      };

      if (base.hasVoiceover) {
        const voice = validVoices.includes(style.voice) ? style.voice : 'Puck';
        const mix = style.audioMix || {};
        const subs = style.subtitles || {};

        return {
          ...base,
          scriptPrompt: String(style.scriptPrompt || 'Write an engaging voiceover script for this cooking clip.'),
          voice,
          audioMix: {
            originalVolume: clamp(Number(mix.originalVolume) || 0.15, 0, 1),
            voiceoverVolume: clamp(Number(mix.voiceoverVolume) || 1.0, 0, 1.5),
          },
          subtitles: {
            fontSize: clamp(Math.round(Number(subs.fontSize) || 52), 24, 80),
            uppercase: subs.uppercase !== false,
            wordsPerGroup: clamp(Math.round(Number(subs.wordsPerGroup) || 3), 1, 5),
          },
          audioTreatment: null,
        };
      } else {
        return {
          ...base,
          scriptPrompt: null,
          voice: null,
          audioMix: null,
          subtitles: null,
          audioTreatment: ['asmr', null].includes(style.audioTreatment) ? style.audioTreatment : 'asmr',
        };
      }
    });

    // Ensure we have 1 voiceover + 1 non-voiceover
    const hasVO = validated.some(s => s.hasVoiceover);
    const hasNonVO = validated.some(s => !s.hasVoiceover);
    if (!hasVO || !hasNonVO) {
      console.warn('Styles missing voiceover/non-voiceover variety, using defaults');
      return this._getDefaultStyles();
    }

    return validated;
  }

  /**
   * Fallback styles matching the original narrated + ASMR behavior
   */
  _getDefaultStyles() {
    return [
      {
        type: 'narrated',
        label: 'Narrated',
        hasVoiceover: true,
        scriptPrompt: 'Write a friendly, conversational voiceover script like talking to a friend. Hook at the start, describe the action, satisfying conclusion.',
        voice: 'Puck',
        audioMix: { originalVolume: 0.3, voiceoverVolume: 1.0 },
        subtitles: { fontSize: 52, uppercase: true, wordsPerGroup: 3 },
        audioTreatment: null,
      },
      {
        type: 'asmr',
        label: 'ASMR Cooking',
        hasVoiceover: false,
        scriptPrompt: null,
        voice: null,
        audioMix: null,
        subtitles: null,
        audioTreatment: 'asmr',
      }
    ];
  }
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
