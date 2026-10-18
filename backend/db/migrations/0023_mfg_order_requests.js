// backend/db/migrations/0023_mfg_order_requests.js
//
// Additive: mfg_order_requests (production order <- production request,
// one order per request) — db/manufacturingSchema.js.

const { applyManufacturingSchema } = require('../manufacturingSchema');

module.exports.up = function up(db) {
  applyManufacturingSchema(db);
};
