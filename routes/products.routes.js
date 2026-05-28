const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isFlashSaleActive, formatFlashSaleInfo } = require('../utils/flashSaleHelper');

// Get all products (with pagination)
router.get('/', async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 20;
		const offset = (page - 1) * limit;

		// Start with minimal query - just get what we know exists
		let result;
		try {
			// Using COALESCE to handle NULL category names
			// Also fetch flash_start and flash_end if available
			result = await pool.query(
				`SELECT p.id, p.seller_id, p.name, p.description, p.price, p.stock_quantity, p.main_image_url, 
						p.is_active, p.created_at, p.category_id, p.color, p.size,
						p."flash start" as flash_start, p."flash end" as flash_end,
						COALESCE(c.name, 'uncategorized') as category_name
				 FROM products p
				 LEFT JOIN categories c ON p.category_id = c.id
				 WHERE p.is_active = true AND p.is_deleted = false
				 ORDER BY p.created_at DESC
				 LIMIT $1 OFFSET $2`,
				[limit, offset]
			);
			
			console.log(`✅ Successfully fetched ${result.rows.length} products with categories`);
		} catch (queryError) {
			console.error('Query error details:', queryError.message);
			// If the query fails, try with fewer columns
			console.log('Retrying with minimal columns...');
			result = await pool.query(
				`SELECT p.id, p.name, p.price, p.category_id, p.main_image_url, p.description,
						p.color, p.size,
						p."flash start" as flash_start, p."flash end" as flash_end,
						COALESCE(c.name, 'uncategorized') as category_name
				 FROM products p
				 LEFT JOIN categories c ON p.category_id = c.id
				 WHERE p.is_active = true AND p.is_deleted = false
				 ORDER BY p.created_at DESC
				 LIMIT $1 OFFSET $2`,
				[limit, offset]
			);
		}

		const countResult = await pool.query(
			`SELECT COUNT(*) as total FROM products WHERE is_active = true AND is_deleted = false`
		);

		// Add flash sale and default fields to response
		const productsWithDefaults = result.rows.map(p => {
			const flashInfo = formatFlashSaleInfo(p.flash_start, p.flash_end, p.price);
			
			return {
				...p,
				description: p.description || '',
				main_image_url: p.main_image_url || 'https://via.placeholder.com/500',
				category: p.category_name ? p.category_name.toLowerCase() : 'uncategorized',
				rating: 4.5,
				review_count: 0,
								color: p.color || null,
								size: p.size || null,
				// Flash sale fields
				flash_sale_active: flashInfo.isFlashSaleActive,
				flash_sale_discount: flashInfo.savings || 0,
				flash_sale_discount_percent: flashInfo.savingsPercent || 0,
				effective_price: flashInfo.currentPrice,
				time_remaining: flashInfo.timeRemaining
			};
		});

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
							is_active, category_id, color, size, views,
							"flash start" as flash_start, "flash end" as flash_end,
							created_at, updated_at
				 FROM products 
				 WHERE id = $1 AND is_active = true AND is_deleted = false`,
				[id]
			);
		} catch (queryError) {
			console.error('Product query error:', queryError.message);
			// Fallback to minimal query
			productResult = await pool.query(
				`SELECT id, seller_id, name, price, main_image_url FROM products WHERE id = $1 LIMIT 1`,
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
				`SELECT u.id,
				        u.email,
				        u.first_name,
				        u.last_name,
				        COALESCE(sp.business_name, u.first_name || ' ' || u.last_name) AS name,
				        COALESCE(sp.business_name, u.first_name || ' ' || u.last_name) AS shop_name,
				        sp.store_logo_url AS shop_avatar_url,
				        sp.rating
				 FROM users u
				 LEFT JOIN seller_profiles sp ON sp.user_id = u.id AND sp.is_deleted = false
				 WHERE u.id = $1`,
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
				`SELECT id, name, price, main_image_url
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
				`SELECT id, name, price, main_image_url
				 FROM products 
				 WHERE seller_id = $1 AND id != $2 AND is_active = true AND is_deleted = false
				 LIMIT 10`,
				[product.seller_id, id]
			);
		} catch (err) {
			console.warn('Could not fetch seller products:', err.message);
		}

		// Compute flash sale info using helper so single-product response matches list response
		const flashInfo = formatFlashSaleInfo(product.flash_start, product.flash_end, product.price, product.flash_price || null);

		res.json({
			status: 'success',
			data: {
				...product,
				description: product.description || '',
				main_image_url: product.main_image_url || 'https://via.placeholder.com/500',
				rating: 4.5,
				review_count: 0,
				views: product.views || 0,
				color: product.color || null,
				size: product.size || null,
				// Flash sale fields (consistent with list endpoint)
				flash_sale_active: flashInfo.isFlashSaleActive,
				flash_sale_discount: flashInfo.savings || 0,
				flash_sale_discount_percent: flashInfo.savingsPercent || 0,
				effective_price: flashInfo.currentPrice,
				time_remaining: flashInfo.timeRemaining,
				flash_start: product.flash_start || null,
				flash_end: product.flash_end || null,
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

// Search products by name or description
router.get('/search/query', async (req, res) => {
	try {
		const { q } = req.query;

		if (!q || q.trim().length === 0) {
			return res.json({
				status: 'success',
				data: [],
				message: 'No search query provided'
			});
		}

		const searchQuery = `%${q.toLowerCase()}%`;

		let result;
		try {
			// Try full query with all columns
			result = await pool.query(
				`SELECT id, seller_id, name, description, price, stock_quantity, main_image_url, 
						is_active, created_at, category_id
				 FROM products 
				 WHERE is_active = true AND is_deleted = false 
				 AND (LOWER(name) LIKE $1 OR LOWER(description) LIKE $1)
				 ORDER BY name ASC
				 LIMIT 50`,
				[searchQuery]
			);
		} catch (columnError) {
			console.error('Full query failed, trying minimal columns:', columnError.message);
			// Fallback to minimal columns if some don't exist
			result = await pool.query(
				`SELECT id, name, price, main_image_url, category_id
				 FROM products 
				 WHERE is_active = true AND is_deleted = false 
				 AND (LOWER(name) LIKE $1 OR LOWER(description) LIKE $1)
				 ORDER BY name ASC
				 LIMIT 50`,
				[searchQuery]
			);
		}

		const productsWithDefaults = result.rows.map(p => ({
			...p,
			seller_id: p.seller_id || null,
			description: p.description || '',
			main_image_url: p.main_image_url || 'https://via.placeholder.com/500',
			price: p.price || 0,
			stock_quantity: p.stock_quantity || 0,
			rating: 4.5,
			review_count: 0,
			is_active: p.is_active !== false,
			created_at: p.created_at || new Date().toISOString()
		}));

		res.json({
			status: 'success',
			data: productsWithDefaults,
			count: productsWithDefaults.length
		});
	} catch (error) {
		console.error('Error searching products:', error.message);
		console.error('Error details:', error);
		res.status(500).json({ status: 'error', message: error.message });
	}
});

// Track product view - increment views count
router.post('/:id/view', async (req, res) => {
	try {
		const { id } = req.params;

		// Increment the views column for this product
		const result = await pool.query(
			`UPDATE products 
			 SET views = COALESCE(views, 0) + 1,
			     updated_at = NOW()
			 WHERE id = $1
			 RETURNING id, views`,
			[id]
		);

		if (result.rows.length === 0) {
			return res.status(404).json({ status: 'error', message: 'Product not found' });
		}

		res.json({
			status: 'success',
			message: 'View tracked',
			data: { product_id: id, views: result.rows[0].views }
		});
	} catch (error) {
		console.error('Error tracking product view:', error.message);
		// Don't fail the request - view tracking is non-critical
		res.json({ status: 'success', message: 'View tracked (async)' });
	}
});

module.exports = router;
