import { google } from 'googleapis';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { config } from '../config.js';

const OAuth2 = google.auth.OAuth2;

export class YouTubeUploader {
  constructor() {
    this.oauth2Client = new OAuth2(
      config.youtube.clientId,
      config.youtube.clientSecret,
      config.youtube.redirectUri
    );
  }

  /**
   * Generate OAuth authorization URL
   * @returns {string} - Authorization URL
   */
  getAuthUrl() {
    const scopes = [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube'
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent' // Force consent to get refresh token
    });
  }

  /**
   * Exchange authorization code for tokens
   * @param {string} code - Authorization code from OAuth callback
   * @returns {Promise<object>} - Token object
   */
  async getTokensFromCode(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    return tokens;
  }

  /**
   * Set credentials on the OAuth client
   * @param {object} tokens - Access and refresh tokens
   */
  setCredentials(tokens) {
    this.oauth2Client.setCredentials(tokens);
  }

  /**
   * Refresh access token if expired
   * @param {object} tokens - Current tokens
   * @returns {Promise<object>} - Updated tokens
   */
  async refreshTokenIfNeeded(tokens) {
    this.setCredentials(tokens);

    // Check if token is expired or will expire soon (5 min buffer)
    const expiryDate = tokens.expiry_date || 0;
    const isExpired = Date.now() > expiryDate - 5 * 60 * 1000;

    if (isExpired && tokens.refresh_token) {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      return credentials;
    }

    return tokens;
  }

  /**
   * Upload video to YouTube
   * @param {string} videoPath - Path to video file
   * @param {object} metadata - Video metadata
   * @param {object} tokens - OAuth tokens
   * @param {function} onProgress - Progress callback
   * @returns {Promise<{videoId: string, videoUrl: string}>}
   */
  async uploadVideo(videoPath, metadata, tokens, onProgress = null) {
    // Refresh token if needed
    const freshTokens = await this.refreshTokenIfNeeded(tokens);
    this.setCredentials(freshTokens);

    const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    const {
      title,
      description,
      tags = [],
      privacyStatus = 'private', // Start as private for review
      categoryId = '26' // Howto & Style category
    } = metadata;

    // Get file size for progress tracking
    const fileStats = await stat(videoPath);
    const fileSize = fileStats.size;

    const videoStream = createReadStream(videoPath);

    const requestBody = {
      snippet: {
        title: title.substring(0, 100), // YouTube title limit
        description: description.substring(0, 5000), // YouTube description limit
        tags: tags.slice(0, 500), // YouTube tags limit
        categoryId
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false
      }
    };

    const media = {
      body: videoStream
    };

    // Track upload progress
    let uploadedBytes = 0;
    videoStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      if (onProgress) {
        const progress = Math.round((uploadedBytes / fileSize) * 100);
        onProgress(progress, uploadedBytes, fileSize);
      }
    });

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody,
      media
    });

    const videoId = response.data.id;
    const videoUrl = `https://youtube.com/shorts/${videoId}`;

    return {
      videoId,
      videoUrl,
      freshTokens // Return fresh tokens for client storage
    };
  }

  /**
   * Update video metadata after upload
   * @param {string} videoId - YouTube video ID
   * @param {object} metadata - Updated metadata
   * @param {object} tokens - OAuth tokens
   * @returns {Promise<object>} - Updated video data
   */
  async updateVideo(videoId, metadata, tokens) {
    const freshTokens = await this.refreshTokenIfNeeded(tokens);
    this.setCredentials(freshTokens);

    const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    const { title, description, tags, privacyStatus } = metadata;

    const requestBody = {
      id: videoId,
      snippet: {},
      status: {}
    };

    if (title) requestBody.snippet.title = title.substring(0, 100);
    if (description) requestBody.snippet.description = description.substring(0, 5000);
    if (tags) requestBody.snippet.tags = tags.slice(0, 500);
    if (privacyStatus) requestBody.status.privacyStatus = privacyStatus;

    const parts = [];
    if (Object.keys(requestBody.snippet).length > 0) parts.push('snippet');
    if (Object.keys(requestBody.status).length > 0) parts.push('status');

    if (parts.length === 0) {
      throw new Error('No metadata to update');
    }

    const response = await youtube.videos.update({
      part: parts,
      requestBody
    });

    return response.data;
  }

  /**
   * Set video thumbnail
   * @param {string} videoId - YouTube video ID
   * @param {string} thumbnailPath - Path to thumbnail image
   * @param {object} tokens - OAuth tokens
   * @returns {Promise<object>} - Thumbnail data
   */
  async setThumbnail(videoId, thumbnailPath, tokens) {
    const freshTokens = await this.refreshTokenIfNeeded(tokens);
    this.setCredentials(freshTokens);

    const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    const response = await youtube.thumbnails.set({
      videoId,
      media: {
        body: createReadStream(thumbnailPath)
      }
    });

    return response.data;
  }

  /**
   * Get video status/details
   * @param {string} videoId - YouTube video ID
   * @param {object} tokens - OAuth tokens
   * @returns {Promise<object>} - Video details
   */
  async getVideoStatus(videoId, tokens) {
    const freshTokens = await this.refreshTokenIfNeeded(tokens);
    this.setCredentials(freshTokens);

    const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    const response = await youtube.videos.list({
      part: ['snippet', 'status', 'processingDetails'],
      id: [videoId]
    });

    if (!response.data.items || response.data.items.length === 0) {
      throw new Error('Video not found');
    }

    return response.data.items[0];
  }

  /**
   * Delete a video
   * @param {string} videoId - YouTube video ID
   * @param {object} tokens - OAuth tokens
   * @returns {Promise<void>}
   */
  async deleteVideo(videoId, tokens) {
    const freshTokens = await this.refreshTokenIfNeeded(tokens);
    this.setCredentials(freshTokens);

    const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    await youtube.videos.delete({ id: videoId });
  }

  /**
   * Get user's YouTube channel info
   * @param {object} tokens - OAuth tokens
   * @returns {Promise<object>} - Channel info
   */
  async getChannelInfo(tokens) {
    const freshTokens = await this.refreshTokenIfNeeded(tokens);
    this.setCredentials(freshTokens);

    const youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });

    const response = await youtube.channels.list({
      part: ['snippet', 'contentDetails', 'statistics'],
      mine: true
    });

    if (!response.data.items || response.data.items.length === 0) {
      throw new Error('No channel found for this account');
    }

    const channel = response.data.items[0];
    return {
      id: channel.id,
      title: channel.snippet.title,
      description: channel.snippet.description,
      thumbnailUrl: channel.snippet.thumbnails?.default?.url,
      subscriberCount: channel.statistics.subscriberCount,
      videoCount: channel.statistics.videoCount
    };
  }
}
