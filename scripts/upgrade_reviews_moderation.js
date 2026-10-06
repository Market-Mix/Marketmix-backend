require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    await db.query(`
      ALTER TABLE reviews
        ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(12),
        ADD COLUMN IF NOT EXISTS admin_notes TEXT,
        ADD COLUMN IF NOT EXISTS moderated_by UUID,
        ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;

      UPDATE reviews SET moderation_status =
        CASE WHEN is_deleted THEN 'removed' WHEN is_approved THEN 'published' ELSE 'pending' END
      WHERE moderation_status IS NULL;

      CREATE OR REPLACE FUNCTION reviews_set_moderation() RETURNS trigger AS $$
      BEGIN
        IF NEW.moderation_status IS NULL THEN
          NEW.moderation_status := CASE WHEN NEW.is_approved THEN 'published' ELSE 'pending' END;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_reviews_moderation ON reviews;
      CREATE TRIGGER trg_reviews_moderation BEFORE INSERT ON reviews
        FOR EACH ROW EXECUTE FUNCTION reviews_set_moderation();

      CREATE TABLE IF NOT EXISTS review_moderation_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        admin_id UUID REFERENCES users(id),
        action VARCHAR(30) NOT NULL,
        from_status VARCHAR(12), to_status VARCHAR(12), note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_rml_review ON review_moderation_log(review_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reviews_mod ON reviews(moderation_status, is_deleted);
    `);
    console.log('✅ reviews moderation ready');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await db.closePool();
  }
})();
