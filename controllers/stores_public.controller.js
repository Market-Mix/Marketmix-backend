const pool = require('../config/db');
const { formatFlashSaleInfo } = require('../utils/flashSaleHelper');
const { sendSuccess, sendError } = require('../utils/response');

const getPublicProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const { store_id, seller_id } = req.query;

    const filters = ['p.is_active = true', 'p.is_deleted = false'];
    const params = [];

    if (store_id) {
      params.push(store_id);
      filters.push(`p.store_id = $${params.length}`);
    }

    if (seller_id) {
      params.push(seller_id);
      filters.push(`p.seller_id = $${params.length}`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT p.id, p.seller_id, p.name, p.description, p.price, p.stock_quantity,
              p.main_image_url, p.images, p.category_meta, p.weight_kg,
              p.is_active, p.created_at, p.category_id, p.color, p.size,
              p."flash start" AS flash_start, p."flash end" AS flash_end,
              COALESCE(c.name, 'uncategorized') AS category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM products p ${whereSql}`,
      params
    );

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
        flash_sale_active: flashInfo.isFlashSaleActive,
        flash_sale_discount: flashInfo.savings || 0,
        flash_sale_discount_percent: flashInfo.savingsPercent || 0,
        effective_price: flashInfo.currentPrice,
        time_remaining: flashInfo.timeRemaining
      };
    });

    return sendSuccess(res, 200, 'Products fetched', {
      data: productsWithDefaults,
      pagination: {
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
        pages: Math.ceil(parseInt(countResult.rows[0].total, 10) / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching public products:', error.message || error);
    return sendError(res, 500, 'Error fetching products', error.message || error);
  }
};

module.exports = {
  getPublicProducts,
};
