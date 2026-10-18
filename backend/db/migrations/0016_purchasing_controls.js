// backend/db/migrations/0016_purchasing_controls.js
//
// Post-Prompt-6 purchasing fixes. Additive and idempotent: re-applies the
// purchasing schema, which adds supplier_invoice_lines.fx_base_minor (the
// receipt-vs-invoice exchange-rate difference split out of PPV).

const { applyPurchasingSchema } = require('../purchasingSchema');

module.exports.up = function up(db) {
  applyPurchasingSchema(db);
};
