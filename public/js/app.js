/**
 * VideoResto - Main Application
 */

class VideoRestoApp {
  constructor() {
    this.currentRestaurantId = null;
    this.voiceClient = null;

    // Initialize UI
    this.initElements();
    this.initEventListeners();
    this.loadRecentRestaurants();
  }

  initElements() {
    // Sections
    this.uploadSection = document.getElementById('upload-section');
    this.processingSection = document.getElementById('processing-section');
    this.dashboardSection = document.getElementById('dashboard-section');

    // Upload
    this.uploadArea = document.getElementById('upload-area');
    this.videoInput = document.getElementById('video-input');
    this.uploadProgress = document.getElementById('upload-progress');
    this.progressFill = document.getElementById('progress-fill');
    this.progressText = document.getElementById('progress-text');

    // Processing
    this.processingStatus = document.getElementById('processing-status');
    this.processingProgress = document.getElementById('processing-progress');

    // Dashboard
    this.restaurantName = document.getElementById('restaurant-name');
    this.restaurantCuisine = document.getElementById('restaurant-cuisine');
    this.restaurantDescription = document.getElementById('restaurant-description');
    this.menuPreview = document.getElementById('menu-preview');
    this.downloadList = document.getElementById('download-list');

    // Voice
    this.voiceBtn = document.getElementById('voice-btn');
    this.voiceVisualizer = document.getElementById('voice-visualizer');
    this.voiceTranscript = document.getElementById('voice-transcript');

    // Actions
    this.btnGenerateWebsite = document.getElementById('btn-generate-website');
    this.btnGenerateBrochure = document.getElementById('btn-generate-brochure');
    this.btnPreview = document.getElementById('btn-preview');
    this.btnDeploy = document.getElementById('btn-deploy');

    // Modal
    this.previewModal = document.getElementById('preview-modal');
    this.previewIframe = document.getElementById('preview-iframe');
    this.modalClose = document.getElementById('modal-close');
  }

  initEventListeners() {
    // Upload area
    this.uploadArea.addEventListener('click', () => this.videoInput.click());
    this.videoInput.addEventListener('change', (e) => this.handleVideoUpload(e));

    // Drag and drop
    this.uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.uploadArea.classList.add('dragover');
    });

    this.uploadArea.addEventListener('dragleave', () => {
      this.uploadArea.classList.remove('dragover');
    });

    this.uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      this.uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        this.uploadVideo(e.dataTransfer.files[0]);
      }
    });

    // Voice button
    this.voiceBtn.addEventListener('mousedown', () => this.startVoice());
    this.voiceBtn.addEventListener('mouseup', () => this.stopVoice());
    this.voiceBtn.addEventListener('mouseleave', () => this.stopVoice());
    this.voiceBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.startVoice();
    });
    this.voiceBtn.addEventListener('touchend', () => this.stopVoice());

    // Action buttons
    this.btnGenerateWebsite.addEventListener('click', () => this.generateWebsite());
    this.btnGenerateBrochure.addEventListener('click', () => this.generateBrochure());
    this.btnPreview.addEventListener('click', () => this.previewWebsite());
    this.btnDeploy.addEventListener('click', () => this.deployWebsite());

    // Modal
    this.modalClose.addEventListener('click', () => this.closeModal());
    this.previewModal.addEventListener('click', (e) => {
      if (e.target === this.previewModal) this.closeModal();
    });
  }

  // ===== Upload =====
  handleVideoUpload(event) {
    const file = event.target.files[0];
    if (file) {
      this.uploadVideo(file);
    }
  }

  async uploadVideo(file) {
    if (!file.type.startsWith('video/')) {
      this.showToast('Please select a video file', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('video', file);

    this.uploadProgress.classList.remove('hidden');
    this.progressFill.style.width = '0%';
    this.progressText.textContent = 'Uploading...';

    try {
      const response = await fetch('/api/upload/video', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      this.progressFill.style.width = '100%';
      this.progressText.textContent = 'Upload complete!';

      // Start polling for processing status
      this.showSection('processing');
      this.pollProcessingStatus(data.jobId);
    } catch (error) {
      console.error('Upload error:', error);
      this.showToast('Failed to upload video', 'error');
      this.uploadProgress.classList.add('hidden');
    }
  }

  async pollProcessingStatus(jobId) {
    const poll = async () => {
      try {
        const response = await fetch(`/api/upload/status/${jobId}`);
        const data = await response.json();

        this.processingProgress.style.width = `${data.progress}%`;

        const statusMessages = {
          0: 'Starting video analysis...',
          10: 'Processing video...',
          30: 'Extracting frames...',
          60: 'Analyzing with AI...',
          70: 'Creating restaurant record...',
          80: 'Processing menu items...',
          90: 'Saving photos...',
          100: 'Complete!'
        };

        const closestProgress = Object.keys(statusMessages)
          .map(Number)
          .filter(p => p <= data.progress)
          .pop();

        this.processingStatus.textContent = statusMessages[closestProgress] || 'Processing...';

        if (data.status === 'completed') {
          this.showToast('Video processed successfully!', 'success');
          this.loadRestaurant(data.restaurantId);
        } else if (data.status === 'failed') {
          this.showToast(`Processing failed: ${data.error}`, 'error');
          this.showSection('upload');
        } else {
          setTimeout(poll, 1000);
        }
      } catch (error) {
        console.error('Status poll error:', error);
        setTimeout(poll, 2000);
      }
    };

    poll();
  }

  // ===== Restaurant Dashboard =====
  async loadRestaurant(id) {
    try {
      const response = await fetch(`/api/restaurant/${id}`);
      const restaurant = await response.json();

      this.currentRestaurantId = id;
      this.displayRestaurant(restaurant);
      this.showSection('dashboard');

      // Initialize voice client
      this.initVoiceClient();

      // Save to recent
      this.saveToRecent(restaurant);
    } catch (error) {
      console.error('Failed to load restaurant:', error);
      this.showToast('Failed to load restaurant', 'error');
    }
  }

  displayRestaurant(restaurant) {
    this.restaurantName.textContent = restaurant.name || 'Unnamed Restaurant';
    this.restaurantCuisine.textContent = restaurant.cuisine_type || 'Restaurant';
    this.restaurantDescription.textContent = restaurant.description || '';

    // Display menu
    this.displayMenu(restaurant.menu);

    // Display downloads
    this.displayDownloads(restaurant.materials);
  }

  displayMenu(menu) {
    if (!menu || menu.length === 0) {
      this.menuPreview.innerHTML = '<p class="empty-state">No menu items yet</p>';
      return;
    }

    let html = '';
    for (const category of menu) {
      html += `<h4 style="margin: 15px 0 10px; color: var(--gray-500); font-size: 12px; text-transform: uppercase;">${category.name}</h4>`;
      for (const item of category.items) {
        html += `
          <div class="menu-item">
            <span class="menu-item-name">${item.name}</span>
            <span class="menu-item-price">${item.price ? '$' + item.price : 'MP'}</span>
          </div>
        `;
      }
    }

    this.menuPreview.innerHTML = html;
  }

  displayDownloads(materials) {
    if (!materials || materials.length === 0) {
      this.downloadList.innerHTML = '<p class="empty-state">Generate materials to download</p>';
      return;
    }

    let html = '';
    for (const material of materials) {
      const typeLabels = {
        website: 'Website',
        brochure_pdf: 'Brochure PDF',
        brochure_image: 'Brochure Image'
      };

      const label = typeLabels[material.type] || material.type;

      if (material.type === 'brochure_pdf') {
        html += `
          <div class="download-item">
            <span>${label} (v${material.version})</span>
            <a href="/api/download/pdf/${this.currentRestaurantId}">Download</a>
          </div>
        `;
      } else if (material.type === 'brochure_image') {
        html += `
          <div class="download-item">
            <span>${label} (v${material.version})</span>
            <a href="/api/download/image/${this.currentRestaurantId}?download=true">Download</a>
          </div>
        `;
      } else if (material.cloudflare_url) {
        html += `
          <div class="download-item">
            <span>${label}</span>
            <a href="${material.cloudflare_url}" target="_blank">Visit Site</a>
          </div>
        `;
      }
    }

    this.downloadList.innerHTML = html || '<p class="empty-state">Generate materials to download</p>';
  }

  // ===== Voice =====
  async initVoiceClient() {
    if (this.voiceClient) {
      this.voiceClient.disconnect();
    }

    this.voiceClient = new VoiceClient({
      restaurantId: this.currentRestaurantId,
      onReady: () => {
        console.log('Voice client ready');
        this.voiceBtn.disabled = false;
      },
      onText: (text) => {
        this.voiceTranscript.textContent = text;
      },
      onToolExecuted: (tool, args, result) => {
        this.showToast(`${tool}: ${result.message || 'Done'}`, result.success ? 'success' : 'error');
        // Refresh restaurant data
        this.loadRestaurant(this.currentRestaurantId);
      },
      onError: (error) => {
        this.showToast(`Voice error: ${error.message}`, 'error');
      },
      onDisconnected: () => {
        this.voiceBtn.disabled = true;
      }
    });

    try {
      await this.voiceClient.connect();
    } catch (error) {
      console.error('Failed to connect voice client:', error);
      this.showToast('Voice assistant unavailable', 'error');
    }
  }

  async startVoice() {
    if (!this.voiceClient || !this.voiceClient.isConnected) {
      this.showToast('Voice not connected', 'error');
      return;
    }

    try {
      await this.voiceClient.startListening();
      this.voiceVisualizer.classList.add('active');
      this.voiceBtn.classList.add('active');
    } catch (error) {
      this.showToast('Failed to access microphone', 'error');
    }
  }

  stopVoice() {
    if (this.voiceClient) {
      this.voiceClient.stopListening();
    }
    this.voiceVisualizer.classList.remove('active');
    this.voiceBtn.classList.remove('active');
  }

  // ===== Actions =====
  async generateWebsite() {
    if (!this.currentRestaurantId) return;

    this.showToast('Generating website...', 'success');

    try {
      const response = await fetch(`/api/deploy/generate/website/${this.currentRestaurantId}`, {
        method: 'POST'
      });

      const data = await response.json();

      if (data.success) {
        this.showToast('Website generated!', 'success');
        this.loadRestaurant(this.currentRestaurantId);
      } else {
        this.showToast(data.error || 'Failed to generate', 'error');
      }
    } catch (error) {
      this.showToast('Failed to generate website', 'error');
    }
  }

  async generateBrochure() {
    if (!this.currentRestaurantId) return;

    this.showToast('Generating brochure...', 'success');

    try {
      const response = await fetch(`/api/deploy/generate/brochure/${this.currentRestaurantId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: 'portrait' })
      });

      const data = await response.json();

      if (data.success) {
        this.showToast('Brochure generated!', 'success');
        this.loadRestaurant(this.currentRestaurantId);
      } else {
        this.showToast(data.error || 'Failed to generate', 'error');
      }
    } catch (error) {
      this.showToast('Failed to generate brochure', 'error');
    }
  }

  previewWebsite() {
    if (!this.currentRestaurantId) return;

    this.previewIframe.src = `/preview-static/${this.currentRestaurantId}/index.html`;
    document.getElementById('preview-title').textContent = 'Website Preview';
    this.previewModal.classList.remove('hidden');
  }

  async deployWebsite() {
    if (!this.currentRestaurantId) return;

    this.showToast('Deploying to Cloudflare...', 'success');

    try {
      const response = await fetch(`/api/deploy/cloudflare/${this.currentRestaurantId}`, {
        method: 'POST'
      });

      const data = await response.json();

      if (data.success) {
        this.showToast(`Deployed! ${data.url}`, 'success');
        this.loadRestaurant(this.currentRestaurantId);
      } else {
        this.showToast(data.error || 'Deployment failed', 'error');
      }
    } catch (error) {
      this.showToast('Failed to deploy', 'error');
    }
  }

  closeModal() {
    this.previewModal.classList.add('hidden');
    this.previewIframe.src = '';
  }

  // ===== Recent Restaurants =====
  loadRecentRestaurants() {
    const recent = JSON.parse(localStorage.getItem('recentRestaurants') || '[]');
    const listEl = document.getElementById('recent-list');

    if (recent.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No restaurants yet. Upload a video to get started!</p>';
      return;
    }

    let html = '';
    for (const r of recent.slice(0, 5)) {
      html += `
        <div class="restaurant-item" data-id="${r.id}">
          <div class="restaurant-item-info">
            <div class="restaurant-item-name">${r.name || 'Unnamed'}</div>
            <div class="restaurant-item-cuisine">${r.cuisine_type || 'Restaurant'}</div>
          </div>
          <span>&rarr;</span>
        </div>
      `;
    }

    listEl.innerHTML = html;

    // Add click handlers
    listEl.querySelectorAll('.restaurant-item').forEach(item => {
      item.addEventListener('click', () => {
        this.loadRestaurant(item.dataset.id);
      });
    });
  }

  saveToRecent(restaurant) {
    let recent = JSON.parse(localStorage.getItem('recentRestaurants') || '[]');

    // Remove if already exists
    recent = recent.filter(r => r.id !== restaurant.id);

    // Add to front
    recent.unshift({
      id: restaurant.id,
      name: restaurant.name,
      cuisine_type: restaurant.cuisine_type
    });

    // Keep only last 10
    recent = recent.slice(0, 10);

    localStorage.setItem('recentRestaurants', JSON.stringify(recent));
    this.loadRecentRestaurants();
  }

  // ===== Utilities =====
  showSection(name) {
    this.uploadSection.classList.remove('active');
    this.processingSection.classList.remove('active');
    this.dashboardSection.classList.remove('active');

    const section = document.getElementById(`${name}-section`);
    if (section) {
      section.classList.add('active');
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new VideoRestoApp();
});
