// backend/db/migrations/0011_account_report_class.js
//
// accounts.report_class: where an account shows in the financial statements
// (reports stop reading code prefixes). Additive column (same ALTER as
// db/ledgerSchema.js uses on fresh databases), then a one-time backfill of
// existing accounts from the Prompt 4 code-prefix rules (lib/reportClass.js).

const { ensureReportClassColumn } = require('../ledgerSchema');
const { backfillReportClass } = require('../../lib/reportClass');

module.exports.up = function up(db) {
  ensureReportClassColumn(db);
  backfillReportClass(db);
};
