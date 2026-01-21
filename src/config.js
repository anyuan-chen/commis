import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY,
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,

  paths: {
    root: join(__dirname, '..'),
    uploads: join(__dirname, '..', 'uploads'),
    output: join(__dirname, '..', 'output'),
    websites: join(__dirname, '..', 'output', 'websites'),
    brochures: join(__dirname, '..', 'output', 'brochures'),
    images: join(__dirname, '..', 'output', 'images'),
    public: join(__dirname, '..', 'public'),
    db: join(__dirname, '..', 'data')
  },

  geminiLive: {
    wsEndpoint: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    model: 'models/gemini-2.5-flash-native-audio-preview',
    voiceName: 'Puck'
  },

  audio: {
    inputSampleRate: 16000,
    outputSampleRate: 24000
  }
};
