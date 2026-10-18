// backend/db/migrations/0006_go_live_runs.js
//
// Adds ledger_go_live_runs (db/salesSchema.js): recorded go-live dry runs and
// executions with their plan, backup path and confirmation text. Additive.

const { applySalesSchema } = require('../salesSchema');

module.exports.up = function up(db) {
  applySalesSchema(db);
};
