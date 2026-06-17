// services/sendboxFulfillment.service.js  (NEW FILE)
const db = require('../config/db');
const marketmixAdapter = require('../adapter/marketmix.adapter');

async function bookSendboxShipmentsForOrder(orderId) {
  const o = (await db.query(
    `SELECT a.full_name, a.phone, a.address_line1, a.city, a.state
     FROM orders ord LEFT JOIN addresses a ON a.id = ord.address_id
     WHERE ord.id = $1`, [orderId]
  )).rows[0];
  if (!o) return;

  const vendorOrders = await db.query(
    `SELECT id, seller_id FROM vendor_orders WHERE order_id = $1 AND tracking_code IS NULL`, [orderId]
  );

  for (const vo of vendorOrders.rows) {
    try {
      const items = (await db.query(
        `SELECT oi.quantity, oi.price_at_purchase, p.weight_kg, p.name
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         WHERE oi.vendor_order_id = $1`, [vo.id]
      )).rows;

      const booking = await marketmixAdapter.bookShipment('sendbox', { sellerId: vo.seller_id, address: o, items });

      await db.query(
        `UPDATE vendor_orders SET tracking_code=$1, courier_name=$2, sendbox_shipment_id=$3,
           shipment_status='pending', updated_at=NOW() WHERE id=$4`,
        [booking.trackingNumber, booking.courierName, booking.providerShipmentId, vo.id]
      );

      await db.query(
        `INSERT INTO notifications (user_id, title, message, type, is_read, is_deleted, created_at, updated_at)
         VALUES ($1,'Courier Assigned',$2,'order',FALSE,FALSE,NOW(),NOW())`,
        [vo.seller_id, `Tracking #${booking.trackingNumber} generated. Please pack the item — courier will pick up soon.`]
      );
    } catch (err) {
      console.error(`Sendbox booking failed for vendor_order ${vo.id}:`, err.message);
    }
  }
}
module.exports = { bookSendboxShipmentsForOrder };