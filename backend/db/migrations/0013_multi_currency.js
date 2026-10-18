// backend/db/migrations/0013_multi_currency.js
//
// Prompt 5. Additive: exchange_rates, fx_settlements, fx_revaluations, and
// currency/rate/base columns on invoices, credit notes, receipts and
// allocations (db/currencySchema.js). Existing rows keep NULL = base
// currency at rate 1. New permissions go to every manage_permissions holder.

const { applyCurrencySchema } = require('../currencySchema');

const PERMS = ['manage_exchange_rates', 'override_exchange_rate', 'run_fx_revaluation'];

module.exports.up = function up(db) {
  applyCurrencySchema(db);
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
