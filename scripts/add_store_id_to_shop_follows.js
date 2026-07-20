// scripts/add_store_id_to_shop_follows.js
require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`ALTER TABLE shop_follows ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);`);

  // Backfill existing follows to each seller's primary store
  await db.query(`
    UPDATE shop_follows sf SET store_id = s.id
    FROM stores s
    WHERE s.user_id = sf.seller_id AND s.store_number = 1 AND sf.store_id IS NULL;
  `);

  // Drop old (buyer_id, seller_id) unique constraint — it would block following a 2nd store
  await db.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'shop_follows'::regclass AND contype = 'u'
      LOOP EXECUTE format('ALTER TABLE shop_follows DROP CONSTRAINT %I', r.conname); END LOOP;
    END $$;
  `);

  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS shop_follows_buyer_store_uidx ON shop_follows(buyer_id, store_id);`);
  console.log('✅ done'); await db.closePool(); process.exit();
})();