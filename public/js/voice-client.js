/**
 * Voice client for communicating with the backend WebSocket
 */

class VoiceClient {
  constructor(options = {}) {
    this.restaurantId = options.restaurantId;
    this.ws = null;
    this.isConnected = false;
    this.isListening = false;

    // Audio components
    this.audioCapture = new AudioCapture({ sampleRate: 16000 });
    this.audioPlayer = new AudioPlayer({ sampleRate: 24000 });

    // Event handlers
    this.onReady = options.onReady || (() => {});
    this.onText = options.onText || (() => {});
    this.onToolExecuted = options.onToolExecuted || (() => {});
    this.onError = options.onError || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
  }

  /**
   * Connect to the voice WebSocket
   */
  connect() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/voice?restaurantId=${this.restaurantId}`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('Voice WebSocket connected');
        this.isConnected = true;

        // Send start message to initialize Gemini Live session
        this.ws.send(JSON.stringify({ type: 'start' }));
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);

          if (message.type === 'ready') {
            resolve();
          }
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('Voice WebSocket error:', error);
        this.onError(error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('Voice WebSocket closed');
        this.isConnected = false;
        this.onDisconnected();
      };

      // Set timeout for connection
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Handle incoming messages
   */
  handleMessage(message) {
    switch (message.type) {
      case 'ready':
        console.log('Voice assistant ready');
        this.onReady();
        break;

      case 'audio':
        // Play received audio
        const audioData = this.base64ToArrayBuffer(message.data);
        this.audioPlayer.enqueue(audioData);
        break;

      case 'text':
        this.onText(message.text);
        break;

      case 'toolExecuted':
        console.log('Tool executed:', message.tool, message.result);
        this.onToolExecuted(message.tool, message.args, message.result);
        break;

      case 'error':
        console.error('Voice error:', message.error);
        this.onError(new Error(message.error));
        break;

      case 'geminiDisconnected':
        console.log('Gemini disconnected');
        this.isConnected = false;
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  /**
   * Start listening (capture microphone and send to server)
   */
  async startListening() {
    if (this.isListening || !this.isConnected) return;

    try {
      this.audioCapture.onAudioData = (data) => {
        if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
          const base64 = this.arrayBufferToBase64(data);
          this.ws.send(JSON.stringify({
            type: 'audio',
            data: base64
          }));
        }
      };

      await this.audioCapture.start();
      this.isListening = true;
      console.log('Started listening');
    } catch (error) {
      console.error('Failed to start listening:', error);
      throw error;
    }
  }

  /**
   * Stop listening
   */
  stopListening() {
    if (!this.isListening) return;

    this.audioCapture.stop();
    this.isListening = false;
    console.log('Stopped listening');
  }

  /**
   * Send text message (alternative to voice)
   */
  sendText(text) {
    if (!this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Not connected');
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'text',
      text
    }));
  }

  /**
   * Disconnect from the voice server
   */
  disconnect() {
    this.stopListening();
    this.audioPlayer.close();

    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  // Utility functions
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Export for use in other scripts
window.VoiceClient = VoiceClient;
