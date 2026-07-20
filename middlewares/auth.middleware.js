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
      
      // Attach user info to request
      req.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role
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