import { WebSocketServer } from 'ws';
import { GeminiLiveClient, createSystemInstruction, voiceTools } from '../services/gemini-live.js';
import { RestaurantModel } from '../db/models/index.js';
import { ToolExecutor } from '../tools/index.js';
import { WebsiteGenerator } from '../services/website-generator.js';
import { BrochureGenerator } from '../services/brochure-generator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { ImageGenerator } from '../services/image-generator.js';
import { tools as mcpTools } from '../mcp/tools.js';
import { getStoredTokens } from './youtube-auth.js';

// MCP tools to expose in restaurant mode (beyond voiceTools)
const RESTAURANT_MCP_TOOLS = ['create_youtube_short', 'create_website', 'modify_website', 'suggest_google_ads'];

// Get MCP tool declarations for restaurant mode, stripping restaurantId (auto-injected)
function getRestaurantMcpTools() {
  return mcpTools
    .filter(t => RESTAURANT_MCP_TOOLS.includes(t.name))
    .map(tool => {
      const params = JSON.parse(JSON.stringify(tool.inputSchema));
      if (params.properties?.restaurantId) {
        delete params.properties.restaurantId;
        if (params.required) {
          params.required = params.required.filter(r => r !== 'restaurantId');
        }
      }
      return {
        name: tool.name,
        description: tool.description,
        parameters: params
      };
    });
}

// Execute MCP tool, injecting restaurantId
async function executeMcpTool(name, args, restaurantId) {
  const tool = mcpTools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const mcpArgs = { ...args };
  if (!mcpArgs.restaurantId && restaurantId) mcpArgs.restaurantId = restaurantId;
  return await tool.handler(mcpArgs);
}

/**
 * Setup WebSocket server for voice interactions
 */
export function setupVoiceWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/api/voice' });

  wss.on('connection', (ws, req) => {
    console.log('Voice client connected');

    // Parse query params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const restaurantId = url.searchParams.get('restaurantId');

    if (!restaurantId) {
      ws.send(JSON.stringify({ type: 'error', error: 'restaurantId required' }));
      ws.close();
      return;
    }

    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      ws.send(JSON.stringify({ type: 'error', error: 'Restaurant not found' }));
      ws.close();
      return;
    }

    const toolExecutor = new ToolExecutor(restaurantId);
    toolExecutor.setWebsiteGenerator(new WebsiteGenerator());
    toolExecutor.setBrochureGenerator(new BrochureGenerator());
    toolExecutor.setCloudflareDeployer(new CloudflareDeployer());
    toolExecutor.setImageGenerator(new ImageGenerator({ pro: false }));

    // Create Gemini Live client
    let geminiClient = null;

    // Tools that require video input
    const videoRequiredTools = ['create_youtube_short', 'create_restaurant'];

    // Tools that require YouTube auth for upload
    const youtubeUploadTools = ['create_youtube_short'];

    // Unified pending request state
    const pendingRequest = {
      video: null,  // { callId, toolName, args }
      auth: null    // { callId, toolName, args }
    };

    // Strip URLs from tool results before sending to Gemini — UI shows full results
    function briefResult(result) {
      if (!result) return { success: true };
      const brief = { success: true };
      if (result.title) brief.title = result.title;
      if (result.variants) brief.variantCount = result.variants.length;
      if (result.websiteUrl) brief.websiteReady = true;
      return brief;
    }

    // Execute a tool, trying toolExecutor first then MCP
    async function executeTool(toolName, args) {
      try {
        return await toolExecutor.execute(toolName, args);
      } catch (execErr) {
        if (execErr.message.startsWith('Unknown tool')) {
          return await executeMcpTool(toolName, args, restaurantId);
        }
        throw execErr;
      }
    }

    // Handle video upload completion - execute pending tool independently
    const handleVideoUploaded = async (videoUrl) => {
      if (!pendingRequest.video) return;

      const { toolName, args } = pendingRequest.video;
      pendingRequest.video = null;
      args.videoUrl = videoUrl;

      // Check if YouTube auth is needed before executing
      if (youtubeUploadTools.includes(toolName)) {
        const storedTokens = getStoredTokens();
        if (!storedTokens) {
          ws.send(JSON.stringify({
            type: 'requestYouTubeAuth',
            tool: toolName,
            message: 'Connect YouTube to upload your Short'
          }));
          pendingRequest.auth = { callId: null, toolName, args };
          return;
        }
      }

      ws.send(JSON.stringify({ type: 'toolStarted', tool: toolName, args }));

      try {
        const result = await executeTool(toolName, args);
        ws.send(JSON.stringify({ type: 'toolCompleted', tool: toolName, result }));
        // Notify Gemini so it can comment on the result vocally
        if (geminiClient && geminiClient.isConnected) {
          const summary = result?.title ? `Shorts "${result.title}" created and uploaded.` : 'Shorts created and uploaded.';
          geminiClient.sendText(`[System: ${summary} Let the user know it's done.]`);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'toolError', tool: toolName, error: err.message }));
      }
    };

    // Handle YouTube auth completion - resume pending tool
    const handleAuthComplete = async () => {
      if (!pendingRequest.auth) return;

      const { callId, toolName, args } = pendingRequest.auth;
      pendingRequest.auth = null;

      const tokens = getStoredTokens();
      if (!tokens) {
        ws.send(JSON.stringify({ type: 'error', error: 'YouTube auth failed' }));
        if (geminiClient) {
          geminiClient.sendToolResponse(callId, { name: toolName, response: { error: 'YouTube authentication was not completed' } });
        }
        return;
      }

      ws.send(JSON.stringify({ type: 'toolStarted', tool: toolName, args }));

      try {
        const result = await executeTool(toolName, args);
        ws.send(JSON.stringify({ type: 'toolCompleted', tool: toolName, result }));
        if (geminiClient) {
          geminiClient.sendToolResponse(callId, { name: toolName, response: briefResult(result) });
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'toolError', tool: toolName, error: err.message }));
        if (geminiClient) {
          geminiClient.sendToolResponse(callId, { name: toolName, response: { error: err.message } });
        }
      }
    };

    // Handle messages from the browser client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'start':
            const tools = [...voiceTools, ...getRestaurantMcpTools()];
            const systemInstruction = createSystemInstruction(restaurant);

            // Initialize Gemini Live connection
            geminiClient = new GeminiLiveClient(
              restaurantId,
              tools,
              async (callId, toolName, args) => {
                // Check if tool needs video and none provided
                if (videoRequiredTools.includes(toolName) && !args.videoUrl) {
                  // Show upload widget on client
                  ws.send(JSON.stringify({
                    type: 'requestVideoUpload',
                    tool: toolName
                  }));

                  // Store pending request - will be executed when video is uploaded
                  pendingRequest.video = { toolName, args };

                  // Respond to Gemini's tool call so it can speak to the user
                  geminiClient.sendToolResponse(callId, {
                    name: toolName,
                    response: {
                      status: 'waiting_for_upload',
                      instruction: 'The user needs to upload a cooking video first. An upload button is now on their screen. Ask them to tap it and upload their video so you can create shorts from it.'
                    }
                  });

                  return new Promise(() => {});
                }

                // Check if tool needs YouTube auth and tokens are missing
                if (youtubeUploadTools.includes(toolName) && args.videoUrl) {
                  const storedTokens = getStoredTokens();
                  if (!storedTokens) {
                    ws.send(JSON.stringify({
                      type: 'requestYouTubeAuth',
                      tool: toolName,
                      message: 'Connect YouTube to upload your Short'
                    }));

                    pendingRequest.auth = { callId, toolName, args };
                    return new Promise(() => {});
                  }
                }

                // Notify client that tool is starting (for loading UI)
                ws.send(JSON.stringify({
                  type: 'toolStarted',
                  tool: toolName,
                  args
                }));

                let result;
                try {
                  result = await executeTool(toolName, args);
                } catch (err) {
                  ws.send(JSON.stringify({ type: 'toolError', tool: toolName, error: err.message }));
                  throw err;
                }

                ws.send(JSON.stringify({ type: 'toolCompleted', tool: toolName, result }));
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

            // Native transcription callbacks (kept for models that support it)
            geminiClient.onInputTranscript = (text) => {
              ws.send(JSON.stringify({ type: 'inputTranscript', text }));
            };

            geminiClient.onOutputTranscript = (text) => {
              // Filter out control tokens from native audio model (e.g. <ctrl46>)
              if (text && !text.match(/^<ctrl\d+>$/)) {
                ws.send(JSON.stringify({ type: 'outputTranscript', text }));
              }
            };

            geminiClient.onModelTurnStart = () => {
              ws.send(JSON.stringify({ type: 'modelTurnStart' }));
            };

            geminiClient.onTurnComplete = () => {
              ws.send(JSON.stringify({ type: 'turnComplete' }));
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
            await geminiClient.connect(systemInstruction);

            ws.send(JSON.stringify({
              type: 'ready',
              message: 'Voice assistant ready',
              mode: 'restaurant'
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

          case 'videoUploaded':
            // Video was uploaded, resume pending tool
            if (message.videoUrl) {
              handleVideoUploaded(message.videoUrl);
            }
            break;

          case 'youtubeAuthComplete':
            // YouTube auth completed, resume pending tool
            handleAuthComplete();
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
