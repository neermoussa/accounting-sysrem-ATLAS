// backend/db/migrations/0026_payroll.js
//
// Prompt 11-lite. Additive and idempotent: the payroll accounting tables
// (db/payrollSchema.js) and manage_payroll_intake / approve_payroll_posting
// for every manage_permissions holder. No system account is added: the
// accounts payroll posts to are chosen per company (payroll_settings).

const { applyPayrollSchema } = require('../payrollSchema');

const PERMS = ['manage_payroll_intake', 'approve_payroll_posting'];
module.exports.PERMS = PERMS;
module.exports.up = function up(db) {
  applyPayrollSchema(db);
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
