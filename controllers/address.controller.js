const db = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const { requireActiveSession } = require('./checkout.controller');

// ─── GET /api/checkout/addresses ────────────────────────────────────────────

const getAddresses = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT id, full_name, phone, address_line1, address_line2,
              city, state, country, postal_code,
              delivery_instructions, is_default, created_at
       FROM addresses
       WHERE user_id = $1 AND is_deleted = false
       ORDER BY is_default DESC, created_at DESC`,
      [userId]
    );

    return sendSuccess(res, 200, 'Addresses fetched', {
      addresses: result.rows,
    });
  } catch (err) {
    console.error('getAddresses error:', err);
    return sendError(res, 500, 'Error fetching addresses', err.message);
  }
};

// ─── POST /api/checkout/addresses ───────────────────────────────────────────

const createAddress = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      full_name,
      phone,
      address_line1,
      address_line2,
      city,
      state,
      country         = 'Nigeria',
      postal_code,
      delivery_instructions,
      is_default      = false,
    } = req.body;

    if (!full_name || !address_line1 || !city || !state) {
      return sendError(
        res, 400,
        'full_name, address_line1, city, and state are required'
      );
    }

    // If new address is default, unset all others
    if (is_default) {
      await db.query(
        `UPDATE addresses SET is_default = false, updated_at = NOW()
         WHERE user_id = $1 AND is_deleted = false`,
        [userId]
      );
    }

    // If this is the user's first address, make it default automatically
    const countRes = await db.query(
      `SELECT COUNT(*) FROM addresses
       WHERE user_id = $1 AND is_deleted = false`,
      [userId]
    );
    const makeDefault = is_default || parseInt(countRes.rows[0].count) === 0;

    const result = await db.query(
      `INSERT INTO addresses
         (user_id, full_name, phone, address_line1, address_line2,
          city, state, country, postal_code, delivery_instructions, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        userId, full_name, phone || null, address_line1, address_line2 || null,
        city, state, country, postal_code || null,
        delivery_instructions || null, makeDefault,
      ]
    );

    return sendSuccess(res, 201, 'Address saved', {
      address: result.rows[0],
    });
  } catch (err) {
    console.error('createAddress error:', err);
    return sendError(res, 500, 'Error saving address', err.message);
  }
};

// ─── PUT /api/checkout/addresses/:addressId ──────────────────────────────────

const updateAddress = async (req, res) => {
  try {
    const userId    = req.user.id;
    const { addressId } = req.params;
    const {
      full_name, phone, address_line1, address_line2,
      city, state, country, postal_code,
      delivery_instructions, is_default,
    } = req.body;

    const check = await db.query(
      `SELECT id FROM addresses
       WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
      [addressId, userId]
    );
    if (!check.rows.length) {
      return sendError(res, 404, 'Address not found');
    }

    if (is_default) {
      await db.query(
        `UPDATE addresses SET is_default = false, updated_at = NOW()
         WHERE user_id = $1 AND is_deleted = false`,
        [userId]
      );
    }

    const result = await db.query(
      `UPDATE addresses
       SET full_name             = COALESCE($1, full_name),
           phone                 = COALESCE($2, phone),
           address_line1         = COALESCE($3, address_line1),
           address_line2         = COALESCE($4, address_line2),
           city                  = COALESCE($5, city),
           state                 = COALESCE($6, state),
           country               = COALESCE($7, country),
           postal_code           = COALESCE($8, postal_code),
           delivery_instructions = COALESCE($9, delivery_instructions),
           is_default            = COALESCE($10, is_default),
           updated_at            = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        full_name, phone, address_line1, address_line2,
        city, state, country, postal_code,
        delivery_instructions,
        is_default !== undefined ? is_default : null,
        addressId,
      ]
    );

    return sendSuccess(res, 200, 'Address updated', {
      address: result.rows[0],
    });
  } catch (err) {
    console.error('updateAddress error:', err);
    return sendError(res, 500, 'Error updating address', err.message);
  }
};

// ─── DELETE /api/checkout/addresses/:addressId ───────────────────────────────

const deleteAddress = async (req, res) => {
  try {
    const userId    = req.user.id;
    const { addressId } = req.params;

    await db.query(
      `UPDATE addresses SET is_deleted = true, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [addressId, userId]
    );

    return sendSuccess(res, 200, 'Address deleted');
  } catch (err) {
    console.error('deleteAddress error:', err);
    return sendError(res, 500, 'Error deleting address', err.message);
  }
};

// ─── POST /api/checkout/session/:sessionId/address ───────────────────────────
/**
 * Attach a saved address (or create + attach inline) to a checkout session.
 * Body: { address_id } OR a full address object to create on the fly.
 */
const setSessionAddress = async (req, res) => {
  try {
    const userId    = req.user.id;
    const sessionId = req.params.sessionId;

    const session = await requireActiveSession(sessionId, userId);
    if (!session) {
      return sendError(res, 404, 'Checkout session not found or expired');
    }

    let addressId = req.body.address_id;

    // Inline address creation
    if (!addressId) {
      const {
        full_name, phone, address_line1, address_line2,
        city, state, country = 'Nigeria', postal_code,
        delivery_instructions, save_address = false,
      } = req.body;

      if (!full_name || !address_line1 || !city || !state) {
        return sendError(
          res, 400,
          'full_name, address_line1, city, and state are required'
        );
      }

      const countRes = await db.query(
        `SELECT COUNT(*) FROM addresses WHERE user_id=$1 AND is_deleted=false`,
        [userId]
      );
      const isFirst = parseInt(countRes.rows[0].count) === 0;

      const newAddr = await db.query(
        `INSERT INTO addresses
           (user_id, full_name, phone, address_line1, address_line2,
            city, state, country, postal_code, delivery_instructions,
            is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          userId, full_name, phone || null, address_line1, address_line2 || null,
          city, state, country, postal_code || null,
          delivery_instructions || null, isFirst || save_address,
        ]
      );

      addressId = newAddr.rows[0].id;
    }

    // Verify address belongs to user
    const addrRes = await db.query(
      `SELECT * FROM addresses
       WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
      [addressId, userId]
    );
    if (!addrRes.rows.length) {
      return sendError(res, 404, 'Address not found');
    }

    const addr = addrRes.rows[0];
    const addressSnapshot = {
      full_name:             addr.full_name,
      phone:                 addr.phone,
      address_line1:         addr.address_line1,
      address_line2:         addr.address_line2,
      city:                  addr.city,
      state:                 addr.state,
      country:               addr.country,
      postal_code:           addr.postal_code,
      delivery_instructions: addr.delivery_instructions,
    };

   // controllers/address.controller.js — setSessionAddress
const updateResult = await db.query(
  `UPDATE checkout_sessions
   SET address_id       = $1,
       address_snapshot = $2,
       status           = CASE WHEN status = 'pending'
                           THEN 'address_set'
                           ELSE status END,
       updated_at       = NOW()
   WHERE id = $3
   RETURNING id, address_id`,   // ← add RETURNING
  [addressId, JSON.stringify(addressSnapshot), sessionId]
);

if (!updateResult.rows.length) {
  return sendError(res, 500, 'Failed to attach address to session');
}

    return sendSuccess(res, 200, 'Address set on session', {
      addressId,
      address: addressSnapshot,
      nextStep: 'delivery',
    });

  } catch (err) {
    console.error('setSessionAddress error:', err);
    return sendError(res, 500, 'Error setting address', err.message);
  }
};

module.exports = {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setSessionAddress,
};