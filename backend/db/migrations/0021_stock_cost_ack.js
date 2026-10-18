// backend/db/migrations/0021_stock_cost_ack.js
//
// Additive: stock_cost_acknowledgements (activation dry run blocks on
// products with stock and a missing / zero cost until each is fixed or
// acknowledged with a reason) — db/stockSchema.js.

const { applyStockSchema } = require('../stockSchema');

module.exports.up = function up(db) {
  applyStockSchema(db);
};
