const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePauseParty, canSendRefundMessage } = require('../services/refundChatControl.service');

test('normalizes buyer and seller pause parties only', () => {
  assert.equal(normalizePauseParty('buyer'), 'buyer');
  assert.equal(normalizePauseParty('SELLER'), 'seller');
  assert.equal(normalizePauseParty('admin'), null);
  assert.equal(normalizePauseParty(null), null);
});

test('paused buyer cannot send while seller can still message', () => {
  const buyer = canSendRefundMessage({ role: 'buyer', senderType: 'buyer', buyerPaused: true, sellerPaused: false, resolutionStatus: 'pending' });
  const seller = canSendRefundMessage({ role: 'seller', senderType: 'seller', buyerPaused: true, sellerPaused: false, resolutionStatus: 'pending' });
  assert.equal(buyer.allowed, false);
  assert.match(buyer.reason, /Buyer messaging is paused/);
  assert.equal(seller.allowed, true);
});

test('paused seller cannot send while buyer can still message', () => {
  const seller = canSendRefundMessage({ role: 'seller', senderType: 'seller', buyerPaused: false, sellerPaused: true, resolutionStatus: 'pending' });
  const buyer = canSendRefundMessage({ role: 'buyer', senderType: 'buyer', buyerPaused: false, sellerPaused: true, resolutionStatus: 'pending' });
  assert.equal(seller.allowed, false);
  assert.match(seller.reason, /Seller messaging is paused/);
  assert.equal(buyer.allowed, true);
});

test('admin can send regardless of pause state', () => {
  assert.equal(canSendRefundMessage({ role: 'admin', senderType: 'admin', buyerPaused: true, sellerPaused: true, resolutionStatus: 'pending' }).allowed, true);
});

test('admin can send in resolved and escalated cases', () => {
  assert.equal(canSendRefundMessage({ role: 'admin', senderType: 'admin', buyerPaused: false, sellerPaused: false, resolutionStatus: 'resolved' }).allowed, true);
  assert.equal(canSendRefundMessage({ role: 'admin', senderType: 'admin', buyerPaused: false, sellerPaused: false, resolutionStatus: 'escalated' }).allowed, true);
});

test('resume behavior allows the previously paused party again', () => {
  assert.equal(canSendRefundMessage({ role: 'buyer', senderType: 'buyer', buyerPaused: true, sellerPaused: false, resolutionStatus: 'pending' }).allowed, false);
  assert.equal(canSendRefundMessage({ role: 'buyer', senderType: 'buyer', buyerPaused: false, sellerPaused: false, resolutionStatus: 'pending' }).allowed, true);
});

test('existing resolved and escalated restrictions remain for buyer and seller', () => {
  for (const status of ['resolved', 'escalated']) {
    assert.equal(canSendRefundMessage({ role: 'buyer', senderType: 'buyer', buyerPaused: false, sellerPaused: false, resolutionStatus: status }).allowed, false);
    assert.equal(canSendRefundMessage({ role: 'seller', senderType: 'seller', buyerPaused: false, sellerPaused: false, resolutionStatus: status }).allowed, false);
  }
});

test('pause and resume routes require authentication, admin role, and Refunds Manage permission', () => {
  const router = require('../routes/refund_chat.routes');
  const pauseRoute = router.stack.find(layer => layer.route?.path === '/:caseId/pause/:party');
  const resumeRoute = router.stack.find(layer => layer.route?.path === '/:caseId/resume/:party');

  assert.ok(pauseRoute && pauseRoute.route.methods.put);
  assert.ok(resumeRoute && resumeRoute.route.methods.put);
  assert.equal(pauseRoute.route.stack.length, 4);
  assert.equal(resumeRoute.route.stack.length, 4);
});
