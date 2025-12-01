require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    console.log('Looking for a seller account...');
    let res = await db.query("SELECT id, role, email FROM users WHERE role = 'seller' LIMIT 1");
    let sellerId;
    if (res.rows.length > 0) {
      sellerId = res.rows[0].id;
      console.log('Found seller:', res.rows[0]);
    } else {
      // fallback to any user
      res = await db.query('SELECT id, email FROM users LIMIT 1');
      if (res.rows.length === 0) throw new Error('No users found in users table. Cannot assign seller_id');
      sellerId = res.rows[0].id;
      console.log('No seller role found; using first user as seller:', res.rows[0]);
    }

    const products = [
      {
        name: 'Seed - Smartphone',
        description: 'A seeded smartphone for testing Add to Cart',
        price: 250.0,
        stock_quantity: 10,
        main_image_url: 'https://via.placeholder.com/300x300.png?text=Smartphone'
      },
      {
        name: 'Seed - Headphones',
        description: 'A seeded pair of headphones for testing',
        price: 50.0,
        stock_quantity: 25,
        main_image_url: 'https://via.placeholder.com/300x300.png?text=Headphones'
      }
    ];

    console.log('Seeding products...');
    const inserted = [];
    await db.transaction(async (client) => {
      for (const p of products) {
        const insertText = `INSERT INTO products (id, seller_id, category_id, name, description, price, stock_quantity, main_image_url, is_active, is_deleted, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, true, false, NOW(), NOW())
          RETURNING id, name`;
        const vals = [sellerId, null, p.name, p.description, p.price, p.stock_quantity, p.main_image_url];
        const r = await client.query(insertText, vals);
        inserted.push(r.rows[0]);
      }
    });

    console.log('Inserted products:', inserted);
  } catch (err) {
    console.error('Seeding error:', err && err.message ? err.message : err);
  } finally {
    if (db && db.closePool) await db.closePool();
    process.exit();
  }
})();
