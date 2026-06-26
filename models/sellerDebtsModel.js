/**
 * Seller Debts model helpers for backend awareness.
 * This file exists to document the expected seller_debts table schema
 * and to support future safe usage by backend services.
 */

const SELLER_DEBTS_TABLE = 'seller_debts';

const SELLER_DEBT_FIELDS = [
  'id',
  'seller_id',
  'amount',
  'currency',
  'description',
  'status',
  'created_at',
  'updated_at'
];

const buildSellerDebtPayload = (data = {}) => {
  return {
    seller_id: data.seller_id,
    amount: data.amount,
    currency: data.currency || 'USD',
    description: data.description || null,
    status: data.status || 'pending',
    created_at: data.created_at || new Date().toISOString(),
    updated_at: data.updated_at || new Date().toISOString()
  };
};

module.exports = {
  SELLER_DEBTS_TABLE,
  SELLER_DEBT_FIELDS,
  buildSellerDebtPayload
};
