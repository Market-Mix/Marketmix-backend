const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { sendSuccess, sendError } = require('../utils/response');

router.use(protect);

const CATS = ['general', 'order', 'payment', 'refund', 'account', 'product', 'technical', 'other'];

router.post('/tickets', async (req, res) => {
  try {
    const subject = String(req.body.subject || '').trim().slice(0, 200);
    const body = String(req.body.message || '').trim().slice(0, 5000);
    if (subject.length < 4 || body.length < 10) return sendError(res, 400, 'Subject and message are required');
    const category = CATS.includes(req.body.category) ? req.body.category : 'general';
    const ticket = await db.transaction(async client => {
      const t = (await client.query(
        `INSERT INTO support_tickets (user_id,subject,category,order_id)
         VALUES ($1,$2,$3,$4) RETURNING id, ticket_number`,
        [req.user.id, subject, category, req.body.orderId || null]
      )).rows[0];
      await client.query(
        `INSERT INTO support_messages (ticket_id,sender_id,sender_type,body)
         VALUES ($1,$2,'user',$3)`,
        [t.id, req.user.id, body]
      );
      await client.query(
        `INSERT INTO notifications (user_id,title,message,type,link,is_read,is_deleted,created_at,updated_at)
         SELECT id,'New Support Ticket',$1,'support',NULL,FALSE,FALSE,NOW(),NOW()
         FROM users WHERE role='admin' AND is_deleted=false`,
        [`New ticket: ${subject}`]
      );
      return t;
    });
    return sendSuccess(res, 201, 'Ticket created', {
      id: ticket.id,
      ticketNumber: `TKT-${String(ticket.ticket_number).padStart(5, '0')}`,
    });
  } catch (e) {
    return sendError(res, 500, 'Error creating ticket', e.message);
  }
});

router.get('/tickets', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, ticket_number, subject, category, status, priority, created_at, updated_at
       FROM support_tickets WHERE user_id=$1 AND NOT is_deleted ORDER BY updated_at DESC LIMIT 100`,
      [req.user.id]
    );
    return sendSuccess(res, 200, 'Tickets', { tickets: r.rows });
  } catch (e) {
    return sendError(res, 500, 'Error', e.message);
  }
});

router.get('/tickets/:id', async (req, res) => {
  try {
    const t = (await db.query(
      `SELECT * FROM support_tickets WHERE id=$1 AND user_id=$2 AND NOT is_deleted`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!t) return sendError(res, 404, 'Ticket not found');
    const m = (await db.query(
      `SELECT sender_type, body, attachments, created_at FROM support_messages
       WHERE ticket_id=$1 AND NOT is_internal AND sender_type<>'system' ORDER BY created_at`,
      [t.id]
    )).rows;
    return sendSuccess(res, 200, 'Ticket', { ticket: t, messages: m });
  } catch (e) {
    return sendError(res, 500, 'Error', e.message);
  }
});

router.post('/tickets/:id/reply', async (req, res) => {
  try {
    const body = String(req.body.message || '').trim().slice(0, 5000);
    if (!body) return sendError(res, 400, 'Message is required');
    const result = await db.transaction(async client => {
      const t = (await client.query(
        `SELECT id, status FROM support_tickets WHERE id=$1 AND user_id=$2 AND NOT is_deleted FOR UPDATE`,
        [req.params.id, req.user.id]
      )).rows[0];
      if (!t) return { statusCode: 404 };
      if (t.status === 'closed') return { statusCode: 409 };
      await client.query(
        `INSERT INTO support_messages (ticket_id,sender_id,sender_type,body)
         VALUES ($1,$2,'user',$3)`,
        [t.id, req.user.id, body]
      );
      await client.query(
        `UPDATE support_tickets SET status=CASE WHEN status IN ('waiting','resolved') THEN 'open' ELSE status END,
         resolved_at=NULL, updated_at=NOW() WHERE id=$1`,
        [t.id]
      );
      return { statusCode: 201 };
    });
    if (result.statusCode === 404) return sendError(res, 404, 'Ticket not found');
    if (result.statusCode === 409) return sendError(res, 409, 'Ticket is closed');
    return sendSuccess(res, 201, 'Reply sent');
  } catch (e) {
    return sendError(res, 500, 'Error', e.message);
  }
});

module.exports = router;
