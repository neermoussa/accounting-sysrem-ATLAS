// backend/db/migrations/0032_report_builder.js
//
// Prompt 12b: saved_reports, report_schedules, report_runs, report_sends
// (db/reportBuilderSchema.js). New tables only; nothing existing changes.

const { applyReportBuilderSchema } = require('../reportBuilderSchema');

module.exports.up = function up(db) {
  applyReportBuilderSchema(db);
};
