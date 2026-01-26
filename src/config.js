import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,

  paths: {
    root: join(__dirname, '..'),
    uploads: join(__dirname, '..', 'uploads'),
    output: join(__dirname, '..', 'output'),
    websites: join(__dirname, '..', 'output', 'websites'),
    brochures: join(__dirname, '..', 'output', 'brochures'),
    images: join(__dirname, '..', 'output', 'images'),
    shorts: join(__dirname, '..', 'output', 'shorts'),
    public: join(__dirname, '..', 'public'),
    db: join(__dirname, '..', 'data')
  },

  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/api/youtube/callback'
  },

  geminiLive: {
    wsEndpoint: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    voiceName: 'Puck'
  },

  audio: {
    inputSampleRate: 16000,
    outputSampleRate: 24000
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
  },

  google: {
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY
  },

  googleAds: {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    redirectUri: process.env.GOOGLE_ADS_REDIRECT_URI || 'http://localhost:3000/api/google-ads/callback'
  }
};
