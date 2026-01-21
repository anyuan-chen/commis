import { Router } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel } from '../db/models/index.js';

const router = Router();

// Get restaurant data
router.get('/restaurant/:id', (req, res) => {
  const restaurant = RestaurantModel.getFullData(req.params.id);

  if (!restaurant) {
    return res.status(404).json({ error: 'Restaurant not found' });
  }

  res.json(restaurant);
});

// Preview website (redirect to static files)
router.get('/website/:id', (req, res) => {
  const material = MaterialModel.getLatestByType(req.params.id, 'website');

  if (!material || !material.file_path) {
    return res.status(404).json({ error: 'Website not generated yet' });
  }

  // Check if index.html exists
  const indexPath = join(material.file_path, 'index.html');
  if (!existsSync(indexPath)) {
    return res.status(404).json({ error: 'Website files not found' });
  }

  // Redirect to static file serving
  res.redirect(`/preview-static/${req.params.id}/index.html`);
});

// Get brochure preview info
router.get('/brochure/:id', (req, res) => {
  const pdfMaterial = MaterialModel.getLatestByType(req.params.id, 'brochure_pdf');
  const imageMaterial = MaterialModel.getLatestByType(req.params.id, 'brochure_image');

  if (!pdfMaterial && !imageMaterial) {
    return res.status(404).json({ error: 'Brochure not generated yet' });
  }

  res.json({
    pdf: pdfMaterial ? {
      id: pdfMaterial.id,
      version: pdfMaterial.version,
      downloadUrl: `/api/download/pdf/${req.params.id}`
    } : null,
    image: imageMaterial ? {
      id: imageMaterial.id,
      version: imageMaterial.version,
      previewUrl: `/api/download/image/${req.params.id}`,
      downloadUrl: `/api/download/image/${req.params.id}?download=true`
    } : null
  });
});

// Get all materials for a restaurant
router.get('/materials/:id', (req, res) => {
  const materials = MaterialModel.getByRestaurant(req.params.id);
  res.json(materials);
});

export default router;
