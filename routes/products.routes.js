const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Get all products (with pagination)
router.get('/', async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 20;
		const offset = (page - 1) * limit;

		// Start with minimal query - just get what we know exists
		let result;
		try {
			result = await pool.query(
				`SELECT id, seller_id, name, description, price, stock_quantity, main_image_url, 
						rating, review_count, is_active, created_at
				 FROM products 
				 WHERE is_active = true AND is_deleted = false
				 ORDER BY created_at DESC
				 LIMIT $1 OFFSET $2`,
				[limit, offset]
			);
		} catch (queryError) {
			console.error('Query error details:', queryError.message);
			// If the query fails, try with fewer columns
			console.log('Retrying with minimal columns...');
			result = await pool.query(
				`SELECT id, name, price FROM products LIMIT $1 OFFSET $2`,
				[limit, offset]
			);
		}

		const countResult = await pool.query(
			`SELECT COUNT(*) as total FROM products WHERE is_active = true AND is_deleted = false`
		);

		// Add default flash_sale fields to response
		const productsWithDefaults = result.rows.map(p => ({
			...p,
			description: p.description || '',
			main_image_url: p.main_image_url || 'https://via.placeholder.com/500',
			rating: p.rating || 4.5,
			review_count: p.review_count || 0,
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
		console.error('Error fetching products:', error.message);
		res.status(500).json({ status: 'error', message: error.message });
	}
});

// Get single product by ID
router.get('/:id', async (req, res) => {
	try {
		const { id } = req.params;

		// Get product details with fallback
		let productResult;
		try {
			productResult = await pool.query(
				`SELECT id, seller_id, name, description, price, stock_quantity, main_image_url, 
						rating, review_count, is_active, 
						created_at, updated_at
				 FROM products 
				 WHERE id = $1 AND is_active = true AND is_deleted = false`,
				[id]
			);
		} catch (queryError) {
			console.error('Product query error:', queryError.message);
			// Fallback to minimal query
			productResult = await pool.query(
				`SELECT id, seller_id, name, price FROM products WHERE id = $1 LIMIT 1`,
				[id]
			);
		}

		if (productResult.rows.length === 0) {
			return res.status(404).json({ status: 'error', message: 'Product not found' });
		}

		const product = productResult.rows[0];

		// Get seller info (non-critical, use empty array if fails)
		let sellerResult = { rows: [] };
		try {
			sellerResult = await pool.query(
				`SELECT id, name, email, shop_name, shop_avatar_url, rating 
				 FROM users 
				 WHERE id = $1`,
				[product.seller_id]
			);
		} catch (err) {
			console.warn('Could not fetch seller info:', err.message);
		}

		// Get product reviews (non-critical)
		let reviewsResult = { rows: [] };
		try {
			reviewsResult = await pool.query(
				`SELECT id, user_id, rating, comment, created_at 
				 FROM reviews 
				 WHERE product_id = $1 
				 ORDER BY created_at DESC 
				 LIMIT 10`,
				[id]
			);
		} catch (err) {
			console.warn('Could not fetch reviews:', err.message);
		}

		// Get related products (non-critical)
		let relatedResult = { rows: [] };
		try {
			relatedResult = await pool.query(
				`SELECT id, name, price, main_image_url, rating, review_count 
				 FROM products 
				 WHERE id != $1 AND is_active = true AND is_deleted = false
				 LIMIT 6`,
				[id]
			);
		} catch (err) {
			console.warn('Could not fetch related products:', err.message);
		}

		// Get other seller products (non-critical)
		let sellerProductsResult = { rows: [] };
		try {
			sellerProductsResult = await pool.query(
				`SELECT id, name, price, main_image_url, rating, review_count 
				 FROM products 
				 WHERE seller_id = $1 AND id != $2 AND is_active = true AND is_deleted = false
				 LIMIT 10`,
				[product.seller_id, id]
			);
		} catch (err) {
			console.warn('Could not fetch seller products:', err.message);
		}

		res.json({
			status: 'success',
			data: {
				...product,
				description: product.description || '',
				main_image_url: product.main_image_url || 'https://via.placeholder.com/500',
				rating: product.rating || 4.5,
				review_count: product.review_count || 0,
				flash_sale_active: product.flash_sale_active || false,
				flash_sale_discount: product.flash_sale_discount || 0,
				seller: sellerResult.rows[0] || null,
				reviews: reviewsResult.rows,
				relatedProducts: relatedResult.rows,
				sellerProducts: sellerProductsResult.rows
			}
		});
	} catch (error) {
		console.error('Error fetching product:', error.message);
		res.status(500).json({ status: 'error', message: error.message });
	}
});

module.exports = router;
