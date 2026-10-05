
const { sendError } = require('../utils/response');
const db = require('../config/db');

/**
 * Restrict access to specific roles
 * @param  {...String} roles - Allowed roles
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    // Check if user exists (should be set by protect middleware)
    if (!req.user) {
      return sendError(res, 401, 'Not authorized');
    }

    // Check if user's role is in allowed roles
    if (!roles.includes(req.user.role)) {
      return sendError(
        res,
        403,
        `Access denied. This action requires one of the following roles: ${roles.join(', ')}`
      );
    }

    next();
  };
};

/**
 * Check if user is buyer
 */
const isBuyer = (req, res, next) => {
  if (!req.user || req.user.role !== 'buyer') {
    return sendError(res, 403, 'Access denied. Buyer role required');
  }
  next();
};

/**
 * Check if user is seller
 */
const isSeller = (req, res, next) => {
  if (!req.user || req.user.role !== 'seller') {
    return sendError(res, 403, 'Access denied. Seller role required');
  }
  next();
};

/**
 * Check if user is admin
 */
const isAdmin = async (req, res, next) => {
  try {
    if (!req.user) return sendError(res, 403, 'Access denied. Admin role required');
    const r = await db.query(
      `SELECT u.role, m.status FROM users u LEFT JOIN admin_members m ON m.user_id = u.id
       WHERE u.id = $1 AND u.is_deleted = false`, [req.user.id]);
    const x = r.rows[0];
    if (!x || x.role !== 'admin') return sendError(res, 403, 'Access denied. Admin role required');
    if (x.status && x.status !== 'active') return sendError(res, 403, `Admin account is ${x.status}`);
    return next();
  } catch (e) {
    return sendError(res, 500, 'Unable to verify admin', e.message);
  }
};

/**
 * Check if user is seller or admin
 */
const isSellerOrAdmin = (req, res, next) => {
  if (!req.user || !['seller', 'admin'].includes(req.user.role)) {
    return sendError(res, 403, 'Access denied. Seller or Admin role required');
  }
  next();
};

const checkSellerActive = async (req, res, next) => {
  if (!req.user || req.user.role !== 'seller') return next();

  try {
    const result = await db.query(
      `SELECT is_suspended, suspended_until, suspension_reason FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = result.rows[0];
    const isActivelySuspended = user?.is_suspended &&
      (!user.suspended_until || new Date(user.suspended_until) > new Date());

    if (isActivelySuspended) {
      return sendError(
        res,
        403,
        `Account suspended: ${user.suspension_reason || 'Policy violation'}. ${user.suspended_until ? `Until ${new Date(user.suspended_until).toLocaleDateString()}` : 'Indefinite.'}`
      );
    }

    if (user?.is_suspended && user.suspended_until && new Date(user.suspended_until) <= new Date()) {
      await db.query(
        `UPDATE users SET is_suspended = false, suspended_until = NULL, suspension_reason = NULL WHERE id = $1`,
        [req.user.id]
      );
    }

    next();
  } catch (error) {
    return sendError(res, 500, 'Unable to verify seller account status', error.message);
  }
};

module.exports = {
  restrictTo,
  isBuyer,
  isSeller,
  isAdmin,
  isSellerOrAdmin,
  checkSellerActive
};