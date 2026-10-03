const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { logAudit } = require('../utils/audit');

router.use(protect, isAdmin);

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, 'A coupon with this code already exists');
    console.error('Admin coupons route error:', error);
    return sendError(res, error.status || 500, error.message);
  }
};
const n = value => Number(value) || 0;
const q = (sql, params = []) => db.query(sql, params).then(result => result.rows);
const audit = (req, action, type, id, metadata) => logAudit(req.user.id, action, type, id, metadata);

const cStatus = alias => `CASE WHEN ${alias}.admin_status='draft' THEN 'Draft' WHEN ${alias}.admin_status='disabled' THEN 'Disabled'
  WHEN ${alias}.expiry_date IS NOT NULL AND ${alias}.expiry_date < NOW() THEN 'Expired'
  WHEN ${alias}.usage_limit > 0 AND ${alias}.used_count >= ${alias}.usage_limit THEN 'Expired'
  WHEN ${alias}.start_date IS NOT NULL AND ${alias}.start_date > NOW() THEN 'Scheduled' ELSE 'Active' END`;
const pStatus = alias => `CASE WHEN ${alias}.admin_status='draft' THEN 'Draft' WHEN ${alias}.admin_status='disabled' THEN 'Disabled'
  WHEN ${alias}.end_date IS NOT NULL AND ${alias}.end_date < NOW() THEN 'Expired'
  WHEN ${alias}.start_date IS NOT NULL AND ${alias}.start_date > NOW() THEN 'Scheduled' ELSE 'Active' END`;

const TYPES = ['percentage', 'fixed', 'free_shipping'];
const STATUSES = ['draft', 'active', 'disabled'];
const AUDIENCES = ['all', 'new_buyers', 'returning_buyers'];
const dte = value => {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date)) throw httpErr(400, 'Invalid date');
  return date;
};
const int0 = value => Math.max(parseInt(value, 10) || 0, 0);

const couponShape = row => ({
  id: row.id,
  code: row.code,
  description: row.description,
  discountType: row.discount_type,
  discountValue: n(row.discount_value),
  maxDiscount: n(row.max_discount),
  minOrderAmount: n(row.min_order_amount),
  usageLimit: row.usage_limit || 0,
  perUserLimit: row.per_user_limit || 0,
  used: row.used_count || 0,
  startDate: row.start_date,
  endDate: row.expiry_date,
  status: row.status,
  adminStatus: row.admin_status,
  campaignId: row.campaign_id,
  campaignName: row.campaign_name,
  sellerId: row.seller_id,
  seller: row.seller_name,
});
const promoShape = row => ({
  id: row.id,
  name: row.name,
  description: row.description,
  audience: row.audience,
  budget: n(row.budget),
  startDate: row.start_date,
  endDate: row.end_date,
  status: row.status,
  adminStatus: row.admin_status,
  coupons: n(row.coupon_count),
  redemptions: n(row.redemptions),
  spent: n(row.spent),
  revenue: n(row.revenue),
  performance: n(row.budget) > 0 ? Math.min(Math.round((n(row.spent) / n(row.budget)) * 100), 100) : null,
});

function couponFields(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
    throw httpErr(400, 'Code must be 3–30 characters (letters, numbers, - or _)');
  }
  const type = body.discountType;
  if (!TYPES.includes(type)) throw httpErr(400, 'Invalid discount type');
  const value = type === 'free_shipping' ? 0 : Number(body.discountValue);
  if (type === 'percentage' && !(value > 0 && value <= 100)) {
    throw httpErr(400, 'Percentage must be between 1 and 100');
  }
  if (type === 'fixed' && !(value > 0)) throw httpErr(400, 'Enter a fixed amount greater than 0');
  const start = dte(body.startDate);
  const end = dte(body.endDate);
  if (start && end && end <= start) throw httpErr(400, 'End date must be after start date');
  return {
    code,
    type,
    value,
    max: type === 'fixed' ? 0 : Math.max(n(body.maxDiscount), 0),
    min: Math.max(n(body.minOrderAmount), 0),
    usage: int0(body.usageLimit),
    perUser: int0(body.perUserLimit),
    start,
    end,
    status: STATUSES.includes(body.status) ? body.status : 'draft',
    campaignId: body.campaignId || null,
    description: (body.description || '').trim().slice(0, 255) || null,
  };
}

async function assertCampaign(id) {
  if (!id) return;
  const rows = await q(`SELECT 1 FROM promotions WHERE id=$1 AND NOT is_deleted`, [id]);
  if (!rows.length) throw httpErr(404, 'Campaign not found');
}

function promoFields(body) {
  const name = String(body.name || '').trim();
  if (name.length < 3 || name.length > 120) throw httpErr(400, 'Campaign name must be 3–120 characters');
  const start = dte(body.startDate);
  const end = dte(body.endDate);
  if (start && end && end <= start) throw httpErr(400, 'End date must be after start date');
  return {
    name,
    description: (body.description || '').trim() || null,
    audience: AUDIENCES.includes(body.audience) ? body.audience : 'all',
    budget: Math.max(n(body.budget), 0),
    start,
    end,
    status: STATUSES.includes(body.status) ? body.status : 'draft',
  };
}

const LIST_BASE = `WITH base AS (
  SELECT c.id, c.code, c.description, c.discount_type, COALESCE(c.discount_value,c.discount_percent) AS discount_value,
         c.max_discount, c.min_order_amount, c.per_user_limit, c.usage_limit, c.used_count, c.start_date, c.expiry_date,
         c.admin_status, c.campaign_id, c.seller_id, c.created_at, ${cStatus('c')} AS status, p.name AS campaign_name,
         CASE WHEN c.seller_id IS NULL THEN 'MarketMix' ELSE COALESCE(s.business_name, u.first_name||' '||u.last_name) END AS seller_name
  FROM coupons c
  LEFT JOIN promotions p ON p.id = c.campaign_id
  LEFT JOIN users u ON u.id = c.seller_id
  LEFT JOIN LATERAL (SELECT business_name FROM stores WHERE user_id=c.seller_id AND is_deleted=false ORDER BY store_number LIMIT 1) s ON true
  WHERE c.is_deleted = false)`;

router.get('/meta', wrap(async (req, res) => {
  const [campaigns, sellers] = await Promise.all([
    q(`SELECT id, name FROM promotions WHERE NOT is_deleted ORDER BY created_at DESC`),
    q(`SELECT DISTINCT c.seller_id id, COALESCE(s.business_name,u.first_name||' '||u.last_name) name
       FROM coupons c JOIN users u ON u.id=c.seller_id
       LEFT JOIN LATERAL (SELECT business_name FROM stores WHERE user_id=u.id AND is_deleted=false ORDER BY store_number LIMIT 1) s ON true
       WHERE c.seller_id IS NOT NULL AND NOT c.is_deleted ORDER BY 2`),
  ]);
  return sendSuccess(res, 200, 'Meta', { campaigns, sellers });
}));

router.get('/summary', wrap(async (req, res) => {
  const [couponStatuses, promotions, redemptionData, redemptionRate, topCampaign] = await Promise.all([
    q(`SELECT status, COUNT(*) c FROM (SELECT ${cStatus('c')} status FROM coupons c WHERE NOT c.is_deleted) t GROUP BY 1`),
    q(`SELECT COUNT(*) c FROM promotions p WHERE NOT p.is_deleted AND ${pStatus('p')}='Scheduled'`),
    q(`SELECT COUNT(*) FILTER (WHERE created_at::date=CURRENT_DATE) today, COALESCE(SUM(discount_amount),0) discounts,
              COALESCE(SUM(order_total),0) revenue FROM coupon_redemptions`),
    q(`SELECT COALESCE(SUM(used_count),0) used, COALESCE(SUM(usage_limit),0) lim FROM coupons WHERE NOT is_deleted AND usage_limit>0`),
    q(`SELECT p.name, SUM(r.order_total) rev FROM coupon_redemptions r JOIN promotions p ON p.id=r.campaign_id
       GROUP BY p.id ORDER BY rev DESC LIMIT 1`),
  ]);
  const byStatus = status => n(couponStatuses.find(row => row.status === status)?.c);
  return sendSuccess(res, 200, 'Summary', {
    activeCoupons: byStatus('Active'),
    scheduledCampaigns: n(promotions[0].c),
    expiredCoupons: byStatus('Expired'),
    redeemedToday: n(redemptionData[0].today),
    totalDiscounts: n(redemptionData[0].discounts),
    promotionRevenue: n(redemptionData[0].revenue),
    redemptionRate: n(redemptionRate[0].lim)
      ? +((n(redemptionRate[0].used) / n(redemptionRate[0].lim)) * 100).toFixed(1)
      : 0,
    topCampaign: topCampaign[0]?.name || null,
  });
}));

router.get('/sidebar', wrap(async (req, res) => {
  const [active, ending, best, most, savings, upcoming] = await Promise.all([
    q(`SELECT p.name, p.audience, (SELECT COUNT(*) FROM coupons c WHERE c.campaign_id=p.id AND NOT c.is_deleted) coupons
       FROM promotions p WHERE NOT p.is_deleted AND ${pStatus('p')}='Active' ORDER BY p.created_at DESC LIMIT 5`),
    q(`(SELECT name title, end_date due FROM promotions p WHERE NOT is_deleted AND ${pStatus('p')}='Active' AND end_date BETWEEN NOW() AND NOW()+INTERVAL '7 days')
       UNION ALL (SELECT code, expiry_date FROM coupons c WHERE NOT is_deleted AND ${cStatus('c')}='Active' AND expiry_date BETWEEN NOW() AND NOW()+INTERVAL '7 days')
       ORDER BY due LIMIT 5`),
    q(`SELECT c.code, c.description, SUM(r.order_total) metric FROM coupon_redemptions r JOIN coupons c ON c.id=r.coupon_id GROUP BY c.id ORDER BY metric DESC LIMIT 1`),
    q(`SELECT c.code, c.description, COUNT(*) metric FROM coupon_redemptions r JOIN coupons c ON c.id=r.coupon_id GROUP BY c.id ORDER BY metric DESC LIMIT 1`),
    q(`SELECT COALESCE(SUM(discount_amount),0) v FROM coupon_redemptions`),
    q(`SELECT name title, start_date date FROM promotions p WHERE NOT is_deleted AND ${pStatus('p')}='Scheduled' ORDER BY start_date LIMIT 5`),
  ]);
  return sendSuccess(res, 200, 'Sidebar', {
    activePromotions: active.map(row => ({
      title: row.name,
      subtitle: `${row.coupons} coupon(s) · ${row.audience.replace('_', ' ')}`,
      value: 'Live now',
    })),
    endingSoon: ending,
    upcoming,
    bestCoupon: best[0]
      ? { title: best[0].code, detail: best[0].description || 'Top revenue coupon', metric: n(best[0].metric), kind: 'money' }
      : null,
    highestRedemption: most[0]
      ? { title: most[0].code, detail: most[0].description || 'Most redeemed', metric: n(most[0].metric), kind: 'count' }
      : null,
    totalSavings: n(savings[0].v),
  });
}));

const PROMO_SQL = `SELECT p.*, ${pStatus('p')} AS status,
  (SELECT COUNT(*) FROM coupons c WHERE c.campaign_id=p.id AND NOT c.is_deleted) coupon_count,
  COALESCE(r.spent,0) spent, COALESCE(r.revenue,0) revenue, COALESCE(r.cnt,0) redemptions
  FROM promotions p LEFT JOIN (SELECT campaign_id, SUM(discount_amount) spent, SUM(order_total) revenue, COUNT(*) cnt
                               FROM coupon_redemptions GROUP BY 1) r ON r.campaign_id=p.id`;

router.get('/promotions', wrap(async (req, res) => sendSuccess(res, 200, 'Promotions', {
  promotions: (await q(`${PROMO_SQL} WHERE NOT p.is_deleted ORDER BY p.created_at DESC`)).map(promoShape),
})));

router.post('/promotions', wrap(async (req, res) => {
  const fields = promoFields(req.body);
  const rows = await q(`INSERT INTO promotions (name,description,audience,budget,start_date,end_date,admin_status,created_by)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [fields.name, fields.description, fields.audience, fields.budget, fields.start, fields.end, fields.status, req.user.id]);
  await audit(req, 'PROMOTION_CREATED', 'promotion', rows[0].id, { name: fields.name });
  return sendSuccess(res, 201, 'Campaign created', { id: rows[0].id });
}));

router.put('/promotions/:id', wrap(async (req, res) => {
  const fields = promoFields(req.body);
  const rows = await q(`UPDATE promotions SET name=$1,description=$2,audience=$3,budget=$4,start_date=$5,end_date=$6,admin_status=$7,updated_at=NOW()
                        WHERE id=$8 AND NOT is_deleted RETURNING id`,
    [fields.name, fields.description, fields.audience, fields.budget, fields.start, fields.end, fields.status, req.params.id]);
  if (!rows.length) throw httpErr(404, 'Campaign not found');
  await audit(req, 'PROMOTION_UPDATED', 'promotion', req.params.id, { name: fields.name });
  return sendSuccess(res, 200, 'Campaign saved');
}));

router.post('/promotions/:id/toggle', wrap(async (req, res) => {
  const rows = await q(`UPDATE promotions SET admin_status = CASE WHEN admin_status='active' THEN 'disabled' ELSE 'active' END, updated_at=NOW()
                        WHERE id=$1 AND NOT is_deleted RETURNING admin_status`, [req.params.id]);
  if (!rows.length) throw httpErr(404, 'Campaign not found');
  await audit(req, 'PROMOTION_UPDATED', 'promotion', req.params.id, { adminStatus: rows[0].admin_status });
  return sendSuccess(res, 200, rows[0].admin_status === 'active' ? 'Campaign enabled' : 'Campaign disabled');
}));

router.delete('/promotions/:id', wrap(async (req, res) => {
  const rows = await q(`UPDATE promotions SET is_deleted=true, updated_at=NOW() WHERE id=$1 AND NOT is_deleted RETURNING name`, [req.params.id]);
  if (!rows.length) throw httpErr(404, 'Campaign not found');
  await db.query(`UPDATE coupons SET campaign_id=NULL, updated_at=NOW() WHERE campaign_id=$1`, [req.params.id]);
  await audit(req, 'PROMOTION_DELETED', 'promotion', req.params.id, { name: rows[0].name });
  return sendSuccess(res, 200, 'Campaign deleted');
}));

router.get('/', wrap(async (req, res) => {
  const { search, code, campaign, type, status, seller, from, to } = req.query;
  const exporting = req.query.export === '1';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = exporting ? 5000 : Math.min(parseInt(req.query.limit, 10) || 10, 100);
  const params = [];
  let where = 'WHERE 1=1';
  const add = (sql, value) => {
    params.push(value);
    where += ` AND ${sql.replace(/\?/g, '$' + params.length)}`;
  };
  if (search) add('(code ILIKE ? OR campaign_name ILIKE ? OR description ILIKE ?)', `%${search}%`);
  if (code) add('code ILIKE ?', `%${code}%`);
  if (campaign) add('campaign_name ILIKE ?', `%${campaign}%`);
  if (TYPES.includes(type)) add('discount_type = ?', type);
  if (status && status !== 'all') add('LOWER(status) = ?', status.toLowerCase());
  if (seller === 'platform') where += ' AND seller_id IS NULL';
  else if (seller && seller !== 'all') add('seller_id = ?', seller);
  if (from) add(`COALESCE(expiry_date,'infinity'::timestamptz) >= ?::timestamptz`, from);
  if (to) add(`COALESCE(start_date,'-infinity'::timestamptz) <= ?::timestamptz`, to);

  const [rows, count] = await Promise.all([
    q(`${LIST_BASE} SELECT * FROM base ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]),
    q(`${LIST_BASE} SELECT COUNT(*) FROM base ${where}`, params),
  ]);
  return sendSuccess(res, 200, 'Coupons', {
    coupons: rows.map(couponShape),
    total: n(count[0].count),
    page,
    limit,
  });
}));

router.post('/', wrap(async (req, res) => {
  const fields = couponFields(req.body);
  await assertCampaign(fields.campaignId);
  const rows = await q(
    `INSERT INTO coupons (code,discount_percent,discount_type,discount_value,max_discount,min_order_amount,usage_limit,per_user_limit,
       start_date,expiry_date,admin_status,is_active,campaign_id,description,seller_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15) RETURNING id`,
    [fields.code, fields.type === 'percentage' ? fields.value : 0, fields.type, fields.value, fields.max, fields.min,
      fields.usage, fields.perUser, fields.start, fields.end, fields.status, fields.status === 'active',
      fields.campaignId, fields.description, req.user.id]
  );
  await audit(req, 'COUPON_CREATED', 'coupon', rows[0].id, { code: fields.code, type: fields.type });
  return sendSuccess(res, 201, 'Coupon created', { id: rows[0].id });
}));

router.get('/:id', wrap(async (req, res) => {
  const coupon = (await q(`${LIST_BASE} SELECT * FROM base WHERE id=$1`, [req.params.id]))[0];
  if (!coupon) throw httpErr(404, 'Coupon not found');
  const [history, totals] = await Promise.all([
    q(`SELECT r.discount_amount, r.order_total, r.created_at, u.first_name||' '||u.last_name buyer,
              COALESCE('MMX-'||o.order_number::text,'#'||UPPER(LEFT(o.id::text,8))) order_no
       FROM coupon_redemptions r JOIN users u ON u.id=r.user_id JOIN orders o ON o.id=r.order_id
       WHERE r.coupon_id=$1 ORDER BY r.created_at DESC LIMIT 20`, [req.params.id]),
    q(`SELECT COUNT(*) cnt, COALESCE(SUM(discount_amount),0) discounts, COALESCE(SUM(order_total),0) revenue
       FROM coupon_redemptions WHERE coupon_id=$1`, [req.params.id]),
  ]);
  return sendSuccess(res, 200, 'Coupon', {
    coupon: couponShape(coupon),
    stats: { redemptions: n(totals[0].cnt), discounts: n(totals[0].discounts), revenue: n(totals[0].revenue) },
    history: history.map(row => ({
      buyer: row.buyer,
      orderNo: row.order_no,
      discount: n(row.discount_amount),
      orderTotal: n(row.order_total),
      at: row.created_at,
    })),
  });
}));

router.put('/:id', wrap(async (req, res) => {
  const fields = couponFields(req.body);
  await assertCampaign(fields.campaignId);
  const rows = await q(
    `UPDATE coupons SET code = CASE WHEN COALESCE(used_count,0)=0 THEN $1 ELSE code END,
       discount_percent=$2, discount_type=$3, discount_value=$4, max_discount=$5, min_order_amount=$6,
       usage_limit=$7, per_user_limit=$8, start_date=$9, expiry_date=$10, admin_status=$11, is_active=$12,
       campaign_id=$13, description=$14, updated_at=NOW()
     WHERE id=$15 AND is_deleted=false RETURNING id`,
    [fields.code, fields.type === 'percentage' ? fields.value : 0, fields.type, fields.value, fields.max, fields.min,
      fields.usage, fields.perUser, fields.start, fields.end, fields.status, fields.status === 'active',
      fields.campaignId, fields.description, req.params.id]
  );
  if (!rows.length) throw httpErr(404, 'Coupon not found');
  await audit(req, 'COUPON_UPDATED', 'coupon', req.params.id, { code: fields.code });
  return sendSuccess(res, 200, 'Coupon saved');
}));

router.post('/:id/toggle', wrap(async (req, res) => {
  const rows = await q(
    `UPDATE coupons SET admin_status = CASE WHEN admin_status='active' THEN 'disabled' ELSE 'active' END,
       is_active = (admin_status <> 'active'), updated_at=NOW()
     WHERE id=$1 AND is_deleted=false RETURNING admin_status, code`,
    [req.params.id]
  );
  if (!rows.length) throw httpErr(404, 'Coupon not found');
  await audit(req, 'COUPON_UPDATED', 'coupon', req.params.id, { code: rows[0].code, adminStatus: rows[0].admin_status });
  return sendSuccess(res, 200, rows[0].admin_status === 'active' ? 'Coupon enabled' : 'Coupon disabled');
}));

router.post('/:id/duplicate', wrap(async (req, res) => {
  const source = (await q(`SELECT * FROM coupons WHERE id=$1 AND is_deleted=false`, [req.params.id]))[0];
  if (!source) throw httpErr(404, 'Coupon not found');
  let code = `${source.code}-COPY`.slice(0, 30);
  let suffix = 1;
  while ((await q(`SELECT 1 FROM coupons WHERE UPPER(code)=UPPER($1)`, [code])).length) {
    code = `${source.code.slice(0, 24)}-C${++suffix}`;
  }
  const rows = await q(
    `INSERT INTO coupons (code,discount_percent,discount_type,discount_value,max_discount,min_order_amount,usage_limit,per_user_limit,
       start_date,expiry_date,admin_status,is_active,campaign_id,description,seller_id,product_id,created_by,used_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',false,$11,$12,$13,$14,$15,0) RETURNING id`,
    [code, source.discount_percent, source.discount_type, source.discount_value, source.max_discount, source.min_order_amount,
      source.usage_limit, source.per_user_limit, source.start_date, source.expiry_date, source.campaign_id,
      source.description, source.seller_id, source.product_id, req.user.id]
  );
  await audit(req, 'COUPON_CREATED', 'coupon', rows[0].id, { code, duplicatedFrom: source.code });
  return sendSuccess(res, 201, 'Coupon duplicated as draft', { id: rows[0].id, code });
}));

router.delete('/:id', wrap(async (req, res) => {
  const rows = await q(
    `UPDATE coupons SET is_deleted=true, is_active=false,
       code = code || '--deleted-' || EXTRACT(EPOCH FROM NOW())::bigint::text, updated_at=NOW()
     WHERE id=$1 AND is_deleted=false RETURNING code`,
    [req.params.id]
  );
  if (!rows.length) throw httpErr(404, 'Coupon not found');
  await audit(req, 'COUPON_DELETED', 'coupon', req.params.id, { code: rows[0].code });
  return sendSuccess(res, 200, 'Coupon deleted');
}));

module.exports = router;
