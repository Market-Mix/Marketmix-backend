const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Get all products (with pagination)
router.get('/', async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 20;
		const offset = (page - 1) * limit;

	const result = await pool.query(
		`SELECT id, seller_id, name, description, price, stock_quantity, main_image_url, 
		        category, rating, review_count, is_active, created_at
		 FROM products 
		 WHERE is_active = true AND is_deleted = false
		 ORDER BY created_at DESC
		 LIMIT $1 OFFSET $2`,
		[limit, offset]
	);

	const countResult = await pool.query(
		`SELECT COUNT(*) as total FROM products WHERE is_active = true AND is_deleted = false`
	);

	// Add default flash_sale fields to response
	const productsWithDefaults = result.rows.map(p => ({
		...p,
		flash_sale_active: p.flash_sale_active || false,
		flash_sale_discount: p.flash_sale_discount || 0
	}));

	res.json({
		status: 'success',
		data: productsWithDefaults,
		pagination: {
			total: parseInt(countResult.rows[0].total),
			page,
			limit,
			pages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
		}
	});
} catch (error) {
	console.error('Error fetching products:', error);
	res.status(500).json({ status: 'error', message: error.message });
}
});

// Get single product by ID
router.get('/:id', async (req, res) => {
	try {
		const { id } = req.params;

		// Get product details
		const productResult = await pool.query(
			`SELECT id, seller_id, name, description, price, stock_quantity, main_image_url, 
			        category, rating, review_count, is_active, flash_sale_discount, flash_sale_active,
			        created_at, updated_at
			 FROM products 
			 WHERE id = $1 AND is_active = true AND is_deleted = false`,
			[id]
		);

		if (productResult.rows.length === 0) {
			return res.status(404).json({ status: 'error', message: 'Product not found' });
		}

		const product = productResult.rows[0];

		// Get seller info
		const sellerResult = await pool.query(
			`SELECT id, name, email, shop_name, shop_avatar_url, rating 
			 FROM users 
			 WHERE id = $1 AND role = 'seller'`,
			[product.seller_id]
		);

		// Get product reviews
		const reviewsResult = await pool.query(
			`SELECT id, user_id, rating, comment, created_at 
			 FROM reviews 
			 WHERE product_id = $1 
			 ORDER BY created_at DESC 
			 LIMIT 10`,
			[id]
		);

		// Get related products (same category)
		const relatedResult = await pool.query(
			`SELECT id, name, price, main_image_url, rating, review_count 
			 FROM products 
			 WHERE category = $1 AND id != $2 AND is_active = true AND is_deleted = false
			 LIMIT 6`,
			[product.category, id]
		);

		// Get other seller products
		const sellerProductsResult = await pool.query(
			`SELECT id, name, price, main_image_url, rating, review_count 
			 FROM products 
			 WHERE seller_id = $1 AND id != $2 AND is_active = true AND is_deleted = false
			 LIMIT 10`,
			[product.seller_id, id]
		);

		res.json({
			status: 'success',
			data: {
				...product,
				flash_sale_active: product.flash_sale_active || false,
				flash_sale_discount: product.flash_sale_discount || 0,
				seller: sellerResult.rows[0] || null,
				reviews: reviewsResult.rows,
				relatedProducts: relatedResult.rows,
				sellerProducts: sellerProductsResult.rows
			}
		});
	} catch (error) {
		console.error('Error fetching product:', error);
		res.status(500).json({ status: 'error', message: error.message });
	}
});

module.exports = router;
