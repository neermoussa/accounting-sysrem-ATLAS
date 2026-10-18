// backend/db/migrations/0010_financial_reports.js
//
// Prompt 4. Additive: budgets, budget_lines, report indexes
// (db/reportsSchema.js), and the new report permissions for every
// manage_permissions holder.

const { applyReportsSchema } = require('../reportsSchema');

const PERMS = ['view_financial_reports', 'manage_budgets', 'run_year_end_close'];

module.exports.up = function up(db) {
  applyReportsSchema(db);
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
