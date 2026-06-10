const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

function stableStringify(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeCartItems(items) {
  const itemMap = new Map();

  for (const item of items) {
    const product_id = item.product_id;
    const quantity = parseInt(item.quantity, 10);
    if (!product_id || !Number.isInteger(quantity) || quantity < 1) continue;

    const color = item.color || null;
    const size = item.size || null;
    const selected_specifications = item.selected_specifications || item.specifications || null;
    const specsKey = stableStringify(selected_specifications);
    const key = `${product_id}|${color || ''}|${size || ''}|${specsKey}`;

    const existing = itemMap.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      itemMap.set(key, {
        product_id,
        quantity,
        color,
        size,
        selected_specifications
      });
    }
  }

  return [...itemMap.values()];
}

/**
 * @desc    Add item to cart
 * @route   POST /api/cart/add
 * @access  Private
 */
const addToCart = async (req, res) => {
  try {
    const { product_id, quantity, color = null, size = null, selected_specifications = null } = req.body;
    const user_id = req.user.id;
    const specs = selected_specifications || req.body.specifications || null;

    console.log('🛒 Add to cart request:', { product_id, quantity, color, size, selected_specifications: specs, user_id });

    // Validate user_id
    if (!user_id) {
      return sendError(res, 401, 'User not authenticated - user_id missing');
    }

    // Validate required fields
    if (!product_id || !quantity) {
      return sendError(res, 400, 'Please provide product_id and quantity');
    }

    // Validate quantity
    if (quantity < 1 || !Number.isInteger(quantity)) {
      return sendError(res, 400, 'Quantity must be a positive integer');
    }

    // Get or create cart for user
    let cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1`,
      [user_id]
    );

    let cartId;
    if (cartRes.rows.length === 0) {
      const createCartRes = await db.query(
        `INSERT INTO cart (user_id, cart_type, is_active, is_deleted, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, NOW(), NOW()) 
         RETURNING id`,
        [user_id, 'shopping', true, false]
      );
      cartId = createCartRes.rows[0].id;
      console.log('✅ Created new cart:', cartId);
    } else {
      cartId = cartRes.rows[0].id;
      console.log('✅ Using existing cart:', cartId);
    }

    // Check if product exists and is active
    const productResult = await db.query(
      `SELECT id, price, stock_quantity, name, main_image_url 
       FROM products 
       WHERE id = $1 AND is_active = true AND is_deleted = false`,
      [product_id]
    );

    if (productResult.rows.length === 0) {
      return sendError(res, 404, 'Product not found or is inactive');
    }

    const product = productResult.rows[0];

    // Check if product has sufficient stock
    if (product.stock_quantity < quantity) {
      return sendError(
        res,
        400,
        `Insufficient stock. Available: ${product.stock_quantity}, Requested: ${quantity}`
      );
    }

    // Check if item already exists in cart with the same spec combination
    const existingCartItem = await db.query(
      `SELECT id, quantity, color, size, selected_specifications FROM cart_items 
       WHERE cart_id = $1 AND product_id = $2
         AND color IS NOT DISTINCT FROM $3
         AND size IS NOT DISTINCT FROM $4
         AND selected_specifications IS NOT DISTINCT FROM $5
       LIMIT 1`,
      [cartId, product_id, color, size, specs]
    );

    let cartItem;

    if (existingCartItem.rows.length > 0) {
      // Update existing cart item
      const existingItem = existingCartItem.rows[0];
      const newQuantity = existingItem.quantity + quantity;

      // Check stock again with new quantity
      if (product.stock_quantity < newQuantity) {
        return sendError(
          res,
          400,
          `Cannot add this quantity. Available: ${product.stock_quantity}, Total would be: ${newQuantity}`
        );
      }

      const updateResult = await db.query(
        `UPDATE cart_items 
         SET quantity = $1, updated_at = NOW() 
         WHERE id = $2 
         RETURNING id, cart_id, product_id, quantity, color, size, selected_specifications, updated_at`,
        [newQuantity, existingItem.id]
      );

      cartItem = updateResult.rows[0];
    } else {
      // Insert new cart item
      const insertResult = await db.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity, color, size, selected_specifications, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) 
         RETURNING id, cart_id, product_id, quantity, color, size, selected_specifications, created_at, updated_at`,
        [cartId, product_id, quantity, color, size, specs]
      );

      cartItem = insertResult.rows[0];
    }

    console.log('Cart item specs saved', {
      cartItem: {
        id: cartItem.id,
        product_id: cartItem.product_id,
        color: cartItem.color,
        size: cartItem.size,
        selected_specifications: cartItem.selected_specifications
      }
    });

    return sendSuccess(res, 201, 'Item added to cart successfully', {
      cartItem: {
        id: cartItem.id,
        productId: cartItem.product_id,
        quantity: cartItem.quantity,
        productName: product.name,
        productImage: product.main_image_url,
        price: parseFloat(product.price),
        totalPrice: parseFloat(product.price) * cartItem.quantity
      }
    });
  } catch (error) {
    console.error('❌ Add to cart error:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      stack: error.stack
    });
    return sendError(res, 500, 'Error adding item to cart', error.message);
  }
};

/**
 * @desc    Merge client cart items into user's cart
 * @route   POST /api/cart/merge
 * @access  Private
 */
const mergeCart = async (req, res) => {
  let client;

  try {
    const user_id = req.user.id;
    const { items } = req.body;

    if (!user_id) {
      return sendError(res, 401, 'User not authenticated - user_id missing');
    }

    if (!Array.isArray(items)) {
      return sendError(res, 400, 'Items must be an array');
    }

    const hasInvalidItem = items.some(
      item =>
        !item ||
        !item.product_id ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1
    );

    if (hasInvalidItem) {
      return sendError(res, 400, 'Each item must include product_id and a positive integer quantity');
    }

    client = await db.pool.connect();

const normalizedItems = normalizeCartItems(items);
    const mergedItems = [];
    const adjustments = [];

    await client.query('BEGIN');

    let cartRes = await client.query(
      `SELECT id FROM cart
       WHERE user_id = $1 AND is_active = true AND is_deleted = false
       LIMIT 1
       FOR UPDATE`,
      [user_id]
    );

    let cartId;
    if (cartRes.rows.length === 0) {
      const createCartRes = await client.query(
        `INSERT INTO cart (user_id, cart_type, is_active, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [user_id, 'shopping', true, false]
      );
      cartId = createCartRes.rows[0].id;
    } else {
      cartId = cartRes.rows[0].id;
    }

    for (const item of normalizedItems) {
      const requested = item.quantity;

      const productResult = await client.query(
        `SELECT id, price, stock_quantity, name, main_image_url
         FROM products
         WHERE id = $1 AND is_active = true AND is_deleted = false
         FOR UPDATE`,
        [item.product_id]
      );

      if (productResult.rows.length === 0) {
        adjustments.push({
          product_id: item.product_id,
          requested,
          adjusted_to: 0,
          reason: 'product_unavailable'
        });
        continue;
      }

      const product = productResult.rows[0];
      const stockQuantity = parseInt(product.stock_quantity || 0, 10);

      const existingCartItem = await client.query(
        `SELECT id, quantity FROM cart_items
         WHERE cart_id = $1 AND product_id = $2
           AND color IS NOT DISTINCT FROM $3
           AND size IS NOT DISTINCT FROM $4
           AND selected_specifications IS NOT DISTINCT FROM $5
         FOR UPDATE`,
        [cartId, item.product_id, item.color, item.size, item.selected_specifications]
      );

      const existingQuantity = existingCartItem.rows.length
        ? parseInt(existingCartItem.rows[0].quantity || 0, 10)
        : 0;
      const desiredQuantity = existingQuantity + requested;
      const adjustedQuantity = Math.min(desiredQuantity, stockQuantity);

      if (adjustedQuantity !== desiredQuantity) {
        adjustments.push({
          product_id: item.product_id,
          requested,
          adjusted_to: adjustedQuantity,
          reason: 'insufficient_stock'
        });
      }

      if (adjustedQuantity < 1) {
        if (existingCartItem.rows.length) {
          await client.query('DELETE FROM cart_items WHERE id = $1', [
            existingCartItem.rows[0].id
          ]);
        }
        continue;
      }

      let cartItem;
      if (existingCartItem.rows.length) {
        const updateResult = await client.query(
          `UPDATE cart_items
           SET quantity = $1, updated_at = NOW()
           WHERE id = $2
           RETURNING id, cart_id, product_id, quantity, color, size, selected_specifications, updated_at`,
          [adjustedQuantity, existingCartItem.rows[0].id]
        );
        cartItem = updateResult.rows[0];
      } else {
        const insertResult = await client.query(
          `INSERT INTO cart_items (cart_id, product_id, quantity, color, size, selected_specifications, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           RETURNING id, cart_id, product_id, quantity, color, size, selected_specifications, created_at, updated_at`,
          [cartId, item.product_id, adjustedQuantity, item.color, item.size, item.selected_specifications]
        );
        cartItem = insertResult.rows[0];
      }

      mergedItems.push({
        id: cartItem.id,
        product_id: cartItem.product_id,
        quantity: cartItem.quantity,
        productName: product.name,
        productImage: product.main_image_url,
        price: parseFloat(product.price),
        totalPrice: parseFloat(product.price) * cartItem.quantity,
        color: cartItem.color || null,
        size: cartItem.size || null,
        selected_specifications: cartItem.selected_specifications || null
      });
    }

    await client.query('COMMIT');

    return sendSuccess(res, 200, 'Cart merged successfully', {
      mergedItems,
      adjustments
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Merge cart error:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      stack: error.stack
    });
    return sendError(res, 500, 'Error merging cart', error.message);
  } finally {
    if (client) {
      client.release();
    }
  }
};

/**
 * @desc    Get user's cart
 * @route   GET /api/cart
 * @access  Private
 */
const getCart = async (req, res) => {
  try {
    const user_id = req.user.id;

    // Get user's cart
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1`,
      [user_id]
    );

    if (cartRes.rows.length === 0) {
      // Return empty cart if no cart exists
      return sendSuccess(res, 200, 'Cart retrieved successfully', {
        items: [],
        totalItems: 0,
        totalPrice: 0
      });
    }

    const cartId = cartRes.rows[0].id;

    const result = await db.query(
      `SELECT 
        ci.id,
        ci.product_id,
        ci.quantity,
        ci.color,
        ci.size,
        ci.selected_specifications,
        p.name,
        p.main_image_url,
        p.price,
        p.stock_quantity,
        (p.price * ci.quantity) as total_price
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.cart_id = $1 AND p.is_deleted = false
       ORDER BY ci.created_at DESC`,
      [cartId]
    );

    const cartItems = result.rows.map(item => ({
      id: item.id,
      productId: item.product_id,
      name: item.name,
      image: item.main_image_url,
      price: parseFloat(item.price),
      quantity: item.quantity,
      stockAvailable: item.stock_quantity,
      totalPrice: parseFloat(item.total_price),
      color: item.color || null,
      size: item.size || null,
      selected_specifications: item.selected_specifications || {}
    }));

    console.log('Cart item specs returned', cartItems.map(item => ({
      id: item.id,
      color: item.color,
      size: item.size,
      selected_specifications: item.selected_specifications
    })));

    const totalCartPrice = cartItems.reduce((sum, item) => sum + item.totalPrice, 0);

    return sendSuccess(res, 200, 'Cart retrieved successfully', {
      items: cartItems,
      totalItems: cartItems.length,
      totalPrice: totalCartPrice
    });
  } catch (error) {
    console.error('Get cart error:', error);
    return sendError(res, 500, 'Error retrieving cart', error);
  }
};

/**
 * @desc    Update cart item quantity
 * @route   PUT /api/cart/:cartItemId
 * @access  Private
 */
const updateCartItem = async (req, res) => {
  try {
    const { cartItemId } = req.params;
    const { quantity } = req.body;
    const user_id = req.user.id;

    console.log('📝 Update cart item:', { cartItemId, quantity, user_id });

    // Validate quantity
    if (!quantity || quantity < 1 || !Number.isInteger(quantity)) {
      return sendError(res, 400, 'Quantity must be a positive integer');
    }

    // Get user's cart
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1`,
      [user_id]
    );

    if (cartRes.rows.length === 0) {
      return sendError(res, 404, 'Cart not found');
    }

    const cartId = cartRes.rows[0].id;

    // Check if cart item exists and belongs to user's cart
    const cartItemResult = await db.query(
      `SELECT ci.id, ci.product_id, p.stock_quantity, p.price, p.name, p.main_image_url
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.id = $1 AND ci.cart_id = $2`,
      [cartItemId, cartId]
    );

    if (cartItemResult.rows.length === 0) {
      return sendError(res, 404, 'Cart item not found');
    }

    const cartItem = cartItemResult.rows[0];

    // Check stock
    if (cartItem.stock_quantity < quantity) {
      return sendError(
        res,
        400,
        `Insufficient stock. Available: ${cartItem.stock_quantity}, Requested: ${quantity}`
      );
    }

    // Update cart item
    const updateResult = await db.query(
      `UPDATE cart_items 
       SET quantity = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING id, product_id, quantity, updated_at`,
      [quantity, cartItemId]
    );

    const updatedItem = updateResult.rows[0];

    return sendSuccess(res, 200, 'Cart item updated successfully', {
      cartItem: {
        id: updatedItem.id,
        productId: updatedItem.product_id,
        quantity: updatedItem.quantity,
        productName: cartItem.name,
        productImage: cartItem.main_image_url,
        price: parseFloat(cartItem.price),
        totalPrice: parseFloat(cartItem.price) * updatedItem.quantity
      }
    });
  } catch (error) {
    console.error('❌ Update cart item error:', {
      message: error.message,
      code: error.code,
      detail: error.detail
    });
    return sendError(res, 500, 'Error updating cart item', error.message);
  }
};

/**
 * @desc    Remove item from cart
 * @route   DELETE /api/cart/:cartItemId
 * @access  Private
 */
const removeFromCart = async (req, res) => {
  try {
    const { cartItemId } = req.params;
    const user_id = req.user.id;

    console.log('🗑️ Remove from cart:', { cartItemId, user_id });

    // Get user's cart
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1`,
      [user_id]
    );

    if (cartRes.rows.length === 0) {
      return sendError(res, 404, 'Cart not found');
    }

    const cartId = cartRes.rows[0].id;

    // Check if cart item exists and belongs to user's cart
    const cartItemResult = await db.query(
      `SELECT id FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [cartItemId, cartId]
    );

    if (cartItemResult.rows.length === 0) {
      return sendError(res, 404, 'Cart item not found');
    }

    // Delete cart item
    await db.query('DELETE FROM cart_items WHERE id = $1', [cartItemId]);

    return sendSuccess(res, 200, 'Item removed from cart successfully');
  } catch (error) {
    console.error('❌ Remove from cart error:', {
      message: error.message,
      code: error.code,
      detail: error.detail
    });
    return sendError(res, 500, 'Error removing item from cart', error.message);
  }
};

/**
 * @desc    Clear entire cart
 * @route   DELETE /api/cart
 * @access  Private
 */
const clearCart = async (req, res) => {
  try {
    const user_id = req.user.id;

    // Get user's cart
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_active = true AND is_deleted = false LIMIT 1`,
      [user_id]
    );

    if (cartRes.rows.length === 0) {
      return sendSuccess(res, 200, 'Cart cleared successfully');
    }

    const cartId = cartRes.rows[0].id;

    // Delete all cart items for this cart
    await db.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);

    return sendSuccess(res, 200, 'Cart cleared successfully');
  } catch (error) {
    console.error('Clear cart error:', error);
    return sendError(res, 500, 'Error clearing cart', error);
  }
};

module.exports = {
  addToCart,
  mergeCart,
  getCart,
  updateCartItem,
  removeFromCart,
  clearCart
};
