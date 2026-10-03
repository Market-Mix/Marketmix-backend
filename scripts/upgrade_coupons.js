require('dotenv').config();
const db = require('../config/db');

(async () => {
  try {
    await db.query(`
      ALTER TABLE coupons ALTER COLUMN seller_id DROP NOT NULL;
      ALTER TABLE coupons ALTER COLUMN discount_percent DROP NOT NULL;

      DO $$
      DECLARE
        constraint_row RECORD;
        code_type RECORD;
      BEGIN
        FOR constraint_row IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'coupons'::regclass
            AND contype = 'c'
            AND regexp_replace(lower(pg_get_constraintdef(oid)), '\\s+', '', 'g')
                ~ 'discount_percent>\\(?0'
        LOOP
          EXECUTE format('ALTER TABLE coupons DROP CONSTRAINT %I', constraint_row.conname);
        END LOOP;

        SELECT atttypid, atttypmod
        INTO code_type
        FROM pg_attribute
        WHERE attrelid = 'coupons'::regclass AND attname = 'code' AND NOT attisdropped;

        IF code_type.atttypid = 'character varying'::regtype
           AND code_type.atttypmod > 4
           AND code_type.atttypmod - 4 < 80 THEN
          ALTER TABLE coupons ALTER COLUMN code TYPE VARCHAR(80);
        END IF;
      END $$;

      ALTER TABLE coupons
        ADD COLUMN IF NOT EXISTS discount_type    VARCHAR(20) NOT NULL DEFAULT 'percentage',
        ADD COLUMN IF NOT EXISTS discount_value   NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS max_discount     NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS min_order_amount NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS per_user_limit   INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS start_date       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS admin_status     VARCHAR(10) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS campaign_id      UUID,
        ADD COLUMN IF NOT EXISTS description      TEXT,
        ADD COLUMN IF NOT EXISTS created_by       UUID,
        ADD COLUMN IF NOT EXISTS is_deleted       BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW();

      UPDATE coupons SET discount_value = discount_percent WHERE discount_value IS NULL;
      UPDATE coupons SET admin_status = CASE WHEN is_active THEN 'active' ELSE 'disabled' END;

      CREATE TABLE IF NOT EXISTS promotions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) NOT NULL,
        description TEXT,
        audience VARCHAR(20) NOT NULL DEFAULT 'all'
          CHECK (audience IN ('all','new_buyers','returning_buyers')),
        budget NUMERIC(14,2) DEFAULT 0,
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
        admin_status VARCHAR(10) NOT NULL DEFAULT 'draft'
          CHECK (admin_status IN ('draft','active','disabled')),
        created_by UUID,
        is_deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS coupon_redemptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        coupon_id UUID NOT NULL REFERENCES coupons(id),
        campaign_id UUID,
        order_id UUID NOT NULL,
        user_id UUID NOT NULL,
        discount_amount NUMERIC(12,2) NOT NULL,
        order_total NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (coupon_id, order_id)
      );

      CREATE INDEX IF NOT EXISTS idx_redemptions_coupon ON coupon_redemptions(coupon_id);
      CREATE INDEX IF NOT EXISTS idx_redemptions_campaign ON coupon_redemptions(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_redemptions_user ON coupon_redemptions(coupon_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_coupons_campaign ON coupons(campaign_id);
    `);
    console.log('Coupons upgraded');
  } catch (error) {
    console.error('Coupon migration failed:', error);
    process.exitCode = 1;
  } finally {
    await db.closePool();
  }
})();
