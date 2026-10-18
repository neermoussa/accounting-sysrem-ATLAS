// backend/db/inventorySchema.js
//
// One stock row per product per holder (factory_inventory = factory stock,
// car_inventory = car stock; both company-level until Prompt 8's stock
// ledger). Applied by db/init.js and db/migrations/0018_inventory_unique.js.
// The unique indexes are created only when no duplicates exist: existing
// duplicates are merged first by lib/inventoryDedupe.js after a recorded
// dry run (the migration refuses otherwise), so startup never merges data
// silently.

const INVENTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inventory_dedupe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('dry_run', 'executed')),
  fingerprint TEXT NOT NULL,
  report_json TEXT NOT NULL,
  dry_run_id INTEGER REFERENCES inventory_dedupe_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Every merged-away row, kept whole (audit trail).
CREATE TABLE IF NOT EXISTS inventory_merged_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES inventory_dedupe_runs(id),
  company_id INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  merged_row_id INTEGER NOT NULL,
  merged_into_id INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const UNIQUE_INDEXES = [
  ['factory_inventory', 'uq_factory_inventory_product'],
  ['car_inventory', 'uq_car_inventory_product'],
];

function duplicateCount(db) {
  return UNIQUE_INDEXES.reduce((n, [table]) => n + db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM ${table} WHERE product_id IS NOT NULL GROUP BY company_id, product_id HAVING COUNT(*) > 1)`).get().c, 0);
}

// Creates the unique indexes when there is nothing to merge; returns
// whether they exist afterwards.
function ensureUniqueIndexes(db) {
  if (duplicateCount(db) > 0) return false;
  for (const [table, name] of UNIQUE_INDEXES) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table}(company_id, product_id) WHERE product_id IS NOT NULL`);
  return true;
}

function applyInventorySchema(db) {
  db.exec(INVENTORY_SCHEMA_SQL);
  if (!ensureUniqueIndexes(db)) console.warn('[db] duplicate inventory rows per product exist — run `node scripts/inventory-dedupe.js` (dry run), then `npm run migrate`');
}

module.exports = { applyInventorySchema, ensureUniqueIndexes, duplicateCount, UNIQUE_INDEXES };
