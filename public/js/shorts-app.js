/**
 * Cooking Shorts Generator - Frontend Application
 */

class ShortsApp {
  constructor() {
    this.currentStep = 'select';
    this.currentJobId = null;
    this.selectedVideo = null;
    this.youtubeTokens = null;
    this.pollInterval = null;

    this.init();
  }

  init() {
    // Handle OAuth callback tokens from URL hash
    this.handleOAuthCallback();

    // Load YouTube tokens from localStorage
    this.loadYouTubeTokens();

    // Setup event listeners
    this.setupEventListeners();

    // Update YouTube status display
    this.updateYouTubeStatus();
  }

  handleOAuthCallback() {
    const hash = window.location.hash;

    if (hash.includes('youtube_tokens=')) {
      try {
        const tokenData = hash.split('youtube_tokens=')[1].split('&')[0];
        this.youtubeTokens = JSON.parse(decodeURIComponent(tokenData));
        localStorage.setItem('youtube_tokens', JSON.stringify(this.youtubeTokens));
        window.location.hash = '';
        this.updateYouTubeStatus();
      } catch (e) {
        console.error('Failed to parse YouTube tokens:', e);
      }
    }

    if (hash.includes('auth_error=')) {
      const error = decodeURIComponent(hash.split('auth_error=')[1].split('&')[0]);
      this.showError(`YouTube connection failed: ${error}`);
      window.location.hash = '';
    }
  }

  loadYouTubeTokens() {
    const stored = localStorage.getItem('youtube_tokens');
    if (stored) {
      try {
        this.youtubeTokens = JSON.parse(stored);
      } catch (e) {
        localStorage.removeItem('youtube_tokens');
      }
    }
  }

  setupEventListeners() {
    // Upload area
    const uploadArea = document.getElementById('upload-area');
    const videoInput = document.getElementById('video-input');

    uploadArea.addEventListener('click', () => videoInput.click());
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.handleVideoSelect(e.dataTransfer.files[0]);
      }
    });
    videoInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.handleVideoSelect(e.target.files[0]);
      }
    });

    // Watch folder button
    document.getElementById('watch-folder-btn').addEventListener('click', () => {
      if (typeof VideoWatcher !== 'undefined') {
        VideoWatcher.startWatching(this.handleNewVideo.bind(this));
      } else {
        alert('Folder watching is not supported in this browser');
      }
    });

    // Confirm step buttons
    document.getElementById('cancel-btn').addEventListener('click', () => this.goToStep('select'));
    document.getElementById('confirm-btn').addEventListener('click', () => this.startProcessing());

    // Preview step buttons
    document.getElementById('start-over-btn').addEventListener('click', () => this.reset());
    document.getElementById('upload-youtube-btn').addEventListener('click', () => this.uploadToYouTube());

    // Success step
    document.getElementById('new-short-btn').addEventListener('click', () => this.reset());

    // Error step
    document.getElementById('retry-btn').addEventListener('click', () => this.reset());

    // YouTube status click
    document.getElementById('youtube-status').addEventListener('click', () => this.showYouTubeModal());

    // YouTube modal
    document.getElementById('modal-close-btn').addEventListener('click', () => this.hideYouTubeModal());
    document.getElementById('connect-youtube-btn').addEventListener('click', () => this.connectYouTube());
    document.getElementById('disconnect-youtube-btn').addEventListener('click', () => this.disconnectYouTube());

    // Close modal on backdrop click
    document.getElementById('youtube-modal').addEventListener('click', (e) => {
      if (e.target.id === 'youtube-modal') {
        this.hideYouTubeModal();
      }
    });
  }

  async handleVideoSelect(file) {
    if (!file.type.startsWith('video/')) {
      this.showError('Please select a video file');
      return;
    }

    this.selectedVideo = file;

    // Extract a random frame for cooking detection
    const frame = await this.extractRandomFrame(file);
    document.getElementById('preview-frame').src = frame;

    this.goToStep('confirm');
    this.checkCookingContent(frame);
  }

  handleNewVideo(file) {
    // Called by VideoWatcher when new video is detected
    this.handleVideoSelect(file);
  }

  async extractRandomFrame(videoFile) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      video.preload = 'metadata';
      video.src = URL.createObjectURL(videoFile);

      video.onloadedmetadata = () => {
        // Seek to random position (between 10% and 90% of video)
        const randomTime = video.duration * (0.1 + Math.random() * 0.8);
        video.currentTime = randomTime;
      };

      video.onseeked = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);

        const frameUrl = canvas.toDataURL('image/jpeg', 0.8);
        URL.revokeObjectURL(video.src);
        resolve(frameUrl);
      };
    });
  }

  async checkCookingContent(frameDataUrl) {
    const resultEl = document.getElementById('detection-result');
    const confirmBtn = document.getElementById('confirm-btn');

    resultEl.innerHTML = `
      <span class="detection-icon">?</span>
      <span class="detection-text">Analyzing...</span>
    `;
    confirmBtn.disabled = true;

    try {
      // Convert data URL to blob
      const response = await fetch(frameDataUrl);
      const blob = await response.blob();

      const formData = new FormData();
      formData.append('frame', blob, 'frame.jpg');

      const result = await fetch('/api/shorts/check-cooking', {
        method: 'POST',
        body: formData
      });

      const data = await result.json();

      if (data.isCooking) {
        resultEl.innerHTML = `
          <span class="detection-icon cooking">&#10003;</span>
          <span class="detection-text">Cooking detected! ${data.description}</span>
        `;
        confirmBtn.disabled = false;
      } else {
        resultEl.innerHTML = `
          <span class="detection-icon not-cooking">?</span>
          <span class="detection-text">Not sure if this is cooking. ${data.description}</span>
        `;
        // Still allow processing
        confirmBtn.disabled = false;
      }
    } catch (error) {
      resultEl.innerHTML = `
        <span class="detection-icon error">!</span>
        <span class="detection-text">Could not analyze. Continue anyway?</span>
      `;
      confirmBtn.disabled = false;
    }
  }

  async startProcessing() {
    if (!this.selectedVideo) return;

    this.goToStep('processing');

    try {
      const formData = new FormData();
      formData.append('video', this.selectedVideo);

      const response = await fetch('/api/shorts/process', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      this.currentJobId = data.jobId;
      this.startPolling();
    } catch (error) {
      this.showError(error.message);
    }
  }

  startPolling() {
    this.pollInterval = setInterval(() => this.pollStatus(), 2000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async pollStatus() {
    if (!this.currentJobId) return;

    try {
      const response = await fetch(`/api/shorts/status/${this.currentJobId}`);
      const data = await response.json();

      this.updateProgress(data);

      if (data.status === 'ready') {
        this.stopPolling();
        this.showPreview(data);
      } else if (data.status === 'failed') {
        this.stopPolling();
        this.showError(data.errorMessage || 'Processing failed');
      }
    } catch (error) {
      console.error('Polling error:', error);
    }
  }

  updateProgress(data) {
    const stages = {
      'analyzing': 'Analyzing video content...',
      'clip_extracted': 'Best clip extracted!',
      'generating_script': 'Writing voiceover script...',
      'script_ready': 'Script ready!',
      'generating_voiceover': 'Generating AI voiceover...',
      'voiceover_done': 'Voiceover generated!',
      'mixing_audio': 'Mixing audio tracks...',
      'audio_mixed': 'Audio mixed!',
      'converting_format': 'Converting to Shorts format...',
      'ready': 'Ready for review!'
    };

    document.getElementById('progress-fill').style.width = `${data.progress}%`;
    document.getElementById('progress-text').textContent = `${data.progress}%`;
    document.getElementById('processing-stage').textContent = stages[data.progressStage] || 'Processing...';
  }

  showPreview(data) {
    this.goToStep('preview');

    const video = document.getElementById('preview-video');
    video.src = `/api/shorts/preview/${this.currentJobId}`;

    document.getElementById('video-title').value = data.title || '';
    document.getElementById('video-description').value = data.description || '';
    document.getElementById('video-tags').value = (data.tags || []).join(', ');
    document.getElementById('script-text').textContent = data.script || '';
  }

  async uploadToYouTube() {
    if (!this.youtubeTokens) {
      this.showYouTubeModal();
      return;
    }

    const uploadBtn = document.getElementById('upload-youtube-btn');
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<span class="spinner small"></span> Uploading...';

    try {
      // Save metadata first
      await this.saveMetadata();

      const tokenHeader = btoa(JSON.stringify(this.youtubeTokens));

      const response = await fetch(`/api/shorts/upload-youtube/${this.currentJobId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenHeader}`
        },
        body: JSON.stringify({
          privacyStatus: 'private'
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Update stored tokens if refreshed
      if (data.freshTokens) {
        this.youtubeTokens = data.freshTokens;
        localStorage.setItem('youtube_tokens', JSON.stringify(this.youtubeTokens));
      }

      this.showSuccess(data.videoUrl);
    } catch (error) {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
        Upload to YouTube
      `;
      this.showError(error.message);
    }
  }

  async saveMetadata() {
    const title = document.getElementById('video-title').value;
    const description = document.getElementById('video-description').value;
    const tagsInput = document.getElementById('video-tags').value;
    const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t);

    await fetch(`/api/shorts/metadata/${this.currentJobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, tags })
    });
  }

  showSuccess(videoUrl) {
    this.goToStep('success');
    document.getElementById('youtube-link').href = videoUrl;
  }

  showError(message) {
    this.stopPolling();
    this.goToStep('error');
    document.getElementById('error-message').textContent = message;
  }

  reset() {
    this.stopPolling();
    this.currentJobId = null;
    this.selectedVideo = null;
    document.getElementById('video-input').value = '';
    this.goToStep('select');
  }

  goToStep(step) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById(`step-${step}`).classList.add('active');
    this.currentStep = step;
  }

  // YouTube connection methods

  async updateYouTubeStatus() {
    const statusEl = document.getElementById('youtube-status');
    const dot = statusEl.querySelector('.status-dot');
    const text = statusEl.querySelector('.status-text');

    if (!this.youtubeTokens) {
      dot.className = 'status-dot disconnected';
      text.textContent = 'Not connected';
      return;
    }

    try {
      const tokenHeader = btoa(JSON.stringify(this.youtubeTokens));
      const response = await fetch('/api/youtube/channel', {
        headers: { 'Authorization': `Bearer ${tokenHeader}` }
      });

      if (!response.ok) {
        throw new Error('Invalid token');
      }

      const channel = await response.json();
      dot.className = 'status-dot connected';
      text.textContent = channel.title;

      // Store channel info for modal
      this.channelInfo = channel;
    } catch (error) {
      // Token might be expired, try refreshing
      try {
        const refreshResponse = await fetch('/api/youtube/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokens: this.youtubeTokens })
        });

        const refreshData = await refreshResponse.json();
        if (refreshData.tokens) {
          this.youtubeTokens = refreshData.tokens;
          localStorage.setItem('youtube_tokens', JSON.stringify(this.youtubeTokens));
          this.updateYouTubeStatus(); // Retry with new tokens
          return;
        }
      } catch {
        // Refresh failed too
      }

      // Clear invalid tokens
      this.youtubeTokens = null;
      localStorage.removeItem('youtube_tokens');
      dot.className = 'status-dot disconnected';
      text.textContent = 'Not connected';
    }
  }

  showYouTubeModal() {
    const modal = document.getElementById('youtube-modal');
    const connectBtn = document.getElementById('connect-youtube-btn');
    const disconnectBtn = document.getElementById('disconnect-youtube-btn');
    const channelInfo = document.getElementById('channel-info');

    if (this.youtubeTokens && this.channelInfo) {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'block';
      channelInfo.style.display = 'flex';
      document.getElementById('channel-avatar').src = this.channelInfo.thumbnailUrl || '';
      document.getElementById('channel-name').textContent = this.channelInfo.title;
    } else {
      connectBtn.style.display = 'block';
      disconnectBtn.style.display = 'none';
      channelInfo.style.display = 'none';
    }

    modal.classList.add('active');
  }

  hideYouTubeModal() {
    document.getElementById('youtube-modal').classList.remove('active');
  }

  async connectYouTube() {
    try {
      const response = await fetch('/api/youtube/auth');
      const data = await response.json();

      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch (error) {
      alert('Failed to start YouTube connection');
    }
  }

  disconnectYouTube() {
    this.youtubeTokens = null;
    this.channelInfo = null;
    localStorage.removeItem('youtube_tokens');
    this.hideYouTubeModal();
    this.updateYouTubeStatus();
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.shortsApp = new ShortsApp();
});
