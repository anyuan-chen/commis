/**
 * Restaurant AI - Minimal voice interface
 */

const SAMPLE_RATE = 16000;

class VoiceApp {
  constructor() {
    // Get restaurantId from URL - redirect to onboarding if missing
    const params = new URLSearchParams(window.location.search);
    this.restaurantId = params.get('restaurantId');

    if (!this.restaurantId) {
      window.location.href = '/';
      return;
    }

    this.waveform = document.getElementById('waveform');
    this.actionBtn = document.getElementById('action-btn');
    this.actionIcon = document.getElementById('action-icon');
    this.fileInput = document.getElementById('file-input');
    this.imagePreviewEl = document.getElementById('image-preview');
    this.previewImgEl = document.getElementById('preview-img');
    this.transcriptEl = document.getElementById('transcript-scroll');

    this.ws = null;
    this.isConnected = false;
    this.isRecording = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.audioQueue = [];
    this.isPlaying = false;
    this.mode = 'mic'; // 'mic' or 'upload'
    this.pendingTool = null; // Tool waiting for video upload
    this.pendingAuthTool = null; // Tool waiting for YouTube auth
    this.currentPreviewUrl = null;
    this.uploadWidgetEl = null; // Current upload widget element
    this.thinkingTimeout = null; // Show "thinking" after silence
    this.lastTranscript = null; // Last user speech transcript
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // Transcript state
    this.messages = [];
    this.MAX_MESSAGES = 10;
    this.currentAiText = '';
    this.currentAiMsgEl = null;
    this.isAiSpeaking = false;
    this._pendingUserTurn = false;

    // Web Speech API for user input transcription
    this.recognition = null;
    this.initSpeechRecognition();

    // Website generation background job tracking
    this.websiteJobId = null;
    this.websitePollInterval = null;

    // Gallery state
    this.galleryDrawer = document.getElementById('gallery-drawer');
    this.galleryContent = document.getElementById('gallery-content');

    this.actionBtn.addEventListener('click', () => this.handleAction());
    this.fileInput.addEventListener('change', (e) => this.handleFile(e));
    document.getElementById('gallery-btn').addEventListener('click', () => {
      if (this.galleryDrawer.classList.contains('open')) {
        this.closeGallery();
      } else {
        this.openGallery();
      }
    });

    // Chip click → send as text message
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.sendTextMessage(chip.dataset.text);
      });
    });

    this.init();
  }

  async init() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (err) {
      this.setStatus('Mic access needed');
    }

    // Load restaurant branding
    this.loadBranding();

    // Check for pending website generation job on page load
    this.checkPendingWebsiteJob();
  }

  initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this._hasWebSpeech = true; // Flag so we can skip Gemini inputTranscript
    this._interimMsgEl = null; // Element for showing interim (building) text

    this.recognition.onresult = (e) => {
      // Ignore results while AI is speaking (mic picks up speaker audio)
      if (this.isAiSpeaking || this._recognitionMuted) return;

      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          final += t;
        } else {
          interim += t;
        }
      }

      if (final) {
        // Finalize: promote interim bubble to final, or create new
        if (this._interimMsgEl) {
          this._interimMsgEl.textContent = final.trim();
          this._interimMsgEl.classList.remove('interim');
          this._interimMsgEl._ts = Date.now();
          this._interimMsgEl = null;
        } else {
          this.handleSpeechTranscript(final.trim());
        }
      } else if (interim) {
        // Show building text in a user bubble
        if (this._interimMsgEl) {
          this._interimMsgEl.textContent = interim;
          this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
        } else {
          this._interimMsgEl = this.addMessage('user', interim);
          this._interimMsgEl.classList.add('interim');
          this._interimMsgEl._ts = Date.now();
        }
      }
    };

    this.recognition.onend = () => {
      // Restart if still recording and not muted (browser stops after silence)
      if (this.isRecording && !this._recognitionMuted) {
        try { this.recognition.start(); } catch (e) {}
      }
    };

    this.recognition.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('Speech recognition error:', e.error);
      }
    };
  }

  _muteRecognition() {
    if (!this.recognition) return;
    this._recognitionMuted = true;
    try { this.recognition.stop(); } catch (e) {}
    // Finalize any in-progress interim bubble (don't discard — it's real user speech)
    if (this._interimMsgEl) {
      this._interimMsgEl.classList.remove('interim');
      this._interimMsgEl = null;
    }
  }

  _unmuteRecognition() {
    if (!this.recognition || !this.isRecording) return;
    this._recognitionMuted = false;
    try { this.recognition.start(); } catch (e) {}
  }

  handleSpeechTranscript(text) {
    if (!text) return;
    // Dedup: if last message is also user and recent, update in place
    if (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1];
      if (last.classList.contains('user') && last._ts && (Date.now() - last._ts < 3000)) {
        last.textContent = text;
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
        return;
      }
    }
    const el = this.addMessage('user', text);
    el._ts = Date.now();
  }

  async loadBranding() {
    try {
      const res = await fetch(`/api/restaurant/${this.restaurantId}`);
      const data = await res.json();
      if (data.name) {
        const match = data.name.match(/^(.+?)\s*[（(]([^)）]+)[)）]$/);
        document.getElementById('brand-name').textContent = match ? match[1] : data.name;
      }
    } catch (err) {
      // Silent fail — branding is decorative
    }
  }

  // Website generation background job methods
  async startWebsiteGeneration(restaurantId, options = {}) {
    try {
      const res = await fetch(`/api/deploy/generate/website/${restaurantId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iterative: options.iterative || false })
      });
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to start website generation');
        return null;
      }

      this.websiteJobId = data.jobId;
      this.startWebsitePolling();
      return data.jobId;
    } catch (err) {
      console.error('Website generation error:', err);
      this.showToast('Failed to start website generation');
      return null;
    }
  }

  startWebsitePolling() {
    if (this.websitePollInterval) return; // Already polling

    this.websitePollInterval = setInterval(async () => {
      if (!this.websiteJobId) {
        this.stopWebsitePolling();
        return;
      }

      try {
        const res = await fetch(`/api/deploy/generate/website/status/${this.websiteJobId}`);
        const job = await res.json();

        if (job.status === 'ready') {
          this.stopWebsitePolling();
          if (job.deployedUrl) {
            // Website is live - show the live URL
            this.showToast('Your website is live!', () => {
              window.open(job.deployedUrl, '_blank');
            });
          } else if (job.restaurantId) {
            // Generation complete but deployment failed - show local preview
            this.showToast('Your website is ready', () => {
              window.open(`/api/preview/website/${job.restaurantId}`, '_blank');
            });
          } else {
            // Fallback if no URL available
            this.showToast('Website generation complete');
          }
        } else if (job.status === 'failed') {
          this.stopWebsitePolling();
          this.showToast('Website generation failed');
        }
        // For 'pending' or 'processing', keep polling
      } catch (err) {
        console.error('Website poll error:', err);
      }
    }, 5000); // Poll every 5 seconds
  }

  stopWebsitePolling() {
    if (this.websitePollInterval) {
      clearInterval(this.websitePollInterval);
      this.websitePollInterval = null;
    }
    this.websiteJobId = null;
  }

  async checkPendingWebsiteJob() {
    if (!this.restaurantId) return;

    try {
      const res = await fetch(`/api/deploy/generate/website/pending/${this.restaurantId}`);
      const data = await res.json();

      if (data.jobId) {
        this.websiteJobId = data.jobId;
        this.startWebsitePolling();
      }
    } catch (err) {
      console.error('Pending job check error:', err);
    }
  }

  handleAction() {
    if (this.mode === 'upload') {
      this.fileInput.click();
    } else {
      this.toggleRecording();
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.actionIcon.setAttribute('data-lucide', mode === 'upload' ? 'upload' : 'audio-lines');
    lucide.createIcons();
  }


  setStatus(text) {
    // Status display removed — waveform handles state visually
  }

  previewImage(url) {
    this.currentPreviewUrl = url;
    this.previewImgEl.src = url;
    this.imagePreviewEl.classList.add('show');
  }

  dismissPreview() {
    this.imagePreviewEl.classList.remove('show');
    this.currentPreviewUrl = null;
  }

  async sharePreview() {
    if (!this.currentPreviewUrl) return;
    await this.share(this.currentPreviewUrl);
  }

  openImageModal(url) {
    const modal = document.getElementById('image-modal');
    const img = document.getElementById('modal-img');
    if (!modal || !img) return;
    img.src = url;
    modal.classList.add('show');
  }

  closeImageModal() {
    const modal = document.getElementById('image-modal');
    if (modal) modal.classList.remove('show');
  }

  sendTextMessage(text) {
    // Connect if needed, then send
    const doSend = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'text', text }));
        this.addMessage('user', text);
      }
    };

    if (!this.isConnected) {
      this.connect();
      const check = setInterval(() => {
        if (this.isConnected) {
          clearInterval(check);
          doSend();
        }
      }, 100);
      setTimeout(() => clearInterval(check), 10000);
    } else {
      doSend();
    }
  }

  addMessage(role, text, meta = {}) {
    // Remove welcome state on first message
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();

    // Show top fade gradient once messages exist
    document.getElementById('transcript').classList.add('has-messages');

    const el = document.createElement('div');
    el.className = `msg ${role}`;

    if (role === 'tool') {
      const name = this.toolDisplayName(meta.toolName);
      el.innerHTML = `<div class="tool-state-pending"><div class="tool-spinner"></div>${this.escapeHtml(name)}</div><div class="tool-state-done"></div>`;
      el._toolName = meta.toolName;
    } else {
      el.textContent = text;
    }

    this.transcriptEl.appendChild(el);
    this.messages.push(el);

    // Cap at MAX_MESSAGES
    while (this.messages.length > this.MAX_MESSAGES) {
      const old = this.messages.shift();
      old.remove();
    }

    // Auto-scroll
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    return el;
  }

  addPreview(url) {
    const el = document.createElement('div');
    el.className = 'msg preview';
    el.innerHTML = `<img src="${this.escapeHtml(url)}" alt="Generated graphic">`;
    el.querySelector('img').addEventListener('click', () => this.previewImage(url));
    this.transcriptEl.appendChild(el);
    this.messages.push(el);
    while (this.messages.length > this.MAX_MESSAGES) {
      this.messages.shift().remove();
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  addLink(label, url) {
    const el = document.createElement('div');
    el.className = 'msg link';
    el.innerHTML = `<a href="${this.escapeHtml(url)}" target="_blank">${this.escapeHtml(label)} &rarr;</a>`;
    this.transcriptEl.appendChild(el);
    this.messages.push(el);
    while (this.messages.length > this.MAX_MESSAGES) {
      this.messages.shift().remove();
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  addUploadWidget() {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    document.getElementById('transcript').classList.add('has-messages');

    const el = document.createElement('div');
    el.className = 'msg upload-widget';
    el.innerHTML = `<i data-lucide="upload" width="18" height="18"></i><span>Tap to select a video</span>`;
    el.addEventListener('click', () => this.fileInput.click());
    this.transcriptEl.appendChild(el);
    this.messages.push(el);
    this.uploadWidgetEl = el;
    while (this.messages.length > this.MAX_MESSAGES) {
      this.messages.shift().remove();
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
  }

  setUploadWidgetState(state, filename) {
    const el = this.uploadWidgetEl;
    if (!el) return;
    if (state === 'uploading') {
      el.className = 'msg upload-widget uploading';
      el.style.pointerEvents = 'none';
      el.innerHTML = `<div class="upload-spinner"></div><span>Uploading${filename ? ' ' + filename : ''}...</span>`;
    } else if (state === 'done') {
      el.className = 'msg upload-widget uploaded';
      el.style.pointerEvents = 'none';
      el.innerHTML = `<i data-lucide="check" width="18" height="18"></i><span>Uploaded</span>`;
      lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
      // Flash uploaded for 1s, then morph into processing
      setTimeout(() => {
        el.className = 'msg upload-widget processing';
        el.innerHTML = `<div class="tool-spinner"></div><span>Creating shorts</span>`;
      }, 1000);
    } else if (state === 'error') {
      el.className = 'msg upload-widget upload-error';
      el.style.pointerEvents = 'auto';
      el.innerHTML = `<i data-lucide="alert-circle" width="18" height="18"></i><span>Upload failed — tap to retry</span>`;
      lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
    }
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  toolDisplayName(tool) {
    const map = {
      'create_restaurant': 'Processing video',
      'create_website': 'Building website',
      'create_youtube_short': 'Creating shorts',
      'generate_graphic': 'Generating graphic',
      'modify_website': 'Updating website',
      'find_restaurant': 'Searching',
      'fetch_reviews': 'Fetching reviews',
      'generate_review_digest': 'Analyzing reviews',
      'get_review_insights': 'Getting insights',
      'get_latest_digest': 'Loading digest',
      'suggest_google_ads': 'Creating ad suggestions',
      'updateRestaurantInfo': 'Updating info',
      'regenerateWebsite': 'Rebuilding website',
      'regenerateBrochure': 'Rebuilding brochure',
      'deployWebsite': 'Deploying',
      'generateSocialGraphic': 'Creating graphic',
      'generatePromoGraphic': 'Creating promo',
      'generateHolidayGraphic': 'Creating holiday graphic',
      'generateMenuGraphic': 'Creating menu graphic',
      'addMenuItem': 'Adding menu item',
      'updateMenuItem': 'Updating menu item',
      'removeMenuItem': 'Removing menu item',
      'addNote': 'Adding note',
      'removeNote': 'Removing note',
      'editWebsiteStyle': 'Updating style',
      'getReviewDigest': 'Loading digest',
      'getReviewStats': 'Getting stats',
      'getRestaurantInfo': 'Loading info',
      'updateHours': 'Updating hours'
    };
    return map[tool] || tool;
  }

  toolResultSummary(tool, result) {
    if (!result) return 'Done';
    if (result.websiteUrl || result.deployedUrl) return 'Website live';
    if (result.imageUrl || result.url) return 'Ready';
    if (result.youtubeUrl || result.variants?.length) return 'Uploaded';
    if (result.error) return 'Error';
    return 'Done';
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/voice?restaurantId=${this.restaurantId}`);

    this.setStatus('Connecting...');

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: 'start' }));
    };

    this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));

    this.ws.onerror = () => {
      this.setStatus('Connection error');
      this.isConnected = false;
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      if (this.isRecording) this.stopRecording();
      this.reconnect();
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.setStatus('Listening...');
        break;

      case 'audio':
        this.clearThinkingTimeout();
        this._pendingUserTurn = false;
        this.waveform.classList.remove('thinking', 'active');
        this.queueAudio(msg.data);
        break;

      case 'outputTranscript':
        // Primary source of AI text — accumulate chunks
        this.currentAiText += msg.text;
        if (!this.currentAiMsgEl) {
          this.currentAiMsgEl = this.addMessage('ai', this.currentAiText);
        } else {
          this.currentAiMsgEl.textContent = this.currentAiText;
          this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
        }
        break;

      case 'text':
        // In AUDIO mode, text parts are internal reasoning — don't display.
        // Only extract URLs as inline links.
        const urlMatch = msg.text.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          this.addLink('Link', urlMatch[1]);
        }
        break;

      case 'inputTranscript':
        this.lastTranscript = msg.text;
        // Skip display if Web Speech API is handling transcripts (avoid duplicates)
        if (this._hasWebSpeech) break;
        // Fallback: show Gemini's transcript if no Web Speech API
        if (this.messages.length > 0) {
          const last = this.messages[this.messages.length - 1];
          if (last.classList.contains('user') && last._ts && (Date.now() - last._ts < 3000)) {
            last.textContent = msg.text;
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
            break;
          }
        }
        {
          const el = this.addMessage('user', msg.text);
          el._ts = Date.now();
        }
        break;

      case 'modelTurnStart':
        this.clearThinkingTimeout();
        this._pendingUserTurn = false;
        this.waveform.classList.remove('thinking', 'active');
        // Stop speech recognition immediately — AI is about to speak
        this._muteRecognition();
        break;

      case 'turnComplete':
        this.clearThinkingTimeout();
        this.lastTranscript = null;
        this.currentAiText = '';
        this.currentAiMsgEl = null;
        this.waveform.classList.remove('thinking');
        // Wait for AI audio to finish playing before activating waveform
        if (this.isAiSpeaking) {
          this._pendingUserTurn = true;
        } else if (this.isRecording) {
          this.waveform.classList.add('active');
        } else {
          this.waveform.classList.remove('active');
        }
        break;

      case 'requestVideoUpload':
        this.clearThinkingTimeout();
        this.pendingTool = msg.tool;
        this.addUploadWidget();
        break;

      case 'toolStarted':
        this.clearThinkingTimeout();
        this.waveform.classList.remove('thinking', 'active');
        // If upload widget is active, it already shows processing state — skip separate tool card
        if (!this.uploadWidgetEl) {
          this.addMessage('tool', '', { toolName: msg.tool });
        }
        break;

      case 'toolCompleted':
        {
          // If upload widget handled this tool, morph into summary card with dropdown
          if (this.uploadWidgetEl && this.uploadWidgetEl.classList.contains('processing')) {
            const el = this.uploadWidgetEl;
            const variants = msg.result?.variants || [];
            const title = msg.result?.title || 'Shorts';

            el.className = 'msg tool completed';
            el.style.pointerEvents = 'auto';
            el.style.overflow = 'visible';
            el.style.position = 'relative';

            if (variants.length > 1) {
              // Multi-result: summary header + dropdown
              el.innerHTML = `
                <div class="tool-state-done" style="opacity:1;transform:none;position:relative;pointer-events:auto;">
                  <div class="summary-header">
                    <div class="tool-visual"><i data-lucide="play" width="20" height="20"></i></div>
                    <div class="tool-body">
                      <div class="tool-title">${this.escapeHtml(title)}</div>
                      <div class="tool-subtitle">${variants.length} shorts uploaded</div>
                    </div>
                    <i data-lucide="chevron-right" class="summary-chevron" width="14" height="14"></i>
                  </div>
                  <div class="summary-dropdown">
                    ${variants.map(v => {
                      const label = v.label || (v.type === 'narrated' ? 'Narrated' : v.type.charAt(0).toUpperCase() + v.type.slice(1));
                      return `<div class="summary-item" data-url="${this.escapeHtml(v.youtubeUrl || v.previewUrl || '')}">
                        <div class="summary-item-icon"><i data-lucide="play" width="14" height="14"></i></div>
                        <div class="summary-item-body">
                          <div class="summary-item-title">${this.escapeHtml(label)}</div>
                          <div class="summary-item-sub">${v.youtubeUrl ? 'YouTube' : 'Preview'}</div>
                        </div>
                        <i data-lucide="external-link" class="summary-item-action" width="14" height="14"></i>
                      </div>`;
                    }).join('')}
                  </div>
                </div>`;
              el.querySelector('.summary-header').addEventListener('click', (e) => {
                e.stopPropagation();
                el.classList.toggle('show-dropdown');
              });
              el.querySelectorAll('.summary-item').forEach(item => {
                const url = item.dataset.url;
                if (url) item.addEventListener('click', (e) => { e.stopPropagation(); window.open(url, '_blank'); });
              });
            } else if (variants.length === 1) {
              // Single result: direct link card
              const v = variants[0];
              const linkUrl = v.youtubeUrl || v.previewUrl;
              el.innerHTML = `
                <div class="tool-state-done" style="opacity:1;transform:none;position:relative;pointer-events:auto;">
                  <div class="tool-visual"><i data-lucide="play" width="20" height="20"></i></div>
                  <div class="tool-body">
                    <div class="tool-title">${this.escapeHtml(title)}</div>
                    <div class="tool-subtitle">Uploaded</div>
                  </div>
                  <i data-lucide="external-link" class="tool-action" width="14" height="14"></i>
                </div>`;
              if (linkUrl) el.addEventListener('click', () => window.open(linkUrl, '_blank'));
            } else {
              el.innerHTML = `
                <div class="tool-state-done" style="opacity:1;transform:none;position:relative;pointer-events:auto;">
                  <div class="tool-visual"><i data-lucide="check" width="20" height="20"></i></div>
                  <div class="tool-body">
                    <div class="tool-title">${this.escapeHtml(title)}</div>
                    <div class="tool-subtitle">Done</div>
                  </div>
                </div>`;
            }

            lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
            this.uploadWidgetEl = null;
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
            break;
          }

          const imgUrl = msg.result?.imageUrl || msg.result?.url;
          const toolMsgs = this.transcriptEl.querySelectorAll('.msg.tool');
          const lastTool = toolMsgs[toolMsgs.length - 1];

          if (lastTool) {
            const doneEl = lastTool.querySelector('.tool-state-done');
            const title = msg.result?.title || this.toolDisplayName(msg.tool);

            if (imgUrl) {
              // Image result — thumbnail card
              doneEl.innerHTML = `
                <div class="tool-visual"><img src="${this.escapeHtml(imgUrl)}" alt=""></div>
                <div class="tool-body">
                  <div class="tool-title">${this.escapeHtml(title)}</div>
                  <div class="tool-subtitle">Tap to view</div>
                </div>
                <i data-lucide="expand" class="tool-action" width="14" height="14"></i>`;
              lastTool._imageUrl = imgUrl;
              lastTool.addEventListener('click', () => this.openImageModal(imgUrl));
            } else {
              // Non-image result — icon card
              const summary = this.toolResultSummary(msg.tool, msg.result);
              // Tools that touch the website — always link to it
              const websiteTools = ['addMenuItem','updateMenuItem','removeMenuItem','editWebsiteStyle',
                'updateRestaurantInfo','updateHours','regenerateWebsite','deployWebsite',
                'modify_website','create_website'];
              const linkUrl = msg.result?.websiteUrl || msg.result?.deployedUrl
                || msg.result?.youtubeUrl || msg.result?.variants?.[0]?.youtubeUrl
                || (websiteTools.includes(msg.tool) ? `/api/website/${this.restaurantId}` : null);
              const icon = linkUrl ? 'globe' : 'check';
              doneEl.innerHTML = `
                <div class="tool-visual"><i data-lucide="${icon}" width="20" height="20"></i></div>
                <div class="tool-body">
                  <div class="tool-title">${this.escapeHtml(title)}</div>
                  <div class="tool-subtitle">${this.escapeHtml(summary)}</div>
                </div>
                ${linkUrl ? '<i data-lucide="external-link" class="tool-action" width="14" height="14"></i>' : ''}`;
              if (linkUrl) {
                lastTool.addEventListener('click', () => window.open(linkUrl, '_blank'));
              }
            }

            lastTool.classList.add('completed');
            lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
          }

        }
        break;

      case 'toolError':
        this.waveform.classList.remove('active', 'thinking');
        this.setStatus('Error');
        break;

      case 'requestYouTubeAuth':
        this.clearThinkingTimeout();
        this.pendingAuthTool = msg.tool;
        this.setStatus(msg.message || 'Connect YouTube');
        this.openYouTubeAuth();
        break;

      case 'geminiDisconnected':
        this.clearThinkingTimeout();
        this.waveform.classList.remove('active', 'thinking');
        this.isConnected = false;
        this.reconnect();
        break;

      case 'error':
        this.clearThinkingTimeout();
        this.waveform.classList.remove('active', 'thinking');
        this.setStatus('Error');
        break;
    }
  }

  openYouTubeAuth() {
    const width = 500, height = 600;
    const left = (screen.width - width) / 2;
    const top = (screen.height - height) / 2;

    const popup = window.open(
      '/api/youtube/auth',
      'youtube-auth',
      `width=${width},height=${height},left=${left},top=${top}`
    );

    // Poll for popup close
    const checkAuth = setInterval(async () => {
      try {
        if (popup.closed) {
          clearInterval(checkAuth);

          // Verify auth succeeded
          const res = await fetch('/api/youtube/status');
          const { connected } = await res.json();

          if (connected) {
            this.setStatus('YouTube connected!');
            this.notifyAuthComplete();
          } else {
            this.setStatus('YouTube auth cancelled');
            this.pendingAuthTool = null;
          }
        }
      } catch (e) {
        // Cross-origin or popup still open
      }
    }, 500);

    // Timeout after 2 minutes
    setTimeout(() => {
      clearInterval(checkAuth);
      if (popup && !popup.closed) popup.close();
    }, 120000);
  }

  notifyAuthComplete() {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'youtubeAuthComplete',
        tool: this.pendingAuthTool
      }));
    }
    this.pendingAuthTool = null;
  }

  startThinkingTimeout() {
    // Reset the timer on every audio chunk — only fires when audio stops flowing
    clearTimeout(this.thinkingTimeout);
    this.thinkingTimeout = setTimeout(() => {
      if (this.isConnected) {
        const status = this.lastTranscript ? `"${this.lastTranscript}"` : 'Thinking...';
        this.setStatus(status);
        this.waveform.classList.remove('active');
        this.waveform.classList.add('thinking');
      }
    }, 1500);
  }

  clearThinkingTimeout() {
    clearTimeout(this.thinkingTimeout);
    this.thinkingTimeout = null;
  }


  async openGallery() {
    this.galleryDrawer.classList.add('open');
    const btn = document.getElementById('gallery-btn');
    btn.classList.add('open');
    btn.innerHTML = '<i data-lucide="x" width="20" height="20"></i>';
    lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
    this.galleryContent.innerHTML = '<div class="gallery-empty">Loading...</div>';

    try {
      const res = await fetch(`/api/gallery/${this.restaurantId}`);
      const data = await res.json();
      this.renderFeed(data);
    } catch (err) {
      console.error('Gallery fetch error:', err);
      this.galleryContent.innerHTML = '<div class="gallery-empty">Failed to load</div>';
    }
  }

  closeGallery() {
    this.galleryDrawer.classList.remove('open');
    const btn = document.getElementById('gallery-btn');
    btn.classList.remove('open');
    btn.innerHTML = '<i data-lucide="grid-2x2" width="20" height="20"></i>';
    lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
  }

  renderFeed({ graphics, websites, shorts }) {
    // Merge all items into one list with a common shape, sorted newest-first
    const items = [
      ...graphics.map(g => ({ kind: 'graphic', url: g.url, date: g.createdAt })),
      ...websites.map(w => ({
        kind: 'website',
        title: 'Website',
        meta: w.deployedUrl ? 'Live' : 'Preview',
        url: w.deployedUrl || w.previewUrl,
        date: w.createdAt
      })),
      ...shorts.map(s => ({
        kind: 'short',
        title: s.title || 'Short',
        meta: s.youtubeUrl ? 'YouTube' : 'Local',
        url: s.youtubeUrl || s.previewUrl,
        date: s.createdAt
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!items.length) {
      this.galleryContent.innerHTML = '<div class="gallery-empty">Nothing here yet</div>';
      return;
    }

    const feed = document.createElement('div');
    feed.className = 'gallery-feed';

    for (const item of items) {
      if (item.kind === 'graphic') {
        const el = document.createElement('div');
        el.className = 'feed-graphic';
        el.innerHTML = `<img src="${item.url}" alt="Graphic" loading="lazy">`;
        el.addEventListener('click', () => {
          this.closeGallery();
          this.previewImage(item.url);
        });
        feed.appendChild(el);
      } else {
        const icon = item.kind === 'website' ? 'globe' : 'play';
        const date = new Date(item.date).toLocaleDateString();
        const el = document.createElement('div');
        el.className = 'feed-card';
        el.innerHTML = `
          <div class="feed-card-icon"><i data-lucide="${icon}" width="20" height="20"></i></div>
          <div class="feed-card-body">
            <div class="feed-card-title">${item.title}</div>
            <div class="feed-card-meta">${item.meta} &middot; ${date}</div>
          </div>
          <i data-lucide="chevron-right" class="feed-card-arrow" width="16" height="16"></i>`;
        if (item.url) {
          el.addEventListener('click', () => window.open(item.url, '_blank'));
        }
        feed.appendChild(el);
      }
    }

    this.galleryContent.innerHTML = '';
    this.galleryContent.appendChild(feed);

    // Apply stagger delays to each feed item
    const children = feed.children;
    for (let i = 0; i < children.length; i++) {
      children[i].style.animationDelay = `${i * 30}ms`;
    }

    lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setStatus('Connection lost. Tap mic to retry.');
      this.reconnectAttempts = 0;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * this.reconnectAttempts, 5000);
    this.setStatus('Reconnecting...');

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  toolStatus(tool) {
    const map = {
      'create_restaurant': 'Processing video...',
      'create_website': 'Generating website...',
      'create_youtube_short': 'Creating short...',
      'generate_graphic': 'Generating...',
      'modify_website': 'Updating...'
    };
    return map[tool] || 'Working...';
  }

  async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  async startRecording() {
    // Clear welcome state when user starts talking
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    document.getElementById('transcript').classList.add('has-messages');

    // Eagerly acquire mic + AudioContext inside the user gesture (required on iOS)
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch (err) {
      this.setStatus('Mic error');
      return;
    }

    if (!this.isConnected) {
      this.connect();
      const check = setInterval(() => {
        if (this.isConnected) {
          clearInterval(check);
          this.beginCapture();
        }
      }, 100);
      setTimeout(() => clearInterval(check), 10000);
      return;
    }
    this.beginCapture();
  }

  async beginCapture() {
    try {
      // Mic + AudioContext are acquired eagerly in startRecording() for iOS compatibility
      if (!this.mediaStream) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
      }
      if (!this.audioContext) {
        this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording || this.ws?.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
        }
        this.ws.send(JSON.stringify({ type: 'audio', data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))) }));

        // Start thinking timeout — if model doesn't respond within 1.5s, show thinking state
        this.startThinkingTimeout();
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isRecording = true;
      this.actionBtn.classList.add('active');
      this.waveform.classList.add('active');
      this.setStatus('Listening...');

      // Start browser speech recognition for user transcript
      try { this.recognition?.start(); } catch (e) {}
    } catch (err) {
      this.setStatus('Mic error');
    }
  }

  stopRecording() {
    this.isRecording = false;
    this.clearThinkingTimeout();
    this.processor?.disconnect();
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.audioContext?.close();
    this.processor = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.actionBtn.classList.remove('active');
    this.waveform.classList.remove('active', 'thinking');
    this.setStatus('Tap to continue');

    // Stop browser speech recognition
    try { this.recognition?.stop(); } catch (e) {}
  }

  queueAudio(base64) {
    // Lazy-init a single persistent AudioContext for playback
    if (!this.playbackCtx) {
      this.playbackCtx = new AudioContext({ sampleRate: 24000 });
      this.nextStartTime = 0;
    }

    this._muteRecognition();
    this.isAiSpeaking = true;

    try {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer);
      const float = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768;

      const buffer = this.playbackCtx.createBuffer(1, float.length, 24000);
      buffer.getChannelData(0).set(float);
      const source = this.playbackCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.playbackCtx.destination);

      // Schedule gapless: play immediately or right after the previous chunk
      const now = this.playbackCtx.currentTime;
      const startAt = Math.max(now, this.nextStartTime);
      source.start(startAt);
      this.nextStartTime = startAt + buffer.duration;

      // Track when the last chunk finishes playing
      source.onended = () => {
        // Only mark done if no more audio is scheduled after this chunk
        if (this.playbackCtx && this.playbackCtx.currentTime >= this.nextStartTime - 0.05) {
          this.isAiSpeaking = false;
          this.onAiSpeakingDone();
        }
      };
    } catch (err) {
      // skip bad chunk
    }
  }

  onAiSpeakingDone() {
    // AI audio finished — restart speech recognition
    this._unmuteRecognition();
    // If it's user's turn (turnComplete already fired), activate waveform
    if (this._pendingUserTurn) {
      this._pendingUserTurn = false;
      if (this.isRecording) {
        this.waveform.classList.add('active');
      }
    }
  }

  handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    this.uploadFile(file);
  }

  async uploadFile(file) {
    this.setUploadWidgetState('uploading', file.name);
    const form = new FormData();
    form.append('video', file);

    try {
      const res = await fetch('/api/upload/video/raw', { method: 'POST', body: form });
      const { videoUrl, error } = await res.json();
      if (error) throw new Error(error);

      this.setUploadWidgetState('done');

      // Notify backend that video is ready - it will resume the pending tool
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'videoUploaded',
          videoUrl,
          tool: this.pendingTool
        }));
      }
      this.pendingTool = null;
    } catch (err) {
      this.setUploadWidgetState('error');
    }

    this.fileInput.value = '';
  }

  async share(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], 'image.png', { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        window.open(url, '_blank');
      }
    } catch (err) {
      window.open(url, '_blank');
    }
  }

  showToast(message, onClick = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    // Clear any existing click handler
    toast.onclick = null;

    toast.textContent = message;
    toast.classList.remove('tappable');

    if (onClick) {
      toast.classList.add('tappable');
      toast.onclick = () => {
        toast.classList.remove('show');
        onClick();
      };
    }

    toast.classList.add('show');

    // Auto-hide after 5 seconds (longer if tappable)
    const duration = onClick ? 8000 : 4000;
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }
}

const app = new VoiceApp();
