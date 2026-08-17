const { verifyToken } = require('../utils/jwt');
const { sendError } = require('../utils/response');

/**
 * Protect routes - verify JWT token
 */
const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    // Cookie-based auth disabled.
    // else if (req.cookies && req.cookies.token) {
    //   token = req.cookies.token;
    // }

    // Verify token exists
    if (!token) {
      return sendError(res, 401, 'Not authorized, no token provided');
    }

    // Verify and decode token
    try {
      const decoded = verifyToken(token);

      const userRes = await db.query(
        `SELECT id, email, role, is_suspended FROM users WHERE id = $1 AND is_deleted = FALSE`,
        [decoded.id]
      );

      if (userRes.rows.length === 0) {
        return sendError(res, 401, 'Not authorized, user no longer exists');
      }

      const user = userRes.rows[0];
      if (user.role === 'seller' && user.is_suspended) {
        return sendError(res, 403, 'Your seller account has been suspended. Contact support.');
      }

      // Attach user info to request
      req.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        is_suspended: user.is_suspended
      };

      next();
    } catch (error) {
      if (error.message === 'Invalid or expired token') {
        return sendError(res, 401, 'Not authorized, token expired or invalid');
      }
      throw error;
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    return sendError(res, 500, 'Authentication error');
  }
};

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      try {
        const decoded = verifyToken(token);
        req.user = {
          id: decoded.id,
          email: decoded.email,
          role: decoded.role
        };
      } catch (error) {
        // Continue without user if token is invalid
        req.user = null;
      }
    }

    next();
  } catch (error) {
    console.error('Optional auth error:', error);
    next();
  }
};

module.exports = {
  protect,
  optionalAuth
};