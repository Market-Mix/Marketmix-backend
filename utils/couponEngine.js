const db = require('../config/db');

const err = (status, message) => Object.assign(new Error(message), { status });
const r2 = value => Math.round((Number(value) || 0) * 100) / 100;

const COUPON_SQL = `
  SELECT c.*, p.admin_status AS campaign_status, p.audience AS campaign_audience,
         p.budget AS campaign_budget, p.start_date AS campaign_start, p.end_date AS campaign_end,
         COALESCE((SELECT SUM(discount_amount) FROM coupon_redemptions x WHERE x.campaign_id = c.campaign_id),0) AS campaign_spent
  FROM coupons c
  LEFT JOIN promotions p ON p.id = c.campaign_id AND p.is_deleted = false
  WHERE UPPER(c.code) = UPPER($1) AND c.is_active = true AND c.is_deleted = false
  LIMIT 1`;

async function validateCoupon(code, session, userId) {
  const coupon = (await db.query(COUPON_SQL, [String(code).trim()])).rows[0];
  if (!coupon) throw err(404, 'Invalid coupon code');
  const now = Date.now();
  const time = date => new Date(date).getTime();

  if (coupon.start_date && time(coupon.start_date) > now) throw err(400, 'This coupon is not active yet');
  if (coupon.expiry_date && time(coupon.expiry_date) < now) throw err(400, 'This coupon has expired');
  if (coupon.usage_limit > 0 && (coupon.used_count || 0) >= coupon.usage_limit) {
    throw err(400, 'This coupon has reached its usage limit');
  }

  if (coupon.campaign_status) {
    if (coupon.campaign_status !== 'active') throw err(400, 'This promotion is not active');
    if (coupon.campaign_start && time(coupon.campaign_start) > now) throw err(400, 'This promotion has not started');
    if (coupon.campaign_end && time(coupon.campaign_end) < now) throw err(400, 'This promotion has ended');
    if (Number(coupon.campaign_budget) > 0 && Number(coupon.campaign_spent) >= Number(coupon.campaign_budget)) {
      throw err(400, 'This promotion budget is exhausted');
    }
    if (coupon.campaign_audience !== 'all') {
      const paid = (await db.query(
        `SELECT 1 FROM orders WHERE buyer_id=$1 AND payment_status='paid' LIMIT 1`,
        [userId]
      )).rows.length > 0;
      if (coupon.campaign_audience === 'new_buyers' && paid) {
        throw err(400, 'This coupon is for new buyers only');
      }
      if (coupon.campaign_audience === 'returning_buyers' && !paid) {
        throw err(400, 'This coupon is for returning buyers only');
      }
    }
  }

  if (coupon.per_user_limit > 0) {
    const used = (await db.query(
      `SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id=$1 AND user_id=$2`,
      [coupon.id, userId]
    )).rows[0].count;
    if (Number(used) >= coupon.per_user_limit) throw err(400, 'You have already used this coupon');
  }

  const items = typeof session.items_snapshot === 'string'
    ? JSON.parse(session.items_snapshot)
    : (session.items_snapshot || []);
  const eligibleSubtotal = r2(items
    .filter(item =>
      (!coupon.seller_id || item.seller_id === coupon.seller_id) &&
      (!coupon.product_id || item.product_id === coupon.product_id)
    )
    .reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0));

  if (eligibleSubtotal <= 0) throw err(400, 'This coupon does not apply to the items in your cart');
  if (Number(coupon.min_order_amount) > 0 && eligibleSubtotal < Number(coupon.min_order_amount)) {
    throw err(400, `Minimum order of ₦${Number(coupon.min_order_amount).toLocaleString()} required`);
  }

  return { coupon, eligibleSubtotal };
}

function calcDiscount(coupon, eligibleSubtotal, shippingFee = 0) {
  const value = Number(coupon.discount_value ?? coupon.discount_percent) || 0;
  let discount = coupon.discount_type === 'fixed'
    ? Math.min(value, eligibleSubtotal)
    : coupon.discount_type === 'free_shipping'
      ? Number(shippingFee)
      : (eligibleSubtotal * value) / 100;

  if (coupon.discount_type !== 'fixed' && Number(coupon.max_discount) > 0) {
    discount = Math.min(discount, Number(coupon.max_discount));
  }
  if (Number(coupon.campaign_budget) > 0) {
    discount = Math.min(discount, Math.max(Number(coupon.campaign_budget) - Number(coupon.campaign_spent), 0));
  }
  return r2(discount);
}

async function recalcDiscount(session, shippingFee) {
  if (!session.coupon_code) return 0;
  try {
    const { coupon, eligibleSubtotal } = await validateCoupon(
      session.coupon_code,
      session,
      session.user_id
    );
    return calcDiscount(coupon, eligibleSubtotal, shippingFee);
  } catch (error) {
    if (error.status) return 0;
    throw error;
  }
}

async function recordRedemption(orderId) {
  await db.transaction(async client => {
    const order = (await client.query(
      `SELECT o.id, o.buyer_id, o.total_amount, cs.coupon_code, cs.coupon_discount
       FROM orders o JOIN checkout_sessions cs ON cs.id = o.checkout_session_id
       WHERE o.id=$1 AND cs.coupon_code IS NOT NULL AND cs.coupon_discount > 0`,
      [orderId]
    )).rows[0];
    if (!order) return;

    const coupon = (await client.query(
      `SELECT id, campaign_id FROM coupons WHERE UPPER(code)=UPPER($1) AND is_deleted=false`,
      [order.coupon_code]
    )).rows[0];
    if (!coupon) return;

    const inserted = await client.query(
      `INSERT INTO coupon_redemptions (coupon_id,campaign_id,order_id,user_id,discount_amount,order_total)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (coupon_id,order_id) DO NOTHING RETURNING id`,
      [coupon.id, coupon.campaign_id, order.id, order.buyer_id, order.coupon_discount, order.total_amount]
    );
    if (inserted.rows.length) {
      await client.query(
        `UPDATE coupons SET used_count = COALESCE(used_count,0)+1 WHERE id=$1`,
        [coupon.id]
      );
    }
  });
}

module.exports = { validateCoupon, calcDiscount, recalcDiscount, recordRedemption };
