require('dotenv').config();
const db = require('../config/db');
(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cms_pages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(200) NOT NULL, slug VARCHAR(80) NOT NULL,
      category VARCHAR(40) DEFAULT 'Info', content TEXT DEFAULT '',
      meta_title VARCHAR(200), meta_description TEXT, keywords TEXT, featured_image_url TEXT,
      status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','scheduled','hidden')),
      visibility VARCHAR(8) NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
      publish_at TIMESTAMPTZ, updated_by UUID REFERENCES users(id),
      is_deleted BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS cms_pages_slug_uidx ON cms_pages(slug) WHERE is_deleted=false;

    CREATE TABLE IF NOT EXISTS cms_sections (
      key VARCHAR(30) PRIMARY KEY, label VARCHAR(60) NOT NULL,
      is_enabled BOOLEAN DEFAULT true, sort_order INT DEFAULT 0);
    INSERT INTO cms_sections (key,label,sort_order) VALUES
      ('hero','Hero Banner',1),('categories','Featured Categories',2),('products','Featured Products',3),
      ('sellers','Featured Sellers',4),('testimonials','Testimonials',5),('blog','Blog Section',6),
      ('newsletter','Newsletter',7),('footer','Footer',8) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS cms_banners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(120) NOT NULL, image_url TEXT NOT NULL, link_url TEXT,
      location VARCHAR(30) NOT NULL DEFAULT 'homepage_hero',
      starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true, sort_order INT DEFAULT 0, is_deleted BOOLEAN DEFAULT false,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS blog_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(200) NOT NULL, slug VARCHAR(80) NOT NULL,
      excerpt VARCHAR(300), content TEXT NOT NULL, cover_image_url TEXT,
      author_name VARCHAR(80) DEFAULT 'MarketMix Team',
      status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','scheduled')),
      published_at TIMESTAMPTZ, created_by UUID REFERENCES users(id),
      is_deleted BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS blog_slug_uidx ON blog_posts(slug) WHERE is_deleted=false;
  `);
  console.log('✅ CMS tables ready'); await db.closePool(); process.exit();
})();
