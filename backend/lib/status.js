function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

// orderDates: array of 'YYYY-MM-DD' strings, most recent first (or any order; we sort internally)
function computeOrderStats(orderDates) {
  if (!orderDates || orderDates.length === 0) {
    return { lastOrderDate: null, avgIntervalDays: null };
  }
  const sorted = [...orderDates].sort(); // ascending
  const lastOrderDate = sorted[sorted.length - 1];
  if (sorted.length < 2) {
    return { lastOrderDate, avgIntervalDays: null };
  }
  let totalGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    totalGap += daysBetween(sorted[i - 1], sorted[i]);
  }
  const avgIntervalDays = totalGap / (sorted.length - 1);
  return { lastOrderDate, avgIntervalDays };
}

function computeShopStatus(shop, latestBalance, orderStats, globalSettings) {
  const debtThreshold = shop.debt_threshold_override ?? Number(globalSettings.debt_threshold);
  const fallbackOverdueDays = shop.order_overdue_days_override ?? Number(globalSettings.order_overdue_days);
  const attentionMultiplier = Number(globalSettings.attention_overdue_multiplier || 1.5);

  const creditLimitColorEnabled = globalSettings.credit_limit_color_enabled !== '0';
  const balance = latestBalance ? latestBalance.balance : 0;
  const isOverDebt = creditLimitColorEnabled && balance > debtThreshold;

  const { lastOrderDate, avgIntervalDays } = orderStats;
  const expectedCycleDays = avgIntervalDays ?? fallbackOverdueDays;

  let daysSinceOrder = null;
  let isOverdue = false;
  let isAbnormallyOverdue = false;
  if (lastOrderDate) {
    daysSinceOrder = daysBetween(lastOrderDate, new Date().toISOString().slice(0, 10));
    isOverdue = daysSinceOrder > expectedCycleDays;
    isAbnormallyOverdue = daysSinceOrder > expectedCycleDays * attentionMultiplier;
  }

  let status = 'green';
  if (isOverDebt) status = 'red';
  else if (isOverdue) status = 'yellow';

  return {
    status,
    isOverDebt,
    isOverdue,
    isAbnormallyOverdue,
    daysSinceOrder,
    avgIntervalDays,
    expectedCycleDays,
    debtThreshold,
    lastOrderDate,
  };
}

module.exports = { computeShopStatus, computeOrderStats, daysBetween };
