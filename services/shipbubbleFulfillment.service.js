const db = require('../config/db');
const shipbubble = require('../adapter/shipbubble.adapter');

async function bookShipbubbleShipmentsForOrder(orderId) {
  const o = (await db.query(
    `SELECT a.full_name, a.phone, a.address_line1, a.city, a.state
     FROM orders ord LEFT JOIN addresses a ON a.id = ord.address_id WHERE ord.id = $1`, [orderId]
  )).rows[0];
  if (!o) return;

  const vendorOrders = await db.query(
    `SELECT id, seller_id FROM vendor_orders WHERE order_id = $1 AND tracking_code IS NULL`, [orderId]
  );

  for (const vo of vendorOrders.rows) {
    try {
      const items = (await db.query(
        `SELECT oi.quantity, oi.price_at_purchase AS price, p.weight_kg, p.name
         FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.vendor_order_id = $1`, [vo.id]
      )).rows.map(r => ({ ...r, seller_id: vo.seller_id }));

      const quotes = await shipbubble.getQuotes(orderId, items, o, vo.seller_id);
      if (!quotes.length) throw new Error('No shipbubble quotes available');
      const cheapest = quotes.sort((a, b) => a.fee - b.fee)[0];
      const requestToken = cheapest.quoteReference.split('-').pop();

      const booking = await shipbubble.bookShipment({
        requestToken, courierId: cheapest.courierId, serviceCode: cheapest.serviceCode,
      });

      await db.query(
        `UPDATE vendor_orders SET tracking_code=$1, courier_name=$2, shipment_status='pending', updated_at=NOW() WHERE id=$3`,
        [booking.trackingNumber, booking.courierName, vo.id]
      );
      await db.query(
        `INSERT INTO notifications (user_id, title, message, type, is_read, is_deleted, created_at, updated_at)
         VALUES ($1,'Courier Assigned',$2,'order',FALSE,FALSE,NOW(),NOW())`,
        [vo.seller_id, `Tracking #${booking.trackingNumber} generated via Shipbubble.`]
      );
    } catch (err) {
      console.error(`Shipbubble booking failed for vendor_order ${vo.id}:`, err.message);
    }
  }
}
module.exports = { bookShipbubbleShipmentsForOrder };