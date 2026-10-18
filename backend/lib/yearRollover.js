// backend/lib/yearRollover.js
//
// Year rollover protection.
//  - autoCreateNextYears(asOf): for every company whose latest fiscal year
//    is in its last month (from 1 Dec for a calendar year) and has no next
//    year, create the next year and its 12 periods (same start month).
//    Idempotent (skips when it exists), audited as
//    ledger.fiscal_year.auto_create. Runs with the background sweeps.
//  - yearStatus(companyId): for the banner — the current year's end, days
//    left, whether the next year exists; warn = within 60 days and missing.

const db = require('../db/init');
const ledger = require('./ledger');
const { logAudit } = require('./auditLog');

const WARN_DAYS = 60;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function latestYear(companyId) {
  return db.prepare('SELECT * FROM fiscal_years WHERE company_id = ? ORDER BY end_date DESC LIMIT 1').get(companyId) || null;
}
function nextYearExists(companyId, fy) {
  return Boolean(db.prepare('SELECT 1 FROM fiscal_years WHERE company_id = ? AND start_date = ?').get(companyId, addDays(fy.end_date, 1)));
}

function yearStatus(companyId, asOf = today()) {
  const current = db.prepare('SELECT * FROM fiscal_years WHERE company_id = ? AND start_date <= ? AND end_date >= ?').get(companyId, asOf, asOf) || null;
  const fy = current || latestYear(companyId);
  if (!fy) return { has_ledger_years: false, warn: false };
  const daysLeft = daysBetween(asOf, fy.end_date);
  const nextMissing = !nextYearExists(companyId, fy);
  return {
    has_ledger_years: true, year: fy.year, end_date: fy.end_date, days_left: daysLeft,
    next_year_missing: nextMissing, today_covered: Boolean(current),
    warn: (nextMissing && daysLeft <= WARN_DAYS) || !current,
    open_posting_failures: require('./postingQueue').openCount(companyId),
  };
}

function autoCreateNextYears(asOf = today()) {
  const created = [];
  const errors = [];
  for (const { company_id: cid } of db.prepare('SELECT DISTINCT company_id FROM fiscal_years').all()) {
    const fy = latestYear(cid);
    if (!fy || nextYearExists(cid, fy)) continue;
    // The latest year's last period has started (1 Dec for a calendar year).
    const last = db.prepare('SELECT start_date FROM fiscal_periods WHERE fiscal_year_id = ? ORDER BY number DESC LIMIT 1').get(fy.id);
    if (!last || asOf < last.start_date) continue;
    try {
      const startMonth = Number(addDays(fy.end_date, 1).slice(5, 7));
      const y = ledger.createFiscalYear(cid, { year: fy.year + 1, startMonth }, null);
      logAudit({ companyId: cid, actor: { id: null, name: 'system' }, action: 'ledger.fiscal_year.auto_create', entityType: 'fiscal_year', entityId: y.id, before: null, after: { year: y.year, start_date: y.start_date, end_date: y.end_date, periods: y.periods.length, as_of: asOf } });
      created.push({ company_id: cid, year: y.year, fiscal_year_id: y.id });
    } catch (err) {
      errors.push({ company_id: cid, error: err.code || err.message });
    }
  }
  return { as_of: asOf, created, errors };
}

module.exports = { WARN_DAYS, yearStatus, autoCreateNextYears };
