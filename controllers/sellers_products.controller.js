const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const multer = require('multer');

// Multer config — memory storage so we can pipe to Supabase
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP and GIF images are allowed'));
    }
  }
});

/**
 * Upload image to Supabase Storage and return public URL
 */
async function uploadImageToSupabase(file, sellerId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase storage not configured');
  }

  const ext = file.originalname.split('.').pop() || 'jpg';
  const filename = `${sellerId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const bucket = 'product-images';

  // Upload
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${filename}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': file.mimetype,
        'x-upsert': 'true',
      },
      body: file.buffer,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Image upload failed: ${err}`);
  }

  // Return public URL
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
}

/**
 * @desc  Get all products belonging to the authenticated seller
 * @route GET /api/seller/products
 */
const getSellerProducts = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { search, status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = `WHERE p.seller_id = $1 AND p.is_deleted = false`;
    const params = [sellerId];
    let idx = 2;

    if (search) {
      where += ` AND LOWER(p.name) LIKE $${idx++}`;
      params.push(`%${search.toLowerCase()}%`);
    }

    if (status === 'in-stock') {
      where += ` AND p.stock_quantity > 10`;
    } else if (status === 'low-stock') {
      where += ` AND p.stock_quantity > 0 AND p.stock_quantity <= 10`;
    } else if (status === 'out-of-stock') {
      where += ` AND p.stock_quantity = 0`;
    }

    const result = await db.query(
      `SELECT
         p.id, p.name, p.description, p.price, p.stock_quantity,
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

    // Compute stock status labels
    const products = result.rows.map(p => ({
      ...p,
      price: parseFloat(p.price),
      stockStatus:
        p.stock_quantity === 0
          ? 'Out of Stock'
          : p.stock_quantity <= 10
          ? 'Low Stock'
          : 'In Stock',
    }));

    return sendSuccess(res, 200, 'Products fetched', {
      products,
      total: parseInt(countRes.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error('getSellerProducts error:', error);
    return sendError(res, 500, 'Error fetching products', error.message);
  }
};

/**
 * @desc  Create a new product (with optional image upload)
 * @route POST /api/seller/products
 */
const createSellerProduct = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { name, description, price, stock_quantity, category_id, is_active } = req.body;

    if (!name || price === undefined || price === null) {
      return sendError(res, 400, 'Product name and price are required');
    }

    let mainImageUrl = req.body.image_url || null;

    // Handle uploaded file
    if (req.file) {
      try {
        mainImageUrl = await uploadImageToSupabase(req.file, sellerId);
      } catch (uploadErr) {
        return sendError(res, 500, `Image upload failed: ${uploadErr.message}`);
      }
    }

    const result = await db.query(
      `INSERT INTO products
         (seller_id, name, description, price, stock_quantity, main_image_url,
          category_id, is_active, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),NOW())
       RETURNING id, name, description, price, stock_quantity, main_image_url,
                 category_id, is_active, created_at`,
      [
        sellerId,
        name.trim(),
        description || '',
        parseFloat(price),
        parseInt(stock_quantity) || 0,
        mainImageUrl,
        category_id || null,
        is_active !== 'false' && is_active !== false,
      ]
    );

    const product = result.rows[0];
    product.price = parseFloat(product.price);
    product.stockStatus =
      product.stock_quantity === 0
        ? 'Out of Stock'
        : product.stock_quantity <= 10
        ? 'Low Stock'
        : 'In Stock';

    return sendSuccess(res, 201, 'Product created successfully', { product });
  } catch (error) {
    console.error('createSellerProduct error:', error);
    return sendError(res, 500, 'Error creating product', error.message);
  }
};

/**
 * @desc  Update a product (with optional new image)
 * @route PUT /api/seller/products/:productId
 */
const updateSellerProduct = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { productId } = req.params;

    // Ownership check
    const ownership = await db.query(
      `SELECT id, main_image_url FROM products WHERE id = $1 AND seller_id = $2 AND is_deleted = false`,
      [productId, sellerId]
    );
    if (ownership.rows.length === 0) {
      return sendError(res, 404, 'Product not found or access denied');
    }

    const existing = ownership.rows[0];
    const { name, description, price, stock_quantity, category_id, is_active } = req.body;

    let mainImageUrl = existing.main_image_url;

    if (req.file) {
      try {
        mainImageUrl = await uploadImageToSupabase(req.file, sellerId);
      } catch (uploadErr) {
        return sendError(res, 500, `Image upload failed: ${uploadErr.message}`);
      }
    } else if (req.body.image_url) {
      mainImageUrl = req.body.image_url;
    }

    const fields = [];
    const vals = [];
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
      product.stock_quantity === 0
        ? 'Out of Stock'
        : product.stock_quantity <= 10
        ? 'Low Stock'
        : 'In Stock';

    return sendSuccess(res, 200, 'Product updated successfully', { product });
  } catch (error) {
    console.error('updateSellerProduct error:', error);
    return sendError(res, 500, 'Error updating product', error.message);
  }
};

/**
 * @desc  Soft-delete a product
 * @route DELETE /api/seller/products/:productId
 */
const deleteSellerProduct = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { productId } = req.params;

    const result = await db.query(
      `UPDATE products
       SET is_deleted = true, is_active = false, updated_at = NOW()
       WHERE id = $1 AND seller_id = $2 AND is_deleted = false
       RETURNING id`,
      [productId, sellerId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'Product not found or already deleted');
    }

    return sendSuccess(res, 200, 'Product deleted successfully');
  } catch (error) {
    console.error('deleteSellerProduct error:', error);
    return sendError(res, 500, 'Error deleting product', error.message);
  }
};

module.exports = {
  upload,
  getSellerProducts,
  createSellerProduct,
  updateSellerProduct,
  deleteSellerProduct,
};