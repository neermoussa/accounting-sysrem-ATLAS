// backend/db/migrations/0002_ledger_core.js
//
// Adds the double-entry ledger (currencies, chart of accounts, fiscal
// years/periods, cost centers, projects, branches_ref, journal entries/lines/
// attachments and the immutability triggers). Purely additive — the
// statements are shared with db/init.js via db/ledgerSchema.js and are all
// IF NOT EXISTS, so this is a no-op on a database that already has them.
//
// Also:
//  - seeds USD/SYP/EUR (+ the company's own base currency) for every
//    existing company, and
//  - grants the new ledger permissions to every user who already holds
//    manage_permissions (the company owner role), because on a fresh
//    company the owner receives every permission at creation and existing
//    owners would otherwise lose access to the new screens. Nobody else
//    gains anything.

const { applyLedgerSchema } = require('../ledgerSchema');

const LEDGER_PERMISSIONS = [
  'view_ledger',
  'manage_accounts',
  'post_journal_entries',
  'reverse_journal_entries',
  'manage_fiscal_periods',
  'lock_fiscal_periods',
  'manage_opening_balances',
];

module.exports.up = function up(db) {
  applyLedgerSchema(db);

  const { ensureCurrencies } = require('../../lib/ledgerCurrencies');
  for (const c of db.prepare('SELECT id FROM companies').all()) ensureCurrencies(db, c.id);

  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of LEDGER_PERMISSIONS) grant.run(o.user_id, p);
};
