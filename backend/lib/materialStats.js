const db = require('../db/init');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function periodRange(period) {
  const end = todayStr();
  const start = new Date();
  if (period === 'week') start.setDate(start.getDate() - 7);
  else if (period === 'year') start.setFullYear(start.getFullYear() - 1);
  else start.setMonth(start.getMonth() - 1); // 'month' is the default
  return { start: start.toISOString().slice(0, 10), end };
}

// Ranks every material that appears in at least one order within the period
// by total quantity sold — materials never ordered in the window are simply
// absent (not treated as "least selling" with a trivial zero).
function computeMaterialStats(companyId, period) {
  const { start, end } = periodRange(period);
  const orders = db
    .prepare("SELECT items_json FROM orders WHERE company_id = ? AND deleted_at IS NULL AND order_date >= ? AND order_date <= ?")
    .all(companyId, start, end);

  // Summed in kg (the canonical, always-comparable unit `qty` stores) even
  // though two orders of the same material might have been entered in
  // different units (kg/g/box) — summing whatever was "entered" verbatim
  // would mix units into a meaningless total.
  const totals = new Map();
  for (const o of orders) {
    const items = JSON.parse(o.items_json || '[]');
    for (const it of items) {
      const name = it.product_name || 'غير محدد';
      const entry = totals.get(name) || { productName: name, unit: 'كغ', totalQty: 0 };
      entry.totalQty += Number(it.qty) || 0;
      totals.set(name, entry);
    }
  }

  const ranked = Array.from(totals.values()).sort((a, b) => b.totalQty - a.totalQty);
  return {
    period,
    start,
    end,
    ranked,
    topSelling: ranked[0] || null,
    bottomSelling: ranked.length ? ranked[ranked.length - 1] : null,
  };
}

module.exports = { computeMaterialStats };
