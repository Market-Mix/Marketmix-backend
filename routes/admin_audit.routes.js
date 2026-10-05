const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { logAudit } = require('../utils/audit');

router.use(protect, isAdmin);

const SEV = `CASE WHEN a.action ~ '(DELET|_SUSPENDED|REJECT|FAIL|DISABL|REVOK)' THEN 'high'
  WHEN a.action ~ '(UPDATE|APPROV|RELEAS|WITHDRAW|PASSWORD|REFUND|SENT|PROCESS|EXPORT)' THEN 'medium' ELSE 'low' END`;
const BASE = `WITH base AS (
  SELECT a.id::text AS id, a.actor_id, a.action, a.object_type, a.object_id::text AS object_id,
         a.metadata, a.metadata::text AS meta_text, a.ip_address, a.user_agent, a.created_at,
         COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),''), u.email, 'System') AS actor_name,
         u.email AS actor_email, u.role AS actor_role, ${SEV} AS severity
  FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id)`;

const parseMeta = m => { if (!m) return null; if (typeof m !== 'string') return m; try { return JSON.parse(m); } catch { return { raw: m }; } };
const label = a => String(a || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
const shape = r => {
  const meta = parseMeta(r.metadata);
  return {
    id: r.id, action: r.action, actionLabel: label(r.action), severity: r.severity,
    objectType: r.object_type, objectId: r.object_id,
    description: meta?.description || meta?.message ||
      `${label(r.action)}${r.object_type ? ' · ' + r.object_type : ''}${r.object_id ? ' ' + String(r.object_id).slice(0, 8) : ''}`,
    actor: { id: r.actor_id, name: r.actor_name, email: r.actor_email, role: r.actor_role || 'system' },
    ip: r.ip_address, userAgent: r.user_agent, metadata: meta, createdAt: r.created_at,
  };
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function filters(qs) {
  const p = []; let w = 'WHERE 1=1';
  const add = (sql, v) => { p.push(v); w += ` AND ${sql.replace(/\?/g, '$' + p.length)}`; };
  const { search, action, type, severity, actor, from, to } = qs;
  if (search) add(`(action ILIKE ? OR object_type ILIKE ? OR object_id ILIKE ? OR meta_text ILIKE ? OR actor_name ILIKE ? OR actor_email ILIKE ? OR ip_address ILIKE ?)`, `%${search}%`);
  if (action && action !== 'all') add('action = ?', action);
  if (type && type !== 'all') add('object_type = ?', type);
  if (['high', 'medium', 'low'].includes(severity)) add('severity = ?', severity);
  if (actor && actor !== 'all') add('actor_id::text = ?', actor);
  if (DATE.test(from || '')) add('created_at >= ?::date', from);
  if (DATE.test(to || '')) add('created_at < (?::date + 1)', to);
  return { w, p };
}
const wrap = fn => async (req, res) => { try { return await fn(req, res); } catch (e) { console.error('audit route:', e.message); return sendError(res, e.status || 500, e.message); } };

router.get('/', wrap(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { w, p } = filters(req.query);
  const dir = req.query.sort === 'asc' ? 'ASC' : 'DESC';
  const [rows, count] = await Promise.all([
    db.query(`${BASE} SELECT * FROM base ${w} ORDER BY created_at ${dir} LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, limit, (page - 1) * limit]),
    db.query(`${BASE} SELECT COUNT(*) FROM base ${w}`, p),
  ]);
  return sendSuccess(res, 200, 'Audit logs', { logs: rows.rows.map(shape), total: +count.rows[0].count, page, limit });
}));

router.get('/stats', wrap(async (req, res) => {
  const [s, top] = await Promise.all([
    db.query(`${BASE} SELECT COUNT(*) total,
      COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) today,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') week,
      COUNT(DISTINCT actor_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') actors,
      COUNT(*) FILTER (WHERE severity='high' AND created_at >= NOW() - INTERVAL '7 days') high_week FROM base`),
    db.query(`${BASE} SELECT action, COUNT(*) c FROM base WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY c DESC LIMIT 6`),
  ]);
  const r = s.rows[0];
  return sendSuccess(res, 200, 'Stats', {
    total: +r.total, today: +r.today, week: +r.week, actors: +r.actors, highWeek: +r.high_week,
    topActions: top.rows.map(x => ({ action: x.action, label: label(x.action), count: +x.c })),
  });
}));

router.get('/filters', wrap(async (req, res) => {
  const [a, t, u] = await Promise.all([
    db.query(`SELECT DISTINCT action FROM audit_logs ORDER BY 1`),
    db.query(`SELECT DISTINCT object_type FROM audit_logs WHERE object_type IS NOT NULL ORDER BY 1`),
    db.query(`${BASE} SELECT actor_id id, MAX(actor_name) name, COUNT(*) c FROM base WHERE actor_id IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 100`),
  ]);
  return sendSuccess(res, 200, 'Filters', {
    actions: a.rows.map(r => ({ value: r.action, label: label(r.action) })),
    types: t.rows.map(r => r.object_type),
    actors: u.rows.map(r => ({ id: r.id, name: r.name })),
  });
}));

const cell = c => { c = String(c ?? ''); if (/^[=+\-@]/.test(c)) c = "'" + c; return `"${c.replace(/"/g, '""')}"`; };
router.get('/export', wrap(async (req, res) => {
  const { w, p } = filters(req.query);
  const r = await db.query(`${BASE} SELECT * FROM base ${w} ORDER BY created_at DESC LIMIT 10000`, p);
  const head = ['Time', 'Severity', 'Action', 'Object Type', 'Object ID', 'Actor', 'Actor Email', 'Role', 'IP', 'User Agent', 'Metadata'];
  const lines = [head.map(cell).join(','), ...r.rows.map(x => [
    new Date(x.created_at).toISOString(), x.severity, x.action, x.object_type, x.object_id,
    x.actor_name, x.actor_email, x.actor_role, x.ip_address, x.user_agent, x.meta_text].map(cell).join(','))];
  await logAudit(req.user.id, 'AUDIT_LOGS_EXPORTED', 'audit_log', null, { rows: r.rows.length, filters: req.query });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
  return res.send(lines.join('\n'));
}));

router.get('/:id', wrap(async (req, res) => {
  const r = await db.query(`${BASE} SELECT * FROM base WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return sendError(res, 404, 'Log entry not found');
  return sendSuccess(res, 200, 'Log', { log: shape(r.rows[0]) });
}));

module.exports = router;
