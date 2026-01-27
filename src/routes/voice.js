import { WebSocketServer } from 'ws';
import { GeminiLiveClient, createSystemInstruction, voiceTools } from '../services/gemini-live.js';
import { RestaurantModel } from '../db/models/index.js';
import { ToolExecutor } from '../tools/index.js';
import { WebsiteGenerator } from '../services/website-generator.js';
import { BrochureGenerator } from '../services/brochure-generator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { ImageGenerator } from '../services/image-generator.js';
import { tools as mcpTools } from '../mcp/tools.js';

// Convert MCP tools to Gemini function declarations
function getMcpToolDeclarations() {
  return mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));
}

// Execute MCP tool
async function executeMcpTool(name, args) {
  const tool = mcpTools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return await tool.handler(args);
}

// System instruction for general assistant mode (no restaurant context)
const GENERAL_SYSTEM_INSTRUCTION = `You are a helpful restaurant marketing assistant. You help restaurant owners create websites, generate graphics, manage their online presence, and understand their customer reviews.

CRITICAL: You are speaking out loud to a user. NEVER output internal reasoning, thoughts, or planning. Only speak natural, conversational responses. No asterisks, no "I've determined", no explaining your thought process.

Available tools:
- find_restaurant: Search for existing restaurants by name
- create_restaurant: Process a video to extract restaurant data (menu, photos, name, etc.) - requires videoUrl
- create_website: Generate and deploy a website for a restaurant
- generate_graphic: Create social media graphics
- modify_website: Update an existing website with natural language
- suggest_google_ads: Get Google Ads recommendations
- create_youtube_short: Process cooking videos into YouTube Shorts - requires videoUrl
- fetch_reviews: Pull latest reviews from Google Places
- generate_review_digest: Create AI analysis of reviews with complaints, praise, and actions
- get_review_insights: Get quick stats like average rating and sentiment
- get_latest_digest: Get the most recent review digest
- link_review_platform: Connect a Google Place ID for review tracking

CONVERSATION FLOW:
1. When user wants to create a website/restaurant, say something like: "Sure! Please upload a video of your restaurant."
2. When user wants YouTube Shorts, say: "Great, please upload a cooking video."
3. When you receive "[Video uploaded: /uploads/xxx.mp4]", say "Got it, processing now..." then call the tool
4. Keep responses SHORT - 1-2 sentences max
5. When user asks about reviews or feedback, use get_latest_digest or get_review_insights

IMPORTANT: Always ask for the video BEFORE calling tools that need videoUrl. Use phrases like "please upload" to trigger the file picker.

When you see "[Video uploaded: /uploads/abc123.mp4]", use that exact path as the videoUrl parameter and proceed immediately.

RESTAURANT CONTEXT:
- When you call create_restaurant, it returns a restaurantId. Use that ID for subsequent calls (create_website, generate_graphic, etc.)
- For returning users who say things like "update my website" or "make me a graphic", use find_restaurant to look up their restaurant by name first
- If unclear which restaurant, ask: "Which restaurant?"

PROACTIVE REVIEW INSIGHTS:
- If user asks what they should work on or improve, check their review digest for top complaints
- If user asks what's going well, mention praise themes from reviews
- Offer to pull fresh reviews or generate a new digest when discussing customer feedback

Be conversational and BRIEF. This is a voice interface. Never explain what you're thinking - just respond naturally like a human assistant would.`;

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
    const mode = url.searchParams.get('mode') || 'restaurant'; // 'restaurant' or 'general'

    let restaurant = null;
    let toolExecutor = null;
    let useGeneralMode = mode === 'general' || !restaurantId;

    if (!useGeneralMode) {
      restaurant = RestaurantModel.getFullData(restaurantId);
      if (!restaurant) {
        // Fall back to general mode if restaurant not found
        useGeneralMode = true;
      } else {
        // Create tool executor for restaurant-specific mode
        toolExecutor = new ToolExecutor(restaurantId);
        toolExecutor.setWebsiteGenerator(new WebsiteGenerator());
        toolExecutor.setBrochureGenerator(new BrochureGenerator());
        toolExecutor.setCloudflareDeployer(new CloudflareDeployer());
        toolExecutor.setImageGenerator(new ImageGenerator({ pro: false }));
      }
    }

    // Create Gemini Live client
    let geminiClient = null;

    // Handle messages from the browser client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'start':
            // Choose tools and system instruction based on mode
            const tools = useGeneralMode ? getMcpToolDeclarations() : voiceTools;
            const systemInstruction = useGeneralMode
              ? GENERAL_SYSTEM_INSTRUCTION
              : createSystemInstruction(restaurant);

            // Initialize Gemini Live connection
            geminiClient = new GeminiLiveClient(
              restaurantId || 'general',
              tools,
              async (callId, toolName, args) => {
                // Notify client that tool is starting (for loading UI)
                ws.send(JSON.stringify({
                  type: 'toolStarted',
                  tool: toolName,
                  args
                }));

                let result;
                try {
                  if (useGeneralMode) {
                    result = await executeMcpTool(toolName, args);
                  } else {
                    result = await toolExecutor.execute(toolName, args);
                  }
                } catch (err) {
                  ws.send(JSON.stringify({
                    type: 'toolError',
                    tool: toolName,
                    error: err.message
                  }));
                  throw err;
                }

                // Notify browser client of tool completion
                ws.send(JSON.stringify({
                  type: 'toolCompleted',
                  tool: toolName,
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
            await geminiClient.connect(systemInstruction);

            ws.send(JSON.stringify({
              type: 'ready',
              message: 'Voice assistant ready',
              mode: useGeneralMode ? 'general' : 'restaurant'
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
