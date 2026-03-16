/**
 * Authentication Middleware
 * Mirrors PHP session-based auth: if (!isset($_SESSION['uid'])) redirect
 */

function memberAuth(req, res, next) {
  if (!req.session || !req.session.uid) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
  }
  next();
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

module.exports = { memberAuth, adminAuth, adminRights };
