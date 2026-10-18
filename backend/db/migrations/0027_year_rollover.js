// backend/db/migrations/0027_year_rollover.js
//
// Additive: posting_failures (db/rolloverSchema.js). The automatic creation
// of the next fiscal year needs no schema change.

const { applyRolloverSchema } = require('../rolloverSchema');

module.exports.up = function up(db) {
  applyRolloverSchema(db);
};
