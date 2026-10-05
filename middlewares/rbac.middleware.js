const db = require('../config/db');
const { sendError } = require('../utils/response');
const { mergeMatrix, granted } = require('../utils/rbac');

async function getEffective(userId) {
  const { rows } = await db.query(
    `SELECT u.role AS db_role, m.user_id IS NOT NULL AS has_member, m.status, m.custom_permissions,
            r.permissions, COALESCE(r.is_super,false) AS is_super, r.status AS role_status
     FROM users u
     LEFT JOIN admin_members m ON m.user_id = u.id
     LEFT JOIN admin_roles r ON r.id = m.role_id AND NOT r.is_deleted
     WHERE u.id = $1 AND u.is_deleted = false`, [userId]);
  const x = rows[0];
  if (!x || x.db_role !== 'admin') return { allowed: false, status: 'revoked' };
  if (!x.has_member) return { allowed: true, isSuper: true, status: 'active' };
  if (x.is_super) return { allowed: true, isSuper: true, status: x.status };
  const base = x.role_status === 'Active' ? x.permissions : {};
  return { allowed: true, isSuper: false, status: x.status, matrix: mergeMatrix(base, x.custom_permissions) };
}

const requirePermission = (module, action) => async (req, res, next) => {
  try {
    const e = await getEffective(req.user?.id);
    if (!e.allowed) return sendError(res, 403, 'Admin access revoked');
    if (e.status !== 'active') return sendError(res, 403, `Admin account is ${e.status}`);
    if (e.isSuper || granted(e.matrix[module]?.[action])) return next();
    return sendError(res, 403, `Missing permission: ${module} → ${action}`);
  } catch (err) {
    return sendError(res, 500, 'Permission check failed', err.message);
  }
};

module.exports = { getEffective, requirePermission };
