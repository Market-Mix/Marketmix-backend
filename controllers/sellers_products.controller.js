/**
 * controllers/sellers_products.controller.js
 * All product operations are now scoped to a specific store_id.
 * The active store is passed as X-Store-Id header or storeId query param.
 */

const db           = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const multer       = require('multer');
const { logActivity } = require('./seller_activity.controller');

// ─── Multer ──────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));
  },
});

// ─── Helper: resolve active store ────────────────────────────────────────────
/**
 * Reads storeId from X-Store-Id header or ?storeId query param,
 * then confirms the store belongs to this seller.
 * Returns storeId string or null.
 */
async function resolveStoreId(req) {
  const storeId = req.headers['x-store-id'] || req.query.storeId;
  if (!storeId) return null;

  const r = await db.query(
    `SELECT id FROM stores WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [storeId, req.user.id]
  );
  return r.rows.length ? storeId : null;
}

// ─── Supabase image upload ───────────────────────────────────────────────────
async function uploadImageToSupabase(file, sellerId) {
  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Supabase storage not configured');

  const ext      = file.originalname.split('.').pop() || 'jpg';
  const filename = `${sellerId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const bucket   = 'product-images';

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${filename}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': file.mimetype, 'x-upsert': 'true' },
    body:    file.buffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Image upload failed: ${err}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
}

// ─── GET /api/seller/products ────────────────────────────────────────────────
const getSellerProducts = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeId  = await resolveStoreId(req);

    if (!storeId) {
      return sendError(res, 400, 'No active store selected. Send X-Store-Id header.');
    }

    const { search, status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where  = `WHERE p.seller_id = $1 AND p.store_id = $2 AND p.is_deleted = false`;
    const params = [sellerId, storeId];
    let idx = 3;

    if (search) {
      where += ` AND LOWER(p.name) LIKE $${idx++}`;
      params.push(`%${search.toLowerCase()}%`);
    }
    if (status === 'in-stock')       where += ` AND p.stock_quantity > 10`;
    else if (status === 'low-stock') where += ` AND p.stock_quantity > 0 AND p.stock_quantity <= 10`;
    else if (status === 'out-of-stock') where += ` AND p.stock_quantity = 0`;

    const result = await db.query(
      `SELECT p.id, p.name, p.description, p.price, p.stock_quantity,
              p.main_image_url, p.is_active, p.category_id,
              p.color, p.size, p.created_at, p.updated_at,
              COALESCE(c.name, 'Uncategorized') AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM products p ${where}`,
      params
    );

    return sendSuccess(res, 200, 'Products fetched', {
      products: result.rows.map(p => ({
        ...p,
        price: parseFloat(p.price),
        stockStatus:
          p.stock_quantity === 0  ? 'Out of Stock' :
          p.stock_quantity <= 10  ? 'Low Stock'    : 'In Stock',
      })),
      total: parseInt(countRes.rows[0].total),
      page:  parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('getSellerProducts error:', err);
    return sendError(res, 500, 'Error fetching products', err.message);
  }
};

// ─── POST /api/seller/products ───────────────────────────────────────────────
const createSellerProduct = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeId  = await resolveStoreId(req);

    if (!storeId) {
      return sendError(res, 400, 'No active store selected. Send X-Store-Id header.');
    }

    const { name, description, price, stock_quantity, category_id, is_active } = req.body;
    if (!name || price === undefined || price === null) {
      return sendError(res, 400, 'Product name and price are required');
    }

    let mainImageUrl = req.body.image_url || null;
    if (req.file) {
      try { mainImageUrl = await uploadImageToSupabase(req.file, sellerId); }
      catch (e) { return sendError(res, 500, `Image upload failed: ${e.message}`); }
    }

    const result = await db.query(
      `INSERT INTO products
         (seller_id, store_id, name, description, price, stock_quantity,
          main_image_url, category_id, is_active, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,NOW(),NOW())
       RETURNING id, name, description, price, stock_quantity,
                 main_image_url, category_id, is_active, created_at`,
      [
        sellerId, storeId, name.trim(), description || '',
        parseFloat(price), parseInt(stock_quantity) || 0,
        mainImageUrl, category_id || null,
        is_active !== 'false' && is_active !== false
      ]
    );

    const product = result.rows[0];
    product.price = parseFloat(product.price);
    product.stockStatus =
      product.stock_quantity === 0  ? 'Out of Stock' :
      product.stock_quantity <= 10  ? 'Low Stock'    : 'In Stock';

    await logActivity({
      sellerId, storeId,
      type:       'product_added',
      title:      `Added product "${product.name}"`,
      detail:     `Price: $${product.price} · Stock: ${product.stock_quantity}`,
      entityId:   product.id,
      entityType: 'product',
    });

    return sendSuccess(res, 201, 'Product created successfully', { product });
  } catch (err) {
    console.error('createSellerProduct error:', err);
    return sendError(res, 500, 'Error creating product', err.message);
  }
};

// ─── PUT /api/seller/products/:productId ─────────────────────────────────────
const updateSellerProduct = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeId  = await resolveStoreId(req);
    const { productId } = req.params;

    if (!storeId) {
      return sendError(res, 400, 'No active store selected. Send X-Store-Id header.');
    }

    const ownership = await db.query(
      `SELECT id, name, main_image_url FROM products
       WHERE id = $1 AND seller_id = $2 AND store_id = $3 AND is_deleted = false`,
      [productId, sellerId, storeId]
    );
    if (!ownership.rows.length) return sendError(res, 404, 'Product not found or access denied');

    const existing = ownership.rows[0];
    const { name, description, price, stock_quantity, category_id, is_active } = req.body;

    let mainImageUrl = existing.main_image_url;
    if (req.file) {
      try { mainImageUrl = await uploadImageToSupabase(req.file, sellerId); }
      catch (e) { return sendError(res, 500, `Image upload failed: ${e.message}`); }
    } else if (req.body.image_url) {
      mainImageUrl = req.body.image_url;
    }

    const fields = [];
    const vals   = [];
    let i = 1;

    if (name !== undefined)           { fields.push(`name = $${i++}`);           vals.push(name.trim()); }
    if (description !== undefined)    { fields.push(`description = $${i++}`);    vals.push(description); }
    if (price !== undefined)          { fields.push(`price = $${i++}`);          vals.push(parseFloat(price)); }
    if (stock_quantity !== undefined) { fields.push(`stock_quantity = $${i++}`); vals.push(parseInt(stock_quantity)); }
    if (category_id !== undefined)    { fields.push(`category_id = $${i++}`);    vals.push(category_id || null); }
    if (is_active !== undefined)      { fields.push(`is_active = $${i++}`);      vals.push(is_active !== 'false' && is_active !== false); }

    fields.push(`main_image_url = $${i++}`);
    vals.push(mainImageUrl);
    fields.push(`updated_at = NOW()`);
    vals.push(productId);

    const result = await db.query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, name, description, price, stock_quantity,
                 main_image_url, category_id, is_active, updated_at`,
      vals
    );

    const product = result.rows[0];
    product.price = parseFloat(product.price);
    product.stockStatus =
      product.stock_quantity === 0  ? 'Out of Stock' :
      product.stock_quantity <= 10  ? 'Low Stock'    : 'In Stock';

    await logActivity({
      sellerId, storeId,
      type:       'product_updated',
      title:      `Updated product "${product.name}"`,
      entityId:   product.id,
      entityType: 'product',
    });

    return sendSuccess(res, 200, 'Product updated successfully', { product });
  } catch (err) {
    console.error('updateSellerProduct error:', err);
    return sendError(res, 500, 'Error updating product', err.message);
  }
};

// ─── DELETE /api/seller/products/:productId ──────────────────────────────────
const deleteSellerProduct = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const storeId  = await resolveStoreId(req);
    const { productId } = req.params;

    if (!storeId) {
      return sendError(res, 400, 'No active store selected. Send X-Store-Id header.');
    }

    const nameRes = await db.query(
      `SELECT name FROM products
       WHERE id = $1 AND seller_id = $2 AND store_id = $3 AND is_deleted = false`,
      [productId, sellerId, storeId]
    );
    if (!nameRes.rows.length) return sendError(res, 404, 'Product not found or already deleted');

    await db.query(
      `UPDATE products SET is_deleted = true, is_active = false, updated_at = NOW()
       WHERE id = $1 AND seller_id = $2 AND store_id = $3`,
      [productId, sellerId, storeId]
    );

    await logActivity({
      sellerId, storeId,
      type:       'product_deleted',
      title:      `Deleted product "${nameRes.rows[0].name}"`,
      entityId:   productId,
      entityType: 'product',
    });

    return sendSuccess(res, 200, 'Product deleted successfully');
  } catch (err) {
    console.error('deleteSellerProduct error:', err);
    return sendError(res, 500, 'Error deleting product', err.message);
  }
};

module.exports = { upload, getSellerProducts, createSellerProduct, updateSellerProduct, deleteSellerProduct };