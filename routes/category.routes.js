// routes/category.routes.js
const express = require('express');
const router = express.Router();
const {
  getAllCategories,
  getCategoryById,
  getProductsByCategory,
  getCategoriesWithCount
} = require('../controllers/category.controller');
const { protect } = require('../middlewares/auth.middleware');

// Public routes (buyers can view without login)
// Get all active categories
router.get('/', getAllCategories);

// Get categories with product count (useful for buyer page)
router.get('/with-count', getCategoriesWithCount);

// Get single category by ID
router.get('/:id', getCategoryById);

// Get products by category ID
router.get('/:id/products', getProductsByCategory);

// If you want to add protected routes later (for sellers/admin)
// Example: router.post('/', protect, createCategory);

module.exports = router;