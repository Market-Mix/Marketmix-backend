const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Get all products with pagination
router.get('/', async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit) || 10, 100);
		const offset = parseInt(req.query.offset) || 0;

		// Fetch products from database
		const result = await db.query(
			`SELECT id, name, description, price, stock_quantity, main_image_url as image, is_active
			 FROM products 
			 WHERE is_active = true AND is_deleted = false
			 ORDER BY created_at DESC
			 LIMIT $1 OFFSET $2`,
			[limit, offset]
		);

		// Fetch total count
		const countResult = await db.query(
			`SELECT COUNT(*) FROM products WHERE is_active = true AND is_deleted = false`
		);

		const total = parseInt(countResult.rows[0].count);

		res.json({
			status: 'success',
			message: 'Products retrieved successfully',
			data: result.rows.map(p => ({
				id: p.id,
				name: p.name,
				description: p.description,
				price: parseFloat(p.price),
				stock_quantity: p.stock_quantity,
				image: p.image,
				main_image_url: p.image,
				is_active: p.is_active
			})),
			pagination: {
				limit,
				offset,
				total,
				pages: Math.ceil(total / limit)
			}
		});
	} catch (error) {
		console.error('Get products error:', error);
		res.status(500).json({
			status: 'error',
			message: 'Failed to retrieve products',
			error: error.message
		});
	}
});

// Get single product by ID
router.get('/:id', async (req, res) => {
	try {
		const { id } = req.params;

		const result = await db.query(
			`SELECT id, name, description, price, stock_quantity, main_image_url as image, is_active
			 FROM products 
			 WHERE id = $1 AND is_deleted = false`,
			[id]
		);

		if (result.rows.length === 0) {
			return res.status(404).json({
				status: 'error',
				message: 'Product not found'
			});
		}

		const product = result.rows[0];
		res.json({
			status: 'success',
			message: 'Product retrieved successfully',
			data: {
				id: product.id,
				name: product.name,
				description: product.description,
				price: parseFloat(product.price),
				stock_quantity: product.stock_quantity,
				image: product.image,
				main_image_url: product.image,
				is_active: product.is_active
			}
		});
	} catch (error) {
		console.error('Get product error:', error);
		res.status(500).json({
			status: 'error',
			message: 'Failed to retrieve product',
			error: error.message
		});
	}
});

module.exports = router;
