const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const pool = require('../config/database');

const uploadDir = path.join(__dirname, '../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

// Upload image for product (returns Base64 for permanent storage)
router.post('/upload', (req, res) => {
  upload.single('imageFile')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'Image upload failed' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    // Read file and convert to Base64
    const filePath = req.file.path;
    const fs = require('fs');
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = `data:${req.file.mimetype};base64,${imageBuffer.toString('base64')}`;
    
    // Delete the temporary file (we don't need it anymore)
    fs.unlinkSync(filePath);
    
    // Return Base64 directly (this will be stored in DB)
    res.json({ success: true, imageUrl: base64Image });
  });
});

// Get all products (including inactive)
router.get('/', async (req, res) => {
  try {
    // Return only active products
    const result = await pool.query(
      'SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC'
    );
    res.json({ success: true, products: result.rows });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single product
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create product
router.post('/', async (req, res) => {
  try {
    const { name_ar, name_en, description, price, image_url, category, stock } = req.body;
    
    if (!name_ar || !price) {
      return res.status(400).json({ success: false, message: 'اسم المنتج والسعر مطلوبان' });
    }
    
    const result = await pool.query(
      `INSERT INTO products (name_ar, name_en, description, price, image_url, category, stock, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
      [name_ar, name_en || '', description || '', price, image_url || '', category || '', stock || 0]
    );
    
    res.status(201).json({ success: true, product: result.rows[0] });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name_ar, name_en, description, price, image_url, category, stock, is_active } = req.body;
    
    const result = await pool.query(
      `UPDATE products SET 
        name_ar = COALESCE($1, name_ar),
        name_en = COALESCE($2, name_en),
        description = COALESCE($3, description),
        price = COALESCE($4, price),
        image_url = COALESCE($5, image_url),
        category = COALESCE($6, category),
        stock = COALESCE($7, stock),
        is_active = COALESCE($8, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [name_ar, name_en, description, price, image_url, category, stock, is_active, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

// Delete product (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'UPDATE products SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
