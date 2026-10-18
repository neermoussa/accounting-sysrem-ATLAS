const db = require('../db/init');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

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

// [start, end] inclusive, both YYYY-MM-DD, anchored on `today` (or an
// explicit anchor date so a past period's statement can be re-derived the
// same way it would have looked on that day).
function periodRange(period, anchor = todayStr()) {
  if (period === 'daily') return { start: anchor, end: anchor };
  if (period === 'weekly') {
    const start = mondayOf(anchor);
    return { start, end: addDaysStr(start, 6) };
  }
  if (period === 'monthly') {
    const [y, m] = anchor.split('-');
    const start = `${y}-${m}-01`;
    const lastDay = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
    return { start, end: `${y}-${m}-${String(lastDay).padStart(2, '0')}` };
  }
  throw Object.assign(new Error('invalid_period'), { status: 400 });
}

function getCommissionSettings(companyId) {
  const row = db.prepare('SELECT * FROM commission_settings WHERE company_id = ?').get(companyId);
  return (
    row || {
      company_id: companyId,
      base_rate_pct: 0,
      bonus_amount: 0,
      bonus_condition: 'monthly_target_met',
    }
  );
}

function setCommissionSettings(companyId, { base_rate_pct, bonus_amount, bonus_condition }) {
  db.prepare(
    `INSERT INTO commission_settings (company_id, base_rate_pct, bonus_amount, bonus_condition, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET base_rate_pct = excluded.base_rate_pct, bonus_amount = excluded.bonus_amount,
       bonus_condition = excluded.bonus_condition, updated_at = datetime('now')`
  ).run(companyId, base_rate_pct ?? 0, bonus_amount ?? 0, bonus_condition || 'monthly_target_met');
  return getCommissionSettings(companyId);
}

function getRepSalesTarget(companyId, userId, period) {
  return db
    .prepare("SELECT target_value FROM rep_targets WHERE company_id = ? AND user_id = ? AND period = ? AND target_type = 'sales' AND product_id = 0")
    .get(companyId, userId, period)?.target_value ?? null;
}

// Sums this rep's own attributed, non-cancelled orders (deleted_at IS NULL
// — a cancelled/deleted order is excluded automatically, no separate
// "cancelled" flag needed since order cancellation already soft-deletes
// the row) within [start, end]. free_goods_log lines already carry
// line_total 0 inside items_json, so they don't need separate handling —
// they simply don't add to total_value.
function sumAttributedSales(companyId, userId, start, end) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_value), 0) AS total, COUNT(*) AS count
       FROM orders WHERE company_id = ? AND rep_id = ? AND deleted_at IS NULL AND order_date BETWEEN ? AND ?`
    )
    .get(companyId, userId, start, end);
  const cancelled = db
    .prepare(
      `SELECT COALESCE(SUM(total_value), 0) AS total, COUNT(*) AS count
       FROM orders WHERE company_id = ? AND rep_id = ? AND deleted_at IS NOT NULL AND order_date BETWEEN ? AND ?`
    )
    .get(companyId, userId, start, end);
  return { salesTotal: row.total, orderCount: row.count, excludedCancelledCount: cancelled.count, excludedCancelledValue: cancelled.total };
}

const BONUS_PERIOD = { daily_target_met: 'daily', weekly_target_met: 'weekly', monthly_target_met: 'monthly' };

function computeCommissionStatement(companyId, userId, period, anchor) {
  const { start, end } = periodRange(period, anchor);
  const settings = getCommissionSettings(companyId);
  const { salesTotal, orderCount, excludedCancelledCount, excludedCancelledValue } = sumAttributedSales(companyId, userId, start, end);

  const baseCommission = salesTotal * (settings.base_rate_pct / 100);

  const bonusPeriod = BONUS_PERIOD[settings.bonus_condition];
  let targetValue = null;
  let targetMet = false;
  let bonusAmount = 0;
  // The bonus only ever evaluates against the specific period named in
  // bonus_condition — requesting a statement for a different period still
  // shows the base commission for that period, just with no bonus line,
  // since "was the monthly target met" isn't a question a weekly view can
  // answer on its own.
  if (bonusPeriod === period) {
    targetValue = getRepSalesTarget(companyId, userId, period);
    if (targetValue != null && salesTotal >= targetValue) {
      targetMet = true;
      bonusAmount = settings.bonus_amount;
    }
  }

  return {
    userId,
    period,
    start,
    end,
    salesTotal,
    orderCount,
    excludedCancelledCount,
    excludedCancelledValue,
    baseRatePct: settings.base_rate_pct,
    baseCommission,
    targetValue,
    targetMet,
    bonusCondition: settings.bonus_condition,
    bonusAmount,
    totalCommission: baseCommission + bonusAmount,
  };
}

module.exports = { periodRange, getCommissionSettings, setCommissionSettings, computeCommissionStatement, sumAttributedSales };
