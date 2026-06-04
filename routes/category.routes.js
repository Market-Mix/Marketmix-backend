// routes/category.routes.js
const express = require('express');
const router = express.Router();
const {
  getAllCategories,
  getCategoryById,
  getProductsByCategory,
  getCategoriesWithCount,
  searchCategories
} = require('../controllers/category.controller');
const { protect } = require('../middlewares/auth.middleware');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// Public routes (buyers can view without login)
// Get all active categories
router.get('/', getAllCategories);

// Get categories with product count (useful for buyer page)
router.get('/with-count', getCategoriesWithCount);

// Search categories by name
router.get('/search/query', searchCategories);

// Get single category by ID
router.get('/:id', getCategoryById);

// Get products by category ID
router.get('/:id/products', getProductsByCategory);

// Get subcategories by category ID
router.get('/:id/subcategories', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, fields FROM subcategories WHERE category_id = $1 AND is_active = true ORDER BY name',
      [req.params.id]
    );
    return sendSuccess(res, 200, 'Subcategories fetched', result.rows);
  } catch (err) {
    return sendError(res, 500, 'Error fetching subcategories', err.message);
  }
});

// If you want to add protected routes later (for sellers/admin)
// Example: router.post('/', protect, createCategory);

module.exports = router;