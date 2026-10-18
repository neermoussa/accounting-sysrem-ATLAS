// backend/db/migrations/0004_currency_lock.js
//
// Adds trg_companies_currency_locked (db/ledgerSchema.js): companies.currency
// cannot change once the company has posted journal entries. Additive.

const { applyLedgerSchema } = require('../ledgerSchema');

module.exports.up = function up(db) {
  applyLedgerSchema(db);
};
