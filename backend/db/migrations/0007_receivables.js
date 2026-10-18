// backend/db/migrations/0007_receivables.js
//
// Prompt 3. Additive only:
//  1. Receipts, allocations, cheques, AR reconciliation checks (db/receivablesSchema.js).
//  2. `cheques_in_portfolio` system account (new 1145 under 11) for
//     companies that already have a chart of accounts.
//  3. Grants the new permissions to every manage_permissions holder.

const { applyReceivablesSchema } = require('../receivablesSchema');

const PERMS = ['view_receivables', 'manage_receipts', 'override_credit_limit'];

module.exports.up = function up(db) {
  applyReceivablesSchema(db);
  const companies = db.prepare("SELECT DISTINCT company_id FROM accounts WHERE system_key = 'opening_balance_equity'").all().map((r) => r.company_id);
  for (const cid of companies) {
    if (db.prepare("SELECT 1 FROM accounts WHERE company_id = ? AND system_key = 'cheques_in_portfolio'").get(cid)) continue;
    const parent = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = '11' AND type = 'asset'").get(cid);
    let n = 1145;
    while (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(cid, String(n))) n++;
    if (parent) db.prepare('UPDATE accounts SET is_postable = 0 WHERE id = ?').run(parent.id);
    db.prepare(
      `INSERT INTO accounts (company_id, code, name_ar, name_en, parent_id, type, normal_balance, is_postable, is_active, is_system, system_key)
       VALUES (?, ?, 'شيكات برسم التحصيل', 'Cheques in portfolio', ?, 'asset', 'debit', 1, 1, 1, 'cheques_in_portfolio')`
    ).run(cid, String(n), parent ? parent.id : null);
  }
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
