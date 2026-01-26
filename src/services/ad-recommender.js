import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { RestaurantModel } from '../db/models/index.js';
import { googleAdsService } from './google-ads.js';
import { getStoredGoogleAdsTokens } from '../routes/google-ads-auth.js';

/**
 * AI-powered Google Ads campaign recommendation generator
 */
export class AdRecommender {
  constructor() {
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  /**
   * Generate comprehensive ad campaign recommendations
   * @param {string} restaurantId - Restaurant ID
   * @returns {Object} Campaign recommendations with keyword data
   */
  async generateRecommendations(restaurantId) {
    // 1. Get restaurant data
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error(`Restaurant not found: ${restaurantId}`);
    }

    // 2. Generate seed keywords from restaurant data
    const seedKeywords = await this.generateSeedKeywords(restaurant);

    // 3. Try to get Keyword Planner data if connected
    let keywordData = null;
    const tokens = getStoredGoogleAdsTokens();

    if (tokens?.refresh_token && tokens?.customer_id) {
      try {
        keywordData = await googleAdsService.getKeywordIdeas(
          tokens.customer_id,
          tokens.refresh_token,
          seedKeywords.slice(0, 10) // Limit to 10 seed keywords
        );
      } catch (error) {
        console.warn('Failed to get Keyword Planner data:', error.message);
        // Continue without keyword data - AI will generate estimates
      }
    }

    // 4. Generate final recommendations combining all data
    return this.generateFinalRecommendations(restaurant, seedKeywords, keywordData);
  }

  /**
   * Generate seed keywords from restaurant data using AI
   */
  async generateSeedKeywords(restaurant) {
    const menuItems = restaurant.menu?.flatMap(cat => cat.items.map(item => item.name)) || [];

    const prompt = `Generate 15 high-intent Google Ads seed keywords for this restaurant. Focus on keywords people would search when looking for a place to eat.

Restaurant Information:
- Name: ${restaurant.name}
- Cuisine Type: ${restaurant.cuisine_type || 'Restaurant'}
- Tagline: ${restaurant.tagline || 'N/A'}
- Description: ${restaurant.description || 'N/A'}
- Location: ${restaurant.address || 'Local area'}
- Popular Menu Items: ${menuItems.slice(0, 10).join(', ') || 'Various dishes'}

Generate keywords in these categories:
1. Cuisine-based (e.g., "italian restaurant near me")
2. Location-based (e.g., "best pizza downtown")
3. Intent-based (e.g., "dinner reservations tonight")
4. Dish-specific (e.g., "authentic pad thai delivery")
5. Experience-based (e.g., "romantic dinner restaurant")

Return ONLY a JSON array of keyword strings, nothing else.
Example: ["italian restaurant near me", "best pasta downtown", "romantic dinner spots"]`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();

      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      // Fallback: parse as lines
      return text.split('\n')
        .map(line => line.replace(/^[\d\.\-\*\s"]+|"$/g, '').trim())
        .filter(k => k.length > 0)
        .slice(0, 15);
    } catch (error) {
      console.error('Failed to generate seed keywords:', error);
      // Return basic fallback keywords
      const cuisine = restaurant.cuisine_type || 'restaurant';
      return [
        `${cuisine} near me`,
        `best ${cuisine}`,
        `${cuisine} delivery`,
        `${cuisine} takeout`,
        `${restaurant.name}`,
        'dinner near me',
        'lunch spots nearby',
        'restaurants open now'
      ];
    }
  }

  /**
   * Generate final campaign recommendations using AI
   */
  async generateFinalRecommendations(restaurant, seedKeywords, keywordData) {
    const menuItems = restaurant.menu?.flatMap(cat => cat.items.map(item => ({
      name: item.name,
      price: item.price,
      description: item.description
    }))) || [];

    const keywordInfo = keywordData
      ? keywordData.map(k => `- "${k.keyword}": ${k.avgMonthlySearches} monthly searches, ${k.competition} competition, CPC: $${k.topOfPageBidLow || '?'}-$${k.topOfPageBidHigh || '?'}`).join('\n')
      : 'Keyword Planner data not available - please provide estimated metrics.';

    const prompt = `Generate comprehensive Google Ads campaign recommendations for this restaurant.

RESTAURANT DATA:
Name: ${restaurant.name}
Cuisine: ${restaurant.cuisine_type || 'Restaurant'}
Tagline: ${restaurant.tagline || 'N/A'}
Description: ${restaurant.description || 'N/A'}
Address: ${restaurant.address || 'Local area'}
Phone: ${restaurant.phone || 'N/A'}
Brand Color: ${restaurant.primary_color || '#2563eb'}

Menu Highlights:
${menuItems.slice(0, 8).map(m => `- ${m.name}${m.price ? ` ($${m.price})` : ''}: ${m.description || 'No description'}`).join('\n')}

KEYWORD RESEARCH DATA:
${keywordInfo}

Seed Keywords Generated: ${seedKeywords.join(', ')}

Generate a complete campaign recommendation in this exact JSON format:
{
  "searchCampaign": {
    "name": "Campaign name",
    "headlines": ["Headline 1 (max 30 chars)", "Headline 2", "Headline 3", "Headline 4", "Headline 5"],
    "descriptions": ["Description 1 (max 90 chars)", "Description 2"],
    "keywords": [
      {
        "keyword": "keyword phrase",
        "matchType": "PHRASE|BROAD|EXACT",
        "avgSearches": 1000,
        "competition": "HIGH|MEDIUM|LOW",
        "cpcRange": "$1.00-$2.00",
        "priority": "HIGH|MEDIUM|LOW"
      }
    ],
    "negativeKeywords": ["negative keyword 1", "negative keyword 2"],
    "suggestedBudget": {
      "daily": "$20-30",
      "rationale": "Based on keyword CPCs and competition"
    },
    "targeting": {
      "radius": "10 miles",
      "adSchedule": "11am-10pm",
      "devices": "All devices, mobile bid adjustment +20%"
    }
  },
  "displayCampaign": {
    "name": "Display campaign name",
    "headlines": ["Short headline 1", "Short headline 2", "Short headline 3"],
    "descriptions": ["Display description"],
    "targeting": {
      "audiences": ["Foodies", "Local diners", "Cuisine enthusiasts"],
      "placements": "Food blogs, recipe sites, local news"
    },
    "suggestedBudget": {
      "daily": "$10-15",
      "rationale": "Brand awareness focus"
    }
  },
  "callCampaign": {
    "name": "Call campaign name",
    "headlines": ["Call-focused headline 1", "Call-focused headline 2"],
    "description": "Call-focused description",
    "targeting": {
      "radius": "5 miles",
      "adSchedule": "During business hours",
      "devices": "Mobile only"
    },
    "suggestedBudget": {
      "daily": "$15-25",
      "rationale": "High-intent local calls"
    }
  },
  "strategicNotes": [
    "Strategic recommendation 1",
    "Strategic recommendation 2"
  ]
}

IMPORTANT GUIDELINES:
- Headlines must be under 30 characters
- Descriptions must be under 90 characters
- Include the restaurant name in at least one headline
- Focus on unique selling points and popular dishes
- Keywords should include mix of high-volume and long-tail
- ${keywordData ? 'Use the actual keyword metrics provided' : 'Estimate realistic metrics based on industry averages'}
- Budget should be realistic for a local restaurant

Return ONLY valid JSON, no additional text.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();

      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON in response');
      }

      const recommendations = JSON.parse(jsonMatch[0]);

      // Enrich with actual keyword data if available
      if (keywordData && recommendations.searchCampaign?.keywords) {
        recommendations.searchCampaign.keywords = recommendations.searchCampaign.keywords.map(kw => {
          const realData = keywordData.find(k =>
            k.keyword.toLowerCase() === kw.keyword.toLowerCase()
          );
          if (realData) {
            return {
              ...kw,
              avgSearches: realData.avgMonthlySearches,
              competition: realData.competition,
              cpcRange: `$${realData.topOfPageBidLow || '?'}-$${realData.topOfPageBidHigh || '?'}`,
              dataSource: 'Google Keyword Planner'
            };
          }
          return { ...kw, dataSource: 'AI Estimate' };
        });
      }

      return {
        restaurantName: restaurant.name,
        restaurantId: restaurant.id,
        generatedAt: new Date().toISOString(),
        keywordPlannerConnected: !!keywordData,
        recommendations
      };
    } catch (error) {
      console.error('Failed to generate recommendations:', error);
      throw new Error(`Failed to generate ad recommendations: ${error.message}`);
    }
  }

  /**
   * Check if Google Ads Keyword Planner is available
   */
  isKeywordPlannerAvailable() {
    const tokens = getStoredGoogleAdsTokens();
    return !!(tokens?.refresh_token && tokens?.customer_id);
  }
}

export const adRecommender = new AdRecommender();
