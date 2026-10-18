// backend/db/migrations/0019_stock_ledger.js
//
// Prompt 8a. Additive and idempotent:
//  1. Stock ledger tables (db/stockSchema.js).
//  2. System accounts for companies that already have a chart:
//     inventory_custody 1155 under 11 (stock held by reps / vehicles),
//     inventory_adjustments 5800 under 5 (count and manual adjustments),
//     inventory_wastage = the food template's 5500 "Wastage and spoilage"
//     when untagged, else a new 5550 under 5 — next free code when taken.
//  3. Stock permissions for every manage_permissions holder.
// No stock is moved here: a company starts using the stock ledger only
// when it executes its activation (dry run first) — lib/stockLedger.js.

const { applyStockSchema } = require('../stockSchema');

const ACCOUNTS = [
  { key: 'inventory_custody', code: '1155', parent: '11', type: 'asset', normal: 'debit', cls: 'current_asset', ar: 'بضاعة لدى المندوبين والسيارات', en: 'Stock held by reps and vehicles' },
  { key: 'inventory_adjustments', code: '5800', parent: '5', type: 'expense', normal: 'debit', cls: 'cogs', ar: 'فروقات الجرد وتسويات المخزون', en: 'Inventory count and adjustment differences' },
  { key: 'inventory_wastage', code: '5550', parent: '5', type: 'expense', normal: 'debit', cls: 'cogs', ar: 'تالف وهدر المخزون', en: 'Inventory wastage and damage', adopt: '5500' },
];
const PERMS = ['view_stock_valuation', 'manage_stock_ledger'];

module.exports.up = function up(db) {
  applyStockSchema(db);
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
