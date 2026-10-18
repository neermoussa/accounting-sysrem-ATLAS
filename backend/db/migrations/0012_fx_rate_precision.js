// backend/db/migrations/0012_fx_rate_precision.js
//
// Exchange-rate audit (before Prompt 5): journal_lines.exchange_rate_ppm
// stored base-per-foreign at 1e6 scale — a USD company posting SYP kept
// 0.0000741 as 74 ppm (two significant digits). New columns rate_e8 +
// rate_quote store the rate at 1e8 scale in its most-significant direction
// (lib/fxRate.js). Additive only: posted lines are immutable, so existing
// rows keep rate_e8 NULL and readers fall back to the ppm column, which is
// exactly what was typed then (input was limited to 6 decimals) — the base
// amounts already posted are unchanged.

const { ensureFxRateColumns } = require('../ledgerSchema');

module.exports.up = function up(db) {
  ensureFxRateColumns(db);
};
