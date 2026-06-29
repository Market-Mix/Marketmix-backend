/**
 * Refund Cases model helpers for backend payload construction and field awareness.
 * This file is intentionally lightweight: it only defines the known refund case
 * fields and builds a safe insert payload for Supabase / PostgreSQL.
 */

const REFUND_CASE_TABLE = 'refund_cases';

const REFUND_CASE_FIELDS = [
  'buyer_id',
  'seller_id',
  'order_id',
  'order_item_id',
  'product_id',
  'product_name',
  'complaint_text',
  'evidence_url',
  'status',
  'resolution_status',
  'seller_marked_resolved',
  'buyer_confirmed_resolution',
  'escalated_to_marketmix',
  'chat_started',
  'seller_resolved_at',
  'escalated_at',
  'buyer_confirmed_at',
  'created_at',
  'updated_at',
  'marketmix_decision',
  'marketmix_decided_at',
  'marketmix_decided_by',
  'marketmix_decision_reason',
  'seller_return_choice',
  'seller_return_choice_at',
  'return_address_line1',
  'return_address_line2',
  'return_city',
  'return_state',
  'return_postal_code',
  'return_country',
  'buyer_return_deadline',
  'courier_name',
  'tracking_number',
  'shipping_receipt_url',
  'return_received',
  'return_received_at',
  'shipping_reimbursement_amount',
  'shipping_reimbursement_status'
];

const buildRefundCasePayload = (data = {}) => {
  return {
    buyer_id: data.buyer_id,
    seller_id: data.seller_id,
    order_id: String(data.order_id),
    order_item_id: data.order_item_id || null,
    product_id: data.product_id || null,
    product_name: data.product_name || null,
    complaint_text: data.complaint_text || null,
    evidence_url: data.evidence_url || null,
    status: data.status || 'pending',
    resolution_status: data.resolution_status || 'pending',
    seller_marked_resolved: data.seller_marked_resolved ?? false,
    buyer_confirmed_resolution: data.buyer_confirmed_resolution ?? false,
    escalated_to_marketmix: data.escalated_to_marketmix ?? false,
    chat_started: data.chat_started ?? false,
    seller_resolved_at: data.seller_resolved_at || null,
    escalated_at: data.escalated_at || null,
    buyer_confirmed_at: data.buyer_confirmed_at || null,
    marketmix_decision: data.marketmix_decision || null,
    marketmix_decision_reason: data.marketmix_decision_reason || null,
    marketmix_decided_at: data.marketmix_decided_at || null,
    marketmix_decided_by: data.marketmix_decided_by || null,
    seller_return_choice: data.seller_return_choice || null,
    seller_return_choice_at: data.seller_return_choice_at || null,
    return_address_line1: data.return_address_line1 || null,
    return_address_line2: data.return_address_line2 || null,
    return_city: data.return_city || null,
    return_state: data.return_state || null,
    return_postal_code: data.return_postal_code || null,
    return_country: data.return_country || null,
    buyer_return_deadline: data.buyer_return_deadline || null,
    courier_name: data.courier_name || null,
    tracking_number: data.tracking_number || null,
    shipping_receipt_url: data.shipping_receipt_url || null,
    return_received: data.return_received ?? false,
    return_received_at: data.return_received_at || null,
    shipping_reimbursement_amount: data.shipping_reimbursement_amount || null,
    shipping_reimbursement_status: data.shipping_reimbursement_status || null,
    created_at: data.created_at || new Date().toISOString(),
    updated_at: data.updated_at || new Date().toISOString()
  };
};

module.exports = {
  REFUND_CASE_TABLE,
  REFUND_CASE_FIELDS,
  buildRefundCasePayload
};
