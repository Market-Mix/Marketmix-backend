// routes/sendbox_webhook.routes.js  (NEW FILE)
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { notifyBuyer } = require('../utils/sellerEmailService');

router.post('/', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const { code, status, status_code, courier } = req.body;
    if (!code) return;
    const newStatusCode = status_code || status?.code;

    const voRes = await db.query(
      `SELECT vo.id, vo.order_id, o.buyer_id FROM vendor_orders vo
       JOIN orders o ON o.id = vo.order_id WHERE vo.tracking_code = $1`, [code]
    );
    if (!voRes.rows.length) return;
    const vo = voRes.rows[0];

    await db.query(
      `UPDATE vendor_orders SET shipment_status=$1, courier_name=COALESCE($2,courier_name), updated_at=NOW() WHERE id=$3`,
      [newStatusCode, courier?.name, vo.id]
    );

    const map = { picked_up: 'shipped', in_transit: 'shipped', delivered: 'delivered' };
    const orderStatus = map[newStatusCode];
    if (orderStatus) {
      await db.query(
        `UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 AND status NOT IN ('delivered','cancelled')`,
        [orderStatus, vo.order_id]
      );
      if (orderStatus === 'delivered') notifyBuyer(vo.buyer_id, 'orderDelivered', { orderId: vo.order_id }).catch(()=>{});
      if (orderStatus === 'shipped')   notifyBuyer(vo.buyer_id, 'orderShipped', { orderId: vo.order_id, trackingId: code, courierName: courier?.name }).catch(()=>{});
    }
  } catch (e) { console.error('Sendbox webhook error:', e.message); }
});
module.exports = router;