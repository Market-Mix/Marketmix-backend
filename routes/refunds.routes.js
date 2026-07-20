const express = require('express');
const router = express.Router();
const { sendSuccess, sendError } = require('../utils/response');
const db = require('../config/db');
const { protect } = require('../middlewares/auth.middleware');
const { isSeller } = require('../middlewares/role.middleware');
const { notifySeller } = require('../utils/sellerEmailService');
const { notifyBuyer } = require('../utils/sellerEmailService');
const { createDedupedNotification } = require('../controllers/notification.controller');
const { getPaymentSummaryForRefundCase } = require('../services/refundPaymentPreparationService');

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

async function notifyRefundStakeholders({ refundCase, title, message, link = null }) {
  if (!refundCase) return;

  const targetUserIds = [];
  if (refundCase.buyer_id) targetUserIds.push(refundCase.buyer_id);
  if (refundCase.seller_id) targetUserIds.push(refundCase.seller_id);

  try {
    const adminRes = await db.query("SELECT id FROM users WHERE role = 'admin'");
    adminRes.rows.forEach(row => {
      if (row.id && !targetUserIds.includes(row.id)) {
        targetUserIds.push(row.id);
      }
    });
  } catch (err) {
    console.warn('⚠️ Could not resolve admin recipients for refund notification:', err.message);
  }

  await Promise.allSettled(targetUserIds.map(userId => createDedupedNotification({
    userId,
    title,
    message,
    type: 'refund',
    link
  })));
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
    if (!resolvedSellerId && order_item_id) {
      try {
        const itemSellerRes = await db.query(
          'SELECT seller_id FROM order_items WHERE id = $1 AND seller_id IS NOT NULL LIMIT 1',
          [order_item_id]
        );
        if (itemSellerRes.rows.length > 0) {
          resolvedSellerId = itemSellerRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from order_item_id:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from order_item_id:', err.message);
      }
    }

    if (!resolvedSellerId && order_id) {
      try {
        const orderItemsRes = await db.query(
          'SELECT seller_id FROM order_items WHERE order_id = $1 AND seller_id IS NOT NULL LIMIT 1',
          [order_id]
        );
        if (orderItemsRes.rows.length > 0) {
          resolvedSellerId = orderItemsRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from order_items by order_id:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from order_items:', err.message);
      }
    }

    if (!resolvedSellerId && product_id && order_id) {
      try {
        const orderItemRes = await db.query(
          'SELECT seller_id FROM order_items WHERE order_id = $1 AND product_id = $2 AND seller_id IS NOT NULL LIMIT 1',
          [order_id, product_id]
        );
        if (orderItemRes.rows.length > 0) {
          resolvedSellerId = orderItemRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from order_items by product_id:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from order_items by product_id:', err.message);
      }
    }

    if (!resolvedSellerId && product_id) {
      try {
        const productRes = await db.query(
          'SELECT seller_id FROM products WHERE id = $1 AND seller_id IS NOT NULL LIMIT 1',
          [product_id]
        );
        if (productRes.rows.length > 0) {
          resolvedSellerId = productRes.rows[0].seller_id;
          console.log('🔎 Resolved seller_id from product_id record:', resolvedSellerId);
        }
      } catch (err) {
        console.warn('⚠️ Could not resolve seller_id from product record using product_id:', err.message);
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
          console.log('🔎 Resolved seller_id from product record by product_name:', resolvedSellerId);
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

    // Resolve store/seller name for display in refund case to avoid relying on order enrichment later
    let storeName = null;
    let sellerName = null;
    try {
      // Try stores table first
      const storeRes = await db.query('SELECT business_name FROM stores WHERE (user_id = $1 OR id = $1) AND is_deleted = FALSE LIMIT 1', [resolvedSellerId]);
      if (storeRes.rows.length > 0 && storeRes.rows[0].business_name) {
        storeName = storeRes.rows[0].business_name;
      }
    } catch (e) {
      // ignore
    }
    if (!storeName) {
      try {
        const profileRes = await db.query('SELECT business_name FROM seller_profiles WHERE user_id = $1 AND is_deleted = FALSE LIMIT 1', [resolvedSellerId]);
        if (profileRes.rows.length > 0 && profileRes.rows[0].business_name) storeName = profileRes.rows[0].business_name;
      } catch (e) {}
    }
    if (!storeName) {
      try {
        const userRes = await db.query('SELECT first_name, last_name FROM users WHERE id = $1 LIMIT 1', [resolvedSellerId]);
        if (userRes.rows.length > 0) {
          const r = userRes.rows[0];
          sellerName = `${r.first_name || ''} ${r.last_name || ''}`.trim();
          storeName = sellerName || null;
        }
      } catch (e) {}
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
      total_amount: totalAmount,
      refund_amount: totalAmount,
      store_name: storeName || null,
      seller_name: sellerName || null,
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

    // Create a confirmation notification for the buyer in local notifications table
    try {
      await createDedupedNotification({
        userId: buyer_id,
        title: 'Refund Case Created',
        message: `Your refund case for order ${order_id} has been created successfully.`,
        type: 'refund',
        link: '/buyers/buyers%20return%20report.html',
        referenceId: refundCase.id
      });
    } catch (e) {
      console.warn('Could not create buyer notification:', e.message || e);
    }

    notifyBuyer(buyer_id, 'disputeOpened', {
      orderId: order_id,
      caseId: refundCase.id
    }).catch(() => {});

    if (seller_id) {
      try {
        await createDedupedNotification({
          userId: seller_id,
          title: 'New refund request received.',
          message: `A refund request was submitted for order ${order_id}.`,
          type: 'refund',
          link: '/sellers/sellers%20returns.html',
          referenceId: refundCase.id
        });
      } catch (e) {
        console.warn('Could not create seller notification:', e.message || e);
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
      // Notify buyer that seller confirmed receipt of returned product
      try {
        const updated = Array.isArray(updatedData) ? updatedData[0] : updatedData;
        if (updated && updated.buyer_id) {
          await createDedupedNotification({
            userId: updated.buyer_id,
            title: 'Product Received',
            message: 'The seller confirmed receiving your returned product.\n\nYour refund is now being processed.',
            type: 'refund',
            referenceId: refund_id,
            link: '/buyers/buyers%20return%20report.html'
          });
        }
      } catch (e) {
        console.warn('Could not create product-received notification:', e.message || e);
      }

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
      // Notify buyer and seller that refund has been completed
      try {
        const updated = Array.isArray(updatedData) ? updatedData[0] : updatedData;
        if (updated && updated.buyer_id) {
          await createDedupedNotification({
            userId: updated.buyer_id,
            title: 'Refund Completed',
            message: 'Your refund has been completed successfully.',
            type: 'refund',
            referenceId: refund_id,
            link: '/buyers/buyers%20return%20report.html'
          });
        }
        if (updated && updated.seller_id) {
          await createDedupedNotification({
            userId: updated.seller_id,
            title: 'Refund Completed',
            message: 'The refund process has been completed successfully.',
            type: 'refund',
            referenceId: refund_id,
            link: '/sellers/sellers%20returns.html'
          });
        }
      } catch (e) {
        console.warn('Could not create refund completed notifications:', e.message || e);
      }

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

    const refundCase = await fetchRefundCaseById(refund_id);
    if (!refundCase) {
      return res.status(404).json({ success: false, message: 'Refund case not found' });
    }

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

    // Notify buyer that refund has been escalated to MarketMix
    try {
      const updated = Array.isArray(updatedData) ? updatedData[0] : updatedData;
      if (updated && updated.buyer_id) {
        await createDedupedNotification({
          userId: updated.buyer_id,
          title: 'Refund Escalated to MarketMix',
          message: 'Your refund case has been escalated to MarketMix support for further review and resolution.',
          type: 'refund',
          referenceId: refund_id,
          link: '/buyers/buyers%20return%20report.html'
        });
      }
    } catch (e) {
      console.warn('Could not create escalation notification for buyer:', e.message || e);
    }

    return res.status(200).json({ success: true, refundCase: Array.isArray(updatedData) ? updatedData[0] : updatedData });
  } catch (error) {
    console.error('❌ Error in /api/refunds/escalate:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ─── GET /api/refunds/buyer/:buyerId — Fetch buyer refund cases ─────────────
router.get('/buyer/:buyerId', protect, async (req, res) => {
  try {
    const { buyerId } = req.params;
    const currentUserId = String(req.user?.id || '');

    console.log('➡️ /api/refunds/buyer/:buyerId hit for buyerId:', buyerId);
    console.log('Current buyer:', currentUserId);

    if (!buyerId) {
      return res.status(400).json({ success: false, message: 'Missing buyerId parameter' });
    }

    if (currentUserId !== String(buyerId)) {
      console.warn(`⚠️ Unauthorized refund fetch attempt: current user ${currentUserId} requested buyerId ${buyerId}`);
      return res.status(403).json({ success: false, message: 'Forbidden: buyer may only access their own refund cases' });
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
    const enrichedRefundCases = await Promise.all((refundCases || []).map(async (refundCase) => {
      try {
        const paymentSummary = await getPaymentSummaryForRefundCase(refundCase.id);
        return paymentSummary ? { ...refundCase, payment_summary: paymentSummary } : refundCase;
      } catch (err) {
        console.warn('⚠️ Could not enrich refund case with payment summary:', refundCase?.id, err.message || err);
        return refundCase;
      }
    }));

    console.log('Refund cases loaded:', enrichedRefundCases);
    console.log('Refund owners:', enrichedRefundCases.map(r => r.buyer_id));
    console.log('✅ Refund cases fetched successfully:', enrichedRefundCases.length);
    return res.status(200).json({ success: true, refundCases: enrichedRefundCases });
  } catch (error) {
    console.error('❌ Error in /api/refunds/buyer/:buyerId:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

router.post('/:refundId/shipment-update', protect, async (req, res) => {
  try {
    const { refundId } = req.params;
    const currentUserId = req.user?.id;
    const { courier_name, tracking_number, shipping_receipt_url, shipment_notes, notes } = req.body;

    if (!refundId) {
      return res.status(400).json({ success: false, message: 'Missing refundId' });
    }

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const refundCaseRes = await db.query('SELECT * FROM refund_cases WHERE id = $1 LIMIT 1', [refundId]);
    const refundCase = refundCaseRes.rows[0];

    if (!refundCase) {
      return res.status(404).json({ success: false, message: 'Refund case not found' });
    }

    if (refundCase.buyer_id !== currentUserId) {
      return res.status(403).json({ success: false, message: 'You can only update your own return shipment details' });
    }

    if (refundCase.return_received) {
      return res.status(409).json({ success: false, message: 'The seller has already received the return, so shipment details can no longer be updated' });
    }

    if (refundCase.seller_return_choice !== 'return_product') {
      return res.status(400).json({ success: false, message: 'Shipment update is only available for return-product cases' });
    }

    const trimmedCourier = typeof courier_name === 'string' ? courier_name.trim() : '';
    const trimmedTracking = typeof tracking_number === 'string' ? tracking_number.trim() : '';
    const trimmedReceiptUrl = typeof shipping_receipt_url === 'string' ? shipping_receipt_url.trim() : '';
    const trimmedNotes = typeof shipment_notes === 'string'
      ? shipment_notes.trim()
      : (typeof notes === 'string' ? notes.trim() : '');

    const hasShipmentPayload = trimmedCourier || trimmedTracking || trimmedReceiptUrl || trimmedNotes;
    if (!hasShipmentPayload) {
      return res.status(400).json({ success: false, message: 'Please provide at least one shipment detail' });
    }

    const alreadySubmitted = Boolean(
      refundCase.buyer_shipped_at ||
      refundCase.courier_name ||
      refundCase.tracking_number ||
      refundCase.shipping_receipt_url ||
      refundCase.shipment_notes ||
      refundCase.shipping_status
    );

    if (alreadySubmitted) {
      return res.status(409).json({ success: false, message: 'Shipment details have already been submitted for this refund case.' });
    }

    const timestamp = new Date().toISOString();
    const updateQuery = `
      UPDATE refund_cases
      SET updated_at = $1,
          resolution_status = $2,
          shipping_status = $3,
          buyer_shipped_at = $4,
          courier_name = COALESCE($5, courier_name),
          tracking_number = COALESCE($6, tracking_number),
          shipping_receipt_url = COALESCE($7, shipping_receipt_url),
          shipment_notes = COALESCE($8, shipment_notes)
      WHERE id = $9
      RETURNING *
    `;

    const updateValues = [timestamp, 'return_in_transit', 'in_transit', timestamp, trimmedCourier || null, trimmedTracking || null, trimmedReceiptUrl || null, trimmedNotes || null, refundId];
    const updateRes = await db.query(updateQuery, updateValues);
    const updatedCase = updateRes.rows[0];

    if (!updatedCase) {
      return res.status(500).json({ success: false, message: 'Failed to update shipment details' });
    }

    // Notify seller that buyer shipped the product
    try {
      if (updatedCase.seller_id) {
        await createDedupedNotification({
          userId: updatedCase.seller_id,
          title: 'Buyer Shipped Product',
          message: 'The buyer has shipped the returned product.\n\nPlease review the shipment information and confirm once received.',
          type: 'refund',
          referenceId: updatedCase.id,
          link: '/sellers/sellers%20returns.html'
        });
      }
    } catch (e) {
      console.warn('Could not create shipment notification for seller:', e.message || e);
    }

    return res.status(200).json({ success: true, refundCase: updatedCase });
  } catch (error) {
    console.error('❌ Error in POST /api/refunds/:refundId/shipment-update:', error);
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
