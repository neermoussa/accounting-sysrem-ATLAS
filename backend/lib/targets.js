const db = require('../db/init');

// SQLite dates from this app are plain "YYYY-MM-DD" strings — same
// Monday-start-week convention as lib/shopStats.js's buildWeeklyTrend, kept
// consistent so "this week" means the same thing everywhere in the app.
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function listReps(companyId) {
  return db
    .prepare("SELECT id, name FROM users WHERE company_id = ? AND role = 'rep' AND status = 'approved' ORDER BY name COLLATE NOCASE")
    .all(companyId);
}

// Orders carry no per-rep attribution in this schema (confirmed against
// db/init.js — no rep/created_by column), so "actual sales" figures below
// are always company-wide totals. Picking a rep here only selects whose
// *target* number that total gets compared against. That's an exact match
// for today's reality (a single rep), and stays meaningful for a second rep
// later since each still gets their own target — it just means the
// progress bar isn't scoped to only that rep's own sales until orders gain
// real attribution, which is a separate, larger change.
function defaultRepId(companyId) {
  return listReps(companyId)[0]?.id ?? null;
}

function getTargets(companyId, userId) {
  const rows = db
    .prepare('SELECT period, target_value FROM sales_targets WHERE company_id = ? AND user_id = ?')
    .all(companyId, userId);
  const out = { weekly: null, monthly: null };
  for (const r of rows) out[r.period] = r.target_value;
  return out;
}

function setTarget(companyId, userId, period, value) {
  if (!['weekly', 'monthly'].includes(period)) {
    const err = new Error('invalid_period');
    err.status = 400;
    throw err;
  }
  const numeric = value === '' || value === null || value === undefined ? null : Number(value);
  if (numeric === null) {
    db.prepare('DELETE FROM sales_targets WHERE company_id = ? AND user_id = ? AND period = ?').run(companyId, userId, period);
  } else {
    db.prepare(
      `INSERT INTO sales_targets (company_id, user_id, period, target_value, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, period) DO UPDATE SET target_value = excluded.target_value, updated_at = excluded.updated_at`
    ).run(companyId, userId, period, numeric);
  }
  return getTargets(companyId, userId);
}

function salesBetween(companyId, fromDate, toDate) {
  return db
    .prepare(
      'SELECT COALESCE(SUM(total_value), 0) v FROM orders WHERE company_id = ? AND order_date >= ? AND order_date <= ? AND deleted_at IS NULL'
    )
    .get(companyId, fromDate, toDate).v;
}

function build(target, actual, daysRemaining) {
  const percent = target ? Math.round((actual / target) * 1000) / 10 : null;
  return { target, actual, percent, daysRemaining };
}

function computeProgress(companyId, userId) {
  const targets = getTargets(companyId, userId);
  const today = todayStr();

  const weekStart = mondayOf(today);
  const weekEnd = addDaysStr(weekStart, 6);
  const weeklyActual = salesBetween(companyId, weekStart, today);
  const daysRemainingWeek = Math.round(
    (new Date(`${weekEnd}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000
  );

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemainingMonth = daysInMonth - now.getDate();
  const monthlyActual = salesBetween(companyId, monthStart, today);

  return {
    userId,
    weekly: { ...build(targets.weekly, weeklyActual, daysRemainingWeek), weekStart, weekEnd },
    monthly: { ...build(targets.monthly, monthlyActual, daysRemainingMonth), monthStart },
  };
}

module.exports = { listReps, defaultRepId, getTargets, setTarget, computeProgress };
