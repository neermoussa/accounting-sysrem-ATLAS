// backend/db/migrations/0030_mfg_theoretical_snapshot.js
//
// NEXT ACTION item 1: the theoretical cost of a closed production order is
// fixed when it closes (mfg_order_theoretical_costs, db/manufacturingSchema.js)
// so the cost-variance report of a closed period does not move.
//
// Orders already closed get their snapshot now (source 'migration'), on
// their production date, from the data as it stands when this runs: the
// 'latest' basis only reads receipts dated on or before the production date,
// so it is what the report showed; 'average' (and the fallback of 'latest'
// for a material with no receipt) is today's stock average — from here on it
// no longer moves. Idempotent: orders that already have a row are skipped.

const { applyManufacturingSchema } = require('../manufacturingSchema');

module.exports.up = function up(db) {
  applyManufacturingSchema(db);
  const orders = db.prepare("SELECT o.id, o.company_id, o.version_id, o.production_date, o.batches FROM mfg_orders o WHERE o.status = 'closed' AND o.production_date IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mfg_order_theoretical_costs t WHERE t.order_id = o.id) ORDER BY o.id").all();
  if (!orders.length) return;
  const M = require('../../lib/manufacturing');
  const ins = db.prepare("INSERT OR IGNORE INTO mfg_order_theoretical_costs (company_id, order_id, basis, cost_json, source) VALUES (?, ?, ?, ?, 'migration')");
  for (const o of orders) {
    for (const basis of ['latest', 'average', 'standard']) {
      const th = M.versionCost(o.company_id, o.version_id, { date: o.production_date, basis, batches: o.batches });
      ins.run(o.company_id, o.id, basis, JSON.stringify(th));
    }
  }
};
