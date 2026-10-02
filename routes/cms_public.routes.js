const express = require('express');
const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const router = express.Router();

const LIVE_POST = `(status='published' OR (status='scheduled' AND published_at<=NOW())) AND NOT is_deleted`;
const postPub = r => ({ title: r.title, slug: r.slug, excerpt: r.excerpt, coverImageUrl: r.cover_image_url,
  authorName: r.author_name, publishedAt: r.published_at || r.created_at, ...(r.content ? { content: r.content } : {}) });

router.get('/hero', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id,title,image_url,link_url FROM cms_banners
       WHERE location='homepage_hero' AND NOT is_deleted AND is_active
         AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW())
       ORDER BY sort_order, created_at DESC LIMIT 10`);
    return sendSuccess(res, 200, 'Hero', { slides: r.rows.map(b => ({ id: b.id, title: b.title, imageUrl: b.image_url, linkUrl: b.link_url })) });
  } catch (e) { return sendError(res, 500, 'Error', e.message); }
});

router.get('/sections', async (req, res) => {
  try {
    const r = await db.query(`SELECT key,is_enabled FROM cms_sections`);
    return sendSuccess(res, 200, 'Sections', { sections: Object.fromEntries(r.rows.map(s => [s.key, s.is_enabled])) });
  } catch (e) { return sendError(res, 500, 'Error', e.message); }
});

router.get('/blog', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const r = await db.query(
      `SELECT title,slug,excerpt,cover_image_url,author_name,published_at,created_at FROM blog_posts
       WHERE ${LIVE_POST} ORDER BY COALESCE(published_at,created_at) DESC LIMIT $1`, [limit]);
    return sendSuccess(res, 200, 'Posts', { posts: r.rows.map(postPub) });
  } catch (e) { return sendError(res, 500, 'Error', e.message); }
});

router.get('/blog/:slug', async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM blog_posts WHERE slug=$1 AND ${LIVE_POST}`, [req.params.slug]);
    if (!r.rows.length) return sendError(res, 404, 'Post not found');
    return sendSuccess(res, 200, 'Post', { post: postPub(r.rows[0]) });
  } catch (e) { return sendError(res, 500, 'Error', e.message); }
});

router.get('/pages/:slug', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT title,slug,content,meta_title,meta_description,featured_image_url,updated_at FROM cms_pages
       WHERE slug=$1 AND NOT is_deleted AND visibility='public'
         AND (status='published' OR (status='scheduled' AND publish_at<=NOW()))`, [req.params.slug]);
    if (!r.rows.length) return sendError(res, 404, 'Page not found');
    const p = r.rows[0];
    return sendSuccess(res, 200, 'Page', { page: { title: p.title, slug: p.slug, content: p.content, metaTitle: p.meta_title,
      metaDescription: p.meta_description, featuredImageUrl: p.featured_image_url, updatedAt: p.updated_at } });
  } catch (e) { return sendError(res, 500, 'Error', e.message); }
});

module.exports = router;
