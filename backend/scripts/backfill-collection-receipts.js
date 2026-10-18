// backend/scripts/backfill-collection-receipts.js
//
// Creates receipts for confirmed collections of a ledger-live company that
// have a journal entry but no receipt (confirmed between Prompt 2 and
// Prompt 3), so they can be allocated to invoices. Idempotent — running it
// again creates nothing. Dry run unless --execute.
//
//   node scripts/backfill-collection-receipts.js --company 1            # dry run
//   node scripts/backfill-collection-receipts.js --company 1 --execute  # write
//   add --no-auto-allocate to leave the new receipts unallocated

const db = require('../db/init');
const { backfillCollectionReceipts } = require('../lib/receivables');

const args = process.argv.slice(2);
const companyId = Number(args[args.indexOf('--company') + 1]);
if (!args.includes('--company') || !companyId) {
  console.error('Usage: node scripts/backfill-collection-receipts.js --company <id> [--execute] [--no-auto-allocate]');
  process.exit(1);
}
const actor = db.prepare("SELECT id, name FROM users WHERE company_id = ? AND role IN ('manager','admin') ORDER BY id LIMIT 1").get(companyId);
try {
  const r = backfillCollectionReceipts(companyId, { dryRun: !args.includes('--execute'), autoAllocate: args.includes('--no-auto-allocate') ? false : undefined }, actor);
  if (r.dry_run) {
    console.log(`DRY RUN — ${r.to_create} receipt(s) would be created, ${r.skipped.length} skipped`);
    for (const p of r.plan) console.log(`  collection ${p.collection_id}: ${p.amount_minor} (${p.date})`);
  } else {
    console.log(`EXECUTED — ${r.created} receipt(s) created, ${r.skipped.length} skipped`);
  }
  for (const s of r.skipped) console.log(`  skipped collection ${s.collection_id}: ${s.reason}`);
} catch (err) {
  console.error(`FAILED: ${err.code || ''} ${err.message}`);
  process.exit(1);
}
