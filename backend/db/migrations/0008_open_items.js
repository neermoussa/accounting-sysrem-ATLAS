// backend/db/migrations/0008_open_items.js
//
// Adds open_item_imports / open_items (db/receivablesSchema.js): the go-live
// open-items import that gives migrated customer debt its real invoice ages.
// Additive.

const { applyReceivablesSchema } = require('../receivablesSchema');

module.exports.up = function up(db) {
  applyReceivablesSchema(db);
};
