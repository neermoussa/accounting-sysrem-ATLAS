// backend/db/migrations/0022_manufacturing.js
//
// Prompt 9. Additive and idempotent:
//  1. Manufacturing tables (db/manufacturingSchema.js).
//  2. System accounts for companies that already have a chart:
//     wip                 work in process — adopts the food template's
//                         untagged 1152 "إنتاج تحت التشغيل", else 1157 under 11;
//     production_labour   labour absorbed into production (credit side;
//                         payroll debits it later) — adopts 5300, else 5310;
//     production_overhead overhead absorbed — adopts 5400, else 5410;
//     production_energy   energy absorbed — 5450.
//     Next free code when the planned one is taken.
//  3. Manufacturing permissions for every manage_permissions holder.
//  4. Widened CHECK lists (table rebuild, same procedure as 0009, foreign
//     keys OFF, row counts verified, indexes re-created):
//     stock_moves.move_type      + production_issue / _return / _output / _byproduct
//     sync_operations.entity_type + production_issue / _output / _wastage
//     The new table text is the stored definition with the list extended,
//     identical to what db/stockSchema.js and db/init.js create fresh.

const { applyManufacturingSchema } = require('../manufacturingSchema');

const ACCOUNTS = [
  { key: 'wip', code: '1157', parent: '11', type: 'asset', normal: 'debit', cls: 'current_asset', ar: 'إنتاج تحت التشغيل', en: 'Work in process', adopt: '1152' },
  { key: 'production_labour', code: '5310', parent: '5', type: 'expense', normal: 'debit', cls: 'cogs', ar: 'أجور الإنتاج المحمّلة', en: 'Production labour absorbed', adopt: '5300' },
  { key: 'production_overhead', code: '5410', parent: '5', type: 'expense', normal: 'debit', cls: 'cogs', ar: 'مصاريف الإنتاج غير المباشرة المحمّلة', en: 'Production overhead absorbed', adopt: '5400' },
  { key: 'production_energy', code: '5450', parent: '5', type: 'expense', normal: 'debit', cls: 'cogs', ar: 'طاقة الإنتاج المحمّلة', en: 'Production energy absorbed' },
];
const PERMS = ['view_manufacturing', 'manage_recipes', 'plan_production', 'manage_production_orders', 'record_production', 'approve_production_qc', 'manage_production_costs'];

const WIDEN = [
  { table: 'stock_moves', from: "'reclass_in', 'reclass_out', 'revaluation')", to: "'reclass_in', 'reclass_out', 'revaluation', 'production_issue', 'production_return', 'production_output', 'production_byproduct')" },
  { table: 'sync_operations', from: "'custody_transfer', 'delete')", to: "'custody_transfer', 'delete', 'production_issue', 'production_output', 'production_wastage')" },
];
function widenCheck(db, { table, from, to }) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || row.sql.includes(to)) return;
  if (!row.sql.includes(from)) throw new Error(`0022: unexpected ${table} definition`);
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table);
  // Triggers on the table (e.g. the analytics change capture added later)
  // are dropped with the old table: keep and re-create them like indexes.
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ');
  const before = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_0022`);
    for (const ix of indexes) db.exec(`DROP INDEX IF EXISTS ${ix.name}`);
    for (const tr of triggers) db.exec(`DROP TRIGGER IF EXISTS ${tr.name}`);
    db.exec(row.sql.replace(from, to));
    db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_pre_0022`);
    db.exec(`DROP TABLE ${table}_pre_0022`);
    for (const ix of indexes) db.exec(ix.sql);
    for (const tr of triggers) db.exec(tr.sql);
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
  const after = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  if (after !== before) throw new Error(`0022: ${table} row count changed ${before} -> ${after}`);
}

module.exports.foreignKeysOff = true;
module.exports.ACCOUNTS = ACCOUNTS;
module.exports.PERMS = PERMS;
module.exports.up = function up(db) {
  for (const w of WIDEN) widenCheck(db, w);
  applyManufacturingSchema(db);
  const companies = db.prepare("SELECT DISTINCT company_id FROM accounts WHERE system_key = 'opening_balance_equity'").all().map((r) => r.company_id);
  for (const cid of companies) {
    for (const a of ACCOUNTS) {
      if (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND system_key = ?').get(cid, a.key)) continue;
      if (a.adopt) {
        const existing = db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ? AND type = ? AND system_key IS NULL AND is_postable = 1').get(cid, a.adopt, a.type);
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
