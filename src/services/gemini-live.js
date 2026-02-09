import WebSocket from 'ws';
import { config } from '../config.js';
import { ReviewDigestModel, ReviewModel } from '../db/models/index.js';

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
    this.onInputTranscript = null;
    this.onOutputTranscript = null;
    this.onTurnComplete = null;
    this.onModelTurnStart = null;
    this.onError = null;
    this.onClose = null;
    this._modelTurnActive = false;
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
        }],
        outputAudioTranscription: {},
        inputAudioTranscription: {}
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

      // User speech transcript
      if (content.inputTranscription?.text) {
        if (this.onInputTranscript) this.onInputTranscript(content.inputTranscription.text);
      }

      // Model speech transcript (output transcription)
      const outputTranscript = content.outputTranscription || content.output_transcription;
      if (outputTranscript?.text) {
        if (this.onOutputTranscript) this.onOutputTranscript(outputTranscript.text);
      }

      // Handle model turn (response)
      if (content.modelTurn) {
        // Signal model started responding (first chunk of a new turn)
        if (!this._modelTurnActive) {
          this._modelTurnActive = true;
          if (this.onModelTurnStart) this.onModelTurnStart();
        }

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
        this._modelTurnActive = false;
        if (this.onTurnComplete) this.onTurnComplete();
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
  // Get latest review digest if available
  let reviewSection = '';
  const latestDigest = ReviewDigestModel.getLatest(restaurantData.id);

  if (latestDigest && latestDigest.reviewCount > 0) {
    const stats = ReviewModel.getStats(restaurantData.id);
    reviewSection = `

RECENT CUSTOMER REVIEWS DIGEST (${latestDigest.periodStart?.slice(0, 10)} to ${latestDigest.periodEnd?.slice(0, 10)}):
- Reviews analyzed: ${latestDigest.reviewCount}
- Average rating: ${latestDigest.avgRating?.toFixed(1) || 'N/A'}/5
- Total reviews in database: ${stats?.total_reviews || 0}

Summary: ${latestDigest.sentimentSummary}

Top complaints to address:
${latestDigest.commonComplaints?.slice(0, 3).map(c => `- [${c.severity}] ${c.theme}`).join('\n') || '- None identified'}

What customers love:
${latestDigest.praiseThemes?.slice(0, 3).map(p => `- ${p.theme} (${p.count} mentions)`).join('\n') || '- No data yet'}

Suggested actions:
${latestDigest.suggestedActions?.slice(0, 2).map(a => `- [${a.priority}] ${a.action}`).join('\n') || '- None yet'}

PROACTIVELY mention review insights when relevant. For example:
- If user asks about improvements: reference the complaints and suggested actions
- If user seems unsure what to work on: suggest addressing top complaints
- If user wants to promote something: mention what customers already love`;
  }

  return `You are a friendly and helpful restaurant marketing assistant. You're helping the user create marketing materials for their restaurant.

CURRENT RESTAURANT DATA:
${JSON.stringify(restaurantData, null, 2)}
${reviewSection}

YOUR CAPABILITIES:
1. Update restaurant information (name, description, hours, contact info)
2. Edit menu items (add, update, remove dishes and prices) — the website auto-updates and deploys
3. Customize website style (colors, themes, layout)
4. Modify the website with natural language (modify_website) — for free-form changes
5. Create YouTube Shorts from cooking videos (create_youtube_short) — ask user to upload a video
6. Generate and deploy a website (create_website)
7. Regenerate marketing materials
8. Get review insights and digest summaries
9. Get Google Ads suggestions (suggest_google_ads)

GUIDELINES:
- Be conversational and helpful
- Keep responses concise since this is a voice interface
- When adding a menu item, ALWAYS ask the user for the price and category before calling addMenuItem. Never guess or make up a price
- When the user wants to create a Short, immediately call create_youtube_short (even without a videoUrl) — the system will prompt the user to upload a video
- When you add/update/remove menu items, the website updates automatically — tell the user their site is live
- Proactively share review insights when they're relevant to what the user is working on
- After a tool completes, keep your response very brief. Do NOT repeat URLs or links — the UI already shows clickable result cards
- When shorts are created, briefly mention the 2 styles that were chosen and why they fit (e.g. "I went with a high-energy narration with Fenrir's voice to match the fast plating, and a cinematic ASMR version to highlight those sizzling sounds"). Keep it to 1-2 sentences

When the user asks you to make changes, use the appropriate tool to update the data. Always confirm what you changed.`;
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
  },
  {
    name: 'generateTestimonialGraphic',
    description: 'Generate a testimonial graphic featuring a customer review quote with star rating',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['instagram', 'facebook', 'twitter', 'story'],
          description: 'Target platform (affects aspect ratio)'
        },
        style: {
          type: 'string',
          enum: ['elegant', 'bold', 'minimal', 'warm'],
          description: 'Design style for the testimonial graphic'
        }
      }
    }
  },
  {
    name: 'getReviewDigest',
    description: 'Get the latest review digest with sentiment analysis, complaints, praise, and suggested actions',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'getReviewStats',
    description: 'Get quick review statistics like total count, average rating, and sentiment breakdown',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to analyze (default: 30)'
        }
      }
    }
  }
];
