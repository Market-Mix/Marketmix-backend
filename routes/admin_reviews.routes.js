const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission } = require('../middlewares/rbac.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { logAudit } = require('../utils/audit');

router.use(protect, isAdmin);

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => async (req, res) => {
  try { return await fn(req, res); }
  catch (e) {
    if (!e.status) console.error('admin reviews:', e.message);
    return sendError(res, e.status || 500, e.message);
  }
};
const q = (sql, p = []) => db.query(sql, p).then(r => r.rows);
const n = v => Number(v) || 0;

const BASE = `WITH base AS (
  SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at, r.admin_notes,
    CASE WHEN r.is_deleted THEN 'Removed' WHEN r.moderation_status='hidden' THEN 'Hidden'
         WHEN EXISTS (SELECT 1 FROM review_reports rp WHERE rp.review_id=r.id AND rp.status='pending') THEN 'Reported'
         WHEN r.moderation_status='published' THEN 'Published' ELSE 'Pending' END AS status,
    (SELECT COUNT(*) FROM review_reports rp WHERE rp.review_id=r.id) AS reports,
    p.id AS product_id, p.name AS product, p.main_image_url AS product_image,
    COALESCE(c.name,'Uncategorized') AS category,
    p.seller_id, COALESCE(s.business_name, su.first_name||' '||su.last_name) AS seller, su.email AS seller_email,
    r.user_id AS buyer_id, TRIM(COALESCE(b.first_name,'')||' '||COALESCE(b.last_name,'')) AS buyer, b.email AS buyer_email,
    (r.order_id IS NOT NULL) AS verified,
    COALESCE('MMX-'||o.order_number::text, '#'||UPPER(LEFT(o.id::text,8))) AS order_no
  FROM reviews r
  JOIN products p ON p.id=r.product_id
  LEFT JOIN categories c ON c.id=p.category_id
  LEFT JOIN stores s ON s.id=p.store_id
  LEFT JOIN users su ON su.id=p.seller_id
  LEFT JOIN users b ON b.id=r.user_id
  LEFT JOIN orders o ON o.id=r.order_id)`;

const shape = r => ({
  id: r.id, displayId: 'REV-' + String(r.id).slice(0, 6).toUpperCase(),
  product: r.product, productImage: r.product_image, category: r.category,
  buyer: r.buyer || 'Buyer', buyerEmail: r.buyer_email, seller: r.seller || '—', sellerEmail: r.seller_email,
  rating: r.rating, review: r.comment || '', title: (r.comment || '').slice(0, 60),
  status: r.status, reports: n(r.reports), created: r.created_at, updated: r.updated_at,
  orderId: r.order_no || '—', verified: !!r.verified, adminNotes: r.admin_notes || '',
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function filters(qs) {
  const p = []; let w = 'WHERE 1=1';
  const add = (sql, v) => { p.push(v); w += ` AND ${sql.replace(/\?/g, '$' + p.length)}`; };
  const { search, status, rating, category, date, seller, buyer, ids } = qs;
  if (search) add(`(comment ILIKE ? OR product ILIKE ? OR buyer ILIKE ? OR seller ILIKE ? OR id::text ILIKE ?)`, `%${search}%`);
  if (status && status !== 'all') add('status = ?', status);
  if (rating && rating !== 'all') add('rating = ?', parseInt(rating, 10));
  if (category && category !== 'all') add('category = ?', category);
  if (DATE.test(date || '')) add('created_at::date = ?::date', date);
  if (seller && seller !== 'all') add('seller_id::text = ?', seller);
  if (buyer && buyer !== 'all') add('buyer_id::text = ?', buyer);
  if (ids) add(`id::text = ANY(string_to_array(?, ','))`, ids);
  return { w, p };
}

const PERM = {
  approve: 'Approve', restore: 'Approve', hide: 'Reject', remove: 'Delete',
  flag: 'Edit', reviewed: 'Edit', 'warn-seller': 'Edit', 'warn-buyer': 'Edit'
};
const AUDIT = {
  approve: 'REVIEW_APPROVED', restore: 'REVIEW_RESTORED', hide: 'REVIEW_HIDDEN', remove: 'REVIEW_DELETED',
  flag: 'REVIEW_FLAGGED', reviewed: 'REVIEW_MARKED_REVIEWED', 'warn-seller': 'REVIEW_SELLER_WARNED', 'warn-buyer': 'REVIEW_BUYER_WARNED'
};
const STATE = {
  approve: [`moderation_status='published', is_approved=true, is_deleted=false`, 'Published'],
  restore: [`moderation_status='published', is_approved=true, is_deleted=false`, 'Published'],
  hide: [`moderation_status='hidden', is_approved=false`, 'Hidden'],
  remove: [`moderation_status='removed', is_approved=false, is_deleted=true`, 'Removed'],
};
const gate = (req, res, next) => {
  const perm = PERM[req.body.action];
  if (!perm) return sendError(res, 400, 'Invalid action');
  return requirePermission('Reviews', perm)(req, res, next);
};
const NOTIFY = `INSERT INTO notifications (user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
                VALUES ($1,$2,$3,'account',$4,FALSE,FALSE,NOW(),NOW())`;

async function apply(c, id, action, adminId, note) {
  const cur = (await c.query(`${BASE} SELECT * FROM base WHERE id=$1`, [id])).rows[0];
  if (!cur) throw httpErr(404, 'Review not found');
  let to = cur.status;
  const st = STATE[action];
  if (st) {
    await c.query(`UPDATE reviews SET ${st[0]}, moderated_by=$2, moderated_at=NOW(), updated_at=NOW() WHERE id=$1`, [id, adminId]);
    await c.query(`UPDATE review_reports SET status='reviewed' WHERE review_id=$1 AND status='pending'`, [id]);
    to = st[1];
    if (['hide', 'remove'].includes(action) && cur.buyer_id) {
      await c.query(NOTIFY, [cur.buyer_id, `Review ${action === 'hide' ? 'Hidden' : 'Removed'}`,
        `Your review of "${cur.product}" was ${action === 'hide' ? 'hidden' : 'removed'} by MarketMix moderation. Reason: ${note || 'Policy violation'}`, null]);
    }
  } else if (action === 'reviewed') {
    await c.query(`UPDATE review_reports SET status='reviewed' WHERE review_id=$1 AND status='pending'`, [id]);
  } else if (action === 'flag') {
    await c.query(`INSERT INTO review_reports (review_id, reporter_id, reason, details, status)
                   VALUES ($1,$2,'other',$3,'pending') ON CONFLICT DO NOTHING`, [id, adminId, note || 'Flagged by admin']);
    to = 'Reported';
  } else if (action === 'warn-seller') {
    await c.query(NOTIFY, [cur.seller_id, 'Moderation Warning',
      `MarketMix flagged a review on "${cur.product}". ${note || 'Please review your listing and service quality.'}`,
      '/sellers/sellers%20notification%20page.html']);
  } else if (action === 'warn-buyer') {
    await c.query(NOTIFY, [cur.buyer_id, 'Review Guidelines Warning',
      `Your review of "${cur.product}" may violate our review guidelines. ${note || ''}`.trim(), null]);
  }
  await c.query(`INSERT INTO review_moderation_log (review_id,admin_id,action,from_status,to_status,note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, adminId, action, cur.status, to, note || null]);
  return { from: cur.status, to };
}

const audit = (req, action, id, extra = {}) =>
  logAudit(req.user.id, AUDIT[action], 'review', id, { description: `Review ${action}${extra.note ? ': ' + extra.note : ''}`, ...extra });

router.get('/meta', requirePermission('Reviews', 'View'), wrap(async (req, res) => {
  const [categories, sellers, buyers] = await Promise.all([
    q(`SELECT name FROM categories WHERE is_deleted=false ORDER BY name`),
    q(`SELECT DISTINCT p.seller_id id, COALESCE(s.business_name, u.first_name||' '||u.last_name) name
       FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=p.seller_id
       LEFT JOIN stores s ON s.id=p.store_id ORDER BY 2 LIMIT 300`),
    q(`SELECT DISTINCT u.id, TRIM(u.first_name||' '||u.last_name) name FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY 2 LIMIT 300`),
  ]);
  return sendSuccess(res, 200, 'Meta', { categories: categories.map(c => c.name), sellers, buyers });
}));

router.get('/summary', requirePermission('Reviews', 'View'), wrap(async (req, res) => {
  const [s, topCat, lowCat, topSeller, topProd, warns, removedWeek] = await Promise.all([
    q(`${BASE} SELECT COUNT(*) total,
        COUNT(*) FILTER (WHERE status='Pending') pending, COUNT(*) FILTER (WHERE status='Reported') reported,
        COUNT(*) FILTER (WHERE status='Removed') removed, COUNT(*) FILTER (WHERE status='Published') published,
        ROUND(AVG(rating) FILTER (WHERE status NOT IN ('Removed','Hidden')),1) avg,
        COUNT(*) FILTER (WHERE created_at::date=CURRENT_DATE) today,
        COUNT(*) FILTER (WHERE created_at>=date_trunc('month',NOW())) month FROM base`),
    q(`${BASE} SELECT category, COUNT(*) c FROM base WHERE status<>'Removed' GROUP BY 1 ORDER BY c DESC LIMIT 1`),
    q(`${BASE} SELECT category, ROUND(AVG(rating),1) a FROM base WHERE status<>'Removed' GROUP BY 1 ORDER BY a ASC LIMIT 1`),
    q(`${BASE} SELECT seller, SUM(reports) c FROM base GROUP BY seller_id, seller HAVING SUM(reports)>0 ORDER BY c DESC LIMIT 1`),
    q(`${BASE} SELECT product, SUM(reports) c FROM base GROUP BY product_id, product HAVING SUM(reports)>0 ORDER BY c DESC LIMIT 1`),
    q(`SELECT COUNT(*) c FROM review_moderation_log WHERE action IN ('warn-seller','warn-buyer') AND created_at>=NOW()-INTERVAL '7 days'`),
    q(`SELECT COUNT(*) c FROM review_moderation_log WHERE action='remove' AND created_at>=NOW()-INTERVAL '7 days'`),
  ]);
  const x = s[0];
  return sendSuccess(res, 200, 'Summary', {
    total: n(x.total), pending: n(x.pending), reported: n(x.reported), removed: n(x.removed),
    published: n(x.published), avgRating: n(x.avg), today: n(x.today), month: n(x.month),
    analytics: [
      { title: 'Average Rating', value: `${n(x.avg)}/5`, detail: 'Published & pending reviews' },
      { title: 'Most Reviewed Category', value: topCat[0]?.category || '—', detail: `${n(topCat[0]?.c)} reviews` },
      { title: 'Lowest Rated Category', value: lowCat[0]?.category || '—', detail: `${n(lowCat[0]?.a)} average` },
      { title: 'Most Reported Seller', value: topSeller[0]?.seller || '—', detail: `${n(topSeller[0]?.c)} reports` },
      { title: 'Most Reported Product', value: topProd[0]?.product || '—', detail: `${n(topProd[0]?.c)} reports` },
      { title: 'Pending Queue', value: String(n(x.pending)), detail: `${n(x.reported)} reported` },
      { title: "Today's Reviews", value: String(n(x.today)), detail: 'Submitted today' },
      { title: 'Reviews This Month', value: String(n(x.month)), detail: 'Month to date' },
    ],
    pulse: [
      { title: 'Priority queue', value: `${n(x.reported) + n(x.pending)} to review`, accent: 'blue' },
      { title: 'Warnings (7d)', value: `${n(warns[0].c)} sent`, accent: 'amber' },
      { title: 'Removed (7d)', value: `${n(removedWeek[0].c)} reviews`, accent: 'emerald' },
    ],
  });
}));

const cell = c => {
  c = String(c ?? '');
  if (/^[=+\-@]/.test(c)) c = "'" + c;
  return `"${c.replace(/"/g, '""')}"`;
};
router.get('/export', requirePermission('Reviews', 'Export'), wrap(async (req, res) => {
  const { w, p } = filters(req.query);
  const rows = await q(`${BASE} SELECT * FROM base ${w} ORDER BY created_at DESC LIMIT 10000`, p);
  const lines = [['Review ID', 'Product', 'Buyer', 'Seller', 'Rating', 'Status', 'Reports', 'Created', 'Review'].map(cell).join(','),
    ...rows.map(r => {
      const s = shape(r);
      return [s.displayId, s.product, s.buyer, s.seller, s.rating, s.status, s.reports, new Date(s.created).toISOString(), s.review].map(cell).join(',');
    })];
  await logAudit(req.user.id, 'REVIEWS_EXPORTED', 'review', null, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reviews-${Date.now()}.csv"`);
  return res.send(lines.join('\n'));
}));

router.post('/bulk', gate, wrap(async (req, res) => {
  const { ids, action, note } = req.body;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw httpErr(400, 'Select 1–100 reviews');
  await db.transaction(async c => { for (const id of ids) await apply(c, id, action, req.user.id, note); });
  for (const id of ids) await audit(req, action, id, { note, bulk: true });
  return sendSuccess(res, 200, `${ids.length} review(s) updated`);
}));

router.get('/', requirePermission('Reviews', 'View'), wrap(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const { w, p } = filters(req.query);
  const [rows, count] = await Promise.all([
    q(`${BASE} SELECT * FROM base ${w} ORDER BY created_at DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, limit, (page - 1) * limit]),
    q(`${BASE} SELECT COUNT(*) FROM base ${w}`, p),
  ]);
  return sendSuccess(res, 200, 'Reviews', { reviews: rows.map(shape), total: n(count[0].count), page, limit });
}));

router.get('/:id', requirePermission('Reviews', 'View'), wrap(async (req, res) => {
  const [r] = await q(`${BASE} SELECT * FROM base WHERE id=$1`, [req.params.id]);
  if (!r) throw httpErr(404, 'Review not found');
  const [media, reports, log] = await Promise.all([
    q(`SELECT media_type, media_url FROM review_media WHERE review_id=$1`, [r.id]),
    q(`SELECT rp.reason, rp.details, rp.status, rp.created_at,
              COALESCE(NULLIF(TRIM(u.first_name||' '||u.last_name),''), u.email, 'User') reporter
       FROM review_reports rp LEFT JOIN users u ON u.id=rp.reporter_id WHERE rp.review_id=$1 ORDER BY rp.created_at DESC`, [r.id]),
    q(`SELECT l.action, l.from_status, l.to_status, l.note, l.created_at,
              COALESCE(NULLIF(TRIM(u.first_name||' '||u.last_name),''), u.email, 'System') admin
       FROM review_moderation_log l LEFT JOIN users u ON u.id=l.admin_id WHERE l.review_id=$1 ORDER BY l.created_at DESC`, [r.id]),
  ]);
  const history = log.map(l => ({ event: l.action.replace('-', ' ') + (l.note ? ` — ${l.note}` : ''), date: l.created_at, admin: l.admin, status: l.to_status || l.from_status }));
  const timeline = [
    { event: 'Review Submitted', date: r.created_at, admin: r.buyer || 'Buyer', status: 'Completed' },
    ...reports.map(x => ({ event: `Reported: ${x.reason}`, date: x.created_at, admin: x.reporter, status: x.status === 'pending' ? 'Active' : 'Completed' })),
    ...history.slice().reverse().map(h => ({ ...h, status: 'Completed' })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
  return sendSuccess(res, 200, 'Review', { review: {
    ...shape(r),
    media: {
      images: media.filter(m => m.media_type === 'image').map(m => m.media_url),
      videos: media.filter(m => m.media_type === 'video').map(m => m.media_url)
    },
    reportHistory: reports.map(x => ({ reporter: x.reporter, reason: x.reason, details: x.details, date: x.created_at, status: x.status === 'pending' ? 'Open' : 'Reviewed' })),
    history,
    timeline
  } });
}));

router.post('/:id/action', gate, wrap(async (req, res) => {
  const { action, note } = req.body;
  const out = await db.transaction(c => apply(c, req.params.id, action, req.user.id, (note || '').trim().slice(0, 500)));
  await audit(req, action, req.params.id, { note, from: out.from, to: out.to });
  return sendSuccess(res, 200, 'Review updated', out);
}));

router.put('/:id/notes', requirePermission('Reviews', 'Edit'), wrap(async (req, res) => {
  const notes = String(req.body.notes || '').slice(0, 2000);
  const r = await q(`UPDATE reviews SET admin_notes=$1, updated_at=NOW() WHERE id=$2 RETURNING id`, [notes, req.params.id]);
  if (!r.length) throw httpErr(404, 'Review not found');
  await logAudit(req.user.id, 'REVIEW_NOTE_SAVED', 'review', req.params.id, { description: 'Admin note saved on review' });
  return sendSuccess(res, 200, 'Notes saved');
}));

module.exports = router;
