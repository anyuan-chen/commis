import { config } from '../config.js';
import { ReviewModel, ReviewPlatformModel } from '../db/models/index.js';

export class ReviewAggregator {
  /**
   * Fetch reviews from all linked platforms for a restaurant
   */
  async fetchAll(restaurantId) {
    const platforms = ReviewPlatformModel.getByRestaurant(restaurantId);
    if (!platforms) {
      return { google: [], total: 0 };
    }

    const results = {
      google: [],
      total: 0,
      errors: []
    };

    // Fetch from Google Places
    if (platforms.googlePlaceId) {
      try {
        const googleReviews = await this.fetchGoogleReviews(restaurantId, platforms.googlePlaceId);
        results.google = googleReviews;
        results.total += googleReviews.length;
      } catch (error) {
        results.errors.push({ source: 'google', error: error.message });
      }
    }

    return results;
  }

  /**
   * Fetch reviews from Google Places API
   */
  async fetchGoogleReviews(restaurantId, placeId) {
    if (!config.google.mapsApiKey) {
      throw new Error('Google Maps API key not configured');
    }

    // Use Places API (New)
    const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': config.google.mapsApiKey,
        'X-Goog-FieldMask': 'reviews'
      }
    });

    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = await response.json();
    const reviews = data.reviews || [];
    const savedReviews = [];

    for (const review of reviews) {
      const saved = ReviewModel.upsert(restaurantId, {
        source: 'google',
        externalId: `google_${review.name || review.authorAttribution?.displayName}_${review.publishTime}`,
        authorName: review.authorAttribution?.displayName || 'Anonymous',
        authorUrl: review.authorAttribution?.uri || '',
        rating: { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[review.rating] || 3,
        text: review.text?.text || review.originalText?.text || '',
        reviewDate: review.publishTime || new Date().toISOString()
      });
      savedReviews.push(saved);
    }

    return savedReviews;
  }

  /**
   * Search for a place on Google
   */
  async searchGoogle(query) {
    if (!config.google.mapsApiKey) {
      throw new Error('Google Maps API key not configured');
    }

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.google.mapsApiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount'
      },
      body: JSON.stringify({
        textQuery: query,
        includedType: 'restaurant',
        maxResultCount: 5
      })
    });

    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = await response.json();

    return (data.places || []).map(place => ({
      placeId: place.id,
      name: place.displayName?.text || '',
      address: place.formattedAddress || '',
      rating: place.rating,
      reviewCount: place.userRatingCount
    }));
  }
}

export const reviewAggregator = new ReviewAggregator();
