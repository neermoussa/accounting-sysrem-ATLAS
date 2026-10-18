const { SESSION_COOKIE, getUserBySessionToken } = require('../lib/auth');
const { getUserPermissions } = require('../lib/permissions');
const db = require('../db/init');

// Re-reads status AND permissions from the DB on every single request (not
// just at login) — so an admin revoking a permission takes effect on that
// user's very next request, even mid-session, the same way account
// rejection already invalidates a live session immediately.
function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const user = getUserBySessionToken(token);
  if (!user || user.status !== 'approved') {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  req.user = user;
  req.user.permissions = user.is_platform_admin ? [] : getUserPermissions(user.id);
  next();
}

// Every tenant-scoped route needs this on top of requireAuth: it's the one
// place that turns "who is logged in" into "which company's data this
// request is allowed to touch" (req.companyId), and rejects outright if the
// account has none (a platform-admin account, or a mis-provisioned user) —
// so a route can never accidentally fall through to an unscoped, all-company
// query just because req.companyId was undefined instead of a real id.
function requireCompany(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.user) return;
    if (!req.user.company_id) {
      return res.status(403).json({ error: 'no_company_context' });
    }
    // A platform admin suspending a company's subscription must actually
    // lock that company out, not just show a badge on the platform-admin
    // screen — checked fresh on every request (like status/permissions
    // above) so a mid-session suspension takes effect immediately.
    const subscriptionStatus = db
      .prepare('SELECT subscription_status FROM companies WHERE id = ?')
      .get(req.user.company_id)?.subscription_status;
    if (subscriptionStatus === 'suspended') {
      return res.status(403).json({ error: 'subscription_suspended' });
    }
    req.companyId = req.user.company_id;
    next();
  });
}

// The platform-admin surface (routes/platformAdmin.js) is a completely
// separate gate from the company permission system on purpose — a company
// manager can hold every permission there is inside their own company and
// still never pass this check, because it looks at `is_platform_admin`
// only, never at `permissions`.
function requirePlatformAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.user) return;
    if (!req.user.is_platform_admin) {
      return res.status(403).json({ error: 'platform_admin_only' });
    }
    next();
  });
}

// Every permission gate below also runs requireCompany, not just
// requireAuth — a company-scoped permission is meaningless without
// req.companyId also being set, and this is the single choke point that
// guarantees every route registered behind requirePermission/
// requireAnyPermission/requireAllPermissions gets it, with no per-route
// opt-in to remember (and no way to forget it).
function requirePermission(permission) {
  return function (req, res, next) {
    requireCompany(req, res, (err) => {
      if (err) return next(err);
      if (!req.user) return; // requireCompany already responded
      if (!req.user.permissions.includes(permission)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      next();
    });
  };
}

function requireAnyPermission(...permissions) {
  return function (req, res, next) {
    requireCompany(req, res, (err) => {
      if (err) return next(err);
      if (!req.user) return;
      const allowed = permissions.some((p) => req.user.permissions.includes(p));
      if (!allowed) return res.status(403).json({ error: 'forbidden' });
      next();
    });
  };
}

// AND-composition — used to layer a second, narrower gate on top of a
// router-wide requirePermission (e.g. an export route needs both the
// section's own view/manage permission AND export_data).
function requireAllPermissions(...permissions) {
  return function (req, res, next) {
    requireCompany(req, res, (err) => {
      if (err) return next(err);
      if (!req.user) return;
      const allowed = permissions.every((p) => req.user.permissions.includes(p));
      if (!allowed) return res.status(403).json({ error: 'forbidden' });
      next();
    });
  };
}

// Stricter than any grantable permission: some actions (editing inventory
// quantities/thresholds) are meant to stay with the actual admin account
// type, not something an admin could hand out via the permission system —
// so this checks the user's fixed `role` column instead of `permissions`.
// 'manager' is the company-owner role every company's first account gets
// at creation (lib/companies.js createCompanyWithAdmin) in the
// multi-tenant schema — the direct successor to the pre-multi-tenant
// 'admin' role this check predates, so it counts here too.
function requireAdminRole(req, res, next) {
  requireCompany(req, res, (err) => {
    if (err) return next(err);
    if (!req.user) return;
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(403).json({ error: 'admin_only' });
    }
    next();
  });
}

module.exports = {
  requireAuth,
  requireCompany,
  requirePlatformAdmin,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  requireAdminRole,
};
