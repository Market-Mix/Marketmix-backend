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

    // Check if item already exists in cart
    const existingCartItem = await db.query(
      `SELECT id, quantity FROM cart_items 
       WHERE user_id = $1 AND product_id = $2`,
      [user_id, product_id]
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
         RETURNING id, user_id, product_id, quantity, updated_at`,
        [newQuantity, existingItem.id]
      );

      cartItem = updateResult.rows[0];
    } else {
      // Insert new cart item
      const insertResult = await db.query(
        `INSERT INTO cart_items (user_id, product_id, quantity, created_at, updated_at) 
         VALUES ($1, $2, $3, NOW(), NOW()) 
         RETURNING id, user_id, product_id, quantity, created_at, updated_at`,
        [user_id, product_id, quantity]
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
       WHERE ci.user_id = $1 AND p.is_deleted = false
       ORDER BY ci.created_at DESC`,
      [user_id]
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

    // Validate quantity
    if (!quantity || quantity < 1 || !Number.isInteger(quantity)) {
      return sendError(res, 400, 'Quantity must be a positive integer');
    }

    // Check if cart item exists and belongs to user
    const cartItemResult = await db.query(
      `SELECT ci.id, ci.product_id, p.stock_quantity, p.price, p.name, p.main_image_url
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.id = $1 AND ci.user_id = $2`,
      [cartItemId, user_id]
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

    // Check if cart item exists and belongs to user
    const cartItemResult = await db.query(
      `SELECT id FROM cart_items WHERE id = $1 AND user_id = $2`,
      [cartItemId, user_id]
    );

    if (cartItemResult.rows.length === 0) {
      return sendError(res, 404, 'Cart item not found');
    }

    // Delete cart item
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

    // Delete all cart items for user
    await db.query('DELETE FROM cart_items WHERE user_id = $1', [user_id]);

    return sendSuccess(res, 200, 'Cart cleared successfully');
  } catch (error) {
    console.error('Clear cart error:', error);
    return sendError(res, 500, 'Error clearing cart', error);
  }
};

/**
 * @desc    Merge local cart (from localStorage) with server cart
 * @route   POST /api/cart/merge
 * @access  Private
 * @param   items[] - Array of { productId, quantity, name, price, image } from localStorage
 */
const mergeCart = async (req, res) => {
  try {
    const { items } = req.body;
    const user_id = req.user.id;

    // Validate items array
    if (!Array.isArray(items)) {
      return sendError(res, 400, 'Items must be an array');
    }

    if (items.length === 0) {
      return sendSuccess(res, 200, 'No items to merge', { merged: [] });
    }

    const merged = [];
    const errors = [];

    // Process each item from localStorage
    for (const item of items) {
      try {
        const { productId, quantity } = item;

        // Validate required fields
        if (!productId || !quantity) {
          errors.push(`Item skipped: missing productId or quantity`);
          continue;
        }

        if (quantity < 1 || !Number.isInteger(quantity)) {
          errors.push(`Item ${productId}: quantity must be a positive integer`);
          continue;
        }

        // Check if product exists and is active
        const productResult = await db.query(
          `SELECT id, price, stock_quantity, name, main_image_url 
           FROM products 
           WHERE id = $1 AND is_active = true AND is_deleted = false`,
          [productId]
        );

        if (productResult.rows.length === 0) {
          errors.push(`Product ${productId}: not found or inactive`);
          continue;
        }

        const product = productResult.rows[0];

        // Validate stock
        const requestedQty = quantity;
        if (product.stock_quantity < requestedQty) {
          errors.push(`Product ${product.name}: insufficient stock (available: ${product.stock_quantity}, requested: ${requestedQty})`);
          continue;
        }

        // Check if item already exists in cart
        const existingCartItem = await db.query(
          `SELECT id, quantity FROM cart_items 
           WHERE user_id = $1 AND product_id = $2`,
          [user_id, productId]
        );

        let mergedItem;

        if (existingCartItem.rows.length > 0) {
          // Item exists: update quantity (sum with existing)
          const existing = existingCartItem.rows[0];
          const newQuantity = existing.quantity + requestedQty;

          // Validate new quantity against stock
          if (product.stock_quantity < newQuantity) {
            errors.push(
              `Product ${product.name}: merged quantity (${newQuantity}) exceeds stock (${product.stock_quantity}). Set to maximum.`
            );
            // Cap at available stock
            const updateResult = await db.query(
              `UPDATE cart_items 
               SET quantity = $1, updated_at = NOW() 
               WHERE id = $2 
               RETURNING id, product_id, quantity`,
              [product.stock_quantity, existing.id]
            );
            mergedItem = updateResult.rows[0];
          } else {
            // Update with summed quantity
            const updateResult = await db.query(
              `UPDATE cart_items 
               SET quantity = $1, updated_at = NOW() 
               WHERE id = $2 
               RETURNING id, product_id, quantity`,
              [newQuantity, existing.id]
            );
            mergedItem = updateResult.rows[0];
          }
        } else {
          // Item doesn't exist: insert it
          const insertResult = await db.query(
            `INSERT INTO cart_items (user_id, product_id, quantity, created_at, updated_at) 
             VALUES ($1, $2, $3, NOW(), NOW()) 
             RETURNING id, product_id, quantity`,
            [user_id, productId, requestedQty]
          );
          mergedItem = insertResult.rows[0];
        }

        merged.push({
          productId: mergedItem.product_id,
          quantity: mergedItem.quantity,
          productName: product.name
        });
      } catch (itemErr) {
        errors.push(`Item processing error: ${itemErr.message}`);
      }
    }

    return sendSuccess(res, 200, 'Cart merged successfully', {
      merged,
      errors: errors.length > 0 ? errors : undefined,
      totalMergedItems: merged.length
    });
  } catch (error) {
    console.error('Merge cart error:', error);
    return sendError(res, 500, 'Error merging cart', error);
  }
};

module.exports = {
  addToCart,
  getCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  mergeCart
};
