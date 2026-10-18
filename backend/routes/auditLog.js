const express = require('express');
const db = require('../db/init');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(requirePermission('view_audit_log'));

router.get('/', (req, res) => {
  const { action, actorId, shopId, limit } = req.query;
  // Tenant isolation: a company only ever sees its own audit rows.
  const clauses = ['al.company_id = ?'];
  const params = [req.companyId];
  if (action) {
    clauses.push('al.action = ?');
    params.push(action);
  }
  if (actorId) {
    clauses.push('al.actor_id = ?');
    params.push(Number(actorId));
  }
  if (shopId) {
    clauses.push('al.shop_id = ?');
    params.push(Number(shopId));
  }
  // Payroll (Prompt 11-lite): payroll / advance audit rows are visible only
  // to holders of a payroll permission.
  const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  if (!perms.includes('manage_payroll_intake') && !perms.includes('approve_payroll_posting') && !perms.includes('manage_permissions')) {
    clauses.push("al.action NOT LIKE 'payroll.%'");
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const cap = Math.min(Number(limit) || 200, 500);

  const rows = db
    .prepare(
      `SELECT al.*, s.name AS shop_name
       FROM audit_log al
       LEFT JOIN shops s ON s.id = al.shop_id
       ${where}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT ?`
    )
    .all(...params, cap)
    .map((r) => ({
      ...r,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
    }));

  res.json(rows);
});

module.exports = router;
