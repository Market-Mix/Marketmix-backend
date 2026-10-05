const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission } = require('../middlewares/rbac.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { logAudit } = require('../utils/audit');
const { dispatch } = require('../services/adminBroadcast.service');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => f.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')) });

router.use(protect, isAdmin);

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const CHANNELS = { push: 'in_app', 'in-app': 'in_app', in_app: 'in_app', email: 'email', both: 'both' };
const AUDIENCES = ['all', 'buyers', 'sellers', 'admins', 'individual'];

const shape = r => ({
  id: r.id, displayId: 'NTF-' + String(r.id).slice(0, 6).toUpperCase(),
  title: r.title, subject: r.subject, message: r.message, channel: r.channel,
  audience: r.audience, type: r.type, priority: r.priority, status: r.status,
  link: r.link, bannerUrl: r.banner_url, scheduledFor: r.scheduled_for, sentDate: r.sent_at,
  createdAt: r.created_at, createdBy: r.created_by_name || 'System', targetUserId: r.target_user_id,
  recipients: r.recipients || 0, delivered: r.delivered || 0, opened: parseInt(r.opened) || 0,
  clicked: null, failed: r.failed || 0, error: r.error_message,
});

const SELECT = `SELECT n.*, TRIM(COALESCE(u.first_name||' '||u.last_name, u.email)) AS created_by_name,
  (SELECT COUNT(*) FROM notifications x WHERE x.data->>'broadcast_id' = n.id::text AND x.is_read) AS opened
  FROM admin_notifications n LEFT JOIN users u ON u.id = n.created_by`;

async function normalize(b) {
  const title = (b.title || '').trim(), message = (b.message || '').trim();
  if (title.length < 3 || title.length > 255) throw httpErr(400, 'Title must be 3–255 characters');
  if (message.length < 5) throw httpErr(400, 'Message is too short');
  const chRaw = String(b.channel || 'in_app').toLowerCase();
  if (chRaw === 'sms') throw httpErr(400, 'SMS is not supported yet');
  const channel = CHANNELS[chRaw]; if (!channel) throw httpErr(400, 'Invalid channel');
  const audience = String(b.audience || 'all').toLowerCase();
  if (!AUDIENCES.includes(audience)) throw httpErr(400, 'Invalid audience');
  const type = ['system', 'user', 'seller'].includes(String(b.type).toLowerCase()) ? b.type.toLowerCase() : 'system';
  const priority = ['low', 'medium', 'high', 'critical'].includes(String(b.priority).toLowerCase()) ? b.priority.toLowerCase() : 'medium';
  const link = (b.link || '').trim() || null;
  if (link && !/^(\/|https?:\/\/)/.test(link)) throw httpErr(400, 'Link must start with / or https://');
  let target = null;
  if (audience === 'individual') {
    const r = await db.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND is_deleted=false`, [b.target_email || '']);
    if (!r.rows.length) throw httpErr(404, 'No user found with that email');
    target = r.rows[0].id;
  }
  return { title, subject: (b.subject || '').trim() || null, message, channel, audience,
           target_user_id: target, type, priority, link, banner_url: b.banner_url || null };
}

async function save(req, res, id = null) {
  const d = await normalize(req.body);
  const action = req.body.action || 'draft';
  let status = 'draft', sched = null;
  if (action === 'schedule') {
    sched = new Date(req.body.scheduled_for);
    if (isNaN(sched) || sched.getTime() < Date.now() + 60000) throw httpErr(400, 'Schedule time must be at least 1 minute in the future');
    status = 'scheduled';
  }
  const vals = [d.title, d.subject, d.message, d.channel, d.audience, d.target_user_id,
                d.type, d.priority, d.link, d.banner_url, status, sched];
  let row;
  if (id) {
    const cur = await db.query(`SELECT status FROM admin_notifications WHERE id=$1 AND is_deleted=false`, [id]);
    if (!cur.rows.length) throw httpErr(404, 'Notification not found');
    if (!['draft', 'scheduled'].includes(cur.rows[0].status)) throw httpErr(409, 'Only drafts or scheduled notifications can be edited');
    row = (await db.query(
      `UPDATE admin_notifications SET title=$1,subject=$2,message=$3,channel=$4,audience=$5,target_user_id=$6,
         type=$7,priority=$8,link=$9,banner_url=COALESCE($10,banner_url),status=$11,scheduled_for=$12,updated_at=NOW()
       WHERE id=$13 RETURNING id`, [...vals, id])).rows[0];
  } else {
    row = (await db.query(
      `INSERT INTO admin_notifications (title,subject,message,channel,audience,target_user_id,type,priority,link,
         banner_url,status,scheduled_for,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [...vals, req.user.id])).rows[0];
  }
  await logAudit(req.user.id, id ? 'NOTIFICATION_UPDATED' : 'NOTIFICATION_CREATED', 'notification', row.id, { action, audience: d.audience });

  if (action === 'send') {
    await logAudit(req.user.id, 'NOTIFICATION_SENT', 'notification', row.id, { audience: d.audience, channel: d.channel });
    const p = dispatch(row.id);
    if (d.channel === 'in_app') await p; else p.catch(e => console.error('dispatch:', e.message));
  }
  const out = await db.query(`${SELECT} WHERE n.id=$1`, [row.id]);
  return shape(out.rows[0]);
}

const wrap = fn => async (req, res) => {
  try { return await fn(req, res); }
  catch (e) { return sendError(res, e.status || 500, e.message); }
};

router.post('/banner-upload', requirePermission('Notifications', 'Create'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpErr(400, 'No file provided');
  const url = await uploadToCloudinary(req.file.buffer, req.file.mimetype, 'notification-banners');
  return sendSuccess(res, 200, 'Uploaded', { url });
}));

router.get('/stats', requirePermission('Notifications', 'View'), wrap(async (req, res) => {
  const [a, o, un] = await Promise.all([
    db.query(`SELECT COUNT(*) total,
        COUNT(*) FILTER (WHERE type='system') sys, COUNT(*) FILTER (WHERE type='user') usr,
        COUNT(*) FILTER (WHERE type='seller') sel, COUNT(*) FILTER (WHERE status='scheduled') sched,
        COUNT(*) FILTER (WHERE sent_at::date = CURRENT_DATE) today,
        COALESCE(SUM(recipients),0) rec, COALESCE(SUM(delivered),0) del
      FROM admin_notifications WHERE is_deleted=false`),
    db.query(`SELECT COUNT(*) c FROM notifications WHERE data->>'broadcast_id' IS NOT NULL AND is_read`),
    db.query(`SELECT COUNT(*) c FROM notifications WHERE user_id=$1 AND is_read=false AND is_deleted=false`, [req.user.id]),
  ]);
  const s = a.rows[0], rec = +s.rec, del = +s.del;
  return sendSuccess(res, 200, 'Stats', {
    total: +s.total, unread: +un.rows[0].c, systemAlerts: +s.sys, userNotifications: +s.usr,
    sellerNotifications: +s.sel, scheduled: +s.sched, today: +s.today,
    deliveryRate: rec ? Math.round(del / rec * 100) : 0,
    openRate: del ? Math.round(+o.rows[0].c / del * 100) : 0,
    clickRate: null,
  });
}));

router.get('/', requirePermission('Notifications', 'View'), wrap(async (req, res) => {
  const { search, id, status, type, audience, date } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const p = []; let w = 'WHERE n.is_deleted=false';
  if (search)   { p.push(`%${search}%`); w += ` AND (n.title ILIKE $${p.length} OR n.message ILIKE $${p.length})`; }
  if (id)       { p.push(id.replace(/^ntf-/i, '').toLowerCase() + '%'); w += ` AND n.id::text ILIKE $${p.length}`; }
  if (status)   { p.push(status.toLowerCase()); w += ` AND n.status=$${p.length}`; }
  if (type)     { p.push(type.toLowerCase());   w += ` AND n.type=$${p.length}`; }
  if (audience) { p.push(audience.toLowerCase()); w += ` AND n.audience=$${p.length}`; }
  if (date)     { p.push(date); w += ` AND COALESCE(n.sent_at, n.scheduled_for, n.created_at)::date=$${p.length}`; }

  const [rows, count] = await Promise.all([
    db.query(`${SELECT} ${w} ORDER BY n.created_at DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, limit, (page - 1) * limit]),
    db.query(`SELECT COUNT(*) FROM admin_notifications n ${w}`, p),
  ]);
  return sendSuccess(res, 200, 'Notifications fetched', {
    notifications: rows.rows.map(shape), total: +count.rows[0].count, page, limit });
}));

router.get('/:id', requirePermission('Notifications', 'View'), wrap(async (req, res) => {
  const r = await db.query(`${SELECT} WHERE n.id=$1 AND n.is_deleted=false`, [req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Notification not found');
  return sendSuccess(res, 200, 'Notification fetched', { notification: shape(r.rows[0]) });
}));

router.post('/', requirePermission('Notifications', 'Create'), wrap(async (req, res) =>
  sendSuccess(res, 201, 'Saved', { notification: await save(req, res) })));

router.put('/:id', requirePermission('Notifications', 'Edit'), wrap(async (req, res) =>
  sendSuccess(res, 200, 'Updated', { notification: await save(req, res, req.params.id) })));

router.post('/:id/send', requirePermission('Notifications', 'Manage'), wrap(async (req, res) => {
  const r = await db.query(`SELECT channel FROM admin_notifications WHERE id=$1 AND is_deleted=false`, [req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Notification not found');
  const p = dispatch(req.params.id);
  if (r.rows[0].channel === 'in_app') await p; else p.catch(e => console.error(e.message));
  await logAudit(req.user.id, 'NOTIFICATION_SENT', 'notification', req.params.id);
  return sendSuccess(res, 200, 'Sending');
}));

router.delete('/:id', requirePermission('Notifications', 'Delete'), wrap(async (req, res) => {
  const r = await db.query(
    `UPDATE admin_notifications SET is_deleted=true, updated_at=NOW()
     WHERE id=$1 AND is_deleted=false AND status<>'sending' RETURNING id`, [req.params.id]);
  if (!r.rows.length) throw httpErr(404, 'Not found, or currently sending');
  await db.query(`UPDATE notifications SET is_deleted=true, updated_at=NOW() WHERE data->>'broadcast_id'=$1`, [req.params.id]);
  await logAudit(req.user.id, 'NOTIFICATION_DELETED', 'notification', req.params.id);
  return sendSuccess(res, 200, 'Deleted');
}));

module.exports = router;
