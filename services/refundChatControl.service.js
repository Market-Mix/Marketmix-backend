function normalizePauseParty(party) {
  const normalized = String(party || '').toLowerCase();
  if (normalized === 'buyer' || normalized === 'seller') return normalized;
  return null;
}

function canSendRefundMessage({ role, senderType, buyerPaused, sellerPaused, resolutionStatus }) {
  if (role === 'admin') return { allowed: true };

  const status = String(resolutionStatus || '').toLowerCase();
  if (['resolved', 'escalated'].includes(status)) {
    return { allowed: false, reason: 'Chat is read-only for this case' };
  }

  if (senderType === 'buyer' && buyerPaused === true) {
    return { allowed: false, reason: 'Buyer messaging is paused for this refund case' };
  }
  if (senderType === 'seller' && sellerPaused === true) {
    return { allowed: false, reason: 'Seller messaging is paused for this refund case' };
  }

  return { allowed: true };
}

module.exports = { normalizePauseParty, canSendRefundMessage };
