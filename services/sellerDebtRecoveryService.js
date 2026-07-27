const db = require('../config/db');
const { createDedupedNotification } = require('../controllers/notification.controller');

function calculateDebtRecovery({ releaseAmount = 0, remainingDebt = 0 } = {}) {
  const normalizedReleaseAmount = Number(releaseAmount) || 0;
  const normalizedRemainingDebt = Number(remainingDebt) || 0;

  if (normalizedRemainingDebt <= 0) {
    return {
      recoveredAmount: 0,
      remainingDebt: 0,
      isSettled: true,
      remainingToRecover: normalizedReleaseAmount
    };
  }

  const recoveredAmount = Math.min(normalizedReleaseAmount, normalizedRemainingDebt);
  const nextRemainingDebt = Math.max(0, normalizedRemainingDebt - recoveredAmount);

  return {
    recoveredAmount,
    remainingDebt: nextRemainingDebt,
    isSettled: nextRemainingDebt <= 0,
    remainingToRecover: Math.max(0, normalizedReleaseAmount - recoveredAmount)
  };
}

async function ensureSellerDebtRecoveryTables(executor) {
  try {
    await executor.query(`
      CREATE TABLE IF NOT EXISTS seller_debt_recoveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID NOT NULL,
        debt_id UUID,
        refund_case_id UUID,
        escrow_transaction_id UUID,
        order_id UUID,
        release_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        recovered_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        remaining_debt NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'recovered',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch (error) {
    if (String(error.message).includes('permission denied') || String(error.message).includes('syntax')) {
      throw error;
    }
    console.warn('[debt-recovery] Could not ensure recovery table exists:', error.message || error);
  }
}

async function ensureSellerRecentTransactionsTable(executor) {
  try {
    await executor.query(`
      CREATE TABLE IF NOT EXISTS seller_recent_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID NOT NULL,
        type VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'Recovered',
        reference_id UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch (error) {
    if (String(error.message).includes('permission denied') || String(error.message).includes('syntax')) {
      throw error;
    }
    console.warn('[debt-recovery] Could not ensure recent transactions table exists:', error.message || error);
  }
}

async function recoverSellerDebtFromEscrowRelease(client, options = {}) {
  const {
    sellerId,
    releaseAmount = 0,
    orderId = null,
    escrowId = null,
    refundCaseId = null,
    context = 'escrow-release'
  } = options;

  const executor = client || db;

  if (!sellerId) {
    return {
      recoveredAmount: 0,
      remainingDebt: 0,
      isSettled: true,
      remainingToRecover: Number(releaseAmount) || 0,
      debtFound: false,
      debtId: null,
      recoveryId: null
    };
  }

  try {
    await ensureSellerDebtRecoveryTables(executor);

    const debtRes = await executor.query(
      `SELECT id, refund_case_id, remaining_debt, status
       FROM seller_debts
       WHERE seller_id = $1
         AND remaining_debt > 0
         AND status IN ('active', 'partial')
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [sellerId]
    );

    const debt = debtRes.rows[0];
    if (!debt) {
      console.log('[debt-recovery] Checking seller debt', {
        sellerId,
        context,
        releaseAmount,
        status: 'no-active-debt'
      });
      return {
        recoveredAmount: 0,
        remainingDebt: 0,
        isSettled: true,
        remainingToRecover: Number(releaseAmount) || 0,
        debtFound: false,
        debtId: null,
        recoveryId: null
      };
    }

    console.log('[debt-recovery] Checking seller debt', {
      sellerId,
      context,
      debtId: debt.id,
      remainingDebt: debt.remaining_debt,
      releaseAmount
    });

    const recovery = calculateDebtRecovery({
      releaseAmount,
      remainingDebt: debt.remaining_debt
    });

    if (recovery.recoveredAmount <= 0) {
      console.log('[debt-recovery] No debt recovered', {
        sellerId,
        context,
        debtId: debt.id,
        releaseAmount,
        remainingDebt: debt.remaining_debt
      });
      return {
        recoveredAmount: 0,
        remainingDebt: Number(debt.remaining_debt) || 0,
        isSettled: false,
        remainingToRecover: Number(releaseAmount) || 0,
        debtFound: true,
        debtId: debt.id,
        recoveryId: null
      };
    }

    const updatedDebtRes = await executor.query(
      `UPDATE seller_debts
       SET remaining_debt = $1,
           status = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, remaining_debt, status`,
      [recovery.remainingDebt, recovery.isSettled ? 'paid' : 'partial', debt.id]
    );

    const recoveryRes = await executor.query(
      `INSERT INTO seller_debt_recoveries (
         seller_id,
         debt_id,
         refund_case_id,
         escrow_transaction_id,
         order_id,
         release_amount,
         recovered_amount,
         remaining_debt,
         status,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING id`,
      [sellerId, debt.id, debt.refund_case_id || refundCaseId || null, escrowId || null, orderId || null, releaseAmount, recovery.recoveredAmount, recovery.remainingDebt, recovery.isSettled ? 'settled' : 'partial']
    );

    if (recovery.recoveredAmount > 0) {
      try {
        await ensureSellerRecentTransactionsTable(executor);
        await executor.query(
          `INSERT INTO seller_recent_transactions (seller_id, type, description, amount, status, reference_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
          [sellerId, 'Debt Recovery', 'Automatic refund debt recovery.', -Number(recovery.recoveredAmount), 'Recovered', debt.refund_case_id || refundCaseId || null]
        );

        await createDedupedNotification({
          userId: sellerId,
          title: 'Debt Recovery',
          message: `₦${Number(recovery.recoveredAmount).toFixed(2)} has been automatically deducted from your earnings to recover a previous refund debt.`,
          type: 'refund',
          referenceId: debt.refund_case_id || refundCaseId || null,
          link: '/sellers/sellers%20earning.html'
        });
      } catch (notificationError) {
        console.warn('[debt-recovery] Could not create debt recovery notification or recent transaction:', notificationError.message || notificationError);
      }
    }

    if (recovery.isSettled) {
      console.log('[debt-recovery] Debt fully settled', {
        sellerId,
        context,
        debtId: debt.id,
        recoveryId: recoveryRes.rows[0]?.id,
        recoveredAmount: recovery.recoveredAmount
      });
    } else {
      console.log('[debt-recovery] Partial recovery', {
        sellerId,
        context,
        debtId: debt.id,
        recoveryId: recoveryRes.rows[0]?.id,
        recoveredAmount: recovery.recoveredAmount,
        remainingDebt: recovery.remainingDebt
      });
    }

    return {
      recoveredAmount: recovery.recoveredAmount,
      remainingDebt: recovery.remainingDebt,
      isSettled: recovery.isSettled,
      remainingToRecover: recovery.remainingToRecover,
      debtFound: true,
      debtId: updatedDebtRes.rows[0]?.id || debt.id,
      recoveryId: recoveryRes.rows[0]?.id || null
    };
  } catch (error) {
    const message = error.message || String(error);
    if (message.includes('seller_debts') || message.includes('seller_debt_recoveries') || message.includes('relation')) {
      console.warn('[debt-recovery] Debt tables are unavailable; skipping recovery', { sellerId, context, message });
      return {
        recoveredAmount: 0,
        remainingDebt: 0,
        isSettled: true,
        remainingToRecover: Number(releaseAmount) || 0,
        debtFound: false,
        debtId: null,
        recoveryId: null
      };
    }

    throw error;
  }
}

module.exports = {
  calculateDebtRecovery,
  ensureSellerRecentTransactionsTable,
  recoverSellerDebtFromEscrowRelease
};
