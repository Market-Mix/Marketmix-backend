const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAnalyticsRange } = require('../controllers/stores.controller');

function fixedNow() {
  return new Date('2026-11-20T12:00:00.000Z');
}

test('analytics ranges use Africa/Lagos midnight boundaries', () => {
  const seven = parseAnalyticsRange('7days', fixedNow());
  assert.equal(seven.startTimestamp, '2026-11-13T23:00:00.000Z');
  assert.equal(seven.endTimestamp, '2026-11-20T23:00:00.000Z');

  const thirty = parseAnalyticsRange('30days', fixedNow());
  assert.equal(thirty.startTimestamp, '2026-10-21T23:00:00.000Z');
  assert.equal(thirty.endTimestamp, '2026-11-20T23:00:00.000Z');

  const ninety = parseAnalyticsRange('90days', fixedNow());
  assert.equal(ninety.startTimestamp, '2026-08-22T23:00:00.000Z');
  assert.equal(ninety.endTimestamp, '2026-11-20T23:00:00.000Z');

  const year = parseAnalyticsRange('year', fixedNow());
  assert.equal(year.startTimestamp, '2025-12-31T23:00:00.000Z');
  assert.equal(year.endTimestamp, '2026-11-20T23:00:00.000Z');

  assert.equal(parseAnalyticsRange('invalid', fixedNow()), null);
});

test('timestamped store and product view ranges are separate from lifetime counters', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../controllers/stores.controller'), 'utf8');

  assert.match(source, /FROM public\.view_events[\s\S]*?view_type = 'store'/);
  assert.match(source, /FROM public\.view_events ve[\s\S]*?ve\.view_type = 'product'/);
  assert.match(source, /WITH product_totals AS \([\s\S]*?COUNT\(\*\)::bigint AS views/);
  assert.match(source, /COALESCE\(SUM\(COALESCE\(p\.views, 0\)\), 0\)::bigint AS total_product_views/);
});

test('range analytics preserve Lagos, paid-payment, ownership and isolation predicates', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../controllers/stores.controller'), 'utf8');

  assert.match(source, /timeZone: 'Africa\/Lagos'/);
  assert.match(source, /o\.payment_status = 'paid'/);
  assert.match(source, /pt\.status = 'success'/);
  assert.match(source, /oi\.seller_id = \$1/);
  assert.match(source, /oi\.store_id = \$2/);
  assert.match(source, /ve\.seller_id = \$2/);
  assert.match(source, /ve\.store_id = \$1/);
});
