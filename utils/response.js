/**
 * Send success response
 * @param {Object} res - Express response object
 * @param {Number} statusCode - HTTP status code
 * @param {String} message - Success message
 * @param {Object} data - Response data
 */
const sendSuccess = (res, statusCode = 200, message = 'Success', data = null) => {
  const response = {
    status: 'success',
    message,
    ...(data && { data })
  };
  
  return res.status(statusCode).json(response);
};

/**
 * Send error response
 * @param {Object} res - Express response object
 * @param {Number} statusCode - HTTP status code
 * @param {String} message - Error message
 * @param {Object} errors - Additional error details
 */
const sendError = (res, statusCode = 500, message = 'Internal server error', errors = null) => {
  const response = {
    status: 'error',
    message,
    ...(errors && { errors }),
    ...(process.env.NODE_ENV === 'development' && errors && { stack: errors.stack })
  };
  
  return res.status(statusCode).json(response);
};

/**
 * Send validation error response
 * @param {Object} res - Express response object
 * @param {Array} errors - Validation errors
 */
const sendValidationError = (res, errors) => {
  return res.status(400).json({
    status: 'error',
    message: 'Validation failed',
    errors
  });
};

/**
 * Send paginated response
 * @param {Object} res - Express response object
 * @param {Array} data - Data array
 * @param {Number} page - Current page
 * @param {Number} limit - Items per page
 * @param {Number} total - Total items count
 */
const sendPaginatedResponse = (res, data, page, limit, total) => {
  return res.status(200).json({
    status: 'success',
    data,
    pagination: {
      currentPage: parseInt(page),
      totalPages: Math.ceil(total / limit),
      totalItems: total,
      itemsPerPage: parseInt(limit),
      hasNext: page * limit < total,
      hasPrev: page > 1
    }
  });
};

module.exports = {
  sendSuccess,
  sendError,
  sendValidationError,
  sendPaginatedResponse
};