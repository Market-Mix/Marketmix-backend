require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('🔧 Seed test orders script started');

    // Allow specifying target buyer via env var or CLI arg for precise seeding
    const targetBuyerIdEnv = process.env.BUYER_ID || null;
    const targetBuyerEmailEnv = process.env.BUYER_EMAIL || null;
    const cliArg = process.argv[2] || null; // optional CLI arg can be an email or id

    let buyerId = null;

    if (targetBuyerIdEnv || (cliArg && /^[0-9]+$/.test(cliArg))) {
      const idToUse = targetBuyerIdEnv || cliArg;
      const res = await db.query('SELECT id, role, email FROM users WHERE id = $1 LIMIT 1', [idToUse]);
      if (res.rows.length === 0) throw new Error(`No user found with id ${idToUse}`);
      buyerId = res.rows[0].id;
      console.log(`Using buyer by id: ${buyerId} (${res.rows[0].email || 'no-email'})`);
    } else if (targetBuyerEmailEnv || cliArg) {
      const emailToUse = targetBuyerEmailEnv || cliArg;
      const res = await db.query('SELECT id, role, email FROM users WHERE email = $1 LIMIT 1', [emailToUse]);
      if (res.rows.length === 0) throw new Error(`No user found with email ${emailToUse}`);
      buyerId = res.rows[0].id;
      console.log(`Using buyer by email: ${emailToUse} -> id ${buyerId}`);
    } else {
      // Default: pick first user with role buyer, otherwise first user
      let res = await db.query("SELECT id, role, email FROM users WHERE role = 'buyer' LIMIT 1");
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
    }

    // Pick some products to include in orders (need id, price, name, seller_id)
    const productsRes = await db.query('SELECT id, price, name, seller_id FROM products WHERE is_deleted = FALSE LIMIT 4');
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
    const failedInserts = [];

    // Insert each order one-by-one (no transaction) so failures don't abort entire batch
    for (const ord of ordersToCreate) {
      try {
        // Calculate total
        let total = 0;
        for (const it of ord.items) total += (it.product.price || 0) * (it.qty || 1);

        console.log(`\n📦 Inserting order with status="${ord.status}" for buyer_id=${buyerId}, total=${total}`);

        // Try inserting with user_id first, then buyer_id if that column exists
        let orderInsert;
        try {
          console.log('  → Attempting INSERT with user_id column...');
          orderInsert = await db.query(
            `INSERT INTO orders (user_id, total_amount, status, shipping_address, payment_method, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, user_id, total_amount, status, created_at`,
            [buyerId, total, ord.status, 'Seeded address', 'seed', 'Seeded order']
          );
          console.log('  ✅ INSERT with user_id succeeded');
        } catch (userIdErr) {
          console.log(`  ⚠️  user_id insert failed: ${userIdErr.message}`);
          console.log('  → Attempting INSERT with buyer_id column...');
          try {
            orderInsert = await db.query(
              `INSERT INTO orders (buyer_id, total_amount, status, shipping_address, payment_method, notes, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, buyer_id, total_amount, status, created_at`,
              [buyerId, total, ord.status, 'Seeded address', 'seed', 'Seeded order']
            );
            console.log('  ✅ INSERT with buyer_id succeeded');
          } catch (buyerIdErr) {
            console.log(`  ❌ FAILED: Both user_id and buyer_id inserts failed`);
            console.log(`     user_id error: ${userIdErr.message}`);
            console.log(`     buyer_id error: ${buyerIdErr.message}`);
            failedInserts.push({ status: ord.status, error: buyerIdErr.message });
            continue; // Skip to next order
          }
        }

        const orderRow = orderInsert.rows[0];
        console.log(`  ✅ Order created: id=${orderRow.id}`);

        // Insert order items one-by-one
        for (const it of ord.items) {
          try {
            console.log(`    → Inserting order_item: product_id=${it.product.id}, qty=${it.qty}, price_at_purchase=${it.product.price}`);
            await db.query(
              `INSERT INTO order_items (order_id, product_id, seller_id, quantity, price_at_purchase)
               VALUES ($1, $2, $3, $4, $5)`,
              [orderRow.id, it.product.id, it.product.seller_id, it.qty, it.product.price]
            );
            console.log(`    ✅ order_item inserted`);
          } catch (itemErr) {
            console.log(`    ❌ FAILED to insert order_item: ${itemErr.message}`);
            failedInserts.push({ type: 'order_item', orderId: orderRow.id, productId: it.product.id, error: itemErr.message });
          }
        }

        insertedOrders.push({ order: orderRow, items: ord.items.map(i => ({ id: i.product.id, qty: i.qty })) });

      } catch (err) {
        console.log(`\n❌ Unexpected error inserting order: ${err.message}`);
        console.log(err);
        failedInserts.push({ error: err.message, stack: err.stack });
      }
    }

    // Summary
    console.log(`\n\n📊 SEEDING SUMMARY:`);
    console.log(`   ✅ Successfully inserted: ${insertedOrders.length} orders`);
    console.log(`   ❌ Failed inserts: ${failedInserts.length}`);
    if (failedInserts.length > 0) {
      console.log(`\nFailed insert details:`);
      failedInserts.forEach((fail, i) => {
        console.log(`   [${i}] ${JSON.stringify(fail)}`);
      });
    }

    if (insertedOrders.length > 0) {
      console.log(`\n✅ Seeded orders summary:`, insertedOrders);
    }

  } catch (err) {
    console.error('Seeding error:', err && err.message ? err.message : err);
    console.error(err.stack);
  } finally {
    if (db && db.closePool) await db.closePool();
    process.exit(0);
  }
})();
