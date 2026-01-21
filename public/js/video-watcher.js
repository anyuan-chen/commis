/**
 * VideoWatcher - Client-side video detection using File System Access API
 * Falls back to periodic manual selection if API not available
 */

const VideoWatcher = {
  directoryHandle: null,
  watching: false,
  pollInterval: null,
  knownFiles: new Set(),
  onNewVideo: null,

  /**
   * Check if File System Access API is supported
   */
  isSupported() {
    return 'showDirectoryPicker' in window;
  },

  /**
   * Start watching a folder for new videos
   * @param {Function} callback - Called with File object when new video detected
   */
  async startWatching(callback) {
    this.onNewVideo = callback;

    if (this.isSupported()) {
      await this.startFileSystemWatching();
    } else {
      this.showFallbackMessage();
    }
  },

  /**
   * Use File System Access API to watch directory
   */
  async startFileSystemWatching() {
    try {
      // Request directory access
      this.directoryHandle = await window.showDirectoryPicker({
        id: 'cooking-videos',
        mode: 'read',
        startIn: 'videos'
      });

      // Build initial file list
      await this.scanDirectory();

      // Start polling for changes
      this.watching = true;
      this.pollInterval = setInterval(() => this.checkForNewFiles(), 3000);

      this.showWatchingStatus(this.directoryHandle.name);
    } catch (error) {
      if (error.name === 'AbortError') {
        // User cancelled
        return;
      }
      console.error('Failed to watch directory:', error);
      alert('Could not access folder. Please try manual file selection.');
    }
  },

  /**
   * Scan directory and build list of known files
   */
  async scanDirectory() {
    this.knownFiles.clear();

    for await (const entry of this.directoryHandle.values()) {
      if (entry.kind === 'file' && this.isVideoFile(entry.name)) {
        this.knownFiles.add(entry.name);
      }
    }
  },

  /**
   * Check for new files in the watched directory
   */
  async checkForNewFiles() {
    if (!this.watching || !this.directoryHandle) return;

    try {
      for await (const entry of this.directoryHandle.values()) {
        if (entry.kind === 'file' && this.isVideoFile(entry.name)) {
          if (!this.knownFiles.has(entry.name)) {
            // New file detected!
            this.knownFiles.add(entry.name);
            await this.handleNewFile(entry);
          }
        }
      }
    } catch (error) {
      console.error('Error checking for new files:', error);
      // Directory might have been moved/deleted, stop watching
      this.stopWatching();
    }
  },

  /**
   * Handle a newly detected video file
   */
  async handleNewFile(fileHandle) {
    try {
      const file = await fileHandle.getFile();

      // Small delay to ensure file is fully written
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Notify the app
      if (this.onNewVideo) {
        this.onNewVideo(file);
      }
    } catch (error) {
      console.error('Error reading new file:', error);
    }
  },

  /**
   * Check if filename appears to be a video
   */
  isVideoFile(filename) {
    const videoExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];
    const lowerName = filename.toLowerCase();
    return videoExtensions.some(ext => lowerName.endsWith(ext));
  },

  /**
   * Stop watching the directory
   */
  stopWatching() {
    this.watching = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.directoryHandle = null;
    this.hideWatchingStatus();
  },

  /**
   * Show status that folder is being watched
   */
  showWatchingStatus(folderName) {
    const btn = document.getElementById('watch-folder-btn');
    if (btn) {
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        Watching: ${folderName}
      `;
      btn.classList.add('watching');

      // Add stop button
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn-stop-watching';
      stopBtn.innerHTML = '&times;';
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        this.stopWatching();
      };
      btn.appendChild(stopBtn);
    }
  },

  /**
   * Hide watching status
   */
  hideWatchingStatus() {
    const btn = document.getElementById('watch-folder-btn');
    if (btn) {
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        Watch Folder for New Videos
      `;
      btn.classList.remove('watching');
    }
  },

  /**
   * Show message when File System Access API not available
   */
  showFallbackMessage() {
    alert(
      'Automatic folder watching is not supported in this browser.\n\n' +
      'To use this feature, please:\n' +
      '1. Use Chrome, Edge, or another Chromium-based browser\n' +
      '2. Access this page over HTTPS (or localhost)\n\n' +
      'You can still manually select videos to process.'
    );
  }
};

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VideoWatcher;
}
