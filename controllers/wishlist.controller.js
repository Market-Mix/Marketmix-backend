const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

const ensureBuyerRole = async (req, res) => {
  const user_id = req.user && req.user.id;
  if (!user_id) {
    sendError(res, 401, 'Not authenticated');
    return null;
  }

  const userRoleResult = await db.query(
    `SELECT role FROM users WHERE id = $1 AND COALESCE(is_deleted, false) = false LIMIT 1`,
    [user_id]
  );
  const userRecord = userRoleResult.rows[0];

  console.log('Wishlist auth check:', {
    user_id,
    tokenRole: req.user && req.user.role,
    roleSource: 'database',
    dbRole: userRecord && userRecord.role,
    dbQueryRows: userRoleResult.rows
  });

  if (!userRecord) {
    sendError(res, 401, 'User not found');
    return null;
  }

  if (userRecord.role !== 'buyer') {
    sendError(res, 403, 'Access denied. Buyer role required');
    return null;
  }

  req.user.role = userRecord.role;
  return user_id;
};

/**
 * Add item to wishlist
 * POST /api/wishlist/add
 */
const addToWishlist = async (req, res) => {
  try {
    const user_id = await ensureBuyerRole(req, res);
    if (!user_id) return;
    const { product_id } = req.body;

    if (!product_id) return sendError(res, 400, 'product_id required');

    // Find or create a wishlist for this user
    let wl = await db.query(`SELECT id FROM wishlists WHERE user_id = $1 LIMIT 1`, [user_id]);
    let wishlist_id;
    if (wl.rows.length > 0) {
      wishlist_id = wl.rows[0].id;
    } else {
      const created = await db.query(
        `INSERT INTO wishlists (user_id, created_at) VALUES ($1, NOW()) RETURNING id`,
        [user_id]
      );
      wishlist_id = created.rows[0].id;
    }

    // Check if item already exists for this wishlist
    const exists = await db.query(
      `SELECT id FROM wishlist_items WHERE wishlist_id = $1 AND product_id = $2 LIMIT 1`,
      [wishlist_id, product_id]
    );

    if (exists.rows.length > 0) {
      return sendSuccess(res, 200, 'Already in wishlist');
    }

    const insert = await db.query(
      `INSERT INTO wishlist_items (wishlist_id, product_id, added_at) VALUES ($1, $2, NOW()) RETURNING id, wishlist_id, product_id, added_at`,
      [wishlist_id, product_id]
    );

    return sendSuccess(res, 201, 'Added to wishlist', { item: insert.rows[0] });
  } catch (error) {
    console.error('Wishlist add error:', error);
    return sendError(res, 500, 'Error adding to wishlist');
  }
};

/**
 * Get wishlist for user
 * GET /api/wishlist
 */
const getWishlist = async (req, res) => {
  try {
    const user_id = await ensureBuyerRole(req, res);
    if (!user_id) return;

    const result = await db.query(
      `SELECT wi.id, wi.product_id, p.name, p.price, p.main_image_url, wi.added_at
       FROM wishlist_items wi
       JOIN wishlists w ON wi.wishlist_id = w.id
       JOIN products p ON wi.product_id = p.id
       WHERE w.user_id = $1
       ORDER BY wi.added_at DESC`,
      [user_id]
    );

    return sendSuccess(res, 200, 'Wishlist retrieved', { items: result.rows });
  } catch (error) {
    console.error('Get wishlist error:', error);
    return sendError(res, 500, 'Error retrieving wishlist');
  }
};

/**
 * Create a guest wishlist (returns wishlist_id)
 * POST /api/wishlist/guest/create
 */
const createGuestWishlist = async (req, res) => {
  try {
    const insert = await db.query(
      `INSERT INTO wishlists (created_at) VALUES (NOW()) RETURNING id`
    );
    return sendSuccess(res, 201, 'Guest wishlist created', { wishlist_id: insert.rows[0].id });
  } catch (error) {
    console.error('Create guest wishlist error:', error);
    return sendError(res, 500, 'Error creating guest wishlist');
  }
};

/**
 * Add item to guest wishlist using wishlist_id
 * POST /api/wishlist/guest/add
 */
const addToGuestWishlist = async (req, res) => {
  try {
    const { wishlist_id, product_id } = req.body;
    if (!product_id) return sendError(res, 400, 'product_id required');

    let wid = wishlist_id;
    if (!wid) {
      const w = await db.query(`INSERT INTO wishlists (created_at) VALUES (NOW()) RETURNING id`);
      wid = w.rows[0].id;
    }

    // Prevent duplicates for same wishlist
    const exists = await db.query(
      `SELECT id FROM wishlist_items WHERE wishlist_id = $1 AND product_id = $2 LIMIT 1`,
      [wid, product_id]
    );

    if (exists.rows.length > 0) {
      return sendSuccess(res, 200, 'Already in wishlist', { wishlist_id: wid });
    }

    const insert = await db.query(
      `INSERT INTO wishlist_items (wishlist_id, product_id, added_at) VALUES ($1, $2, NOW()) RETURNING id, wishlist_id, product_id, added_at`,
      [wid, product_id]
    );

    return sendSuccess(res, 201, 'Added to guest wishlist', { item: insert.rows[0], wishlist_id: wid });
  } catch (error) {
    console.error('Add to guest wishlist error:', error);
    return sendError(res, 500, 'Error adding to guest wishlist');
  }
};


// Add this to your wishlist.controller.js
const removeFromWishlist = async (req, res) => {
  try {
    const user_id = await ensureBuyerRole(req, res);
    const { id } = req.params; // wishlist_item id
    
    if (!user_id) return;
    
    await db.query(
      `DELETE FROM wishlist_items 
       WHERE id = $1 
       AND wishlist_id IN (SELECT id FROM wishlists WHERE user_id = $2)`,
      [id, user_id]
    );
    
    return sendSuccess(res, 200, 'Item removed from wishlist');
  } catch (error) {
    console.error('Remove from wishlist error:', error);
    return sendError(res, 500, 'Error removing from wishlist');
  }
};

module.exports = { addToWishlist, getWishlist, createGuestWishlist, addToGuestWishlist, removeFromWishlist };