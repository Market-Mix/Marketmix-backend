// routes/shipbubble_webhook.routes.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const { notifyBuyer } = require('../utils/sellerEmailService');

router.post('/', express.json(), async (req, res) => {
  const signature = req.headers['x-ship-signature'];
  const key = process.env.SHIPBUBBLE_API_KEY;
  if (signature && key) {
    const expected = crypto.createHmac('sha512', key).update(JSON.stringify(req.body)).digest('hex');
    if (signature !== expected) {
      console.warn('Shipbubble signature mismatch — proceeding anyway, verify key source');
    }
  }

  res.status(200).json({ received: true });

  try {
    const { order_id, status, courier } = req.body;
    if (!order_id) return;

    const voRes = await db.query(
      `SELECT vo.id, vo.order_id, o.buyer_id FROM vendor_orders vo
       JOIN orders o ON o.id = vo.order_id WHERE vo.tracking_code = $1`, [order_id]
    );
    if (!voRes.rows.length) return;
    const vo = voRes.rows[0];

    await db.query(`UPDATE vendor_orders SET shipment_status=$1, courier_name=COALESCE($2,courier_name), updated_at=NOW() WHERE id=$3`,
      [status, courier?.name, vo.id]);

    const map = { picked_up: 'shipped', in_transit: 'shipped', completed: 'delivered' };

    // after the vendor_orders UPDATE, before the orderStatus block
await db.query(
  `UPDATE orders SET
     tracking_id   = COALESCE($1, tracking_id),
     courier_name  = COALESCE($2, courier_name),
     tracking_link = COALESCE($3, tracking_link),
     updated_at    = NOW()
   WHERE id = $4`,
  [order_id, courier?.name, req.body.tracking_url || null, vo.order_id]
);

    const orderStatus = map[status];
    if (orderStatus) {
      await db.query(`UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 AND status NOT IN ('delivered','cancelled')`, [orderStatus, vo.order_id]);
      
      // seller notification — mirrors what updateSellerOrderStatus does manually
  const sellerRes = await db.query(`SELECT seller_id FROM vendor_orders WHERE id=$1`, [vo.id]);
  if (sellerRes.rows[0]) {
    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, is_read, is_deleted, created_at, updated_at)
       VALUES ($1,$2,$3,'order',FALSE,FALSE,NOW(),NOW())`,
      [sellerRes.rows[0].seller_id, `Order #${String(vo.order_id).slice(0,8)} ${orderStatus} by courier`,
       `Shipbubble courier updated this order to ${orderStatus}.`]
    );
  }
      if (orderStatus === 'delivered') notifyBuyer(vo.buyer_id, 'orderDelivered', { orderId: vo.order_id }).catch(()=>{});
      if (orderStatus === 'shipped') notifyBuyer(vo.buyer_id, 'orderShipped', { orderId: vo.order_id, trackingId: order_id, courierName: courier?.name }).catch(()=>{});
    }
  } catch (e) { console.error('Shipbubble webhook error:', e.message); }
});

module.exports = router;