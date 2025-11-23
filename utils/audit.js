const db = require('../config/db');

/**
 * Log an action to the audit_logs table
 * @param {UUID} actorId - User who performed the action
 * @param {String} action - Action performed (e.g., 'USER_REGISTERED', 'PRODUCT_CREATED')
 * @param {String} objectType - Type of object (e.g., 'user', 'product', 'order')
 * @param {String} objectId - ID of the affected object
 * @param {Object} metadata - Additional data
 */
const logAudit = async (actorId, action, objectType = null, objectId = null, metadata = null) => {
  try {
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [actorId, action, objectType, objectId, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (error) {
    console.error('Audit log error:', error);
    // Don't throw - audit failures shouldn't break main operations
  }
};

/**
 * Common audit actions
 */
const AUDIT_ACTIONS = {
  // Auth
  USER_REGISTERED: 'USER_REGISTERED',
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGOUT: 'USER_LOGOUT',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  
  // Products
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_DELETED: 'PRODUCT_DELETED',
  PRODUCT_VIEWED: 'PRODUCT_VIEWED',
  
  // Orders
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_UPDATED: 'ORDER_UPDATED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  
  // Payments
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  
  // Withdrawals
  WITHDRAWAL_REQUESTED: 'WITHDRAWAL_REQUESTED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  
  // Admin
  USER_DELETED: 'USER_DELETED',
  USER_VERIFIED: 'USER_VERIFIED'
};

module.exports = {
  logAudit,
  AUDIT_ACTIONS
};