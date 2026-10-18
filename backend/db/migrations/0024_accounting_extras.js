// backend/db/migrations/0024_accounting_extras.js
//
// Prompt 10. Additive and idempotent:
//  1. Tax codes, fixed assets, recurring templates (db/accountingExtrasSchema.js).
//  2. manage_fixed_assets / manage_tax_codes / manage_recurring_entries for
//     every manage_permissions holder (same as 0022).
// No new system account: each asset category names its own asset,
// accumulated depreciation, expense and disposal gain/loss accounts.

const { applyAccountingExtrasSchema } = require('../accountingExtrasSchema');

const PERMS = ['manage_fixed_assets', 'manage_tax_codes', 'manage_recurring_entries'];
module.exports.PERMS = PERMS;
module.exports.up = function up(db) {
  applyAccountingExtrasSchema(db);
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
