const crypto = require('crypto');

router.post('/', express.json(), async (req, res) => {
  const signature = req.headers['x-ship-signature'];
  const key = process.env.SHIPBUBBLE_API_KEY; // use test/live key as signing secret
  if (signature && key) {
    const expected = crypto.createHmac('sha512', key).update(JSON.stringify(req.body)).digest('hex');
    if (signature !== expected) {
      console.warn('Shipbubble signature mismatch — proceeding anyway, verify key source');
    }
  }

  res.status(200).json({ received: true }); // ack within 15s

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
    const orderStatus = map[status];
    if (orderStatus) {
      await db.query(`UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 AND status NOT IN ('delivered','cancelled')`, [orderStatus, vo.order_id]);
      if (orderStatus === 'delivered') notifyBuyer(vo.buyer_id, 'orderDelivered', { orderId: vo.order_id }).catch(()=>{});
      if (orderStatus === 'shipped') notifyBuyer(vo.buyer_id, 'orderShipped', { orderId: vo.order_id, trackingId: order_id, courierName: courier?.name }).catch(()=>{});
    }
  } catch (e) { console.error('Shipbubble webhook error:', e.message); }
});