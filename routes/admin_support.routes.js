const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission } = require('../middlewares/rbac.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { logAudit } = require('../utils/audit');

router.use(protect, isAdmin);

const STATUS = ['new', 'open', 'pending', 'waiting', 'escalated', 'resolved', 'closed'];
const PRIORITY = ['low', 'medium', 'high', 'urgent'];
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => async (req, res) => {
  try { return await fn(req, res); }
  catch (e) {
    if (!e.status) console.error('admin support:', e.message);
    return sendError(res, e.status || 500, e.message);
  }
};
const q = (sql, p = []) => db.query(sql, p).then(r => r.rows);
const n = v => Number(v) || 0;
const V = p => requirePermission('Support Center', p);

const BASE = `SELECT t.*, 'TKT-'||LPAD(t.ticket_number::text,5,'0') AS display_id,
  TRIM(u.first_name||' '||u.last_name) AS user_name, u.email AS user_email, u.role AS user_role,
  TRIM(COALESCE(a.first_name||' '||a.last_name,'')) AS agent_name,
  (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id=t.id AND NOT m.is_internal) AS msg_count
  FROM support_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.assigned_to
  WHERE NOT t.is_deleted`;

const shape = r => ({
  id: r.id, displayId: r.display_id, subject: r.subject, category: r.category, priority: r.priority,
  status: r.status, orderId: r.order_id, user: { id: r.user_id, name: r.user_name, email: r.user_email, role: r.user_role },
  assignedTo: r.assigned_to, agent: r.agent_name || null, messages: n(r.msg_count),
  createdAt: r.created_at, updatedAt: r.updated_at, firstResponseAt: r.first_response_at, resolvedAt: r.resolved_at,
});

function filters(qs) {
  const p = [];
  let w = 'WHERE 1=1';
  const add = (sql, v) => {
    p.push(v);
    w += ` AND ${sql.replace(/\?/g, '$' + p.length)}`;
  };
  const { search, status, priority, category, assigned } = qs;
  if (search) add('(subject ILIKE ? OR user_email ILIKE ? OR user_name ILIKE ? OR display_id ILIKE ?)', `%${search}%`);
  if (STATUS.includes(status)) add('status = ?', status);
  if (PRIORITY.includes(priority)) add('priority = ?', priority);
  if (category && category !== 'all') add('category = ?', category);
  if (assigned === 'me') add('assigned_to::text = ?', qs._me);
  else if (assigned === 'unassigned') w += ' AND assigned_to IS NULL';
  return { w, p };
}

const notifyUser = (uid, title, message, role) => db.query(
  `INSERT INTO notifications (user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
   VALUES ($1,$2,$3,'support',$4,FALSE,FALSE,NOW(),NOW())`,
  [uid, title, message, role === 'seller' ? '/sellers/sellers%20notification%20page.html' : '/buyers/help%20center.html']
).catch(e => console.warn('support notify:', e.message));

router.get('/summary', V('View'), wrap(async (req, res) => {
  const [[s], cats, pris] = await Promise.all([
    q(`SELECT COUNT(*) total,
        COUNT(*) FILTER (WHERE status IN ('new','open','pending','waiting')) open,
        COUNT(*) FILTER (WHERE status='new') new_count,
        COUNT(*) FILTER (WHERE status='escalated') escalated,
        COUNT(*) FILTER (WHERE resolved_at::date=CURRENT_DATE) resolved_today,
        COUNT(*) FILTER (WHERE assigned_to IS NULL AND status NOT IN ('resolved','closed')) unassigned,
        ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at-created_at))/3600)::numeric,1) avg_response_h
       FROM support_tickets WHERE NOT is_deleted`),
    q(`SELECT category name, COUNT(*) v FROM support_tickets WHERE NOT is_deleted GROUP BY 1 ORDER BY v DESC LIMIT 6`),
    q(`SELECT priority name, COUNT(*) v FROM support_tickets WHERE NOT is_deleted AND status NOT IN ('resolved','closed') GROUP BY 1`),
  ]);
  return sendSuccess(res, 200, 'Summary', {
    total: n(s.total), open: n(s.open), newCount: n(s.new_count), escalated: n(s.escalated),
    resolvedToday: n(s.resolved_today), unassigned: n(s.unassigned),
    avgResponseHours: s.avg_response_h == null ? null : n(s.avg_response_h),
    categories: cats.map(c => ({ name: c.name, value: n(c.v) })),
    priorities: pris.map(c => ({ name: c.name, value: n(c.v) })),
  });
}));

router.get('/agents', V('View'), wrap(async (req, res) => {
  const rows = await q(`SELECT u.id, TRIM(u.first_name||' '||u.last_name) name FROM users u
    JOIN admin_members m ON m.user_id=u.id AND m.status='active' WHERE u.is_deleted=false ORDER BY 2`);
  return sendSuccess(res, 200, 'Agents', { agents: rows });
}));

const cell = c => {
  c = String(c ?? '');
  if (/^[=+\-@]/.test(c)) c = "'" + c;
  return `"${c.replace(/"/g, '""')}"`;
};
router.get('/export', V('Export'), wrap(async (req, res) => {
  const { w, p } = filters({ ...req.query, _me: req.user.id });
  const rows = await q(`SELECT * FROM (${BASE}) x ${w} ORDER BY created_at DESC LIMIT 10000`, p);
  const lines = [
    ['Ticket', 'Subject', 'User', 'Email', 'Category', 'Priority', 'Status', 'Agent', 'Created'].map(cell).join(','),
    ...rows.map(r => [
      r.display_id, r.subject, r.user_name, r.user_email, r.category, r.priority, r.status, r.agent_name,
      new Date(r.created_at).toISOString(),
    ].map(cell).join(',')),
  ];
  await logAudit(req.user.id, 'SUPPORT_TICKETS_EXPORTED', 'support_ticket', null, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tickets-${Date.now()}.csv"`);
  return res.send(lines.join('\n'));
}));

router.get('/', V('View'), wrap(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 15, 100);
  const { w, p } = filters({ ...req.query, _me: req.user.id });
  const [rows, count] = await Promise.all([
    q(`SELECT * FROM (${BASE}) x ${w}
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC
       LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, limit, (page - 1) * limit]),
    q(`SELECT COUNT(*) FROM (${BASE}) x ${w}`, p),
  ]);
  return sendSuccess(res, 200, 'Tickets', { tickets: rows.map(shape), total: n(count[0].count), page, limit });
}));

router.get('/:id', V('View'), wrap(async (req, res) => {
  const [t] = await q(`SELECT * FROM (${BASE}) x WHERE id=$1`, [req.params.id]);
  if (!t) throw httpErr(404, 'Ticket not found');
  const msgs = await q(`SELECT m.id, m.sender_type, m.body, m.is_internal, m.attachments, m.created_at,
      COALESCE(NULLIF(TRIM(u.first_name||' '||u.last_name),''),'System') sender
    FROM support_messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=$1 ORDER BY m.created_at`, [t.id]);
  return sendSuccess(res, 200, 'Ticket', {
    ticket: shape(t),
    messages: msgs.map(m => ({
      id: m.id, type: m.sender_type, body: m.body, internal: m.is_internal,
      attachments: m.attachments || [], sender: m.sender, at: m.created_at,
    })),
  });
}));

router.post('/:id/reply', V('Edit'), wrap(async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 5000);
  const internal = req.body.internal === true;
  if (!body) throw httpErr(400, 'Message is required');
  const [t] = await q(`SELECT id, user_id, subject, status, (SELECT role FROM users WHERE id=user_id) role
                       FROM support_tickets WHERE id=$1 AND NOT is_deleted`, [req.params.id]);
  if (!t) throw httpErr(404, 'Ticket not found');
  if (t.status === 'closed') throw httpErr(409, 'Ticket is closed. Reopen it first.');
  await q(`INSERT INTO support_messages (ticket_id,sender_id,sender_type,body,is_internal) VALUES ($1,$2,'support',$3,$4)`,
    [t.id, req.user.id, body, internal]);
  if (!internal) {
    await q(`UPDATE support_tickets SET first_response_at=COALESCE(first_response_at,NOW()),
      assigned_to=COALESCE(assigned_to,$2),
      status=CASE WHEN status IN ('new','open','pending') THEN 'waiting' ELSE status END, updated_at=NOW() WHERE id=$1`,
    [t.id, req.user.id]);
    notifyUser(t.user_id, 'Support replied to your ticket', `New reply on "${t.subject}".`, t.role);
  }
  await logAudit(req.user.id, 'SUPPORT_TICKET_REPLIED', 'support_ticket', t.id, { internal });
  return sendSuccess(res, 201, internal ? 'Note added' : 'Reply sent');
}));

router.put('/:id', V('Edit'), wrap(async (req, res) => {
  const { status, priority, assignedTo } = req.body;
  if (status && !STATUS.includes(status)) throw httpErr(400, 'Invalid status');
  if (priority && !PRIORITY.includes(priority)) throw httpErr(400, 'Invalid priority');
  const [cur] = await q(`SELECT t.*, u.role user_role FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND NOT t.is_deleted`, [req.params.id]);
  if (!cur) throw httpErr(404, 'Ticket not found');
  if (assignedTo) {
    const ok = await q(`SELECT 1 FROM admin_members WHERE user_id=$1 AND status='active'`, [assignedTo]);
    if (!ok.length) throw httpErr(400, 'Assignee is not an active admin');
  }
  const [updated] = await q(
    `UPDATE support_tickets SET status=COALESCE($1,status), priority=COALESCE($2,priority),
       assigned_to=CASE WHEN $3::text='__keep' THEN assigned_to WHEN $3::text='' THEN NULL ELSE $3::uuid END,
       resolved_at=CASE WHEN $1='resolved' THEN NOW() WHEN $1 IN ('open','new','pending','waiting','escalated') THEN NULL ELSE resolved_at END,
       closed_at=CASE WHEN $1='closed' THEN NOW() WHEN $1 IS NOT NULL AND $1<>'closed' THEN NULL ELSE closed_at END,
       updated_at=NOW() WHERE id=$4 RETURNING *`,
    [status || null, priority || null, assignedTo === undefined ? '__keep' : (assignedTo || ''), cur.id]);
  const changes = [];
  if (status && status !== cur.status) changes.push(`status ${cur.status} → ${status}`);
  if (priority && priority !== cur.priority) changes.push(`priority ${cur.priority} → ${priority}`);
  if (assignedTo !== undefined && (assignedTo || null) !== cur.assigned_to) changes.push(assignedTo ? 'reassigned' : 'unassigned');
  if (changes.length) await q(`INSERT INTO support_messages (ticket_id,sender_id,sender_type,body,is_internal) VALUES ($1,$2,'system',$3,true)`,
    [cur.id, req.user.id, `Updated: ${changes.join(', ')}`]);
  if (status && status !== cur.status && ['resolved', 'closed'].includes(status))
    notifyUser(cur.user_id, `Ticket ${status}`, `Your ticket "${cur.subject}" was marked ${status}.`, cur.user_role);
  await logAudit(req.user.id, 'SUPPORT_TICKET_UPDATED', 'support_ticket', cur.id, { description: changes.join('; ') || 'No change' });
  return sendSuccess(res, 200, 'Ticket updated', { status: updated.status, priority: updated.priority });
}));

module.exports = router;
