// backend/db/migrations/0005_sales_documents.js
//
// Prompt 2. Additive only:
//  1. Sales documents + external balance snapshots (db/salesSchema.js).
//  2. New system accounts for companies that already have a chart:
//     output_tax (existing 2140), sales_returns (existing 4200) and
//     bank_in_transit (new 1115). An existing account is only tagged when
//     its code exists and the key is still free; otherwise a new account is
//     created under the matching header.
//  3. Grants the new sales permissions to every manage_permissions holder.

const { applySalesSchema } = require('../salesSchema');

const NEW_KEYS = [
  { key: 'output_tax', code: '2140', parent: '21', type: 'liability', normal: 'credit', nameAr: 'ضرائب ورسوم مستحقة', nameEn: 'Taxes payable' },
  { key: 'sales_returns', code: '4200', parent: '4', type: 'revenue', normal: 'debit', nameAr: 'مردودات ومسموحات المبيعات', nameEn: 'Sales returns and allowances' },
  { key: 'bank_in_transit', code: '1115', parent: '11', type: 'asset', normal: 'debit', nameAr: 'حوالات قيد التحصيل', nameEn: 'Transfers in transit' },
];
const SALES_PERMISSIONS = ['view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'];

module.exports.up = function up(db) {
  applySalesSchema(db);

  const companies = db
    .prepare("SELECT DISTINCT company_id FROM accounts WHERE system_key = 'opening_balance_equity'")
    .all()
    .map((r) => r.company_id);
  for (const cid of companies) {
    for (const k of NEW_KEYS) {
      if (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND system_key = ?').get(cid, k.key)) continue;
      const existing = db.prepare('SELECT * FROM accounts WHERE company_id = ? AND code = ?').get(cid, k.code);
      if (existing && existing.type === k.type && existing.is_postable && !existing.system_key) {
        db.prepare('UPDATE accounts SET system_key = ?, is_system = 1, is_active = 1 WHERE id = ?').run(k.key, existing.id);
        continue;
      }
      const parent = db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ? AND type = ?').get(cid, k.parent, k.type);
      let n = Number(k.code);
      while (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(cid, String(n))) n++;
      if (parent) db.prepare('UPDATE accounts SET is_postable = 0 WHERE id = ?').run(parent.id);
      db.prepare(
        `INSERT INTO accounts (company_id, code, name_ar, name_en, parent_id, type, normal_balance, is_postable, is_active, is_system, system_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?)`
      ).run(cid, String(n), k.nameAr, k.nameEn, parent ? parent.id : null, k.type, k.normal, k.key);
    }
  }

  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of SALES_PERMISSIONS) grant.run(o.user_id, p);
};
