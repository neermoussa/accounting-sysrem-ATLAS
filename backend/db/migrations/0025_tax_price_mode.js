// backend/db/migrations/0025_tax_price_mode.js
//
// After Prompt 10, item 2: company_tax_settings (explicit price-mode
// choice). Additive. Companies that created tax codes before this
// migration get no row: they must choose the mode before their next taxed
// document posts (409 price_mode_not_chosen). Companies without tax codes
// are unaffected.

const { applyAccountingExtrasSchema } = require('../accountingExtrasSchema');

module.exports.up = function up(db) {
  applyAccountingExtrasSchema(db);
};
