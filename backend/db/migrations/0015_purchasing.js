// backend/db/migrations/0015_purchasing.js
//
// Prompt 6. Additive: purchasing tables (db/purchasingSchema.js), the
// purchasing system accounts for companies that already have a chart
// (input_tax 1180 under 11, grni 2160 under 21, purchase_price_variance
// 5900 under 5 — next free code when taken), and the purchasing
// permissions for every manage_permissions holder.

const { applyPurchasingSchema } = require('../purchasingSchema');

const ACCOUNTS = [
  { key: 'input_tax', code: '1180', parent: '11', type: 'asset', normal: 'debit', cls: 'current_asset', ar: 'ضريبة المدخلات (المشتريات)', en: 'Input tax' },
  { key: 'grni', code: '2160', parent: '21', type: 'liability', normal: 'credit', cls: 'current_liability', ar: 'بضاعة مستلمة لم تصل فواتيرها', en: 'Goods received not invoiced (GRNI)' },
  { key: 'purchase_price_variance', code: '5900', parent: '5', type: 'expense', normal: 'debit', cls: 'cogs', ar: 'فروقات أسعار الشراء', en: 'Purchase price variance' },
];
const PERMS = ['view_purchases', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch', 'manage_suppliers'];

module.exports.up = function up(db) {
  applyPurchasingSchema(db);
  const companies = db.prepare("SELECT DISTINCT company_id FROM accounts WHERE system_key = 'opening_balance_equity'").all().map((r) => r.company_id);
  for (const cid of companies) {
    for (const a of ACCOUNTS) {
      if (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND system_key = ?').get(cid, a.key)) continue;
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
