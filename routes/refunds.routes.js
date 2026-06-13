const express = require('express');
const router = express.Router();
const { sendSuccess, sendError } = require('../utils/response');
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');
const { notifySeller } = require('../utils/sellerEmailService');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfyoxmwwuwgvaevwlgzn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function getSupabaseHeaders() {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
}

function ensureSupabaseConfigured(res) {
  if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY not configured');
    res.status(500).json({ success: false, message: 'Server misconfiguration: Supabase service key not available' });
    return false;
  }
  return true;
}

// ─── GET /api/refunds/seller — Get seller's refund count ────────────────────
router.get('/seller', protect, isSeller, async (req, res) => {
  try {
    const sellerId = req.user.id;
    
    if (!ensureSupabaseConfigured(res)) return;

    const queryUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=id&seller_id=eq.${encodeURIComponent(sellerId)}&count=exact`;
    
    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        ...getSupabaseHeaders(),
        'Prefer': 'count=exact'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Supabase refund count fetch failed: ${response.status} ${response.statusText}`);
      // Return 0 count as fallback instead of error
      return sendSuccess(res, 200, 'Seller refunds fetched', { count: 0, refunds: [] });
    }

    const refundCases = await response.json();
    // Supabase returns an exact count in the Content-Range header when using Prefer: count=exact
    const contentRange = response.headers.get('content-range');
    let count = 0;
    if (contentRange) {
      // Format: 0-9/123  -> total is after '/'
      const parts = contentRange.split('/');
      if (parts.length === 2) {
        const parsed = parseInt(parts[1], 10);
        if (!Number.isNaN(parsed)) count = parsed;
      }
    }
    // Fallback to array length if header missing
    if (!count && Array.isArray(refundCases)) count = refundCases.length;

    console.log(`✅ Refund count fetched for seller ${sellerId}: ${count}`);
    return sendSuccess(res, 200, 'Seller refunds fetched successfully', {
      count,
      refunds: Array.isArray(refundCases) ? refundCases : []
    });
  } catch (error) {
    console.error('❌ Error in /api/refunds/seller:', error);
    // Return 0 count as fallback instead of error
    return sendSuccess(res, 200, 'Seller refunds fetched', { count: 0, refunds: [] });
  }
});

// ─── POST /api/refunds/create — Create refund case ───────────────────────────
router.post('/create', async (req, res) => {
  try {
    const {
      buyer_id,
      order_id,
      order_item_id,
      product_id,
      product_name,
      complaint_text,
      seller_id,
      evidence_url
    } = req.body;

    console.log('➡️ /api/refunds/create hit with body:', req.body);

    const requiredFields = ['buyer_id', 'order_id', 'order_item_id', 'product_id', 'product_name', 'complaint_text'];
    const missing = requiredFields.filter(field => !req.body[field]);
    if (missing.length > 0) {
      console.error('❌ Missing required refund fields:', missing);
      return res.status(400).json({ success: false, message: 'Missing required fields', missing });
    }

    if (!ensureSupabaseConfigured(res)) return;

    let resolvedSellerId = seller_id;
    if (!resolvedSellerId && order_id) {
      try {
        const orderItemsRes = await db.query(
          'SELECT seller_id FROM order_items WHERE order_id = $1 AND seller_id IS NOT NULL LIMIT 1',
          [order_id]
        );
        if (orderItemsRes.rows.length > 0) {
          resolvedSellerId = orderItemsRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from order_items:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from order_items:', err.message);
      }
    }

    if (!resolvedSellerId && product_name) {
      try {
        const productRes = await db.query(
          'SELECT seller_id FROM products WHERE name = $1 AND seller_id IS NOT NULL LIMIT 1',
          [product_name]
        );
        if (productRes.rows.length > 0) {
          resolvedSellerId = productRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from product record:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from product record:', err.message);
      }
    }

    if (!resolvedSellerId) {
      console.error('❌ Unable to resolve seller_id for refund create payload:', { order_id, product_name, receivedSellerId: seller_id });
      return res.status(400).json({ success: false, message: 'Unable to resolve seller_id for this order', details: { order_id, product_name } });
    }

    // Fetch buyer name and order item amount
    let buyerName = null;
    let totalAmount = 0;
    try {
      const buyerRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1', [buyer_id]);
      if (buyerRes.rows.length > 0) {
        const row = buyerRes.rows[0];
        buyerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || null;
      }

      const itemRes = await db.query(
        'SELECT quantity, price_at_purchase FROM order_items WHERE order_id = $1 AND id = $2',
        [order_id, order_item_id]
      );
      if (itemRes.rows.length > 0) {
        const row = itemRes.rows[0];
        totalAmount = (parseFloat(row.quantity) || 1) * (parseFloat(row.price_at_purchase) || 0);
      }
    } catch (err) {
      console.warn('⚠️ Could not fetch buyer name or amount:', err.message);
    }

    const refundPayload = {
      buyer_id,
      seller_id: resolvedSellerId,
      order_id: String(order_id),
      order_item_id: order_item_id || null,
      product_id: product_id || null,
      product_name,
      complaint_text,
      evidence_url: evidence_url || null,
      status: 'pending',
      resolution_status: 'pending',
      seller_marked_resolved: false,
      buyer_confirmed_resolution: false,
      escalated_to_marketmix: false,
      chat_started: false,
      seller_resolved_at: null,
      escalated_at: null,
      buyer_confirmed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('📦 Refund payload prepared for Supabase insert:', refundPayload);
    console.log('Final refund insert payload:', refundPayload);

    console.log('📦 Inserting refund case into Supabase:', refundPayload);

    const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases`, {
      method: 'POST',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(refundPayload)
    });

    const insertedData = await insertResponse.json().catch(async () => {
      const text = await insertResponse.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!insertResponse.ok) {
      console.error(`❌ Supabase insert failed: ${insertResponse.status} ${insertResponse.statusText}`);
      console.error('Supabase error body:', insertedData);
      return res.status(insertResponse.status).json({ success: false, message: 'Failed to create refund case', details: insertedData });
    }

    const refundCase = Array.isArray(insertedData) ? insertedData[0] : insertedData;
    if (!refundCase || !refundCase.id) {
      console.error('❌ Missing refund case ID after insert', insertedData);
      return res.status(500).json({ success: false, message: 'Refund case created but no ID returned' });
    }

    console.log('✅ Refund case inserted successfully:', { id: refundCase.id, buyer_id: refundCase.buyer_id, order_id: refundCase.order_id });

    if (resolvedSellerId) {
      notifySeller(resolvedSellerId, 'refundRequest', {
        orderId: order_id, buyerName: 'A buyer',
        productName: product_name, reason: complaint_text
      }).catch(() => {});
    }

    const buyerNotification = {
      user_id: buyer_id,
      title: 'Refund Case Created',
      message: `Your refund case for order ${order_id} has been created successfully.`,
      type: 'refund',
      link: '/buyers/buyers%20return%20report.html',
      is_read: false,
      is_deleted: false,
      created_at: new Date().toISOString()
    };

    console.log('📬 Inserting buyer notification');
    const buyerNotifResponse = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify(buyerNotification)
    });

    if (!buyerNotifResponse.ok) {
      const errorText = await buyerNotifResponse.text();
      console.error('⚠️ Failed to create buyer notification:', errorText);
    } else {
      console.log('✅ Buyer notification created successfully');
    }

    if (seller_id) {
      const sellerNotification = {
        user_id: seller_id,
        title: 'New Refund Request',
        message: `A refund request was submitted for order ${order_id}.`,
        type: 'refund',
        link: '/sellers/sellers%20returns.html',
        is_read: false,
        is_deleted: false,
        created_at: new Date().toISOString()
      };

      console.log('📬 Inserting seller notification');
      const sellerNotifResponse = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
        method: 'POST',
        headers: getSupabaseHeaders(),
        body: JSON.stringify(sellerNotification)
      });

      if (!sellerNotifResponse.ok) {
        const errorText = await sellerNotifResponse.text();
        console.error('⚠️ Failed to create seller notification:', errorText);
      } else {
        console.log('✅ Seller notification created successfully');
      }
    }

    return res.status(200).json({ success: true, refundCase });
  } catch (error) {
    console.error('❌ Error in /api/refunds/create:', error);
    console.error('Refund insert error:', error);
    console.error('Refund payload received:', req.body);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

async function fetchRefundCaseById(refundId) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(refundId)}&select=*`, {
    method: 'GET',
    headers: getSupabaseHeaders()
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unable to read Supabase response');
    throw new Error(`Supabase fetch failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

router.post('/chat-started', async (req, res) => {
  try {
    const { refund_id } = req.body;
    console.log('➡️ /api/refunds/chat-started hit with refund_id:', refund_id);

    if (!refund_id) {
      return res.status(400).json({ success: false, message: 'Missing refund_id' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const refundCase = await fetchRefundCaseById(refund_id);
    if (!refundCase) {
      return res.status(404).json({ success: false, message: 'Refund case not found' });
    }

    if (refundCase.chat_started) {
      console.log(`ℹ️ Chat already started for refund ${refund_id}`);
      return res.status(200).json({ success: true, message: 'Chat already started', refundCase });
    }

    const updatePayload = {
      chat_started: true,
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(refund_id)}`, {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updatePayload)
    });

    const updatedData = await response.json().catch(async () => {
      const text = await response.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!response.ok) {
      console.error(`❌ Failed updating chat_started for refund ${refund_id}: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to mark chat started', details: updatedData });
    }

    console.log(`✅ Chat started marked for refund ${refund_id}`);
    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/chat-started:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

router.post('/mark-resolved', async (req, res) => {
  try {
    const { refund_id } = req.body;
    console.log('➡️ /api/refunds/mark-resolved hit with refund_id:', refund_id);

    if (!refund_id) {
      return res.status(400).json({ success: false, message: 'Missing refund_id' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const updatePayload = {
      seller_marked_resolved: true,
      seller_resolved_at: new Date().toISOString(),
      resolution_status: 'waiting_buyer_confirmation',
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(refund_id)}`, {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updatePayload)
    });

    const updatedData = await response.json().catch(async () => {
      const text = await response.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!response.ok) {
      console.error(`❌ Failed marking refund ${refund_id} resolved by seller: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to mark refund resolved', details: updatedData });
    }

    console.log(`✅ Seller marked refund ${refund_id} resolved`);
    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/mark-resolved:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

router.post('/buyer-satisfied', async (req, res) => {
  try {
    const { refund_id } = req.body;
    console.log('➡️ /api/refunds/buyer-satisfied hit with refund_id:', refund_id);

    if (!refund_id) {
      return res.status(400).json({ success: false, message: 'Missing refund_id' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const updatePayload = {
      buyer_confirmed_resolution: true,
      buyer_confirmed_at: new Date().toISOString(),
      resolution_status: 'resolved',
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(refund_id)}`, {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updatePayload)
    });

    const updatedData = await response.json().catch(async () => {
      const text = await response.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!response.ok) {
      console.error(`❌ Failed confirming buyer satisfaction for refund ${refund_id}: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to confirm buyer satisfaction', details: updatedData });
    }

    console.log(`✅ Buyer confirmed resolution for refund ${refund_id}`);
    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/buyer-satisfied:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

router.post('/escalate', async (req, res) => {
  try {
    const { refund_id, escalated_by } = req.body;
    console.log('➡️ /api/refunds/escalate hit with refund_id:', refund_id, 'escalated_by:', escalated_by);

    if (!refund_id || !escalated_by) {
      return res.status(400).json({ success: false, message: 'Missing refund_id or escalated_by' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const updatePayload = {
      escalated_to_marketmix: true,
      escalated_at: new Date().toISOString(),
      resolution_status: 'escalated',
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(refund_id)}`, {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updatePayload)
    });

    const updatedData = await response.json().catch(async () => {
      const text = await response.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!response.ok) {
      console.error(`❌ Failed escalating refund ${refund_id}: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to escalate refund case', details: updatedData });
    }

    console.log(`✅ Refund ${refund_id} escalated to MarketMix by ${escalated_by}`);
    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/escalate:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ─── GET /api/refunds/buyer/:buyerId — Fetch buyer refund cases ─────────────
router.get('/buyer/:buyerId', async (req, res) => {
  try {
    const { buyerId } = req.params;
    console.log('➡️ /api/refunds/buyer/:buyerId hit for buyerId:', buyerId);
    if (!buyerId) {
      return res.status(400).json({ success: false, message: 'Missing buyerId parameter' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const queryUrl = `${SUPABASE_URL}/rest/v1/refund_cases?select=*&buyer_id=eq.${encodeURIComponent(buyerId)}&order=created_at.desc`;
    console.log('📦 Fetching refund cases from Supabase:', queryUrl);

    const response = await fetch(queryUrl, {
      method: 'GET',
      headers: getSupabaseHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Supabase refund fetch failed: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to fetch refund cases', details: errorText });
    }

    const refundCases = await response.json();
    console.log('✅ Refund cases fetched successfully:', refundCases.length);
    return res.status(200).json({ success: true, refundCases });
  } catch (error) {
    console.error('❌ Error in /api/refunds/buyer/:buyerId:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

router.patch('/:caseId/status', async (req, res) => {
  try {
    const { caseId } = req.params;
    const { status } = req.body;

    if (!caseId || !status) {
      return res.status(400).json({ success: false, message: 'Missing caseId or status' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    const updatePayload = {
      status,
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(caseId)}`, {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updatePayload)
    });

    const updatedData = await response.json().catch(async () => {
      const text = await response.text().catch(() => 'No body');
      return { errorBody: text };
    });

    if (!response.ok) {
      console.error(`❌ Supabase refund update failed: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ success: false, message: 'Failed to update refund case status', details: updatedData });
    }

    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/:caseId/status:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ─── GET /api/refunds/:refundId — Poll refund case for real-time updates ────
router.get('/:refundId', protect, async (req, res) => {
  try {
    const { refundId } = req.params;
    const userId = req.user.id;

    if (!refundId) {
      return res.status(400).json({ success: false, message: 'Missing refundId' });
    }

    if (!ensureSupabaseConfigured(res)) return;

    // Fetch refund case
    const caseRes = await fetch(`${SUPABASE_URL}/rest/v1/refund_cases?id=eq.${encodeURIComponent(refundId)}&select=*`, {
      method: 'GET',
      headers: getSupabaseHeaders()
    });

    if (!caseRes.ok) {
      const text = await caseRes.text().catch(() => 'Unable to read response');
      console.error(`❌ Failed to fetch refund case ${refundId}: ${caseRes.status}`);
      return res.status(caseRes.status).json({ success: false, message: 'Failed to fetch refund case', details: text });
    }

    const cases = await caseRes.json();
    const refundCase = Array.isArray(cases) && cases.length > 0 ? cases[0] : null;

    if (!refundCase) {
      return res.status(404).json({ success: false, message: 'Refund case not found' });
    }

    // Verify user has access (buyer, seller, or admin)
    if (req.user.role !== 'admin' && refundCase.buyer_id !== userId && refundCase.seller_id !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Count unread messages from other party
    let unreadCount = 0;
    try {
      let senderType = null;
      if (refundCase.buyer_id === userId) senderType = 'seller';
      else if (refundCase.seller_id === userId) senderType = 'buyer';
      else if (req.user.role === 'admin') senderType = 'all'; // admins see all unread

      let query = `SELECT COUNT(*) FROM refund_messages WHERE refund_case_id = '${refundId}' AND is_read = false`;
      if (senderType !== 'all') {
        query += ` AND sender_type = '${senderType}'`;
      }

      const countRes = await db.query(query);
      unreadCount = parseInt(countRes.rows[0]?.count || 0, 10);
    } catch (err) {
      console.warn('⚠️ Failed to count unread messages:', err.message);
    }

    console.log(`✅ Refund case ${refundId} fetched for polling. Unread: ${unreadCount}`);
    return res.status(200).json({
      success: true,
      refundCase: {
        ...refundCase,
        unreadCount
      }
    });
  } catch (error) {
    console.error('❌ Error in GET /api/refunds/:refundId:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

module.exports = router;
