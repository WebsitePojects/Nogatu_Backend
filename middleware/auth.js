/**
 * Authentication Middleware
 * Mirrors PHP session-based auth: if (!isset($_SESSION['uid'])) redirect
 */

const { pool } = require('../config/database');

async function enforceMemberAccountStatus(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT account_status, account_status_reason
         FROM usertab
        WHERE uid = ?
        LIMIT 1`,
      [req.session.uid]
    );

    const status = String(rows[0]?.account_status || 'active').trim().toLowerCase();
    if (status === 'active' || !status) {
      req.session.accountStatus = 'active';
      req.session.accountStatusReason = null;
      return true;
    }

    const reason = rows[0]?.account_status_reason || null;
    req.session.destroy(() => {});
    res.status(423).json({
      error: status === 'frozen'
        ? 'This account is frozen. Please contact support or your administrator.'
        : 'This account is suspended. Please contact support or your administrator.',
      accountStatus: status,
      reason,
    });
    return false;
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      return true;
    }
    throw error;
  }
}

/**
 * Admin read-only "view as member": an authenticated admin may browse a member's
 * OWN interface by sending the X-View-As-Member: <uid> header. Returns the target
 * uid only when there is NO real member session (so a logged-in member can never be
 * impersonated) AND a valid admin session exists. Anything else → null.
 */
function resolveAdminViewAs(req) {
  if (req.session?.uid) return null;       // a real member session always wins
  if (!req.session?.adminid) return null;  // must be an authenticated admin
  // Cashier (rights=2) is scoped to voucher endpoints only — never let them
  // read a member's interface via the view-as header. Administrator/BOD only.
  if (![1, 3].includes(Number(req.session?.adminrights))) return null;
  const target = Number(req.get('x-view-as-member') || 0);
  return Number.isInteger(target) && target > 0 ? target : null;
}

function memberAuth(req, res, next) {
  // Defense in depth (independent of express-session save timing): a clean member
  // session NEVER carries adminid. If both uid and adminid are present, a prior
  // view-as override leaked onto the admin session — never honor it as a real member
  // login (which would allow writes). Strip it so the request is re-evaluated under
  // the GET-only view-as rules below, where writes are always blocked.
  if (req.session && req.session.adminid && req.session.uid) {
    req.session.uid = undefined;
  }

  // Read-only admin view-as. GET-only (read-only by construction); the uid override
  // is request-scoped and RESTORED before express-session persists, so the admin's
  // own session is never mutated and no member write path is ever reachable.
  const viewAsUid = resolveAdminViewAs(req);
  if (viewAsUid) {
    if (req.method !== 'GET') {
      return res.status(403).json({ error: 'Read-only admin view — changes are disabled.', code: 'VIEW_AS_READONLY' });
    }
    const originalUid = req.session.uid;
    req.session.uid = viewAsUid;
    req.isAdminViewAs = true;
    const origEnd = res.end;
    res.end = function restoreThenEnd(...args) {
      // Runs BEFORE express-session's own res.end wrapper (mounted earlier), so the
      // override is undone before the session is written back to the store.
      try { req.session.uid = originalUid; } catch { /* session gone — ignore */ }
      return origEnd.apply(this, args);
    };
    return next();
  }

  if (!req.session || !req.session.uid) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
  }
  enforceMemberAccountStatus(req, res)
    .then((allowed) => {
      if (allowed) next();
    })
    .catch((error) => {
      console.error('[Auth] Member status enforcement error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });
}

function adminAuth(req, res, next) {
  if (!req.session || !req.session.adminid) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/admin/login' });
  }
  next();
}

function adminRights(allowedRights) {
  return (req, res, next) => {
    if (!allowedRights.includes(req.session.adminrights)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

// Blocks all non-GET requests for readonly admin accounts.
// Mount this BEFORE admin routes in index.js.
// Role values: 'administrator', 'cashier', 'bod', 'readonly' (or legacy 'admin').
function readonlyGuard(req, res, next) {
  const role = req.session?.adminrole;
  if (role !== 'readonly') return next();
  if (req.method === 'GET') return next();
  // Always allow logout so readonly accounts can sign out
  if (req.originalUrl.includes('/auth/logout')) return next();
  return res.status(403).json({
    error: 'This account is read-only. No changes can be made.',
    code: 'READONLY_ACCOUNT',
  });
}

function requireSelfParam(paramName = 'uid') {
  return (req, res, next) => {
    const requestedUid = Number(req.params[paramName] || req.query[paramName] || req.body[paramName]);
    if (!req.session || !req.session.uid) {
      return res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
    }
    if (!requestedUid || Number(req.session.uid) !== requestedUid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

function adminOrMemberSelf(paramName = 'uid') {
  return (req, res, next) => {
    if (req.session?.adminid) return next();
    return requireSelfParam(paramName)(req, res, next);
  };
}

module.exports = { memberAuth, adminAuth, adminRights, readonlyGuard, requireSelfParam, adminOrMemberSelf };
