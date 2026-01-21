/**
 * Media utilities for audio capture and playback
 */

class AudioCapture {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.stream = null;
    this.audioContext = null;
    this.workletNode = null;
    this.onAudioData = null;
    this.isCapturing = false;
  }

  async start() {
    if (this.isCapturing) return;

    try {
      // Get microphone access
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: this.sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      // Create audio context
      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });

      // Create source from stream
      const source = this.audioContext.createMediaStreamSource(this.stream);

      // Use ScriptProcessor for compatibility (AudioWorklet is better but more complex to set up)
      const bufferSize = 4096;
      const processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      processor.onaudioprocess = (event) => {
        if (!this.isCapturing) return;

        const inputData = event.inputBuffer.getChannelData(0);

        // Convert float32 to int16
        const int16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        if (this.onAudioData) {
          this.onAudioData(int16Data.buffer);
        }
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);

      this.processor = processor;
      this.source = source;
      this.isCapturing = true;

      console.log('Audio capture started');
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      throw error;
    }
  }

  stop() {
    this.isCapturing = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('Audio capture stopped');
  }
}

class AudioPlayer {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 24000;
    this.audioContext = null;
    this.audioQueue = [];
    this.isPlaying = false;
  }

  init() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    }
  }

  /**
   * Add audio data to the playback queue
   * @param {ArrayBuffer} pcmData - Raw PCM audio data (int16)
   */
  enqueue(pcmData) {
    this.init();

    // Convert int16 to float32
    const int16Array = new Int16Array(pcmData);
    const float32Array = new Float32Array(int16Array.length);

    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }

    // Create audio buffer
    const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    this.audioQueue.push(audioBuffer);

    if (!this.isPlaying) {
      this.playNext();
    }
  }

  playNext() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const buffer = this.audioQueue.shift();

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    source.onended = () => {
      this.playNext();
    };

    source.start();
  }

  clear() {
    this.audioQueue = [];
    this.isPlaying = false;
  }

  close() {
    this.clear();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

// Export for use in other scripts
window.AudioCapture = AudioCapture;
window.AudioPlayer = AudioPlayer;
