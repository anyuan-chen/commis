import { Router } from 'express';
import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';
import { MaterialModel, RestaurantModel } from '../db/models/index.js';

const router = Router();

// Download PDF brochure
router.get('/pdf/:id', (req, res) => {
  const material = MaterialModel.getLatestByType(req.params.id, 'brochure_pdf');

  if (!material || !material.file_path) {
    return res.status(404).json({ error: 'PDF brochure not found' });
  }

  if (!existsSync(material.file_path)) {
    return res.status(404).json({ error: 'PDF file not found on disk' });
  }

  const restaurant = RestaurantModel.getById(req.params.id);
  const filename = restaurant ? `${restaurant.name.replace(/[^a-z0-9]/gi, '_')}_brochure.pdf` : 'brochure.pdf';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  createReadStream(material.file_path).pipe(res);
});

// Download/preview brochure image
router.get('/image/:id', (req, res) => {
  const material = MaterialModel.getLatestByType(req.params.id, 'brochure_image');

  if (!material || !material.file_path) {
    return res.status(404).json({ error: 'Brochure image not found' });
  }

  if (!existsSync(material.file_path)) {
    return res.status(404).json({ error: 'Image file not found on disk' });
  }

  const restaurant = RestaurantModel.getById(req.params.id);
  const filename = restaurant ? `${restaurant.name.replace(/[^a-z0-9]/gi, '_')}_brochure.png` : 'brochure.png';

  res.setHeader('Content-Type', 'image/png');

  if (req.query.download === 'true') {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  createReadStream(material.file_path).pipe(res);
});

export default router;
