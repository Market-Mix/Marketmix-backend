const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * @desc    Add item to cart
 * @route   POST /api/cart/add
 * @access  Private
 */
const addToCart = async (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    const user_id = req.user.id;

    // Validate required fields
    if (!product_id || !quantity) {
      return sendError(res, 400, 'Please provide product_id and quantity');
    }

    // Validate quantity
    if (quantity < 1 || !Number.isInteger(quantity)) {
      return sendError(res, 400, 'Quantity must be a positive integer');
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

    // Get or create user's cart
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_deleted = false`,
      [user_id]
    );

    let cart_id;
    if (cartRes.rows.length > 0) {
      cart_id = cartRes.rows[0].id;
    } else {
      const newCartRes = await db.query(
        `INSERT INTO cart (user_id, cart_type, is_active, is_deleted, created_at, updated_at)
         VALUES ($1, 'personal', true, false, NOW(), NOW()) RETURNING id`,
        [user_id]
      );
      cart_id = newCartRes.rows[0].id;
    }

    // Check if item already exists in cart (by cart_id)
    const existingCartItem = await db.query(
      `SELECT id, quantity FROM cart_items 
       WHERE cart_id = $1 AND product_id = $2`,
      [cart_id, product_id]
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
         RETURNING id, cart_id, product_id, quantity, updated_at`,
        [newQuantity, existingItem.id]
      );

      cartItem = updateResult.rows[0];
    } else {
      // Insert new cart item tied to cart_id
      const insertResult = await db.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity, created_at, updated_at) 
         VALUES ($1, $2, $3, NOW(), NOW()) 
         RETURNING id, cart_id, product_id, quantity, created_at, updated_at`,
        [cart_id, product_id, quantity]
      );

      cartItem = insertResult.rows[0];
    }

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
    console.error('Add to cart error:', error);
    return sendError(res, 500, 'Error adding item to cart', error);
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

    // Get user's cart id
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_deleted = false`,
      [user_id]
    );

    if (cartRes.rows.length === 0) {
      return sendSuccess(res, 200, 'Cart retrieved successfully', {
        items: [],
        totalItems: 0,
        totalPrice: 0
      });
    }

    const cart_id = cartRes.rows[0].id;

    const result = await db.query(
      `SELECT 
        ci.id,
        ci.product_id,
        ci.quantity,
        p.name,
        p.main_image_url,
        p.price,
        p.stock_quantity,
        (p.price * ci.quantity) as total_price
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.cart_id = $1 AND p.is_deleted = false
       ORDER BY ci.created_at DESC`,
      [cart_id]
    );

    const cartItems = result.rows.map(item => ({
      id: item.id,
      productId: item.product_id,
      name: item.name,
      image: item.main_image_url,
      price: parseFloat(item.price),
      quantity: item.quantity,
      stockAvailable: item.stock_quantity,
      totalPrice: parseFloat(item.total_price)
    }));

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

    console.log('DEBUG updateCartItem called', { cartItemId, quantity, user_id });

    // Validate quantity
    if (!quantity || quantity < 1 || !Number.isInteger(quantity)) {
      return sendError(res, 400, 'Quantity must be a positive integer');
    }

    // Get user's cart to verify ownership
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_deleted = false`,
      [user_id]
    );

    console.log('DEBUG updateCartItem cartRes.rows', cartRes.rows);

    if (cartRes.rows.length === 0) {
      return sendError(res, 404, 'Cart not found');
    }

    const cart_id = cartRes.rows[0].id;

    // Check if cart item exists and belongs to user's cart
    const cartItemResult = await db.query(
      `SELECT ci.id, ci.product_id, p.stock_quantity, p.price, p.name, p.main_image_url
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.id = $1 AND ci.cart_id = $2`,
      [cartItemId, cart_id]
    );

    console.log('DEBUG updateCartItem cartItemResult.rows', cartItemResult.rows);

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
    console.log('DEBUG updateCartItem performing UPDATE', { cartItemId, quantity });
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
    console.error('Update cart item error:', error);
    return sendError(res, 500, 'Error updating cart item', error);
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

    console.log('DEBUG removeFromCart called', { cartItemId, user_id });

    // Get user's cart to verify ownership
    const cartRes = await db.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_deleted = false`,
      [user_id]
    );

    console.log('DEBUG removeFromCart cartRes.rows', cartRes.rows);

    if (cartRes.rows.length === 0) {
      return sendError(res, 404, 'Cart not found');
    }

    const cart_id = cartRes.rows[0].id;

    // Check if cart item exists and belongs to user's cart
    const cartItemResult = await db.query(
      `SELECT id FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [cartItemId, cart_id]
    );

    console.log('DEBUG removeFromCart cartItemResult.rows', cartItemResult.rows);

    if (cartItemResult.rows.length === 0) {
      return sendError(res, 404, 'Cart item not found');
    }

    // Delete cart item
    console.log('DEBUG removeFromCart performing DELETE', { cartItemId });
    await db.query('DELETE FROM cart_items WHERE id = $1', [cartItemId]);

    return sendSuccess(res, 200, 'Item removed from cart successfully');
  } catch (error) {
    console.error('Remove from cart error:', error);
    return sendError(res, 500, 'Error removing item from cart', error);
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
      `SELECT id FROM cart WHERE user_id = $1 AND is_deleted = false`,
      [user_id]
    );

    if (cartRes.rows.length === 0) {
      return sendSuccess(res, 200, 'Cart cleared successfully');
    }

    const cart_id = cartRes.rows[0].id;

    console.log('DEBUG clearCart cart_id', { user_id, cart_id });

    // Delete all cart items for user's cart
    await db.query('DELETE FROM cart_items WHERE cart_id = $1', [cart_id]);

    return sendSuccess(res, 200, 'Cart cleared successfully');
  } catch (error) {
    console.error('Clear cart error:', error);
    return sendError(res, 500, 'Error clearing cart', error);
  }
};

/**
 * @desc    Merge local cart items into server cart
 * @route   POST /api/cart/merge
 * @access  Private
 *
 * Body: { items: [{ product_id, quantity }, ...] }
 */
const mergeCart = async (req, res) => {
  const client = await db.getClient();
  try {
    const user_id = req.user.id;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return sendError(res, 400, 'No items to merge');
    }

    await client.query('BEGIN');

    // Get or create user's cart
    const cartRes = await client.query(
      `SELECT id FROM cart WHERE user_id = $1 AND is_deleted = false FOR UPDATE`,
      [user_id]
    );

    let cart_id;
    if (cartRes.rows.length > 0) {
      cart_id = cartRes.rows[0].id;
    } else {
      // Create new cart if it doesn't exist
      const newCartRes = await client.query(
        `INSERT INTO cart (user_id, cart_type, is_active, is_deleted, created_at, updated_at)
         VALUES ($1, 'personal', true, false, NOW(), NOW())
         RETURNING id`,
        [user_id]
      );
      cart_id = newCartRes.rows[0].id;
    }

    const mergedItems = [];
    const adjustments = [];

    for (const it of items) {
      const product_id = it.product_id;
      let quantity = parseInt(it.quantity, 10) || 0;

      if (!product_id || quantity < 1) continue; // skip invalid

      // Lock product row to avoid race conditions
      const prodRes = await client.query(
        `SELECT id, price, stock_quantity, name, main_image_url
         FROM products
         WHERE id = $1 AND is_active = true AND is_deleted = false
         FOR UPDATE`,
        [product_id]
      );

      if (prodRes.rows.length === 0) {
        adjustments.push({ product_id, reason: 'product_not_found_or_inactive' });
        continue;
      }

      const product = prodRes.rows[0];

      // Get existing cart item if any
      const existingRes = await client.query(
        `SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2 FOR UPDATE`,
        [cart_id, product_id]
      );

      let finalQuantity = quantity;
      if (existingRes.rows.length > 0) {
        finalQuantity = existingRes.rows[0].quantity + quantity;
      }

      // Enforce stock limits
      if (product.stock_quantity < finalQuantity) {
        // cap to stock
        finalQuantity = product.stock_quantity;
        adjustments.push({ product_id, requested: it.quantity, adjusted_to: finalQuantity });
      }

      if (existingRes.rows.length > 0) {
        // update
        await client.query(
          `UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2`,
          [finalQuantity, existingRes.rows[0].id]
        );
      } else {
        // insert
        await client.query(
          `INSERT INTO cart_items (cart_id, product_id, quantity, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW())`,
          [cart_id, product_id, finalQuantity]
        );
      }

      mergedItems.push({ product_id, quantity: finalQuantity });
    }

    await client.query('COMMIT');

    return sendSuccess(res, 200, 'Cart merged successfully', { mergedItems, adjustments });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Merge cart error:', err);
    return sendError(res, 500, 'Error merging cart', err.message || err);
  } finally {
    client.release();
  }
};

module.exports = {
  addToCart,
  getCart,
  updateCartItem,
  removeFromCart,
  clearCart
  , mergeCart
};
