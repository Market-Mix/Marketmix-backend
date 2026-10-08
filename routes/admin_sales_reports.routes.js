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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const n = v => Number(v) || 0;
const pct = (c, p) => (p > 0 ? +(((c - p) / p) * 100).toFixed(1) : null);
const q = (sql, p) => db.query(sql, p).then(r => r.rows);

function parseRange(qs) {
  const today = new Date().toISOString().slice(0, 10);
  const to = DATE.test(qs.to || '') ? qs.to : today;
  const from = DATE.test(qs.from || '') ? qs.from : new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const interval = qs.interval === 'month' ? 'month' : 'day';
  if (from > to) throw Object.assign(new Error('"From" date must be before "To" date'), { status: 400 });
  const days = (new Date(to) - new Date(from)) / 864e5 + 1;
  if (days > 732) throw Object.assign(new Error('Range cannot exceed 2 years'), { status: 400 });
  return { from, to, interval, days };
}

async function build({ from, to, interval, days }) {
  const prevFrom = new Date(new Date(from) - days * 864e5).toISOString().slice(0, 10);
  const W = `payment_status='paid' AND created_at >= $1::date AND created_at < $2::date + 1`;

  const [tot, prev, series, cats, ref] = await Promise.all([
    q(`SELECT COALESCE(SUM(total_amount),0) gross, COUNT(*) orders FROM orders WHERE ${W}`, [from, to]),
    q(`SELECT COALESCE(SUM(total_amount),0) gross, COUNT(*) orders FROM orders
       WHERE payment_status='paid' AND created_at >= $1::date AND created_at < $2::date`, [prevFrom, from]),
    q(`SELECT to_char(g.k,'YYYY-MM-DD') label, COALESCE(o.rev,0) revenue, COALESCE(o.cnt,0) orders
       FROM generate_series(date_trunc('${interval}',$1::date)::timestamp, date_trunc('${interval}',$2::date)::timestamp, '1 ${interval}') g(k)
       LEFT JOIN (SELECT date_trunc('${interval}',created_at)::timestamp k, SUM(total_amount) rev, COUNT(*) cnt
                  FROM orders WHERE ${W} GROUP BY 1) o ON o.k = g.k
       ORDER BY g.k`, [from, to]),
    q(`SELECT COALESCE(c.name,'Uncategorized') category, COUNT(DISTINCT o.id) orders,
              SUM(oi.quantity*oi.price_at_purchase) revenue
       FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
       LEFT JOIN categories c ON c.id=p.category_id
       WHERE o.payment_status='paid' AND o.created_at >= $1::date AND o.created_at < $2::date + 1
       GROUP BY 1 ORDER BY revenue DESC LIMIT 8`, [from, to]),
    q(`SELECT COALESCE(SUM(COALESCE(refund_amount,0)+COALESCE(shipping_amount,0)),0) v
       FROM refund_transactions WHERE payment_status='paid' AND created_at >= $1::date AND created_at < $2::date + 1`, [from, to]),
  ]);

  const gross = n(tot[0].gross), orders = n(tot[0].orders), refunds = n(ref[0].v);
  const catTotal = cats.reduce((a, c) => a + n(c.revenue), 0);
  return {
    range: { from, to, interval },
    summary: {
      gross, orders, aov: orders ? +(gross / orders).toFixed(2) : 0,
      refunds, refundRate: gross ? +((refunds / gross) * 100).toFixed(1) : 0,
      platformRevenue: +(gross - stripFee(gross)).toFixed(2), sellerShare: stripFee(gross),
      grossChange: pct(gross, n(prev[0].gross)), ordersChange: pct(orders, n(prev[0].orders)),
    },
    series: { labels: series.map(s => s.label), revenue: series.map(s => n(s.revenue)), orders: series.map(s => n(s.orders)) },
    categories: cats.map(c => ({ category: c.category, orders: n(c.orders), revenue: n(c.revenue),
      share: catTotal ? +((n(c.revenue) / catTotal) * 100).toFixed(1) : 0 })),
  };
}

const wrap = fn => async (req, res) => {
  try { return await fn(req, res); }
  catch (e) { if (!e.status) console.error('sales-reports:', e.message); return sendError(res, e.status || 500, e.message); }
};

router.get('/', requirePermission('Analytics', 'View'), wrap(async (req, res) =>
  sendSuccess(res, 200, 'Sales report', await build(parseRange(req.query)))));

const cell = c => { c = String(c ?? ''); if (/^[=+\-@]/.test(c)) c = "'" + c; return `"${c.replace(/"/g, '""')}"`; };
router.get('/export', requirePermission('Analytics', 'Export'), wrap(async (req, res) => {
  const d = await build(parseRange(req.query));
  const lines = [
    ['Period', 'Orders', 'Revenue (NGN)', 'Share of Total %'].map(cell).join(','),
    ...d.series.labels.map((l, i) => [l, d.series.orders[i], d.series.revenue[i],
      d.summary.gross ? ((d.series.revenue[i] / d.summary.gross) * 100).toFixed(2) : '0.00'].map(cell).join(',')),
    '',
    ['TOTAL', d.summary.orders, d.summary.gross, '100'].map(cell).join(','),
    ['Platform revenue', '', d.summary.platformRevenue, ''].map(cell).join(','),
    ['Refunds', '', d.summary.refunds, ''].map(cell).join(','),
    '', ['Category', 'Orders', 'Revenue (NGN)', 'Share %'].map(cell).join(','),
    ...d.categories.map(c => [c.category, c.orders, c.revenue, c.share].map(cell).join(',')),
  ];
  await logAudit(req.user.id, 'SALES_REPORT_EXPORTED', 'report', null, d.range);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sales-report-${d.range.from}_to_${d.range.to}.csv"`);
  return res.send(lines.join('\n'));
}));

module.exports = router;
