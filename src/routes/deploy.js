import { Router } from 'express';
import { WebsiteGenerator } from '../services/website-generator.js';
import { BrochureGenerator } from '../services/brochure-generator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { RestaurantModel, MaterialModel } from '../db/models/index.js';

const router = Router();

const websiteGenerator = new WebsiteGenerator();
const brochureGenerator = new BrochureGenerator();
const cloudflareDeployer = new CloudflareDeployer();

// Generate website
router.post('/generate/website/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const result = await websiteGenerator.generate(req.params.id);

    res.json({
      success: true,
      message: 'Website generated successfully',
      path: result.path,
      materialId: result.materialId,
      previewUrl: `/api/preview/website/${req.params.id}`
    });
  } catch (error) {
    console.error('Website generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate brochure
router.post('/generate/brochure/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const { layout = 'portrait' } = req.body;
    const result = await brochureGenerator.generate(req.params.id, { layout });

    res.json({
      success: true,
      message: `Brochure generated in ${layout} layout`,
      pdfPath: result.pdfPath,
      imagePath: result.imagePath,
      downloadUrl: `/api/download/pdf/${req.params.id}`,
      previewUrl: `/api/download/image/${req.params.id}`
    });
  } catch (error) {
    console.error('Brochure generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate all materials
router.post('/generate/all/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const results = {};

    // Generate website
    try {
      results.website = await websiteGenerator.generate(req.params.id);
    } catch (error) {
      results.website = { error: error.message };
    }

    // Generate brochures
    try {
      results.brochurePortrait = await brochureGenerator.generate(req.params.id, { layout: 'portrait' });
    } catch (error) {
      results.brochurePortrait = { error: error.message };
    }

    try {
      results.brochureLandscape = await brochureGenerator.generate(req.params.id, { layout: 'landscape' });
    } catch (error) {
      results.brochureLandscape = { error: error.message };
    }

    res.json({
      success: true,
      message: 'All materials generated',
      results
    });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deploy to Cloudflare
router.post('/cloudflare/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Check if website exists
    const material = MaterialModel.getLatestByType(req.params.id, 'website');
    if (!material) {
      return res.status(400).json({ error: 'Website not generated yet. Generate website first.' });
    }

    const result = await cloudflareDeployer.deploy(req.params.id);

    res.json({
      success: true,
      message: 'Website deployed to Cloudflare Pages',
      url: result.url,
      projectName: result.projectName
    });
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
