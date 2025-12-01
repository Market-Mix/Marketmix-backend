const express = require('express');
const router = express.Router();
const { getProducts } = require('../controllers/products.controller');

// Public: list products (supports pagination, search, category_id, seller_id)
router.get('/', getProducts);

module.exports = router;
