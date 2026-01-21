import { Router } from 'express';
import { ImageGenerator } from '../services/image-generator.js';
import { RestaurantModel } from '../db/models/index.js';

const router = Router();

// Generate custom image from prompt
router.post('/generate/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      prompt,
      aspectRatio = '1:1',
      pro = false  // Use Nano Banana Pro for higher quality
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const generator = new ImageGenerator({ pro });

    // Enhance prompt with restaurant context
    const enhancedPrompt = `For restaurant "${restaurant.name}" (${restaurant.cuisine_type || 'restaurant'}), brand color ${restaurant.primary_color || '#2563eb'}:\n\n${prompt}`;

    const result = await generator.generate(enhancedPrompt, { aspectRatio });

    res.json({
      success: true,
      path: result.path,
      url: `/images/${result.path.split('/').pop()}`
    });
  } catch (error) {
    console.error('Image generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate social media graphic
router.post('/social/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      platform = 'instagram',
      theme = 'promotion',
      customText = null,
      pro = false
    } = req.body;

    const generator = new ImageGenerator({ pro });
    const result = await generator.generateSocialPost(restaurantId, {
      platform,
      theme,
      customText
    });

    res.json({
      success: true,
      path: result.path,
      url: `/images/${result.path.split('/').pop()}`,
      platform,
      theme
    });
  } catch (error) {
    console.error('Social graphic error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate menu graphic
router.post('/menu/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      style = 'elegant',
      category = null,
      pro = true  // Default to Pro for menu (better text rendering)
    } = req.body;

    const generator = new ImageGenerator({ pro });
    const result = await generator.generateMenuGraphic(restaurantId, {
      style,
      category
    });

    res.json({
      success: true,
      path: result.path,
      url: `/images/${result.path.split('/').pop()}`,
      style
    });
  } catch (error) {
    console.error('Menu graphic error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate promotional graphic
router.post('/promo/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      promoText = null,
      eventName = null,
      date = null,
      style = 'vibrant',
      pro = false
    } = req.body;

    const generator = new ImageGenerator({ pro });
    const result = await generator.generatePromoGraphic(restaurantId, {
      promoText,
      eventName,
      date,
      style
    });

    res.json({
      success: true,
      path: result.path,
      url: `/images/${result.path.split('/').pop()}`
    });
  } catch (error) {
    console.error('Promo graphic error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate holiday graphic
router.post('/holiday/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      holiday = 'christmas',
      message = null,
      pro = false
    } = req.body;

    const generator = new ImageGenerator({ pro });
    const result = await generator.generateHolidayGraphic(restaurantId, {
      holiday,
      message
    });

    res.json({
      success: true,
      path: result.path,
      url: `/images/${result.path.split('/').pop()}`,
      holiday
    });
  } catch (error) {
    console.error('Holiday graphic error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Edit an existing image
router.post('/edit/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      imagePath,
      editPrompt,
      pro = false
    } = req.body;

    if (!imagePath || !editPrompt) {
      return res.status(400).json({ error: 'imagePath and editPrompt are required' });
    }

    const generator = new ImageGenerator({ pro });
    const result = await generator.editImage(imagePath, editPrompt);

    res.json({
      success: true,
      path: result.path,
      url: `/images/${result.path.split('/').pop()}`
    });
  } catch (error) {
    console.error('Image edit error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
