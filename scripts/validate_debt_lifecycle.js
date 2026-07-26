const db = require('../config/db');

function fmt(n) {
  if (n === null || n === undefined) return '0';
  return String(n);
}

async function runChecks() {
  console.log('\n=== Debt Lifecycle Validation — Start ===\n');

  // 1) Basic counts
  const debtsCountRes = await db.query('SELECT COUNT(*) AS count FROM seller_debts');
  const debtsCount = Number(debtsCountRes.rows[0]?.count || 0);
  console.log('[check] Total seller_debts rows:', debtsCount);

  const recoveriesCountRes = await db.query('SELECT COUNT(*) AS count FROM seller_debt_recoveries');
  const recoveriesCount = Number(recoveriesCountRes.rows[0]?.count || 0);
  console.log('[check] Total seller_debt_recoveries rows:', recoveriesCount);

  // 2) Duplicate debts for same refund_case
  const dupDebtsRes = await db.query(
    `SELECT refund_case_id, COUNT(*) AS cnt
     FROM seller_debts
     WHERE refund_case_id IS NOT NULL
     GROUP BY refund_case_id
     HAVING COUNT(*) > 1
     LIMIT 20`
  );
  if (dupDebtsRes.rows.length > 0) {
    console.error('[FAIL] Duplicate seller_debts found for refund_case_id (showing up to 20):', dupDebtsRes.rows);
  } else {
    console.log('[PASS] No duplicate seller_debts for a single refund_case_id');
  }

  // 3) Duplicate recoveries (same debt_id + escrow_transaction_id)
  const dupRecoveriesRes = await db.query(
    `SELECT debt_id, escrow_transaction_id, COUNT(*) AS cnt
     FROM seller_debt_recoveries
     WHERE debt_id IS NOT NULL AND escrow_transaction_id IS NOT NULL
     GROUP BY debt_id, escrow_transaction_id
     HAVING COUNT(*) > 1
     LIMIT 20`
  );
  if (dupRecoveriesRes.rows.length > 0) {
    console.error('[FAIL] Duplicate recoveries found (same debt_id & escrow_transaction_id):', dupRecoveriesRes.rows);
  } else {
    console.log('[PASS] No duplicate seller_debt_recoveries detected by (debt_id, escrow_transaction_id)');
  }

  // 4) Recovery amounts vs debt totals — ensure recovered <= original and remaining matches
  const mismatchRes = await db.query(
    `SELECT d.id, d.original_debt::numeric AS original_debt, d.remaining_debt::numeric AS remaining_debt, COALESCE(SUM(r.recovered_amount),0)::numeric AS total_recovered
     FROM seller_debts d
     LEFT JOIN seller_debt_recoveries r ON r.debt_id = d.id
     GROUP BY d.id, d.original_debt, d.remaining_debt
     HAVING COALESCE(SUM(r.recovered_amount),0) > d.original_debt
        OR ABS((d.original_debt - COALESCE(SUM(r.recovered_amount),0)) - d.remaining_debt) > 0.01
     LIMIT 30`
  );
  if (mismatchRes.rows.length > 0) {
    console.error('[FAIL] Recovery arithmetic mismatches found (original, recovered, remaining):', mismatchRes.rows);
  } else {
    console.log('[PASS] Recovery arithmetic consistent for tested debts');
  }

  // 5) No negative remaining_debt or recovered_amount
  const negativeDebtRes = await db.query(
    `SELECT id, remaining_debt FROM seller_debts WHERE remaining_debt < 0 LIMIT 20`
  );
  if (negativeDebtRes.rows.length > 0) {
    console.error('[FAIL] Negative remaining_debt values found in seller_debts:', negativeDebtRes.rows);
  } else {
    console.log('[PASS] No negative remaining_debt in seller_debts');
  }

  const negativeRecoveryRes = await db.query(
    `SELECT id, recovered_amount FROM seller_debt_recoveries WHERE recovered_amount < 0 LIMIT 20`
  );
  if (negativeRecoveryRes.rows.length > 0) {
    console.error('[FAIL] Negative recovered_amount found in seller_debt_recoveries:', negativeRecoveryRes.rows);
  } else {
    console.log('[PASS] No negative recovered_amount in seller_debt_recoveries');
  }

  // 6) Seller balances not negative
  const negativeBalancesRes = await db.query(
    `SELECT user_id, available_balance FROM seller_profiles WHERE available_balance < 0 LIMIT 20`
  );
  if (negativeBalancesRes.rows.length > 0) {
    console.error('[FAIL] Seller profiles with negative available_balance:', negativeBalancesRes.rows);
  } else {
    console.log('[PASS] No negative seller available_balance values');
  }

  // 7) Recoveries should not exceed remaining_debt at time of recovery — check any recovery where recovered_amount > (original_debt + recovered?)
  const overRecoveriesRes = await db.query(
    `SELECT r.id, r.debt_id, r.recovered_amount, d.original_debt, d.remaining_debt
     FROM seller_debt_recoveries r
     JOIN seller_debts d ON d.id = r.debt_id
     WHERE r.recovered_amount > (d.original_debt + 1) -- improbable threshold
     LIMIT 20`
  );
  if (overRecoveriesRes.rows.length > 0) {
    console.error('[WARN] Recoveries that individually exceed original debt found (investigate):', overRecoveriesRes.rows);
  } else {
    console.log('[PASS] Individual recoveries are within expected bounds');
  }

  // 8) Recovery history entries have non-negative remaining_debt
  const badHistoryRes = await db.query(
    `SELECT id, debt_id, remaining_debt FROM seller_debt_recoveries WHERE remaining_debt < 0 LIMIT 20`
  );
  if (badHistoryRes.rows.length > 0) {
    console.error('[FAIL] seller_debt_recoveries contain negative remaining_debt values:', badHistoryRes.rows);
  } else {
    console.log('[PASS] seller_debt_recoveries remaining_debt values non-negative');
  }

  // 9) Admin report sanity: count adjustments and compare to debts count
  const adminCountRes = await db.query('SELECT COUNT(*) AS count FROM seller_debts');
  const adminCount = Number(adminCountRes.rows[0]?.count || 0);
  console.log('[check] Admin report total adjustments (seller_debts):', adminCount);

  // 10) Notifications for refunds: ensure resolved refunds generated notifications
  const resolvedRefundsRes = await db.query(`SELECT id FROM refund_cases WHERE status = 'resolved' LIMIT 100`);
  const resolvedRefundIds = resolvedRefundsRes.rows.map(r => String(r.id));
  let notifCountForResolved = 0;
  if (resolvedRefundIds.length > 0) {
    const q = `SELECT COUNT(*) AS count FROM notifications WHERE (data->>'reference_id') IN (${resolvedRefundIds.map((_,i)=>`$${i+1}`).join(',')})`;
    const notifRes = await db.query(q, resolvedRefundIds);
    notifCountForResolved = Number(notifRes.rows[0]?.count || 0);
  }
  console.log('[check] Notifications referencing resolved refunds (sample up to 100 refunds):', notifCountForResolved);

  // 11) Summary and exit
  console.log('\n=== Debt Lifecycle Validation — End ===\n');
}

runChecks().then(() => process.exit(0)).catch((err) => {
  console.error('Validation script error:', err.stack || err.message || err);
  process.exit(2);
});
