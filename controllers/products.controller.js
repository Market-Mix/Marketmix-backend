const db = require('../config/db');
const { sendSuccess, sendError, sendPaginatedResponse } = require('../utils/response');

/**
 * GET /api/products
 * Public - returns paginated list of active products
 */
const getProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : null;
    const categoryId = req.query.category_id || null;
    const sellerId = req.query.seller_id || null;

    const filters = ['is_deleted = false', 'is_active = true'];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      filters.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }

    if (categoryId) {
      params.push(categoryId);
      filters.push(`category_id = $${params.length}`);
    }

    if (sellerId) {
      params.push(sellerId);
      filters.push(`seller_id = $${params.length}`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    // Total count
    const countQuery = `SELECT COUNT(*)::int AS total FROM products ${whereClause}`;
    const countRes = await db.query(countQuery, params);
    const total = countRes.rows[0] ? countRes.rows[0].total : 0;

    // Fetch page
    // Build params for select (we need to append limit/offset)
    const selectParams = params.slice();
    selectParams.push(limit);
    selectParams.push(offset);

    const selectQuery = `SELECT id, seller_id, category_id, name, description, price, stock_quantity, main_image_url, is_active, created_at, updated_at
      FROM products
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${selectParams.length - 1} OFFSET $${selectParams.length}`;

    const result = await db.query(selectQuery, selectParams);

    const items = result.rows.map(r => ({
      id: r.id,
      sellerId: r.seller_id,
      categoryId: r.category_id,
      name: r.name,
      description: r.description,
      price: parseFloat(r.price),
      stockQuantity: r.stock_quantity,
      image: r.main_image_url,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));

    return sendPaginatedResponse(res, items, page, limit, total);
  } catch (error) {
    console.error('Get products error:', error);
    return sendError(res, 500, 'Error fetching products', error);
  }
};

module.exports = {
  getProducts
};
