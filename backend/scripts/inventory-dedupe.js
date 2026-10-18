// backend/scripts/inventory-dedupe.js
//
// Dry run (default): reports duplicate stock rows per product and records
// the report. `--execute`: merges exactly the last dry run's report (same
// as migration 0018) and creates the unique indexes.
//   node scripts/inventory-dedupe.js [--execute]

const db = require('../db/init');
const dedupe = require('../lib/inventoryDedupe');

const exec = process.argv.includes('--execute');
try {
  const r = exec ? db.transaction(() => dedupe.execute(db))() : dedupe.dryRun(db);
  console.log(JSON.stringify({ mode: exec ? 'execute' : 'dry_run', duplicate_groups: r.duplicate_groups, rows_to_merge: r.rows_to_merge, groups: r.groups }, null, 2));
} catch (err) {
  console.error(`[inventory-dedupe] ${err.code || 'error'}: ${err.message}`);
  process.exitCode = 1;
}
