import { GoogleAdsApi, enums } from 'google-ads-api';
import { google } from 'googleapis';
import { config } from '../config.js';

const SCOPES = ['https://www.googleapis.com/auth/adwords'];

/**
 * Google Ads Service
 * Handles OAuth and Keyword Planner API access
 */
export class GoogleAdsService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      config.googleAds.clientId,
      config.googleAds.clientSecret,
      config.googleAds.redirectUri
    );
  }

  /**
   * Generate OAuth URL for Google Ads authorization
   */
  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokensFromCode(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    return tokens;
  }

  /**
   * Create authenticated Google Ads API client
   */
  createClient(refreshToken) {
    return new GoogleAdsApi({
      client_id: config.googleAds.clientId,
      client_secret: config.googleAds.clientSecret,
      developer_token: config.googleAds.developerToken
    });
  }

  /**
   * Get keyword ideas from Keyword Planner
   * @param {string} customerId - Google Ads customer ID (without dashes)
   * @param {string} refreshToken - OAuth refresh token
   * @param {string[]} keywords - Seed keywords to get ideas for
   * @param {Object} options - Additional options
   * @returns {Array} Keyword ideas with metrics
   */
  async getKeywordIdeas(customerId, refreshToken, keywords, options = {}) {
    const client = this.createClient(refreshToken);

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken
    });

    const keywordPlanIdeaService = customer.keywordPlanIdeas;

    // Build the request
    const request = {
      customer_id: customerId,
      language: options.language || 'languageConstants/1000', // English
      geo_target_constants: options.geoTargets || ['geoTargetConstants/2840'], // USA
      keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
      keyword_seed: {
        keywords: keywords
      }
    };

    try {
      const response = await keywordPlanIdeaService.generateKeywordIdeas(request);

      return response.map(idea => ({
        keyword: idea.text,
        avgMonthlySearches: idea.keyword_idea_metrics?.avg_monthly_searches || 0,
        competition: this.mapCompetition(idea.keyword_idea_metrics?.competition),
        competitionIndex: idea.keyword_idea_metrics?.competition_index || 0,
        topOfPageBidLow: this.microsToDollars(idea.keyword_idea_metrics?.low_top_of_page_bid_micros),
        topOfPageBidHigh: this.microsToDollars(idea.keyword_idea_metrics?.high_top_of_page_bid_micros)
      }));
    } catch (error) {
      console.error('Keyword Planner API error:', error);
      throw new Error(`Failed to get keyword ideas: ${error.message}`);
    }
  }

  /**
   * Get metrics for specific keywords
   * @param {string} customerId - Google Ads customer ID
   * @param {string} refreshToken - OAuth refresh token
   * @param {string[]} keywords - Keywords to get metrics for
   * @returns {Array} Keywords with their metrics
   */
  async getKeywordMetrics(customerId, refreshToken, keywords, options = {}) {
    const client = this.createClient(refreshToken);

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken
    });

    const keywordPlanIdeaService = customer.keywordPlanIdeas;

    // Build the request for historical metrics
    const request = {
      customer_id: customerId,
      language: options.language || 'languageConstants/1000',
      geo_target_constants: options.geoTargets || ['geoTargetConstants/2840'],
      keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
      historical_metrics_options: {
        include_average_cpc: true
      },
      keyword_seed: {
        keywords: keywords
      }
    };

    try {
      const response = await keywordPlanIdeaService.generateKeywordHistoricalMetrics(request);

      return response.map((result, index) => ({
        keyword: keywords[index] || result.text,
        avgMonthlySearches: result.keyword_metrics?.avg_monthly_searches || 0,
        competition: this.mapCompetition(result.keyword_metrics?.competition),
        competitionIndex: result.keyword_metrics?.competition_index || 0,
        avgCpc: this.microsToDollars(result.keyword_metrics?.average_cpc_micros),
        topOfPageBidLow: this.microsToDollars(result.keyword_metrics?.low_top_of_page_bid_micros),
        topOfPageBidHigh: this.microsToDollars(result.keyword_metrics?.high_top_of_page_bid_micros)
      }));
    } catch (error) {
      // Fallback to regular keyword ideas if historical metrics fails
      console.warn('Historical metrics failed, falling back to keyword ideas:', error.message);
      return this.getKeywordIdeas(customerId, refreshToken, keywords, options);
    }
  }

  /**
   * Convert micros to dollars
   */
  microsToDollars(micros) {
    if (!micros) return null;
    return (Number(micros) / 1000000).toFixed(2);
  }

  /**
   * Map competition enum to string
   */
  mapCompetition(competition) {
    const competitionMap = {
      0: 'UNSPECIFIED',
      1: 'UNKNOWN',
      2: 'LOW',
      3: 'MEDIUM',
      4: 'HIGH'
    };
    return competitionMap[competition] || 'UNKNOWN';
  }

  /**
   * Validate that Google Ads is configured
   */
  isConfigured() {
    return !!(
      config.googleAds.clientId &&
      config.googleAds.clientSecret &&
      config.googleAds.developerToken
    );
  }
}

export const googleAdsService = new GoogleAdsService();
