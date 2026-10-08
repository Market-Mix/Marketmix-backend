const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isAdmin } = require('../middlewares/role.middleware');
const { requirePermission, getEffective } = require('../middlewares/rbac.middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { logAudit } = require('../utils/audit');
const sendEmail = require('../utils/sendEmail');
const R = require('../utils/rbac');

const router = express.Router();
const FRONTEND = process.env.FRONTEND_URL || 'https://marketmix.vercel.app';
const ACCESS = ['Full Access', 'High Access', 'Moderate Access', 'Limited Access', 'Read Only'];
const ROLE_STATUS = ['Active', 'Pending', 'Suspended'];

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => async (req, res) => {
  try { return await fn(req, res); }
  catch (e) {
    if (e.code === '23505') return sendError(res, 409, 'A role with this name already exists');
    if (e.code === '22P02') return sendError(res, 400, 'Invalid id');
    if (!e.status) console.error('rbac:', e.message);
    return sendError(res, e.status || 500, e.message);
  }
};
const q = (sql, p = []) => db.query(sql, p).then(r => r.rows);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const parse = m => { if (!m) return null; if (typeof m !== 'string') return m; try { return JSON.parse(m); } catch { return null; } };
const audit = (req, action, id, meta) => logAudit(req.user.id, action, 'admin_rbac', id, meta);
const VIEW = requirePermission('Roles & Permissions', 'View');
const MANAGE = requirePermission('Roles & Permissions', 'Manage');

router.get('/invitations/verify/:token', wrap(async (req, res) => {
  const [inv] = await q(
    `SELECT i.email, i.first_name, r.name role FROM admin_invitations i LEFT JOIN admin_roles r ON r.id=i.role_id
     WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW()`, [sha(req.params.token)]);
  if (!inv) throw httpErr(404, 'Invitation is invalid or expired');
  return sendSuccess(res, 200, 'Invitation', { email: inv.email, firstName: inv.first_name, role: inv.role });
}));

router.post('/invitations/accept', wrap(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) throw httpErr(400, 'Token and a password of 8+ characters are required');
  const userId = await db.transaction(async c => {
    const inv = (await c.query(
      `SELECT * FROM admin_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL
       AND expires_at>NOW() FOR UPDATE`, [sha(token)])).rows[0];
    if (!inv) throw httpErr(400, 'Invitation is invalid or expired');
    if ((await c.query(`SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)`, [inv.email])).rows.length)
      throw httpErr(409, 'An account with this email already exists');
    const hash = await bcrypt.hash(password, 10);
    const u = (await c.query(
      `INSERT INTO users (email,password_hash,first_name,last_name,role,is_verified)
       VALUES ($1,$2,$3,$4,'admin',true) RETURNING id`,
      [inv.email, hash, inv.first_name || 'Admin', inv.last_name || inv.first_name || 'User'])).rows[0];
    await c.query(
      `INSERT INTO admin_members (user_id,role_id,department,status,invited_by) VALUES ($1,$2,$3,'active',$4)`,
      [u.id, inv.role_id, inv.department, inv.invited_by]);
    await c.query(`UPDATE admin_invitations SET accepted_at=NOW() WHERE id=$1`, [inv.id]);
    return u.id;
  });
  await logAudit(userId, 'RBAC_INVITE_ACCEPTED', 'user', userId, { target: 'New administrator', description: 'Administrator accepted invitation' });
  return sendSuccess(res, 201, 'Account created. You can now log in.');
}));

router.use(protect, isAdmin);

const ROLE_SQL = `SELECT r.*, (SELECT COUNT(*) FROM admin_members m WHERE m.role_id=r.id) AS admin_count
                  FROM admin_roles r WHERE NOT r.is_deleted`;
const ADMIN_SQL = `SELECT u.id,u.email,u.first_name,u.last_name,u.created_at,m.department,m.status,m.custom_permissions,m.role_id,
    r.name role_name, r.permissions role_permissions, COALESCE(r.is_super,false) is_super,
    (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.actor_id=u.id AND a.action='USER_LOGIN') last_login
  FROM admin_members m JOIN users u ON u.id=m.user_id AND u.is_deleted=false
  LEFT JOIN admin_roles r ON r.id=m.role_id AND NOT r.is_deleted`;

const getRole = async id => { const [r] = await q(`${ROLE_SQL} AND r.id=$1`, [id]); if (!r) throw httpErr(404, 'Role not found'); return r; };
const getAdmin = async id => { const [a] = await q(`${ADMIN_SQL} WHERE m.user_id=$1`, [id]); if (!a) throw httpErr(404, 'Administrator not found'); return a; };

const roleShape = r => {
  const p = R.sanitizeMatrix(r.permissions);
  return { id: r.id, name: r.name, description: r.description, accessLevel: r.access_level, status: r.status, isSuper: r.is_super,
    permissions: p, permissionCount: R.stats(p).granted, admins: +r.admin_count || 0, createdAt: r.created_at };
};

const adminShape = (r, detail) => {
  const eff = r.is_super ? R.fullMatrix('allowed') : R.mergeMatrix(r.role_permissions, r.custom_permissions);
  const st = R.stats(eff);
  const o = { id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email, email: r.email,
    role: r.role_name || '—', roleId: r.role_id, department: r.department, status: cap(r.status), lastLogin: r.last_login,
    createdAt: r.created_at, isSuper: r.is_super, assigned: st.granted, inherited: st.inherited,
    custom: R.overrideLabels(r.custom_permissions), security: R.securityLevel(st) };
  if (detail) o.effective = eff;
  return o;
};

async function assertCanGrant(req, matrix) {
  const e = await getEffective(req.user.id);
  if (e.isSuper) return;
  for (const m of R.MODULES) for (const a of R.ACTIONS)
    if (R.granted(matrix?.[m]?.[a]) && !R.granted(e.matrix?.[m]?.[a])) throw httpErr(403, `You cannot grant ${m} → ${a} because you don't hold it`);
}
async function assertActorIsSuper(req) { if (!(await getEffective(req.user.id)).isSuper) throw httpErr(403, 'Only a Super Admin can do this'); }
async function superGuard(excludeId) {
  const [c] = await q(`SELECT COUNT(*) n FROM admin_members m JOIN admin_roles r ON r.id=m.role_id
                       WHERE r.is_super AND m.status='active' AND m.user_id<>$1`, [excludeId]);
  if (+c.n === 0) throw httpErr(409, 'At least one active Super Admin must remain');
}
const notSelf = (req, id, msg) => { if (id === req.user.id) throw httpErr(403, msg); };

async function roleFields(req) {
  const b = req.body, name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 60) throw httpErr(400, 'Role name must be 2–60 characters');
  const f = { name, description: String(b.description || '').trim().slice(0, 255),
    accessLevel: ACCESS.includes(b.accessLevel) ? b.accessLevel : 'Moderate Access',
    status: ROLE_STATUS.includes(b.status) ? b.status : 'Active', permissions: R.sanitizeMatrix(b.permissions) };
  await assertCanGrant(req, f.permissions);
  return f;
}

router.get('/summary', VIEW, wrap(async (req, res) => {
  const [s] = await q(`SELECT
    (SELECT COUNT(*) FROM admin_members m JOIN users u ON u.id=m.user_id AND u.is_deleted=false) total,
    (SELECT COUNT(*) FROM admin_members m JOIN users u ON u.id=m.user_id AND u.is_deleted=false WHERE m.status='active') active,
    (SELECT COUNT(*) FROM admin_members m JOIN users u ON u.id=m.user_id AND u.is_deleted=false WHERE m.status='suspended') suspended,
    (SELECT COUNT(*) FROM admin_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at>NOW()) pending,
    (SELECT COUNT(*) FROM admin_roles WHERE NOT is_deleted) roles,
    (SELECT COUNT(*) FROM admin_roles WHERE NOT is_deleted AND NOT is_super) custom`);
  return sendSuccess(res, 200, 'Summary', Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v])));
}));

router.get('/history', VIEW, wrap(async (req, res) => {
  const rows = await q(
    `SELECT a.action, a.metadata, a.created_at,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),''), u.email, 'System') actor
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
     WHERE LEFT(a.action,5)='RBAC_' ORDER BY a.created_at DESC LIMIT 20`);
  return sendSuccess(res, 200, 'History', { history: rows.map(r => { const m = parse(r.metadata) || {};
    return { at: r.created_at, target: m.target || '—', description: m.description || cap(r.action.slice(5).toLowerCase().replace(/_/g, ' ')), changedBy: r.actor }; }) });
}));

router.get('/me/permissions', wrap(async (req, res) => {
  const e = await getEffective(req.user.id);
  return sendSuccess(res, 200, 'Permissions', { isSuper: !!e.isSuper, permissions: e.isSuper ? R.fullMatrix('allowed') : e.matrix });
}));

router.get('/roles', VIEW, wrap(async (req, res) =>
  sendSuccess(res, 200, 'Roles', { roles: (await q(`${ROLE_SQL} ORDER BY r.is_super DESC, r.created_at`)).map(roleShape) })));

router.get('/roles/:id', VIEW, wrap(async (req, res) =>
  sendSuccess(res, 200, 'Role', { role: roleShape(await getRole(req.params.id)) })));

router.post('/roles', MANAGE, wrap(async (req, res) => {
  const f = await roleFields(req);
  const [row] = await q(
    `INSERT INTO admin_roles (name,description,access_level,status,permissions,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [f.name, f.description, f.accessLevel, f.status, JSON.stringify(f.permissions), req.user.id]);
  await audit(req, 'RBAC_ROLE_CREATED', row.id, { target: f.name, description: `Role "${f.name}" created` });
  return sendSuccess(res, 201, 'Role created', { id: row.id });
}));

router.put('/roles/:id', MANAGE, wrap(async (req, res) => {
  const role = await getRole(req.params.id);
  if (role.is_super) throw httpErr(409, 'The Super Admin role is protected');
  const f = await roleFields(req);
  await q(`UPDATE admin_roles SET name=$1,description=$2,access_level=$3,status=$4,permissions=$5,updated_at=NOW() WHERE id=$6`,
    [f.name, f.description, f.accessLevel, f.status, JSON.stringify(f.permissions), role.id]);
  const d = R.diff(role.permissions, f.permissions);
  await audit(req, 'RBAC_ROLE_UPDATED', role.id, { target: f.name, description: `Role "${f.name}" updated (+${d.added} −${d.removed} ~${d.modified})` });
  return sendSuccess(res, 200, 'Role saved');
}));

router.delete('/roles/:id', MANAGE, wrap(async (req, res) => {
  const role = await getRole(req.params.id);
  if (role.is_super) throw httpErr(409, 'The Super Admin role is protected');
  if (+role.admin_count > 0) throw httpErr(409, `${role.admin_count} administrator(s) still use this role. Reassign them first.`);
  await q(`UPDATE admin_invitations SET revoked_at=NOW() WHERE role_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [role.id]);
  await q(`UPDATE admin_roles SET is_deleted=true, updated_at=NOW() WHERE id=$1`, [role.id]);
  await audit(req, 'RBAC_ROLE_DELETED', role.id, { target: role.name, description: `Role "${role.name}" deleted` });
  return sendSuccess(res, 200, 'Role deleted');
}));

router.get('/admins', VIEW, wrap(async (req, res) =>
  sendSuccess(res, 200, 'Admins', { admins: (await q(`${ADMIN_SQL} ORDER BY u.created_at`)).map(r => adminShape(r)) })));

router.get('/admins/:id', VIEW, wrap(async (req, res) =>
  sendSuccess(res, 200, 'Admin', { admin: adminShape(await getAdmin(req.params.id), true) })));

router.put('/admins/:id/role', MANAGE, wrap(async (req, res) => {
  const { id } = req.params; notSelf(req, id, 'You cannot change your own role');
  const a = await getAdmin(id), role = await getRole(req.body.roleId);
  if (role.status !== 'Active') throw httpErr(409, 'That role is not active');
  if (role.is_super) await assertActorIsSuper(req);
  await assertCanGrant(req, R.sanitizeMatrix(role.permissions));
  if (a.is_super && a.status === 'active' && !role.is_super) await superGuard(id);
  await q(`UPDATE admin_members SET role_id=$1, custom_permissions='{}'::jsonb, updated_at=NOW() WHERE user_id=$2`, [role.id, id]);
  await audit(req, 'RBAC_ADMIN_ROLE_CHANGED', id, { target: adminShape(a).name, description: `Role changed: ${a.role_name || '—'} → ${role.name}` });
  return sendSuccess(res, 200, 'Role updated');
}));

router.put('/admins/:id/permissions', MANAGE, wrap(async (req, res) => {
  const { id } = req.params; notSelf(req, id, 'You cannot edit your own permissions');
  const a = await getAdmin(id);
  if (a.is_super) throw httpErr(409, 'Super Admins always have full access');
  const ov = R.diffOverrides(R.sanitizeMatrix(a.role_permissions), R.sanitizeMatrix(req.body.permissions));
  await assertCanGrant(req, ov);
  await q(`UPDATE admin_members SET custom_permissions=$1, updated_at=NOW() WHERE user_id=$2`, [JSON.stringify(ov), id]);
  await audit(req, 'RBAC_ADMIN_PERMISSIONS_UPDATED', id, { target: adminShape(a).name, description: `Custom permissions updated (${R.overrideLabels(ov).length} override(s))` });
  return sendSuccess(res, 200, 'Permissions updated');
}));

router.post('/admins/:id/reset-permissions', MANAGE, wrap(async (req, res) => {
  const a = await getAdmin(req.params.id); notSelf(req, a.id, 'You cannot reset your own permissions');
  await q(`UPDATE admin_members SET custom_permissions='{}'::jsonb, updated_at=NOW() WHERE user_id=$1`, [a.id]);
  await audit(req, 'RBAC_ADMIN_PERMISSIONS_RESET', a.id, { target: adminShape(a).name, description: 'Custom permissions reset to role defaults' });
  return sendSuccess(res, 200, 'Permissions reset');
}));

for (const [op, status] of [['suspend', 'suspended'], ['activate', 'active']]) {
  router.post(`/admins/:id/${op}`, MANAGE, wrap(async (req, res) => {
    const a = await getAdmin(req.params.id); notSelf(req, a.id, `You cannot ${op} your own account`);
    if (op === 'suspend' && a.is_super && a.status === 'active') await superGuard(a.id);
    await q(`UPDATE admin_members SET status=$1, updated_at=NOW() WHERE user_id=$2`, [status, a.id]);
    await audit(req, `RBAC_ADMIN_${op === 'suspend' ? 'SUSPENDED' : 'ACTIVATED'}`, a.id,
      { target: adminShape(a).name, description: `Administrator ${op === 'suspend' ? 'suspended' : 'reactivated'}` });
    return sendSuccess(res, 200, `Administrator ${status}`);
  }));
}

router.delete('/admins/:id', MANAGE, wrap(async (req, res) => {
  const a = await getAdmin(req.params.id); notSelf(req, a.id, 'You cannot remove your own access');
  if (a.is_super && a.status === 'active') await superGuard(a.id);
  await db.transaction(async c => {
    await c.query(`DELETE FROM admin_members WHERE user_id=$1`, [a.id]);
    await c.query(`UPDATE users SET role='buyer', updated_at=NOW() WHERE id=$1`, [a.id]);
  });
  await audit(req, 'RBAC_ADMIN_REMOVED', a.id, { target: adminShape(a).name, description: 'Administrator access removed' });
  return sendSuccess(res, 200, 'Administrator removed');
}));

router.put('/admins/:id/profile', MANAGE, wrap(async (req, res) => {
  const a = await getAdmin(req.params.id);
  const dept  = String(req.body.department || '').trim().slice(0, 60) || a.department;
  const first = String(req.body.firstName || '').trim().slice(0, 80);
  const last  = String(req.body.lastName  || '').trim().slice(0, 80);
  await db.transaction(async c => {
    await c.query(`UPDATE admin_members SET department=$1, updated_at=NOW() WHERE user_id=$2`, [dept, a.id]);
    if (first) await c.query(
      `UPDATE users SET first_name=$1, last_name=COALESCE(NULLIF($2,''),last_name), updated_at=NOW() WHERE id=$3`,
      [first, last, a.id]);
  });
  await audit(req, 'RBAC_ADMIN_PROFILE_UPDATED', a.id, { target: adminShape(a).name, description: 'Administrator profile updated' });
  return sendSuccess(res, 200, 'Profile updated');
}));

const INV_SQL = `SELECT i.id,i.email,i.first_name,i.last_name,i.department,i.expires_at,i.created_at,r.name role_name
  FROM admin_invitations i LEFT JOIN admin_roles r ON r.id=i.role_id
  WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW()`;
const invShape = r => ({ id: r.id, email: r.email, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), role: r.role_name,
  department: r.department, expiresAt: r.expires_at, createdAt: r.created_at });

async function mailInvite(inv, token, roleName) {
  const link = `${FRONTEND}/admin/accept-invite.html?token=${token}`;
  await sendEmail({ to: inv.email, subject: "You've been invited to MarketMix Admin",
    html: `<p>Hi ${esc(inv.first_name || '')},</p><p>You've been invited to the MarketMix admin panel as <b>${esc(roleName)}</b>. This link expires in 72 hours.</p>
           <p><a href="${link}" style="background:#FF7A00;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none">Accept invitation</a></p>` });
}
const newToken = () => crypto.randomBytes(32).toString('hex');
const in72h = () => new Date(Date.now() + 72 * 3600000);

router.get('/invitations', VIEW, wrap(async (req, res) =>
  sendSuccess(res, 200, 'Invitations', { invitations: (await q(`${INV_SQL} ORDER BY i.created_at DESC`)).map(invShape) })));

router.post('/invitations', MANAGE, wrap(async (req, res) => {
  const b = req.body, email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpErr(400, 'Enter a valid email address');
  if (!String(b.firstName || '').trim()) throw httpErr(400, 'First name is required');
  const role = await getRole(b.roleId);
  if (role.status !== 'Active') throw httpErr(409, 'That role is not active');
  if (role.is_super) await assertActorIsSuper(req);
  await assertCanGrant(req, R.sanitizeMatrix(role.permissions));
  if ((await q(`SELECT 1 FROM users WHERE LOWER(email)=$1 AND is_deleted=false`, [email])).length) throw httpErr(409, 'A user with this email already exists');
  await q(`UPDATE admin_invitations SET revoked_at=NOW() WHERE LOWER(email)=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [email]);
  const token = newToken();
  const [inv] = await q(
    `INSERT INTO admin_invitations (email,first_name,last_name,role_id,department,token_hash,expires_at,invited_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [email, b.firstName.trim(), (b.lastName || '').trim() || null, role.id, (b.department || 'General').trim().slice(0, 60), sha(token), in72h(), req.user.id]);
  try { await mailInvite(inv, token, role.name); }
  catch (e) { await q(`UPDATE admin_invitations SET revoked_at=NOW() WHERE id=$1`, [inv.id]); throw httpErr(502, 'Could not send invitation email'); }
  await audit(req, 'RBAC_INVITE_SENT', inv.id, { target: email, description: `Invitation sent to ${email} as ${role.name}` });
  return sendSuccess(res, 201, 'Invitation sent', { id: inv.id });
}));

router.post('/invitations/:id/resend', MANAGE, wrap(async (req, res) => {
  const token = newToken();
  const [inv] = await q(`UPDATE admin_invitations SET token_hash=$1, expires_at=$2 WHERE id=$3 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *`,
    [sha(token), in72h(), req.params.id]);
  if (!inv) throw httpErr(404, 'Invitation not found');
  await mailInvite(inv, token, (await getRole(inv.role_id)).name);
  await audit(req, 'RBAC_INVITE_RESENT', inv.id, { target: inv.email, description: `Invitation resent to ${inv.email}` });
  return sendSuccess(res, 200, 'Invitation resent');
}));

router.delete('/invitations/:id', MANAGE, wrap(async (req, res) => {
  const [inv] = await q(`UPDATE admin_invitations SET revoked_at=NOW() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`, [req.params.id]);
  if (!inv) throw httpErr(404, 'Invitation not found');
  await audit(req, 'RBAC_INVITE_REVOKED', req.params.id, { target: inv.email, description: `Invitation to ${inv.email} revoked` });
  return sendSuccess(res, 200, 'Invitation revoked');
}));

module.exports = router;
