const db = require('../db/init');

// SQLite dates from this app are plain "YYYY-MM-DD" strings (order_date) —
// all the helpers below work on those directly, in UTC, to stay consistent
// with how order_date is stored and compared elsewhere in the codebase.
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

// One bucket per calendar week (Monday start) from the shop's first order's
// week through the current week, with zero-filled gaps so a quiet stretch
// shows up as a real dip in the line rather than being skipped over.
function buildWeeklyTrend(orders) {
  if (orders.length === 0) return [];
  const buckets = new Map();
  for (const o of orders) {
    const weekStart = mondayOf(o.order_date);
    const items = JSON.parse(o.items_json || '[]');
    const qty = items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
    const bucket = buckets.get(weekStart) || { weekStart, totalValue: 0, totalQty: 0, orderCount: 0 };
    bucket.totalValue += Number(o.total_value) || 0;
    bucket.totalQty += qty;
    bucket.orderCount += 1;
    buckets.set(weekStart, bucket);
  }
  const firstWeek = mondayOf(orders[0].order_date);
  const lastWeek = mondayOf(todayStr());
  const trend = [];
  let cursor = firstWeek;
  while (cursor <= lastWeek) {
    trend.push(buckets.get(cursor) || { weekStart: cursor, totalValue: 0, totalQty: 0, orderCount: 0 });
    cursor = addDaysStr(cursor, 7);
  }
  return trend;
}

// Flags a notable pullback: average order value over the most recent weeks
// vs. the equal-length window right before it, dropping by 20% or more.
// Needs enough history on both sides of the comparison to mean anything —
// otherwise a brand-new shop with two orders would trivially "decline".
const RECENT_WINDOW_WEEKS = 4;
const DECLINE_THRESHOLD = 0.8; // recentAvg <= 80% of priorAvg => declining

function computeDecline(weeklyTrend) {
  if (weeklyTrend.length < RECENT_WINDOW_WEEKS * 2) {
    return { declining: false, insufficientData: true, recentAvg: null, priorAvg: null, changePct: null };
  }
  const recentWeeks = weeklyTrend.slice(-RECENT_WINDOW_WEEKS);
  const priorWeeks = weeklyTrend.slice(-RECENT_WINDOW_WEEKS * 2, -RECENT_WINDOW_WEEKS);
  const avg = (arr) => arr.reduce((sum, w) => sum + w.totalValue, 0) / arr.length;
  const recentAvg = avg(recentWeeks);
  const priorAvg = avg(priorWeeks);
  const declining = priorAvg > 0 && recentAvg <= priorAvg * DECLINE_THRESHOLD;
  const changePct = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : null;
  return { declining, insufficientData: false, recentAvg, priorAvg, changePct };
}

const TOP_PRODUCTS_WINDOW_DAYS = 30;

function computeTopProducts(companyId, shopId, windowDays) {
  const since = addDaysStr(todayStr(), -windowDays);
  const rows = db
    .prepare('SELECT items_json FROM orders WHERE company_id = ? AND shop_id = ? AND deleted_at IS NULL AND order_date >= ?')
    .all(companyId, shopId, since);
  const totals = new Map();
  for (const row of rows) {
    const items = JSON.parse(row.items_json || '[]');
    for (const it of items) {
      const name = it.product_name || 'غير محدد';
      const entry = totals.get(name) || { productName: name, unit: it.unit || '', totalQty: 0 };
      entry.totalQty += Number(it.qty) || 0;
      totals.set(name, entry);
    }
  }
  return Array.from(totals.values()).sort((a, b) => b.totalQty - a.totalQty);
}

function computeShopStats(companyId, shopId) {
  const orders = db
    .prepare('SELECT order_date, items_json, total_value FROM orders WHERE company_id = ? AND shop_id = ? AND deleted_at IS NULL ORDER BY order_date ASC, id ASC')
    .all(companyId, shopId);
  const weeklyTrend = buildWeeklyTrend(orders);
  const decline = computeDecline(weeklyTrend);
  const topProducts = computeTopProducts(companyId, shopId, TOP_PRODUCTS_WINDOW_DAYS);
  return { weeklyTrend, decline, topProducts, topProductsWindowDays: TOP_PRODUCTS_WINDOW_DAYS };
}

module.exports = { computeShopStats, buildWeeklyTrend, computeDecline, computeTopProducts };
