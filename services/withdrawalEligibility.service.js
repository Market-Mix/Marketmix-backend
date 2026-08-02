// services/withdrawalEligibility.service.js
const db = require('../config/db');

// These lock withdrawals immediately — no grace period, seller already acted or case moved past initial stage
const HARD_LOCK_STATUSES = [
  'waiting_seller_return_decision', 'waiting_buyer_confirmation',
  'return_required', 'return_in_transit', 'escalated', 'refund_processing',
  'awaiting_refund_release'
];

async function hasUnresolvedCases(sellerId) {
  // Hard-locking cases — no grace period
  const hardLocked = await db.query(
    `SELECT id FROM refund_cases_sync
     WHERE seller_id = $1 AND resolution_status = ANY($2::text[]) LIMIT 1`,
    [sellerId, HARD_LOCK_STATUSES]
  );
  if (hardLocked.rows.length) {
    return { blocked: true, reason: 'You have an unresolved refund/return case' };
  }

  // Pending cases — grace period: 24h from open, or 5h if seller already started chatting (no excuse left)
     const pendingOverdue = await db.query(
  `SELECT id FROM refund_cases_sync
   WHERE seller_id = $1 AND resolution_status = 'pending'
     AND (
       updated_at <= NOW() - INTERVAL '24 hours'
       OR (chat_started = true AND updated_at <= NOW() - INTERVAL '5 hours')
     )
   LIMIT 1`,
  [sellerId]
);
  if (pendingOverdue.rows.length) {
    return { blocked: true, reason: 'You have a refund case pending response for over 24 hours' };
  }

  const disputeRes = await db.query(
    `SELECT id FROM escrow_transactions WHERE seller_id = $1 AND status = 'disputed' LIMIT 1`,
    [sellerId]
  );
  if (disputeRes.rows.length) {
    return { blocked: true, reason: 'You have an unresolved order dispute' };
  }

  return { blocked: false };
}

module.exports = { hasUnresolvedCases };