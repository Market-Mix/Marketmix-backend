const express = require('express');
const multer = require('multer');
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { logAudit } = require('../utils/audit');
const { slugify } = require('../utils/slugify');

const router = express.Router();
router.use(protect, isAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => f.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')) });
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => async (req, res) => { try { return await fn(req, res); } catch (e) { return sendError(res, e.status || 500, e.message); } };
const audit = (req, action, type, id, meta) => logAudit(req.user.id, action, type, id, meta);
const STATUSES = ['draft', 'published', 'scheduled', 'hidden'];
const safeLink = l => { l = (l || '').trim(); if (/^\s*(javascript|data):/i.test(l)) throw httpErr(400, 'Invalid link'); return l || null; };

async function uniqueSlug(table, base, excludeId = null) {
  const root = slugify(base) || 'item'; let s = root, i = 0;
  while ((await db.query(`SELECT 1 FROM ${table} WHERE slug=$1 AND is_deleted=false AND ($2::uuid IS NULL OR id<>$2)`, [s, excludeId])).rows.length)
    s = `${root}-${++i}`;
  return s;
}
const uploadImg = (file, folder) => uploadToCloudinary(file.buffer, file.mimetype, folder);

router.post('/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpErr(400, 'No file provided');
  return sendSuccess(res, 200, 'Uploaded', { url: await uploadImg(req.file, 'cms') });
}));

router.get('/summary', wrap(async (req, res) => {
  const r = (await db.query(`SELECT
    (SELECT COUNT(*) FROM cms_pages WHERE NOT is_deleted) total_pages,
    (SELECT COUNT(*) FROM cms_pages WHERE NOT is_deleted AND status='published') published,
    (SELECT COUNT(*) FROM cms_pages WHERE NOT is_deleted AND status='draft') drafts,
    (SELECT COUNT(*) FROM cms_pages WHERE NOT is_deleted AND status='scheduled') scheduled,
    (SELECT COUNT(*) FROM cms_pages WHERE NOT is_deleted AND status='published' AND updated_at::date=CURRENT_DATE) published_today,
    (SELECT COUNT(*) FROM cms_sections WHERE is_enabled) sections,
    (SELECT COUNT(*) FROM cms_banners WHERE NOT is_deleted AND is_active AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW())) active_banners,
    (SELECT COUNT(*) FROM blog_posts WHERE NOT is_deleted AND status='published') posts,
    GREATEST((SELECT MAX(updated_at) FROM cms_pages),(SELECT MAX(updated_at) FROM blog_posts),(SELECT MAX(updated_at) FROM cms_banners)) last_updated`)).rows[0];
  const n = k => +r[k] || 0;
  return sendSuccess(res, 200, 'Summary', { totalPages: n('total_pages'), published: n('published'), drafts: n('drafts'),
    scheduled: n('scheduled'), publishedToday: n('published_today'), sections: n('sections'),
    activeBanners: n('active_banners'), posts: n('posts'), lastUpdated: r.last_updated });
}));

router.get('/activity', wrap(async (req, res) => {
  const r = await db.query(
    `SELECT a.action, a.metadata, a.created_at, COALESCE(u.first_name||' '||u.last_name,u.email,'Admin') actor
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.action LIKE 'CMS_%' ORDER BY a.created_at DESC LIMIT 10`);
  return sendSuccess(res, 200, 'Activity', { activity: r.rows.map(x => {
    const m = typeof x.metadata === 'string' ? JSON.parse(x.metadata) : (x.metadata || {});
    return { text: `${x.action.replace('CMS_', '').replace(/_/g, ' ').toLowerCase()}${m.title ? ': ' + m.title : ''} by ${x.actor}`, at: x.created_at };
  }) });
}));

const pageShape = r => ({ id: r.id, title: r.title, slug: r.slug, category: r.category, content: r.content, status: r.status,
  visibility: r.visibility, metaTitle: r.meta_title, metaDescription: r.meta_description, keywords: r.keywords,
  featuredImageUrl: r.featured_image_url, publishAt: r.publish_at, updatedAt: r.updated_at, updatedBy: r.updated_by_name || '—' });
const PAGE_SEL = `SELECT p.*, TRIM(COALESCE(u.first_name||' '||u.last_name,u.email)) updated_by_name
                  FROM cms_pages p LEFT JOIN users u ON u.id=p.updated_by`;

function pageFields(b) {
  const title = (b.title || '').trim();
  if (title.length < 2) throw httpErr(400, 'Title is required');
  const status = STATUSES.includes(b.status) ? b.status : 'draft';
  let publishAt = null;
  if (status === 'scheduled') { publishAt = new Date(b.publishAt); if (isNaN(publishAt)) throw httpErr(400, 'Pick a valid publish date'); }
  return { title, status, publishAt, visibility: b.visibility === 'private' ? 'private' : 'public',
    category: (b.category || 'Info').trim().slice(0, 40), content: b.content || '',
    metaTitle: (b.metaTitle || '').trim() || null, metaDescription: (b.metaDescription || '').trim() || null,
    keywords: (b.keywords || '').trim() || null, featuredImageUrl: b.featuredImageUrl || null };
}

router.get('/pages', wrap(async (req, res) => {
  const r = await db.query(`${PAGE_SEL} WHERE NOT p.is_deleted ORDER BY p.updated_at DESC`);
  return sendSuccess(res, 200, 'Pages', { pages: r.rows.map(pageShape) });
}));

router.post('/pages', wrap(async (req, res) => {
  const f = pageFields(req.body);
  const slug = await uniqueSlug('cms_pages', req.body.slug || f.title);
  const r = await db.query(
    `INSERT INTO cms_pages (title,slug,category,content,meta_title,meta_description,keywords,featured_image_url,status,visibility,publish_at,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [f.title, slug, f.category, f.content, f.metaTitle, f.metaDescription, f.keywords, f.featuredImageUrl, f.status, f.visibility, f.publishAt, req.user.id]);
  await audit(req, 'CMS_PAGE_CREATED', 'cms_page', r.rows[0].id, { title: f.title, status: f.status });
  return sendSuccess(res, 201, 'Page created', { id: r.rows[0].id });
}));

router.put('/pages/:id', wrap(async (req, res) => {
  const f = pageFields(req.body);
  const slug = await uniqueSlug('cms_pages', req.body.slug || f.title, req.params.id);
  const r = await db.query(
    `UPDATE cms_pages SET title=$1,slug=$2,category=$3,content=$4,meta_title=$5,meta_description=$6,keywords=$7,
       featured_image_url=COALESCE($8,featured_image_url),status=$9,visibility=$10,publish_at=$11,updated_by=$12,updated_at=NOW()
     WHERE id=$13 AND NOT is_deleted RETURNING id`,
    [f.title, slug, f.category, f.content, f.metaTitle, f.metaDescription, f.keywords, f.featuredImageUrl, f.status, f.visibility, f.publishAt, req.user.id, req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Page not found');
  await audit(req, 'CMS_PAGE_UPDATED', 'cms_page', req.params.id, { title: f.title, status: f.status });
  return sendSuccess(res, 200, 'Page saved');
}));

router.post('/pages/:id/duplicate', wrap(async (req, res) => {
  const src = (await db.query(`SELECT * FROM cms_pages WHERE id=$1 AND NOT is_deleted`, [req.params.id])).rows[0];
  if (!src) throw httpErr(404, 'Page not found');
  const title = `${src.title} (Copy)`;
  const r = await db.query(
    `INSERT INTO cms_pages (title,slug,category,content,meta_title,meta_description,keywords,featured_image_url,status,visibility,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10) RETURNING id`,
    [title, await uniqueSlug('cms_pages', title), src.category, src.content, src.meta_title, src.meta_description, src.keywords, src.featured_image_url, src.visibility, req.user.id]);
  await audit(req, 'CMS_PAGE_DUPLICATED', 'cms_page', r.rows[0].id, { title });
  return sendSuccess(res, 201, 'Duplicated', { id: r.rows[0].id });
}));

router.delete('/pages/:id', wrap(async (req, res) => {
  const r = await db.query(`UPDATE cms_pages SET is_deleted=true,updated_at=NOW() WHERE id=$1 AND NOT is_deleted RETURNING title`, [req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Page not found');
  await audit(req, 'CMS_PAGE_DELETED', 'cms_page', req.params.id, { title: r.rows[0].title });
  return sendSuccess(res, 200, 'Page deleted');
}));

router.get('/sections', wrap(async (req, res) => {
  const r = await db.query(`SELECT key,label,is_enabled FROM cms_sections ORDER BY sort_order`);
  return sendSuccess(res, 200, 'Sections', { sections: r.rows.map(s => ({ key: s.key, label: s.label, isEnabled: s.is_enabled })) });
}));
router.put('/sections/:key', wrap(async (req, res) => {
  const r = await db.query(`UPDATE cms_sections SET is_enabled=$1 WHERE key=$2 RETURNING label`, [!!req.body.isEnabled, req.params.key]);
  if (!r.rows.length) throw httpErr(404, 'Section not found');
  await audit(req, 'CMS_SECTION_TOGGLED', 'cms_section', null, { title: `${r.rows[0].label} ${req.body.isEnabled ? 'on' : 'off'}` });
  return sendSuccess(res, 200, 'Section updated');
}));

const bannerShape = r => {
  const now = Date.now(), s = r.starts_at && new Date(r.starts_at), e = r.ends_at && new Date(r.ends_at);
  const status = !r.is_active ? 'Inactive' : (s && s > now) ? 'Scheduled' : (e && e < now) ? 'Expired' : 'Active';
  return { id: r.id, title: r.title, imageUrl: r.image_url, linkUrl: r.link_url, location: r.location,
    startsAt: r.starts_at, endsAt: r.ends_at, isActive: r.is_active, sortOrder: r.sort_order, status };
};
const LOCATIONS = ['homepage_hero', 'category_sidebar'];

function bannerFields(b) {
  const title = (b.title || '').trim(); if (!title) throw httpErr(400, 'Title is required');
  const d = v => v ? new Date(v) : null;
  const startsAt = d(b.startsAt), endsAt = d(b.endsAt);
  if (startsAt && endsAt && endsAt < startsAt) throw httpErr(400, 'End date must be after start date');
  return { title, linkUrl: safeLink(b.linkUrl), startsAt, endsAt,
    location: LOCATIONS.includes(b.location) ? b.location : 'homepage_hero',
    isActive: b.isActive !== 'false' && b.isActive !== false, sortOrder: parseInt(b.sortOrder) || 0 };
}

router.get('/banners', wrap(async (req, res) => {
  const r = await db.query(`SELECT * FROM cms_banners WHERE NOT is_deleted ORDER BY location, sort_order, created_at DESC`);
  return sendSuccess(res, 200, 'Banners', { banners: r.rows.map(bannerShape) });
}));

router.post('/banners', upload.single('image'), wrap(async (req, res) => {
  const f = bannerFields(req.body);
  if (!req.file) throw httpErr(400, 'Banner image is required');
  const url = await uploadImg(req.file, 'cms-banners');
  const r = await db.query(
    `INSERT INTO cms_banners (title,image_url,link_url,location,starts_at,ends_at,is_active,sort_order,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [f.title, url, f.linkUrl, f.location, f.startsAt, f.endsAt, f.isActive, f.sortOrder, req.user.id]);
  await audit(req, 'CMS_BANNER_CREATED', 'cms_banner', r.rows[0].id, { title: f.title });
  return sendSuccess(res, 201, 'Banner created', { id: r.rows[0].id });
}));

router.put('/banners/:id', upload.single('image'), wrap(async (req, res) => {
  const f = bannerFields(req.body);
  const url = req.file ? await uploadImg(req.file, 'cms-banners') : null;
  const r = await db.query(
    `UPDATE cms_banners SET title=$1,image_url=COALESCE($2,image_url),link_url=$3,location=$4,starts_at=$5,ends_at=$6,
       is_active=$7,sort_order=$8,updated_at=NOW() WHERE id=$9 AND NOT is_deleted RETURNING id`,
    [f.title, url, f.linkUrl, f.location, f.startsAt, f.endsAt, f.isActive, f.sortOrder, req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Banner not found');
  await audit(req, 'CMS_BANNER_UPDATED', 'cms_banner', req.params.id, { title: f.title });
  return sendSuccess(res, 200, 'Banner saved');
}));

router.delete('/banners/:id', wrap(async (req, res) => {
  const r = await db.query(`UPDATE cms_banners SET is_deleted=true,updated_at=NOW() WHERE id=$1 AND NOT is_deleted RETURNING title`, [req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Banner not found');
  await audit(req, 'CMS_BANNER_DELETED', 'cms_banner', req.params.id, { title: r.rows[0].title });
  return sendSuccess(res, 200, 'Banner deleted');
}));

const postShape = r => ({ id: r.id, title: r.title, slug: r.slug, excerpt: r.excerpt, content: r.content,
  coverImageUrl: r.cover_image_url, authorName: r.author_name, status: r.status, publishedAt: r.published_at, updatedAt: r.updated_at });

function postFields(b) {
  const title = (b.title || '').trim(), content = (b.content || '').trim();
  if (title.length < 3) throw httpErr(400, 'Title must be at least 3 characters');
  if (content.length < 20) throw httpErr(400, 'Content is too short');
  const status = ['draft', 'published', 'scheduled'].includes(b.status) ? b.status : 'draft';
  let publishedAt = null;
  if (status === 'scheduled') { publishedAt = new Date(b.publishedAt); if (isNaN(publishedAt)) throw httpErr(400, 'Pick a valid publish date'); }
  return { title, content, status, publishedAt, excerpt: (b.excerpt || '').trim().slice(0, 300) || content.slice(0, 150),
    authorName: (b.authorName || 'MarketMix Team').trim().slice(0, 80) };
}

router.get('/blog', wrap(async (req, res) => {
  const r = await db.query(`SELECT * FROM blog_posts WHERE NOT is_deleted ORDER BY COALESCE(published_at,created_at) DESC`);
  return sendSuccess(res, 200, 'Posts', { posts: r.rows.map(postShape) });
}));

router.post('/blog', upload.single('cover'), wrap(async (req, res) => {
  const f = postFields(req.body);
  const cover = req.file ? await uploadImg(req.file, 'blog') : null;
  const pubAt = f.status === 'published' ? new Date() : f.status === 'scheduled' ? f.publishedAt : null;
  const r = await db.query(
    `INSERT INTO blog_posts (title,slug,excerpt,content,cover_image_url,author_name,status,published_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [f.title, await uniqueSlug('blog_posts', f.title), f.excerpt, f.content, cover, f.authorName, f.status, pubAt, req.user.id]);
  await audit(req, 'CMS_BLOG_CREATED', 'blog_post', r.rows[0].id, { title: f.title, status: f.status });
  return sendSuccess(res, 201, 'Post created', { id: r.rows[0].id });
}));

router.put('/blog/:id', upload.single('cover'), wrap(async (req, res) => {
  const f = postFields(req.body);
  const cover = req.file ? await uploadImg(req.file, 'blog') : null;
  const pubAt = f.status === 'published' ? new Date() : f.status === 'scheduled' ? f.publishedAt : null;
  const r = await db.query(
    `UPDATE blog_posts SET title=$1,excerpt=$2,content=$3,cover_image_url=COALESCE($4,cover_image_url),author_name=$5,status=$6,
       published_at=$7, updated_at=NOW() WHERE id=$8 AND NOT is_deleted RETURNING id`,
    [f.title, f.excerpt, f.content, cover, f.authorName, f.status, pubAt, req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Post not found');
  await audit(req, 'CMS_BLOG_UPDATED', 'blog_post', req.params.id, { title: f.title, status: f.status });
  return sendSuccess(res, 200, 'Post saved');
}));

router.delete('/blog/:id', wrap(async (req, res) => {
  const r = await db.query(`UPDATE blog_posts SET is_deleted=true,updated_at=NOW() WHERE id=$1 AND NOT is_deleted RETURNING title`, [req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Post not found');
  await audit(req, 'CMS_BLOG_DELETED', 'blog_post', req.params.id, { title: r.rows[0].title });
  return sendSuccess(res, 200, 'Post deleted');
}));

module.exports = router;
