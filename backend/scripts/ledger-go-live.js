// backend/scripts/ledger-go-live.js
//
// Moves a company onto the ledger (lib/customerLedger.js). Two steps, same
// rules as the screen:
//
//   1) Dry run — records the plan, writes no entries, prints its id:
//        node scripts/ledger-go-live.js --company 1 [--date 2026-10-16]
//   2) Execute that dry run (must be < 24h old and still match the data):
//        node scripts/ledger-go-live.js --company 1 --execute <dryRunId> \
//          --confirm-text "Invoices will be created in Atlas from now on"
//
// Step 2 makes a verified VACUUM INTO backup first and prints its path.
// Rollback = restore that file: see docs/go-live-rollback.md.

const db = require('../db/init');
const { recordDryRun, executeGoLive } = require('../lib/customerLedger');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const companyId = Number(arg('company'));
if (!companyId) {
  console.error('Usage: see the header of scripts/ledger-go-live.js');
  process.exit(1);
}
const actor = db.prepare("SELECT id, name FROM users WHERE company_id = ? AND role IN ('manager','admin') ORDER BY id LIMIT 1").get(companyId);
try {
  if (arg('execute')) {
    const r = executeGoLive(companyId, { dryRunId: Number(arg('execute')), confirmText: arg('confirm-text') }, actor);
    console.log(`EXECUTED — date ${r.date}, customers ${r.customers}, total ${r.total}`);
    console.log(`Backup taken before go-live: ${r.backup_path}`);
    process.exit(0);
  }
  const r = recordDryRun(companyId, { date: arg('date') }, actor);
  console.log(`DRY RUN #${r.dry_run_id} — date ${r.date}, customers ${r.customers}, total ${r.total}`);
  for (const p of r.problems) console.log(`  problem: ${p.code} — ${p.message}`);
  for (const row of r.rows) console.log(`  shop ${row.shop_id} ${row.shop_name}: snapshot ${row.snapshot_minor} ledger ${row.existing_ledger_minor} -> opening ${row.opening}`);
  console.log(`No entries were written. To execute: --execute ${r.dry_run_id} --confirm-text "Invoices will be created in Atlas from now on"`);
  process.exit(r.ok ? 0 : 2);
} catch (err) {
  console.error(`FAILED: ${err.code || ''} ${err.message}`);
  process.exit(1);
}
