// backend/lib/inventoryDedupe.js
//
// Merges duplicate stock rows (same company + product in the same holder
// table) so the one-row-per-product unique index can exist.
//   dryRun(db)   -> report (groups, rows, summed qty, survivor) recorded
//                   with a fingerprint; writes no stock.
//   execute(db)  -> requires the latest dry run to match the current
//                   duplicates exactly; survivor = oldest row; quantity =
//                   sum; min quantity = max; merged rows archived whole in
//                   inventory_merged_rows, deleted; notifications pointed at
//                   the survivor; one audit_log row per group.
// Takes the db handle so it works from the migration and the CLI.

const crypto = require('crypto');
const { UNIQUE_INDEXES, ensureUniqueIndexes } = require('../db/inventorySchema');

function groups(db) {
  const out = [];
  for (const [table] of UNIQUE_INDEXES) {
    const keys = db.prepare(`SELECT company_id, product_id FROM ${table} WHERE product_id IS NOT NULL GROUP BY company_id, product_id HAVING COUNT(*) > 1 ORDER BY company_id, product_id`).all();
    for (const k of keys) {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE company_id = ? AND product_id = ? ORDER BY id`).all(k.company_id, k.product_id).map((r) => ({ ...r }));
      out.push({
        table, company_id: k.company_id, product_id: k.product_id, survivor_id: rows[0].id,
        rows: rows.map((r) => ({ id: r.id, item_name: r.item_name, current_quantity: r.current_quantity, min_quantity: r.min_quantity })),
        merged_quantity: Math.round(rows.reduce((s, r) => s + Number(r.current_quantity || 0), 0) * 1000) / 1000,
        merged_min_quantity: Math.max(...rows.map((r) => Number(r.min_quantity || 0))),
      });
    }
  }
  return out;
}
const fingerprintOf = (gs) => crypto.createHash('sha256').update(JSON.stringify(gs.map((g) => [g.table, g.company_id, g.product_id, g.rows.map((r) => [r.id, r.current_quantity, r.min_quantity])]))).digest('hex');

function report(db) {
  const gs = groups(db);
  return { groups: gs, duplicate_groups: gs.length, rows_to_merge: gs.reduce((s, g) => s + g.rows.length - 1, 0), fingerprint: fingerprintOf(gs) };
}

function dryRun(db) {
  const r = report(db);
  const id = Number(db.prepare("INSERT INTO inventory_dedupe_runs (kind, fingerprint, report_json) VALUES ('dry_run', ?, ?)").run(r.fingerprint, JSON.stringify(r)).lastInsertRowid);
  return { dry_run_id: id, ...r };
}

class DedupeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function execute(db) {
  const r = report(db);
  if (!r.duplicate_groups) {
    ensureUniqueIndexes(db);
    return { executed: false, ...r };
  }
  const dry = db.prepare("SELECT * FROM inventory_dedupe_runs WHERE kind = 'dry_run' ORDER BY id DESC LIMIT 1").get();
  if (!dry) throw new DedupeError('dry_run_required', `توجد ${r.duplicate_groups} مجموعة أسطر مخزون مكررة — شغّل التجربة أولًا: node scripts/inventory-dedupe.js`);
  if (dry.fingerprint !== r.fingerprint) throw new DedupeError('dry_run_stale', 'تغيّرت أسطر المخزون المكررة منذ التجربة — شغّل تجربة جديدة وراجعها');
  const runId = Number(db.prepare("INSERT INTO inventory_dedupe_runs (kind, fingerprint, report_json, dry_run_id) VALUES ('executed', ?, ?, ?)").run(r.fingerprint, JSON.stringify(r), dry.id).lastInsertRowid);
  for (const g of r.groups) {
    const all = db.prepare(`SELECT * FROM ${g.table} WHERE company_id = ? AND product_id = ? ORDER BY id`).all(g.company_id, g.product_id);
    const survivor = all[0];
    for (const row of all.slice(1)) {
      db.prepare('INSERT INTO inventory_merged_rows (run_id, company_id, table_name, merged_row_id, merged_into_id, row_json) VALUES (?, ?, ?, ?, ?, ?)').run(runId, g.company_id, g.table, row.id, survivor.id, JSON.stringify(row));
      db.prepare('UPDATE notifications SET entity_id = ? WHERE company_id = ? AND entity_type = ? AND entity_id = ?').run(survivor.id, g.company_id, g.table, row.id);
      db.prepare(`DELETE FROM ${g.table} WHERE id = ?`).run(row.id);
    }
    db.prepare(`UPDATE ${g.table} SET current_quantity = ?, min_quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(g.merged_quantity, g.merged_min_quantity, survivor.id);
    db.prepare(
      `INSERT INTO audit_log (company_id, actor_id, actor_name, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, NULL, 'migration', 'inventory.dedupe.merge', ?, ?, ?, ?)`
    ).run(g.company_id, g.table, survivor.id, JSON.stringify(g.rows), JSON.stringify({ current_quantity: g.merged_quantity, min_quantity: g.merged_min_quantity, run_id: runId }));
  }
  if (!ensureUniqueIndexes(db)) throw new DedupeError('still_duplicated', 'بقيت أسطر مكررة بعد الدمج');
  return { executed: true, run_id: runId, ...r };
}

module.exports = { report, dryRun, execute, DedupeError };
