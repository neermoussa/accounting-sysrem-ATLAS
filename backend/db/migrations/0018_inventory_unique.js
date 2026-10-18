// backend/db/migrations/0018_inventory_unique.js
//
// One stock row per product per holder table (factory_inventory,
// car_inventory). Existing duplicates are merged (quantities summed, merged
// rows archived in inventory_merged_rows, audit_log row per group) — but
// only after a dry run reviewed by the operator:
//   node scripts/inventory-dedupe.js        (dry run: prints + records the report)
//   npm run migrate                          (merges exactly that report, then indexes)
// Without a matching dry run this migration refuses and nothing changes.

const { applyInventorySchema } = require('../inventorySchema');
const dedupe = require('../../lib/inventoryDedupe');

module.exports.up = function up(db) {
  applyInventorySchema(db);
  const r = dedupe.execute(db);
  if (r.executed) console.log(`[migrate] merged ${r.rows_to_merge} duplicate inventory row(s) in ${r.duplicate_groups} group(s)`);
};
