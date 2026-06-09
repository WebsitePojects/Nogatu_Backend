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

function memberAuth(req, res, next) {
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
function readonlyGuard(req, res, next) {
  if (req.session?.adminrole !== 'readonly') return next();
  if (req.method === 'GET') return next();
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
