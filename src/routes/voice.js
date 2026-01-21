import { WebSocketServer } from 'ws';
import { GeminiLiveClient, createSystemInstruction, voiceTools } from '../services/gemini-live.js';
import { RestaurantModel } from '../db/models/index.js';
import { ToolExecutor } from '../tools/index.js';
import { WebsiteGenerator } from '../services/website-generator.js';
import { BrochureGenerator } from '../services/brochure-generator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { ImageGenerator } from '../services/image-generator.js';

/**
 * Setup WebSocket server for voice interactions
 */
export function setupVoiceWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/api/voice' });

  wss.on('connection', (ws, req) => {
    console.log('Voice client connected');

    // Parse restaurant ID from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const restaurantId = url.searchParams.get('restaurantId');

    if (!restaurantId) {
      ws.send(JSON.stringify({ error: 'Missing restaurantId parameter' }));
      ws.close();
      return;
    }

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      ws.send(JSON.stringify({ error: 'Restaurant not found' }));
      ws.close();
      return;
    }

    // Create tool executor with generators
    const toolExecutor = new ToolExecutor(restaurantId);
    toolExecutor.setWebsiteGenerator(new WebsiteGenerator());
    toolExecutor.setBrochureGenerator(new BrochureGenerator());
    toolExecutor.setCloudflareDeployer(new CloudflareDeployer());
    toolExecutor.setImageGenerator(new ImageGenerator({ pro: false }));

    // Create Gemini Live client
    let geminiClient = null;

    // Handle messages from the browser client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'start':
            // Initialize Gemini Live connection
            geminiClient = new GeminiLiveClient(
              restaurantId,
              voiceTools,
              async (callId, toolName, args) => {
                const result = await toolExecutor.execute(toolName, args);
                // Notify browser client of tool execution
                ws.send(JSON.stringify({
                  type: 'toolExecuted',
                  tool: toolName,
                  args,
                  result
                }));
                return result;
              }
            );

            // Set up response handlers
            geminiClient.onAudioResponse = (audioData, mimeType) => {
              ws.send(JSON.stringify({
                type: 'audio',
                data: audioData.toString('base64'),
                mimeType
              }));
            };

            geminiClient.onTextResponse = (text) => {
              ws.send(JSON.stringify({
                type: 'text',
                text
              }));
            };

            geminiClient.onError = (error) => {
              ws.send(JSON.stringify({
                type: 'error',
                error: error.message
              }));
            };

            geminiClient.onClose = () => {
              ws.send(JSON.stringify({
                type: 'geminiDisconnected'
              }));
            };

            // Connect to Gemini Live
            const systemInstruction = createSystemInstruction(restaurant);
            await geminiClient.connect(systemInstruction);

            ws.send(JSON.stringify({
              type: 'ready',
              message: 'Voice assistant ready'
            }));
            break;

          case 'audio':
            // Forward audio to Gemini
            if (geminiClient && geminiClient.isConnected) {
              const audioBuffer = Buffer.from(message.data, 'base64');
              geminiClient.sendAudio(audioBuffer);
            }
            break;

          case 'text':
            // Send text message to Gemini
            if (geminiClient && geminiClient.isConnected) {
              geminiClient.sendText(message.text);
            }
            break;

          case 'stop':
            // Close Gemini connection
            if (geminiClient) {
              geminiClient.close();
              geminiClient = null;
            }
            break;

          default:
            console.log('Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('Voice WebSocket error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    });

    ws.on('close', () => {
      console.log('Voice client disconnected');
      if (geminiClient) {
        geminiClient.close();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      if (geminiClient) {
        geminiClient.close();
      }
    });
  });

  return wss;
}
