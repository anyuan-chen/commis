import WebSocket from 'ws';
import { config } from '../config.js';

/**
 * Gemini Live WebSocket client for voice interactions
 */
export class GeminiLiveClient {
  constructor(restaurantId, tools, onToolCall) {
    this.restaurantId = restaurantId;
    this.tools = tools;
    this.onToolCall = onToolCall;
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    this.onAudioResponse = null;
    this.onTextResponse = null;
    this.onError = null;
    this.onClose = null;
  }

  /**
   * Connect to Gemini Live API
   */
  async connect(systemInstruction) {
    const apiKey = config.geminiApiKey;
    const url = `${config.geminiLive.wsEndpoint}?key=${apiKey}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log('Connected to Gemini Live');
        this.isConnected = true;

        // Send setup message
        this.sendSetup(systemInstruction);
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data.toString()));
      });

      this.ws.on('error', (error) => {
        console.error('Gemini Live WebSocket error:', error);
        if (this.onError) this.onError(error);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.log('Gemini Live connection closed:', code, reason.toString());
        this.isConnected = false;
        if (this.onClose) this.onClose(code, reason);
      });
    });
  }

  /**
   * Send setup message to initialize session
   */
  sendSetup(systemInstruction) {
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
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        tools: [{
          functionDeclarations: this.tools
        }]
      }
    };

    this.send(setupMessage);
  }

  /**
   * Send audio data to Gemini
   */
  sendAudio(audioData) {
    if (!this.isConnected) return;

    const message = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: `audio/pcm;rate=${config.audio.inputSampleRate}`,
          data: audioData.toString('base64')
        }]
      }
    };

    this.send(message);
  }

  /**
   * Send text message to Gemini
   */
  sendText(text) {
    if (!this.isConnected) return;

    const message = {
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text }]
        }],
        turnComplete: true
      }
    };

    this.send(message);
  }

  /**
   * Send tool response back to Gemini
   */
  sendToolResponse(functionCallId, result) {
    const message = {
      toolResponse: {
        functionResponses: [{
          id: functionCallId,
          name: result.name,
          response: result.response
        }]
      }
    };

    this.send(message);
  }

  /**
   * Handle incoming messages from Gemini
   */
  handleMessage(message) {
    // Setup complete
    if (message.setupComplete) {
      console.log('Gemini Live session setup complete');
      this.sessionId = message.setupComplete.sessionId;
      return;
    }

    // Server content (audio/text response)
    if (message.serverContent) {
      const content = message.serverContent;

      // Handle model turn (response)
      if (content.modelTurn) {
        for (const part of content.modelTurn.parts || []) {
          // Audio response
          if (part.inlineData) {
            const audioData = Buffer.from(part.inlineData.data, 'base64');
            if (this.onAudioResponse) {
              this.onAudioResponse(audioData, part.inlineData.mimeType);
            }
          }

          // Text response
          if (part.text) {
            if (this.onTextResponse) {
              this.onTextResponse(part.text);
            }
          }
        }
      }

      // Turn complete
      if (content.turnComplete) {
        console.log('Turn complete');
      }
    }

    // Tool call request
    if (message.toolCall) {
      const functionCalls = message.toolCall.functionCalls || [];

      for (const call of functionCalls) {
        console.log('Tool call:', call.name, call.args);

        if (this.onToolCall) {
          this.onToolCall(call.id, call.name, call.args)
            .then(result => {
              this.sendToolResponse(call.id, {
                name: call.name,
                response: result
              });
            })
            .catch(error => {
              this.sendToolResponse(call.id, {
                name: call.name,
                response: { error: error.message }
              });
            });
        }
      }
    }

    // Interrupted
    if (message.serverContent?.interrupted) {
      console.log('Response interrupted');
    }
  }

  /**
   * Send a message through the WebSocket
   */
  send(message) {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Close the connection
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.isConnected = false;
    }
  }
}

/**
 * Create system instruction for restaurant assistant
 */
export function createSystemInstruction(restaurantData) {
  return `You are a friendly and helpful restaurant marketing assistant. You're helping the user create marketing materials for their restaurant.

CURRENT RESTAURANT DATA:
${JSON.stringify(restaurantData, null, 2)}

YOUR CAPABILITIES:
1. Update restaurant information (name, description, hours, contact info)
2. Edit menu items (add, update, remove dishes and prices)
3. Manage photos (add photos, set primary image)
4. Customize website style (colors, themes, layout)
5. Modify brochure design
6. Deploy website to the internet
7. Regenerate marketing materials

GUIDELINES:
- Be conversational and helpful
- Ask clarifying questions if the user's request is unclear
- Confirm changes before making them for important updates
- Suggest improvements to make their marketing materials better
- Keep responses concise since this is a voice interface

When the user asks you to make changes, use the appropriate tool to update the data. Always confirm what you changed.

If asked about missing information (like address or phone number), ask the user to provide it.`;
}

/**
 * Tool definitions for Gemini Live
 */
export const voiceTools = [
  {
    name: 'updateRestaurantInfo',
    description: 'Update restaurant information like name, tagline, description, address, phone, email, or hours',
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          enum: ['name', 'tagline', 'description', 'address', 'phone', 'email', 'cuisineType'],
          description: 'The field to update'
        },
        value: {
          type: 'string',
          description: 'The new value for the field'
        }
      },
      required: ['field', 'value']
    }
  },
  {
    name: 'updateHours',
    description: 'Update restaurant operating hours',
    parameters: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
          description: 'Day of the week'
        },
        hours: {
          type: 'string',
          description: 'Operating hours, e.g., "9am-10pm" or "closed"'
        }
      },
      required: ['day', 'hours']
    }
  },
  {
    name: 'addMenuItem',
    description: 'Add a new item to the menu',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the dish'
        },
        description: {
          type: 'string',
          description: 'Description of the dish'
        },
        price: {
          type: 'number',
          description: 'Price of the dish'
        },
        category: {
          type: 'string',
          description: 'Menu category (e.g., Appetizers, Main Dishes, Desserts)'
        }
      },
      required: ['name', 'price', 'category']
    }
  },
  {
    name: 'updateMenuItem',
    description: 'Update an existing menu item',
    parameters: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Name of the item to update'
        },
        field: {
          type: 'string',
          enum: ['name', 'description', 'price'],
          description: 'Field to update'
        },
        value: {
          type: 'string',
          description: 'New value (use string for price too)'
        }
      },
      required: ['itemName', 'field', 'value']
    }
  },
  {
    name: 'removeMenuItem',
    description: 'Remove an item from the menu',
    parameters: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Name of the item to remove'
        }
      },
      required: ['itemName']
    }
  },
  {
    name: 'editWebsiteStyle',
    description: 'Change the website style or colors',
    parameters: {
      type: 'object',
      properties: {
        styleTheme: {
          type: 'string',
          enum: ['modern', 'rustic', 'vibrant'],
          description: 'Overall style theme'
        },
        primaryColor: {
          type: 'string',
          description: 'Primary color as hex code (e.g., #2563eb)'
        }
      }
    }
  },
  {
    name: 'regenerateWebsite',
    description: 'Regenerate the website with current data',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'regenerateBrochure',
    description: 'Regenerate the brochure with current data',
    parameters: {
      type: 'object',
      properties: {
        layout: {
          type: 'string',
          enum: ['portrait', 'landscape'],
          description: 'Brochure orientation'
        }
      }
    }
  },
  {
    name: 'deployWebsite',
    description: 'Deploy the website to Cloudflare Pages',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'getRestaurantInfo',
    description: 'Get current restaurant information',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'addNote',
    description: 'Add a note, announcement, or special notice to display on the website (e.g., holiday closures, special events, temporary changes)',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The note content to display'
        },
        expiresAt: {
          type: 'string',
          description: 'When the note should auto-remove (ISO date like "2024-12-26" for day after Christmas, or omit for permanent)'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'removeNote',
    description: 'Remove a note from the website',
    parameters: {
      type: 'object',
      properties: {
        searchText: {
          type: 'string',
          description: 'Part of the note text to find and remove'
        }
      },
      required: ['searchText']
    }
  },
  {
    name: 'generateSocialGraphic',
    description: 'Generate a social media graphic/post image for the restaurant',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['instagram', 'facebook', 'twitter', 'story'],
          description: 'Social media platform (affects aspect ratio)'
        },
        theme: {
          type: 'string',
          enum: ['promotion', 'announcement', 'menu-highlight', 'holiday'],
          description: 'Type of post'
        },
        customText: {
          type: 'string',
          description: 'Custom text to include in the graphic'
        }
      },
      required: ['platform']
    }
  },
  {
    name: 'generatePromoGraphic',
    description: 'Generate a promotional flyer or graphic for a special offer or event',
    parameters: {
      type: 'object',
      properties: {
        promoText: {
          type: 'string',
          description: 'The promotion text, e.g., "20% off this weekend!"'
        },
        eventName: {
          type: 'string',
          description: 'Name of event if applicable, e.g., "Wine Wednesday"'
        },
        date: {
          type: 'string',
          description: 'Date of the event/promotion'
        }
      }
    }
  },
  {
    name: 'generateHolidayGraphic',
    description: 'Generate a holiday or seasonal graphic',
    parameters: {
      type: 'object',
      properties: {
        holiday: {
          type: 'string',
          enum: ['christmas', 'thanksgiving', 'valentines', 'newyear', 'halloween', 'easter', 'july4th'],
          description: 'Which holiday'
        },
        message: {
          type: 'string',
          description: 'Custom holiday message to include'
        }
      },
      required: ['holiday']
    }
  },
  {
    name: 'generateMenuGraphic',
    description: 'Generate a visual menu graphic/image',
    parameters: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: ['elegant', 'casual', 'bold', 'minimal'],
          description: 'Design style for the menu'
        },
        category: {
          type: 'string',
          description: 'Specific menu category to feature, or omit for full menu'
        }
      }
    }
  }
];
