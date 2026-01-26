import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { tools } from './tools.js';

/**
 * Set up MCP server with Express integration
 */
export function setupMcp(app) {
  // Store active transports for message routing
  const transports = new Map();

  // Create MCP server
  const server = new McpServer({
    name: 'videoresto',
    version: '1.0.0'
  });

  // Register all meta-tools with the MCP server
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args) => {
        try {
          const result = await tool.handler(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true
          };
        }
      }
    );
  }

  // SSE endpoint for MCP connections
  app.get('/mcp', async (req, res) => {
    console.log('MCP: New SSE connection');

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Create SSE transport
    const transport = new SSEServerTransport('/mcp/messages', res);
    const sessionId = Date.now().toString();
    transports.set(sessionId, transport);

    // Send session ID to client
    res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

    // Connect transport to server
    await server.connect(transport);

    // Clean up on disconnect
    req.on('close', () => {
      console.log('MCP: SSE connection closed');
      transports.delete(sessionId);
    });
  });

  // Message endpoint for receiving MCP messages
  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);

    if (!transport) {
      return res.status(400).json({ error: 'Invalid session' });
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error('MCP message error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // List available tools (convenience endpoint)
  app.get('/mcp/tools', (req, res) => {
    res.json({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    });
  });

  // Direct tool call endpoint (for testing without full MCP protocol)
  app.post('/mcp/call', async (req, res) => {
    const { tool: toolName, args } = req.body;

    if (!toolName) {
      return res.status(400).json({ error: 'tool name is required' });
    }

    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      return res.status(404).json({ error: `Tool not found: ${toolName}` });
    }

    try {
      console.log(`MCP: Calling tool ${toolName} with args:`, args);
      const result = await tool.handler(args || {});
      console.log(`MCP: Tool ${toolName} completed successfully`);
      res.json({ result });
    } catch (error) {
      console.error(`MCP: Tool ${toolName} failed:`, error);
      res.status(500).json({ error: error.message });
    }
  });

  console.log('MCP: Server initialized with tools:', tools.map(t => t.name).join(', '));
}
