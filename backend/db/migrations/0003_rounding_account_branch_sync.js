// backend/db/migrations/0003_rounding_account_branch_sync.js
//
// 1. Re-applies db/ledgerSchema.js (IF NOT EXISTS) to add the
//    branches_json -> branches_ref sync triggers, then backfills
//    branches_ref for every company from its current branches_json.
// 2. Adds the `rounding_difference` system account (code 6850 under 6
//    when free) to every company that already has a chart of accounts from
//    a template but predates this key. Additive only; posted entries are
//    never touched. Companies without a chart get it when they apply a
//    template.

const { applyLedgerSchema } = require('../ledgerSchema');

module.exports.up = function up(db) {
  applyLedgerSchema(db);

  // Re-writing the same value fires the AFTER UPDATE trigger = backfill.
  db.exec('UPDATE companies SET branches_json = branches_json');

  const companies = db
    .prepare("SELECT DISTINCT company_id FROM accounts WHERE system_key = 'opening_balance_equity'")
    .all()
    .map((r) => r.company_id);
  for (const cid of companies) {
    if (db.prepare("SELECT 1 FROM accounts WHERE company_id = ? AND system_key = 'rounding_difference'").get(cid)) continue;
    const parent = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = '6' AND type = 'expense'").get(cid);
    let code = '6850';
    for (let n = 6850; db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(cid, code); n++) code = String(n + 1);
    if (parent) db.prepare('UPDATE accounts SET is_postable = 0 WHERE id = ?').run(parent.id);
    db.prepare(
      `INSERT INTO accounts (company_id, code, name_ar, name_en, parent_id, type, normal_balance, is_postable, is_active, is_system, system_key)
       VALUES (?, ?, 'فروقات التقريب', 'Rounding differences', ?, 'expense', 'debit', 1, 1, 1, 'rounding_difference')`
    ).run(cid, code, parent ? parent.id : null);
  }
};
