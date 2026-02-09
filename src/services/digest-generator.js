import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { ReviewModel, ReviewDigestModel } from '../db/models/index.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class DigestGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  /**
   * Generate a digest for a restaurant over a time period
   */
  async generateDigest(restaurantId, options = {}) {
    const {
      periodStart = this.getWeekAgo(),
      periodEnd = new Date().toISOString()
    } = options;

    // Get reviews for the period
    const reviews = ReviewModel.getByRestaurant(restaurantId, {
      startDate: periodStart,
      endDate: periodEnd,
      limit: 500
    });

    if (reviews.length === 0) {
      return {
        periodStart,
        periodEnd,
        reviewCount: 0,
        message: 'No reviews found for this period'
      };
    }

    // Calculate stats
    const stats = ReviewModel.getStats(restaurantId, { startDate: periodStart, endDate: periodEnd });

    // Generate AI analysis
    const analysis = await this.analyzeReviews(reviews);

    // Save digest
    const digest = ReviewDigestModel.create(restaurantId, {
      periodStart,
      periodEnd,
      reviewCount: reviews.length,
      avgRating: stats.avg_rating,
      summary: analysis.sentimentSummary,
      complaints: analysis.commonComplaints,
      praise: analysis.praiseThemes,
      actions: analysis.suggestedActions
    });

    return digest;
  }

  /**
   * Analyze reviews using Gemini
   */
  async analyzeReviews(reviews) {
    const reviewTexts = reviews
      .filter(r => r.text)
      .map(r => ({
        rating: r.rating,
        text: r.text,
        date: r.reviewDate
      }));

    if (reviewTexts.length === 0) {
      return {
        sentimentSummary: 'No review text available for analysis.',
        commonComplaints: [],
        praiseThemes: [],
        suggestedActions: []
      };
    }

    const prompt = `Analyze these restaurant reviews and provide insights in JSON format.

Reviews:
${JSON.stringify(reviewTexts, null, 2)}

Return ONLY valid JSON with this exact structure:
{
  "sentimentSummary": "2-3 sentence summary of overall customer sentiment and reception",
  "commonComplaints": [
    {
      "theme": "short theme name",
      "severity": "high|medium|low",
      "examples": ["direct quote from review"]
    }
  ],
  "praiseThemes": [
    {
      "theme": "short theme name",
      "count": number of reviews mentioning this,
      "examples": ["direct quote from review"]
    }
  ],
  "suggestedActions": [
    {
      "action": "specific actionable recommendation",
      "priority": "high|medium|low",
      "reason": "why this would help based on the reviews"
    }
  ]
}

Guidelines:
- Be specific and actionable in suggestions
- Use actual quotes from reviews as examples
- Severity should reflect frequency and impact
- Limit to top 5 items per category
- Focus on recurring themes, not one-off comments

Return ONLY the JSON, no markdown formatting.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();

      // Clean and parse JSON
      let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Failed to analyze reviews:', error);
      return {
        sentimentSummary: 'Unable to generate analysis.',
        commonComplaints: [],
        praiseThemes: [],
        suggestedActions: []
      };
    }
  }

  /**
   * Analyze sentiment for individual reviews
   */
  async analyzeSentiment(reviews) {
    if (reviews.length === 0) return [];

    const reviewTexts = reviews.map(r => ({
      id: r.id,
      text: r.text,
      rating: r.rating
    }));

    const prompt = `Analyze the sentiment of these reviews. Return JSON array with same order as input.

Reviews:
${JSON.stringify(reviewTexts, null, 2)}

Return ONLY valid JSON array:
[
  {
    "id": "review id",
    "sentimentScore": number from -1.0 (very negative) to 1.0 (very positive),
    "sentimentLabel": "positive|negative|neutral|mixed",
    "keyThemes": ["theme1", "theme2"]
  }
]

Guidelines:
- sentimentScore should reflect overall tone
- keyThemes are 1-3 word topics mentioned (e.g., "food quality", "wait time", "staff friendliness")
- mixed = contains both positive and negative elements

Return ONLY the JSON array.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();

      let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analyzed = JSON.parse(cleaned);

      // Update reviews with sentiment
      for (const item of analyzed) {
        ReviewModel.update(item.id, {
          sentimentScore: item.sentimentScore,
          sentimentLabel: item.sentimentLabel,
          keyThemes: item.keyThemes
        });
      }

      return analyzed;
    } catch (error) {
      console.error('Failed to analyze sentiment:', error);
      return [];
    }
  }

  /**
   * Get insights without generating a full digest
   */
  async getInsights(restaurantId, options = {}) {
    const { days = 30 } = options;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = ReviewModel.getStats(restaurantId, {
      startDate: startDate.toISOString()
    });

    const distribution = ReviewModel.getRatingDistribution(restaurantId);

    const recentReviews = ReviewModel.getByRestaurant(restaurantId, {
      limit: 10,
      startDate: startDate.toISOString()
    });

    // Get sentiment breakdown
    const sentimentBreakdown = {
      positive: stats.positive_count || 0,
      negative: stats.negative_count || 0,
      neutral: stats.neutral_count || 0,
      mixed: stats.mixed_count || 0
    };

    return {
      period: {
        start: startDate.toISOString(),
        end: new Date().toISOString(),
        days
      },
      stats: {
        totalReviews: stats.total_reviews || 0,
        avgRating: stats.avg_rating ? parseFloat(stats.avg_rating.toFixed(2)) : null,
        avgSentiment: stats.avg_sentiment ? parseFloat(stats.avg_sentiment.toFixed(2)) : null
      },
      sentimentBreakdown,
      ratingDistribution: distribution.reduce((acc, item) => {
        acc[item.rating_bucket] = item.count;
        return acc;
      }, {}),
      recentReviews: recentReviews.slice(0, 5)
    };
  }

  /**
   * Get date one week ago
   */
  getWeekAgo() {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return date.toISOString();
  }
}

export const digestGenerator = new DigestGenerator();
