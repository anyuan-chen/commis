import { Router } from 'express';
import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai';
import { config } from '../config.js';
import { tools as mcpTools } from '../mcp/tools.js';

const router = Router();
const genAI = new GoogleGenerativeAI(config.geminiApiKey);

// Convert MCP tool schemas to Gemini function declarations
function getGeminiFunctionDeclarations() {
  return mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));
}

// Execute a tool call
async function executeTool(name, args) {
  const tool = mcpTools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await tool.handler(args);
}

// Store conversation history per session (in-memory for now)
const sessions = new Map();

// POST /api/chat
router.post('/', async (req, res) => {
  try {
    const { message, sessionId, fileUrl, fileType } = req.body;

    if (!message && !fileUrl) {
      return res.status(400).json({ error: 'Message or file required' });
    }

    // Get or create session history
    const session = sessionId || crypto.randomUUID();
    if (!sessions.has(session)) {
      sessions.set(session, []);
    }
    const history = sessions.get(session);

    // Build user message parts
    const userParts = [];

    if (fileUrl) {
      // If there's a file, add context about it
      const fileContext = fileType?.startsWith('video')
        ? `[User attached a video file: ${fileUrl}]`
        : `[User attached an image file: ${fileUrl}]`;
      userParts.push({ text: fileContext });
    }

    if (message) {
      userParts.push({ text: message });
    }

    // Add user message to history
    history.push({
      role: 'user',
      parts: userParts
    });

    // Create model with function calling
    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      tools: [{
        functionDeclarations: getGeminiFunctionDeclarations()
      }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.AUTO
        }
      },
      systemInstruction: `You are a helpful restaurant marketing assistant. You help restaurant owners create websites, generate graphics, and manage their online presence.

When a user wants to create content for their restaurant:
1. If they haven't uploaded a video yet and you need restaurant data, ask them to upload a video of their restaurant
2. Use create_restaurant to process their video and extract restaurant data
3. Use create_website to generate and deploy their website
4. Use generate_graphic for social media images
5. Use modify_website for any changes to existing websites

When a file URL is provided like "/uploads/xyz.mp4", use that as the videoUrl parameter for create_restaurant.

Always be concise and helpful. Explain what you're doing when calling tools.`
    });

    // Start chat with history
    const chat = model.startChat({
      history: history.slice(0, -1) // Exclude the message we just added
    });

    // Send message and handle tool calls
    let response = await chat.sendMessage(userParts);
    const toolCalls = [];

    // Loop while there are function calls
    while (response.response.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
      const parts = response.response.candidates[0].content.parts;

      for (const part of parts) {
        if (part.functionCall) {
          const { name, args } = part.functionCall;

          console.log(`Executing tool: ${name}`, args);
          toolCalls.push({ name, args });

          try {
            const result = await executeTool(name, args);

            // Send function response back to model
            response = await chat.sendMessage([{
              functionResponse: {
                name,
                response: result
              }
            }]);

            toolCalls[toolCalls.length - 1].result = result;
          } catch (error) {
            console.error(`Tool ${name} failed:`, error);

            // Send error back to model
            response = await chat.sendMessage([{
              functionResponse: {
                name,
                response: { error: error.message }
              }
            }]);

            toolCalls[toolCalls.length - 1].error = error.message;
          }
        }
      }
    }

    // Get final text response
    const finalText = response.response.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)
      ?.map(p => p.text)
      ?.join('\n') || 'I completed the task.';

    // Add assistant response to history
    history.push({
      role: 'model',
      parts: [{ text: finalText }]
    });

    // Limit history size
    if (history.length > 50) {
      history.splice(0, history.length - 50);
    }

    res.json({
      sessionId: session,
      message: finalText,
      toolCalls
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear session
router.delete('/session/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ success: true });
});

export default router;
