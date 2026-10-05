const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission } = require('../middlewares/rbac.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { stripFee } = require('../utils/pricing');
const { logAudit } = require('../utils/audit');

router.use(protect, isAdmin);

const RANGES = { '7d': { days: 7, t: 'day' }, '30d': { days: 30, t: 'day' }, '90d': { days: 90, t: 'day' }, '12m': { days: 365, t: 'month' } };
const n = v => Number(v) || 0;
const pct = (c, p) => (p > 0 ? +(((c - p) / p) * 100).toFixed(1) : null);
const rate = (a, b) => (b > 0 ? +((a / b) * 100).toFixed(1) : 0);
const q = (sql, p = []) => db.query(sql, p).then(r => r.rows);
const cache = new Map();

function bounds(key) {
  const cfg = RANGES[key] || RANGES['30d'];
  const now = new Date();
  const start = cfg.t === 'month'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (cfg.days - 1)));
  return { ...cfg, start, prev: new Date(start.getTime() - (now.getTime() - start.getTime())) };
}

async function build(key) {
  const { t, start, prev } = bounds(key);
  const periodEnd = new Date();
  const A = [start];
  const AB = [start, prev];
  const series = c => `SELECT to_char(date_trunc('${t}',${c.col}),'YYYY-MM-DD') k, ${c.agg} FROM ${c.from} WHERE ${c.where} AND ${c.col}>=$1 GROUP BY 1`;

  const [ord, bu, sel, ref, wd, labels, sO, sB, sS, cats, prods, cust, sellerQ, prodQ, ops, rt, pay, chan, status, act] = await Promise.all([
    q(`SELECT COALESCE(SUM(total_amount) FILTER (WHERE created_at>=$1),0) rev,
              COALESCE(SUM(total_amount) FILTER (WHERE created_at<$1),0) prev_rev,
              COUNT(*) FILTER (WHERE created_at>=$1) cnt,
              COUNT(*) FILTER (WHERE created_at<$1) prev_cnt
       FROM orders WHERE payment_status='paid' AND created_at>=$2`, [start, prev]),
    q(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE created_at>=$1) cur, COUNT(*) FILTER (WHERE created_at>=$2 AND created_at<$1) prev
       FROM users WHERE role='buyer' AND is_deleted=false`, [start, prev]),
    q(`SELECT (SELECT COUNT(*) FROM users WHERE role='seller' AND is_deleted=false) total,
              (SELECT COUNT(*) FROM users WHERE role='seller' AND is_deleted=false AND created_at>=$1) new_sellers,
              (SELECT COUNT(DISTINCT oi.seller_id) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.payment_status='paid' AND o.created_at>=$1) active`, [start]),
    q(`SELECT COALESCE(SUM(COALESCE(refund_amount,0)+COALESCE(shipping_amount,0)) FILTER (WHERE created_at>=$1),0) cur,
              COALESCE(SUM(COALESCE(refund_amount,0)+COALESCE(shipping_amount,0)) FILTER (WHERE created_at<$1),0) prev
       FROM refund_transactions WHERE payment_status='paid' AND created_at>=$2`, [start, prev]),
    q(`SELECT COALESCE(SUM(amount),0) v FROM withdrawals WHERE status='success' AND COALESCE(processed_at,created_at)>=$1`, [start]),
    q(`SELECT to_char(d,'YYYY-MM-DD') k FROM generate_series(date_trunc('${t}',$1::timestamptz), date_trunc('${t}',NOW()), interval '1 ${t}') d`, [start]),
    q(series({ col: 'created_at', agg: 'SUM(total_amount) rev, COUNT(*) cnt', from: 'orders', where: `payment_status='paid'` }), [start]),
    q(series({ col: 'created_at', agg: 'COUNT(*) n', from: 'users', where: `role='buyer' AND is_deleted=false` }), [start]),
    q(`SELECT to_char(date_trunc('${t}',o.created_at),'YYYY-MM-DD') k, COUNT(DISTINCT oi.seller_id) n
       FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.payment_status='paid' AND o.created_at>=$1 GROUP BY 1`, [start]),
    q(`SELECT COALESCE(c.name,'Uncategorized') category,
              COUNT(DISTINCT o.id) FILTER (WHERE o.created_at>=$1) orders,
              COALESCE(SUM(oi.quantity*oi.price_at_purchase) FILTER (WHERE o.created_at>=$1),0) revenue,
              COALESCE(SUM(oi.quantity*oi.price_at_purchase) FILTER (WHERE o.created_at<$1),0) prev_revenue
       FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id LEFT JOIN categories c ON c.id=p.category_id
       WHERE o.payment_status='paid' AND o.created_at>=$2 GROUP BY 1
       HAVING SUM(oi.quantity*oi.price_at_purchase) FILTER (WHERE o.created_at>=$1) > 0 ORDER BY revenue DESC LIMIT 8`, [start, prev]),
    q(`SELECT p.name, COALESCE(s.business_name,u.first_name||' '||u.last_name) seller, COUNT(DISTINCT o.id) orders,
              SUM(oi.quantity*oi.price_at_purchase) revenue,
              (SELECT ROUND(AVG(r.rating),1) FROM reviews r WHERE r.product_id=p.id AND r.is_deleted=false) rating
       FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
       LEFT JOIN users u ON u.id=p.seller_id LEFT JOIN stores s ON s.id=p.store_id
       WHERE o.payment_status='paid' AND o.created_at>=$1
       GROUP BY p.id, s.business_name, u.first_name, u.last_name ORDER BY revenue DESC LIMIT 5`, [start]),
    q(`SELECT COUNT(*) FILTER (WHERE n>=2) returning_b, COUNT(*) buyers_with_orders, COALESCE(AVG(spent),0) clv
       FROM (SELECT buyer_id, COUNT(*) n, SUM(total_amount) spent FROM orders WHERE payment_status='paid' GROUP BY buyer_id) t`),
    q(`SELECT COUNT(*) FILTER (WHERE kyc_status IN ('pending','approved','rejected')) submitted, COUNT(*) FILTER (WHERE is_verified) approved,
              COALESCE(AVG(NULLIF(rating,0)),0) avg_rating FROM seller_profiles WHERE is_deleted=false`),
    q(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE stock_quantity=0) oos, COUNT(*) FILTER (WHERE stock_quantity BETWEEN 1 AND 10) low,
              COUNT(*) FILTER (WHERE is_active=false AND COALESCE(admin_disabled,false)=false) pending FROM products WHERE is_deleted=false`),
    q(`SELECT AVG(EXTRACT(EPOCH FROM (delivery_confirmed_at-created_at))/86400) FILTER (WHERE delivery_confirmed_at IS NOT NULL) delivery_days,
              COUNT(*) FILTER (WHERE status NOT IN ('awaiting_payment','cancelled','payment_failed')) ok,
              COUNT(*) FILTER (WHERE status<>'awaiting_payment') total FROM orders WHERE created_at>=$1`, [start]),
    q(`SELECT AVG(EXTRACT(EPOCH FROM (refund_paid_at-created_at))/86400) d FROM refund_cases WHERE refund_paid_at IS NOT NULL AND created_at>=$1`, [start]),
    q(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='success') ok, COUNT(*) FILTER (WHERE status='failed') failed FROM payment_transactions WHERE created_at>=$1`, [start]),
    q(`SELECT COALESCE(channel,'other') name, COUNT(*) v FROM payment_transactions WHERE status='success' AND created_at>=$1 GROUP BY 1 ORDER BY v DESC`, [start]),
    q(`SELECT status name, COUNT(*) v FROM orders WHERE created_at>=$1 GROUP BY 1 ORDER BY v DESC`, [start]),
    q(`(SELECT 'order' type, 'New Order • '||COALESCE('MMX-'||order_number::text,'#'||UPPER(LEFT(id::text,8)))||' • ₦'||total_amount::bigint::text txt, created_at ts FROM orders WHERE payment_status='paid' ORDER BY created_at DESC LIMIT 4)
       UNION ALL (SELECT 'seller','New Seller Registration • '||first_name, created_at FROM users WHERE role='seller' AND is_deleted=false ORDER BY created_at DESC LIMIT 3)
       UNION ALL (SELECT 'refund','Refund Requested • '||COALESCE(product_name,'item'), created_at FROM refund_cases ORDER BY created_at DESC LIMIT 3)
       UNION ALL (SELECT 'withdrawal','Withdrawal '||status||' • ₦'||amount::bigint::text, created_at FROM withdrawals ORDER BY created_at DESC LIMIT 3)
       ORDER BY ts DESC LIMIT 10`),
  ]);

  const o = ord[0], b = bu[0], s = sel[0], r = ref[0], cu = cust[0], sq = sellerQ[0], pq = prodQ[0], op = ops[0], py = pay[0];
  const rev = n(o.rev), prevRev = n(o.prev_rev), orders = n(o.cnt);
  const refundRate = rate(n(r.cur), rev), prevRefundRate = rate(n(r.prev), prevRev);
  const orderSuccess = rate(n(op.ok), n(op.total)), paymentSuccess = rate(n(py.ok), n(py.total));
  const conversion = rate(n(cu.returning_b), n(b.total));

  const scores = [100 - Math.min(refundRate * 5, 100)];
  if (n(py.total)) scores.push(paymentSuccess);
  if (n(op.total)) scores.push(orderSuccess);
  const health = Math.round(scores.reduce((a, c) => a + c, 0) / scores.length);

  const idx = rows => new Map(rows.map(x => [x.k, x]));
  const mO = idx(sO), mB = idx(sB), mS = idx(sS), keys = labels.map(x => x.k);
  const catTotal = cats.reduce((a, c) => a + n(c.revenue), 0);
  const categories = cats.map(c => ({ category: c.category, orders: n(c.orders), revenue: n(c.revenue),
    growth: pct(n(c.revenue), n(c.prev_revenue)), share: rate(n(c.revenue), catTotal) }));

  const insights = [];
  const rc = pct(rev, prevRev);
  if (rc !== null) insights.push(`Revenue ${rc >= 0 ? 'increased' : 'decreased'} ${Math.abs(rc)}% vs the previous period.`);
  if (categories[0]) insights.push(`${categories[0].category} leads with ${categories[0].share}% of sales.`);
  if (n(r.prev) || n(r.cur)) insights.push(`Refund rate is ${refundRate}% (${refundRate <= prevRefundRate ? 'improved from' : 'up from'} ${prevRefundRate}%).`);
  if (n(b.cur)) insights.push(`${n(b.cur)} new buyers joined in this period.`);
  if (n(pq.low) + n(pq.oos)) insights.push(`${n(pq.low)} products are low on stock and ${n(pq.oos)} are out of stock.`);

  return {
    range: key,
    granularity: t,
    generatedAt: new Date(),
    kpis: {
      revenue: { value: rev, change: rc },
      orders: { value: orders, change: pct(orders, n(o.prev_cnt)) },
      buyers: { total: n(b.total), cur: n(b.cur), change: pct(n(b.cur), n(b.prev)) },
      sellers: { active: n(s.active), total: n(s.total) },
      refundRate: { value: refundRate, change: +(refundRate - prevRefundRate).toFixed(1) },
      withdrawals: { value: n(wd[0].v) },
      conversion: { value: conversion },
      health: { value: health, label: health >= 90 ? 'Healthy' : health >= 75 ? 'Monitor' : 'At risk' },
    },
    series: {
      labels: keys,
      revenue: keys.map(k => n(mO.get(k)?.rev)),
      orders: keys.map(k => n(mO.get(k)?.cnt)),
      buyers: keys.map(k => n(mB.get(k)?.n)),
      sellers: keys.map(k => n(mS.get(k)?.n)),
    },
    categories,
    products: prods.map(p => ({ name: p.name, seller: p.seller, orders: n(p.orders), revenue: n(p.revenue), rating: p.rating ? +p.rating : null })),
    customers: { newBuyers: n(b.cur), returning: n(cu.returning_b), retention: rate(n(cu.returning_b), n(cu.buyers_with_orders)), clv: n(cu.clv) },
    sellerStats: { newSellers: n(s.new_sellers), active: n(s.active), kycRate: rate(n(sq.approved), n(sq.submitted)), avgRating: n(sq.avg_rating) },
    productStats: { total: n(pq.total), oos: n(pq.oos), low: n(pq.low), pending: n(pq.pending) },
    financial: { gross: rev, net: net(rev), commission: rev - net(rev), refunds: n(r.cur), withdrawals: n(wd[0].v), taxes: null },
    operational: { deliveryDays: op.delivery_days == null ? null : n(op.delivery_days), refundDays: rt[0].d == null ? null : n(rt[0].d), supportMinutes: null, orderSuccess, paymentSuccess, failedRate: rate(n(py.failed), n(py.total)) },
    channels: chan.map(c => ({ name: c.name, value: n(c.v) })),
    orderStatus: status.map(c => ({ name: c.name, value: n(c.v) })),
    activity: act.map(a => ({ type: a.type, text: a.txt, at: a.ts })),
    insights,
  };
}
function net(v) { return stripFee(v); }

router.get('/', requirePermission('Analytics', 'View'), async (req, res) => {
  try {
    const key = RANGES[req.query.range] ? req.query.range : '30d';
    const hit = cache.get(key);
    if (!req.query.refresh && hit && Date.now() - hit.at < 60000) return sendSuccess(res, 200, 'Analytics', hit.data);
    const data = await build(key);
    cache.set(key, { at: Date.now(), data });
    return sendSuccess(res, 200, 'Analytics', data);
  } catch (err) {
    console.error('GET /admin/analytics error:', err);
    return sendError(res, 500, 'Error loading analytics', err.message);
  }
});

const REPORTS = {
  revenue: `SELECT to_char(created_at::date,'YYYY-MM-DD') date, COUNT(*) orders, SUM(total_amount) gross_sales FROM orders WHERE payment_status='paid' AND created_at>=$1 GROUP BY 1 ORDER BY 1`,
  orders: `SELECT COALESCE('MMX-'||order_number::text,id::text) order_no, status, payment_status, total_amount, created_at FROM orders WHERE created_at>=$1 ORDER BY created_at DESC LIMIT 5000`,
  sellers: `SELECT u.email, COALESCE(sp.business_name,u.first_name||' '||u.last_name) seller, COALESCE(sp.kyc_status,'not_submitted') kyc_status, u.is_suspended suspended, u.created_at joined,
            (SELECT COALESCE(SUM(oi.quantity*oi.price_at_purchase),0) FROM order_items oi WHERE oi.seller_id=u.id) total_sales
            FROM users u LEFT JOIN seller_profiles sp ON sp.user_id=u.id AND sp.is_deleted=false WHERE u.role='seller' AND u.is_deleted=false ORDER BY joined DESC LIMIT 5000`,
  buyers: `SELECT u.email, u.first_name||' '||u.last_name name, u.created_at joined,
           (SELECT COUNT(*) FROM orders o WHERE o.buyer_id=u.id AND o.payment_status='paid') paid_orders,
           (SELECT COALESCE(SUM(total_amount),0) FROM orders o WHERE o.buyer_id=u.id AND o.payment_status='paid') total_spent
           FROM users u WHERE u.role='buyer' AND u.is_deleted=false ORDER BY joined DESC LIMIT 5000`,
  refunds: `SELECT id, product_name, status, resolution_status, created_at FROM refund_cases WHERE created_at>=$1 ORDER BY created_at DESC LIMIT 5000`,
  payments: `SELECT provider_reference reference, provider, channel, amount, status, created_at FROM payment_transactions WHERE created_at>=$1 ORDER BY created_at DESC LIMIT 5000`,
  products: `SELECT name, price, stock_quantity, is_active, created_at FROM products WHERE is_deleted=false ORDER BY created_at DESC LIMIT 5000`,
};

router.get('/reports/:type', requirePermission('Analytics', 'View'), async (req, res) => {
  try {
    const sql = REPORTS[req.params.type];
    if (!sql) return sendError(res, 404, 'Unknown report');
    const key = RANGES[req.query.range] ? req.query.range : '30d';
    const r = await db.query(sql, sql.includes('$1') ? [bounds(key).start] : []);
    const columns = r.fields.map(f => f.name);
    logAudit(req.user.id, 'ANALYTICS_REPORT_VIEWED', 'report', null, { type: req.params.type, range: key });
    return sendSuccess(res, 200, 'Report', { columns, rows: r.rows.map(o => columns.map(c => o[c])) });
  } catch (err) {
    return sendError(res, 500, 'Error building report', err.message);
  }
});

module.exports = router;
