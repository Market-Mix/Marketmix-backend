
const { sendError } = require('../utils/response');

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
const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return sendError(res, 403, 'Access denied. Admin role required');
  }
  next();
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

module.exports = {
  restrictTo,
  isBuyer,
  isSeller,
  isAdmin,
  isSellerOrAdmin
};