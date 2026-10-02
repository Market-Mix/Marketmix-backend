const db = require('../config/db');
const sendEmail = require('../utils/sendEmail');
const FRONTEND = process.env.FRONTEND_URL || 'https://marketmix.vercel.app';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function audienceFilter(b) {
  if (b.audience === 'individual') return { where: 'u.id = $1', params: [b.target_user_id] };
  const map = { all: 'TRUE', buyers: `u.role='buyer'`, sellers: `u.role='seller'`, admins: `u.role='admin'` };
  return { where: map[b.audience] || 'FALSE', params: [] };
}

function emailHtml(b, u) {
  const href = b.link ? (b.link.startsWith('http') ? b.link : FRONTEND + encodeURI(b.link)) : null;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
    ${b.banner_url ? `<img src="${esc(b.banner_url)}" style="width:100%;border-radius:8px">` : ''}
    <h2>${esc(b.title)}</h2><p>Hi ${esc(u.first_name || 'there')},</p>
    <p>${esc(b.message).replace(/\n/g, '<br>')}</p>
    ${href ? `<p><a href="${href}" style="background:#FF7A00;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">View</a></p>` : ''}
  </div>`;
}

async function run(b) {
  try {
    const { where, params } = audienceFilter(b);
    const base = `FROM users u WHERE u.is_deleted=false AND ${where}`;
    const n = params.length;
    const recipients = (await db.query(`SELECT COUNT(*)::int c ${base}`, params)).rows[0].c;
    let inApp = 0, emailOk = 0, emailFail = 0;

    if (['in_app', 'both'].includes(b.channel)) {
      const r = await db.query(
        `INSERT INTO notifications (user_id,title,message,type,link,data,is_read,is_deleted,created_at,updated_at)
         SELECT u.id, $${n + 1}::text, $${n + 2}::text, 'info', $${n + 3}::text,
                jsonb_build_object('broadcast_id',$${n + 4}::text,'banner_url',$${n + 5}::text,'priority',$${n + 6}::text),
                FALSE, FALSE, NOW(), NOW() ${base}`,
        [...params, b.title, b.message, b.link, b.id, b.banner_url, b.priority]
      );
      inApp = r.rowCount;
    }

    if (['email', 'both'].includes(b.channel)) {
      const users = (await db.query(
        `SELECT u.email, u.first_name ${base} AND COALESCE(u.email_notifications,true)`, params
      )).rows;
      for (let i = 0; i < users.length; i += 20) {
        const res = await Promise.allSettled(users.slice(i, i + 20).map(u =>
          sendEmail({ to: u.email, subject: b.subject || b.title, html: emailHtml(b, u) })));
        res.forEach(r => r.status === 'fulfilled' ? emailOk++ : emailFail++);
      }
    }

    const delivered = b.channel === 'email' ? emailOk : inApp;
    const status = recipients > 0 && delivered === 0 ? 'failed' : 'sent';
    await db.query(
      `UPDATE admin_notifications SET status=$1, sent_at=NOW(), recipients=$2, delivered=$3, failed=$4,
         error_message=$5, updated_at=NOW() WHERE id=$6`,
      [status, recipients, delivered, emailFail, status === 'failed' ? 'No recipients reached' : null, b.id]
    );
  } catch (err) {
    console.error('Broadcast run error:', b.id, err.message);
    await db.query(`UPDATE admin_notifications SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2`,
      [err.message, b.id]
    );
  }
}

async function dispatch(id) {
  const c = await db.query(
    `UPDATE admin_notifications SET status='sending', updated_at=NOW()
     WHERE id=$1 AND status IN ('draft','scheduled') AND is_deleted=false RETURNING *`, [id]
  );
  if (!c.rows.length) return null;
  return run(c.rows[0]);
}

async function processDue() {
  const c = await db.query(
    `UPDATE admin_notifications SET status='sending', updated_at=NOW()
     WHERE id IN (SELECT id FROM admin_notifications
                  WHERE status='scheduled' AND scheduled_for<=NOW() AND is_deleted=false
                  ORDER BY scheduled_for LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`
  );
  for (const b of c.rows) await run(b);
  return c.rows.length;
}

module.exports = { dispatch, processDue };
