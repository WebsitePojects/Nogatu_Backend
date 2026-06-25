/**
 * Admin Access-Account Management (accesstab CRUD)
 *
 * Create / edit / remove the back-office login accounts that sign in through
 * /api/admin/auth/login. These are NOT members — they live in `accesstab`
 * (id, uid, username, password, name, rights, role).
 *
 * Access: Administrator (rights=1) and BOD (rights=3) only. Cashier (rights=2)
 * is intentionally excluded at the route AND in the frontend nav. A `readonly`
 * account is additionally blocked from every write by `readonlyGuard` mounted on
 * /api/admin in index.js, so it can open this page but never mutate it.
 *
 * Schema note: accesstab.id is NOT AUTO_INCREMENT (legacy PHP table). New rows
 * compute id = MAX(id)+1 under a named lock, and mirror uid = id (historical).
 * password is varchar(255) → bcrypt(60) fits. username char(15), name char(40).
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../../config/database');
const { adminAuth, adminRights } = require('../../middleware/auth');
const { writeAuditLog } = require('../../services/audit');

// role → rights mapping (must match routes/admin/auth.js semantics).
// readonly maps to rights=1 so it can VIEW admin pages, but readonlyGuard blocks
// all of its writes. Full-access roles are administrator + bod.
const ROLE_DEFS = {
  administrator: { rights: 1, label: 'Administrator' },
  bod:           { rights: 3, label: 'BOD' },
  cashier:       { rights: 2, label: 'Cashier' },
  readonly:      { rights: 1, label: 'Read Only' },
};
const FULL_ACCESS_ROLES = ['administrator', 'bod'];
const MIN_PASSWORD_LENGTH = 6;

// Same normalization the login route applies, so a created username can sign in.
function normalizeLegacyUsername(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[^A-Za-z0-9 ]/g, '');
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  // 'admin' is the legacy alias for administrator (auth.js normalizes it too).
  if (role === 'admin') return 'administrator';
  return ROLE_DEFS[role] ? role : null;
}

function actorContext(req) {
  return {
    actorUid: Number(req.session?.adminNumericId || 0) || null,
    actorRole: req.session?.adminrole || 'administrator',
    req,
  };
}

function shapeRow(row, req) {
  const role = normalizeRole(row.role) || (row.rights === 2 ? 'cashier' : row.rights === 3 ? 'bod' : 'administrator');
  return {
    id: Number(row.id),
    username: row.username,
    name: row.name,
    rights: Number(row.rights),
    role,
    roleLabel: ROLE_DEFS[role]?.label || 'Administrator',
    isSelf: Number(row.id) === Number(req.session?.adminNumericId || 0),
  };
}

// Count of remaining full-access accounts (administrator/bod, excluding readonly),
// optionally excluding a given id — used to prevent locking everyone out.
async function countFullAccessExcept(conn, excludeId = null) {
  const [[{ cnt }]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM accesstab
      WHERE rights IN (1, 3)
        AND LOWER(COALESCE(role, 'administrator')) IN ('administrator', 'bod', 'admin')
        ${excludeId ? 'AND id <> ?' : ''}`,
    excludeId ? [excludeId] : []
  );
  return Number(cnt || 0);
}

// All access routes: Administrator or BOD only. Cashier (rights=2) → 403.
router.use(adminAuth, adminRights([1, 3]));

/**
 * GET /api/admin/access-accounts
 * List every access account (never returns password).
 */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, name, rights, role FROM accesstab ORDER BY id ASC'
    );
    res.json({
      accounts: rows.map((row) => shapeRow(row, req)),
      roles: Object.entries(ROLE_DEFS).map(([value, def]) => ({ value, label: def.label, rights: def.rights })),
    });
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      // role column not migrated yet — fall back without it
      const [rows] = await pool.query('SELECT id, username, name, rights FROM accesstab ORDER BY id ASC');
      return res.json({
        accounts: rows.map((row) => shapeRow({ ...row, role: null }, req)),
        roles: Object.entries(ROLE_DEFS).map(([value, def]) => ({ value, label: def.label, rights: def.rights })),
      });
    }
    console.error('[Admin Access] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/access-accounts
 * Body: { username, name, password, role }
 */
router.post('/', async (req, res) => {
  const username = normalizeLegacyUsername(req.body?.username);
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  const role = normalizeRole(req.body?.role);

  if (!username || username.length < 3 || username.length > 15) {
    return res.status(400).json({ error: 'Username must be 3–15 letters/numbers (no spaces or symbols).' });
  }
  if (!name || name.length > 40) {
    return res.status(400).json({ error: 'Name is required (max 40 characters).' });
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (!role) {
    return res.status(400).json({ error: 'Select a valid role (Administrator, BOD, Cashier, or Read Only).' });
  }

  const rights = ROLE_DEFS[role].rights;
  const lockKey = 'nogatu_accesstab_write';
  const conn = await pool.getConnection();
  let lockAcquired = false;
  let txStarted = false;
  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS s', [lockKey]);
    lockAcquired = Number(lockRows[0]?.s || 0) === 1;
    if (!lockAcquired) throw new Error('Unable to create account right now. Please retry.');

    await conn.beginTransaction();
    txStarted = true;

    const [dupes] = await conn.query('SELECT id FROM accesstab WHERE username = ? LIMIT 1', [username]);
    if (dupes.length > 0) {
      await conn.rollback();
      txStarted = false;
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const [[{ nextId }]] = await conn.query('SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM accesstab');
    const hashed = await bcrypt.hash(password, 12);

    await conn.query(
      'INSERT INTO accesstab (id, uid, username, password, name, rights, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nextId, nextId, username, hashed, name, rights, role]
    );

    await writeAuditLog(conn, {
      ...actorContext(req),
      action: 'admin.access_account.create',
      targetTable: 'accesstab',
      targetId: nextId,
      afterState: { id: nextId, username, name, rights, role },
    });

    await conn.commit();
    txStarted = false;
    res.status(201).json({ success: true, account: shapeRow({ id: nextId, username, name, rights, role }, req) });
  } catch (err) {
    if (txStarted) await conn.rollback();
    console.error('[Admin Access] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (lockAcquired) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch { /* ignore */ }
    }
    conn.release();
  }
});

/**
 * PUT /api/admin/access-accounts/:id
 * Body: { name?, role?, password? } — only provided fields change.
 */
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid account reference.' });
  }

  const hasName = req.body?.name !== undefined;
  const hasRole = req.body?.role !== undefined;
  const hasPassword = typeof req.body?.password === 'string' && req.body.password.length > 0;

  const name = hasName ? String(req.body.name || '').trim() : null;
  const role = hasRole ? normalizeRole(req.body.role) : null;
  const password = hasPassword ? String(req.body.password) : null;

  if (hasName && (!name || name.length > 40)) {
    return res.status(400).json({ error: 'Name is required (max 40 characters).' });
  }
  if (hasRole && !role) {
    return res.status(400).json({ error: 'Select a valid role.' });
  }
  if (hasPassword && password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (!hasName && !hasRole && !hasPassword) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const conn = await pool.getConnection();
  let txStarted = false;
  try {
    await conn.beginTransaction();
    txStarted = true;

    const [rows] = await conn.query('SELECT id, username, name, rights, role FROM accesstab WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    const existing = rows[0];
    if (!existing) {
      await conn.rollback();
      txStarted = false;
      return res.status(404).json({ error: 'Account not found.' });
    }

    const existingRole = normalizeRole(existing.role) || (existing.rights === 2 ? 'cashier' : existing.rights === 3 ? 'bod' : 'administrator');

    // Guard: never demote the LAST full-access account (would lock everyone out
    // of admin-only functions). Applies whether or not it's your own account.
    if (hasRole && FULL_ACCESS_ROLES.includes(existingRole) && !FULL_ACCESS_ROLES.includes(role)) {
      const remaining = await countFullAccessExcept(conn, id);
      if (remaining === 0) {
        await conn.rollback();
        txStarted = false;
        return res.status(409).json({ error: 'Cannot change the role of the only full-access (Administrator/BOD) account.' });
      }
    }

    const updates = [];
    const params = [];
    if (hasName) { updates.push('name = ?'); params.push(name); }
    if (hasRole) { updates.push('role = ?', 'rights = ?'); params.push(role, ROLE_DEFS[role].rights); }
    if (hasPassword) { updates.push('password = ?'); params.push(await bcrypt.hash(password, 12)); }
    params.push(id);

    await conn.query(`UPDATE accesstab SET ${updates.join(', ')} WHERE id = ? LIMIT 1`, params);

    await writeAuditLog(conn, {
      ...actorContext(req),
      action: 'admin.access_account.update',
      targetTable: 'accesstab',
      targetId: id,
      beforeState: { name: existing.name, rights: existing.rights, role: existingRole },
      afterState: {
        name: hasName ? name : existing.name,
        rights: hasRole ? ROLE_DEFS[role].rights : existing.rights,
        role: hasRole ? role : existingRole,
        passwordChanged: hasPassword,
      },
    });

    await conn.commit();
    txStarted = false;

    const [updated] = await pool.query('SELECT id, username, name, rights, role FROM accesstab WHERE id = ? LIMIT 1', [id]);
    res.json({ success: true, account: shapeRow(updated[0], req) });
  } catch (err) {
    if (txStarted) await conn.rollback();
    console.error('[Admin Access] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /api/admin/access-accounts/:id
 */
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid account reference.' });
  }
  if (Number(id) === Number(req.session?.adminNumericId || 0)) {
    return res.status(409).json({ error: 'You cannot delete the account you are signed in with.' });
  }

  const conn = await pool.getConnection();
  let txStarted = false;
  try {
    await conn.beginTransaction();
    txStarted = true;

    const [rows] = await conn.query('SELECT id, username, name, rights, role FROM accesstab WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    const existing = rows[0];
    if (!existing) {
      await conn.rollback();
      txStarted = false;
      return res.status(404).json({ error: 'Account not found.' });
    }

    const existingRole = normalizeRole(existing.role) || (existing.rights === 2 ? 'cashier' : existing.rights === 3 ? 'bod' : 'administrator');
    if (FULL_ACCESS_ROLES.includes(existingRole)) {
      const remaining = await countFullAccessExcept(conn, id);
      if (remaining === 0) {
        await conn.rollback();
        txStarted = false;
        return res.status(409).json({ error: 'Cannot delete the only full-access (Administrator/BOD) account.' });
      }
    }

    await conn.query('DELETE FROM accesstab WHERE id = ? LIMIT 1', [id]);

    await writeAuditLog(conn, {
      ...actorContext(req),
      action: 'admin.access_account.delete',
      targetTable: 'accesstab',
      targetId: id,
      beforeState: { username: existing.username, name: existing.name, rights: existing.rights, role: existingRole },
    });

    await conn.commit();
    txStarted = false;
    res.json({ success: true });
  } catch (err) {
    if (txStarted) await conn.rollback();
    console.error('[Admin Access] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;
