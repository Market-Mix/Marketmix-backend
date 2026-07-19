// scripts/backfill_slugs.js
require('dotenv').config();
const db = require('../config/db');
const { slugify, uniqueAccountSlug } = require('../utils/slugify');

(async () => {
  // 1. Backfill account_slug for all sellers missing one
  const users = await db.query(
    `SELECT id, first_name FROM users WHERE role='seller' AND account_slug IS NULL`
  );
  for (const u of users.rows) {
    const slug = await uniqueAccountSlug(db, u.first_name || 'seller');
    await db.query('UPDATE users SET account_slug=$1 WHERE id=$2', [slug, u.id]);
    console.log(`user ${u.id} → ${slug}`);
  }

  // 2. Backfill store slugs (unique per user via the composite index)
  const stores = await db.query(
    `SELECT id, user_id, business_name FROM stores WHERE slug IS NULL AND is_deleted=false`
  );
  for (const s of stores.rows) {
    let base = slugify(s.business_name || 'store');
    let candidate = base, i = 0;
    while (true) {
      const exists = await db.query(
        `SELECT 1 FROM stores WHERE user_id=$1 AND slug=$2 AND id != $3`,
        [s.user_id, candidate, s.id]
      );
      if (!exists.rows.length) break;
      i++; candidate = `${base}-${i}`;
    }
    await db.query('UPDATE stores SET slug=$1 WHERE id=$2', [candidate, s.id]);
    console.log(`store ${s.id} → ${candidate}`);
  }

  console.log('✅ backfill complete');
  await db.closePool(); process.exit();
})();