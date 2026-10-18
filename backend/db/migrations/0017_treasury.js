// backend/db/migrations/0017_treasury.js
//
// Prompt 7. Additive and idempotent:
//  1. Treasury tables + cheques_received columns (db/treasurySchema.js).
//  2. System accounts for companies that already have a chart:
//     rep_cash_custody (1112 under 11), cheques_payable (2125 under 21),
//     cash_over_short (6960 under 6), bank_charges (the template's 6900
//     "Bank charges" when untagged, else a new 6910) — next free code when
//     the code is taken.
//  3. Treasury permissions for every manage_permissions holder.

const { applyTreasurySchema } = require('../treasurySchema');

const ACCOUNTS = [
  { key: 'rep_cash_custody', code: '1112', parent: '11', type: 'asset', normal: 'debit', cls: 'current_asset', ar: 'نقدية لدى المندوبين', en: 'Cash held by reps' },
  { key: 'cheques_payable', code: '2125', parent: '21', type: 'liability', normal: 'credit', cls: 'current_liability', ar: 'شيكات صادرة برسم الدفع', en: 'Cheques payable' },
  { key: 'cash_over_short', code: '6960', parent: '6', type: 'expense', normal: 'debit', cls: 'opex', ar: 'عجز وزيادة الصناديق', en: 'Cash over and short' },
  { key: 'bank_charges', code: '6910', parent: '6', type: 'expense', normal: 'debit', cls: 'opex', ar: 'مصاريف وعمولات بنكية', en: 'Bank charges', adopt: '6900' },
];
const PERMS = ['view_treasury', 'manage_cash_boxes', 'create_vouchers', 'approve_vouchers', 'manage_cheques', 'reconcile_bank'];

module.exports.up = function up(db) {
  applyTreasurySchema(db);
  const companies = db.prepare("SELECT DISTINCT company_id FROM accounts WHERE system_key = 'opening_balance_equity'").all().map((r) => r.company_id);
  for (const cid of companies) {
    for (const a of ACCOUNTS) {
      if (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND system_key = ?').get(cid, a.key)) continue;
      if (a.adopt) {
        const existing = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = ? AND type = 'expense' AND system_key IS NULL AND is_postable = 1").get(cid, a.adopt);
        if (existing) {
          db.prepare("UPDATE accounts SET system_key = ?, is_system = 1, updated_at = datetime('now') WHERE id = ?").run(a.key, existing.id);
          continue;
        }
      }
      const parent = db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ? AND type = ?').get(cid, a.parent, a.type);
      let n = Number(a.code);
      while (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(cid, String(n))) n += 1;
      if (parent) db.prepare('UPDATE accounts SET is_postable = 0 WHERE id = ?').run(parent.id);
      db.prepare(
        `INSERT INTO accounts (company_id, code, name_ar, name_en, parent_id, type, normal_balance, is_postable, is_active, is_system, system_key, report_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`
      ).run(cid, String(n), a.ar, a.en, parent ? parent.id : null, a.type, a.normal, a.key, a.cls);
    }
  }
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
