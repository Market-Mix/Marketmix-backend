require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('🔧 Seed test orders script started');

    // Find a buyer user
    let res = await db.query("SELECT id, role, email FROM users WHERE role = 'buyer' LIMIT 1");
    let buyerId;
    if (res.rows.length > 0) {
      buyerId = res.rows[0].id;
      console.log('Found buyer:', res.rows[0]);
    } else {
      // fallback to any user
      res = await db.query('SELECT id, email FROM users LIMIT 1');
      if (res.rows.length === 0) throw new Error('No users found in users table. Cannot assign buyer_id');
      buyerId = res.rows[0].id;
      console.log('No buyer role found; using first user as buyer:', res.rows[0]);
    }

    // Pick some products to include in orders
    const productsRes = await db.query('SELECT id, price, name FROM products WHERE is_deleted = FALSE LIMIT 4');
    if (productsRes.rows.length === 0) throw new Error('No products found to seed orders');
    const products = productsRes.rows;
    console.log(`Found ${products.length} products to use in orders`);

    // Create several orders with different statuses
    const ordersToCreate = [
      { status: 'pending', items: [{ product: products[0], qty: 1 }] },
      { status: 'shipped', items: [{ product: products[1] || products[0], qty: 2 }] },
      { status: 'delivered', items: [{ product: products[2] || products[0], qty: 1 }, { product: products[3] || products[0], qty: 1 }] },
      { status: 'cancelled', items: [{ product: products[0], qty: 3 }] }
    ];

    const insertedOrders = [];

    await db.transaction(async (client) => {
      for (const ord of ordersToCreate) {
        // Calculate total
        let total = 0;
        for (const it of ord.items) total += (it.product.price || 0) * (it.qty || 1);

        // Try inserting with user_id first, then buyer_id if that column exists
        let orderInsert;
        try {
          orderInsert = await client.query(
            `INSERT INTO orders (user_id, total_amount, status, shipping_address, payment_method, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, user_id, total_amount, status, created_at`,
            [buyerId, total, ord.status, 'Seeded address', 'seed', 'Seeded order']
          );
        } catch (e) {
          // fallback to buyer_id if user_id column doesn't exist
          console.log('Insert with user_id failed, trying buyer_id insert (this is expected on some schemas)');
          orderInsert = await client.query(
            `INSERT INTO orders (buyer_id, total_amount, status, shipping_address, payment_method, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, buyer_id, total_amount, status, created_at`,
            [buyerId, total, ord.status, 'Seeded address', 'seed', 'Seeded order']
          );
        }

        const orderRow = orderInsert.rows[0];
        // Insert order items
        for (const it of ord.items) {
          await client.query(
            `INSERT INTO order_items (order_id, product_id, quantity, price, product_name)
             VALUES ($1, $2, $3, $4, $5)`,
            [orderRow.id, it.product.id, it.qty, it.product.price, it.product.name]
          );
        }

        insertedOrders.push({ order: orderRow, items: ord.items.map(i => ({ id: i.product.id, qty: i.qty })) });
      }
    });

    console.log('✅ Seeded orders:', insertedOrders);

  } catch (err) {
    console.error('Seeding error:', err && err.message ? err.message : err);
  } finally {
    if (db && db.closePool) await db.closePool();
    process.exit();
  }
})();
