const db = require('../db/init');
const { getAllEnrichedShops } = require('./shopData');
const { computeMonthlyTarget, STATUS_LABEL } = require('./stats');

// Line-item level rows exploded from orders.items_json — the only way to
// get per-material rows at all, since nothing in the schema stores them
// pre-exploded. orderTotal is the ORDER's total_value repeated on each of
// its line items (there is no per-item price anywhere in this app — see
// orders schema — so this is honestly an order-level figure attached for
// context, not a per-material amount).
function getSalesReport(companyId, { from, to, shopId, productQuery } = {}) {
  let sql = `SELECT o.id as order_id, o.order_date, o.shop_id, s.name as shop_name, o.items_json, o.total_value
             FROM orders o JOIN shops s ON s.id = o.shop_id
             WHERE o.deleted_at IS NULL AND o.company_id = ?`;
  const params = [companyId];
  if (from) {
    sql += ' AND o.order_date >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND o.order_date <= ?';
    params.push(to);
  }
  if (shopId) {
    sql += ' AND o.shop_id = ?';
    params.push(shopId);
  }
  sql += ' ORDER BY o.order_date DESC, o.id DESC';
  const orders = db.prepare(sql).all(...params);

  const rows = [];
  for (const o of orders) {
    const items = JSON.parse(o.items_json || '[]');
    for (const it of items) {
      const name = it.product_name || 'غير محدد';
      if (productQuery && !name.toLowerCase().includes(String(productQuery).toLowerCase())) continue;
      rows.push({
        orderId: o.order_id,
        date: o.order_date,
        shopId: o.shop_id,
        shopName: o.shop_name,
        productName: name,
        qty: Number(it.qty) || 0,
        enteredQty: it.enteredQty ?? it.qty,
        enteredUnit: it.enteredUnit || it.unit || 'kg',
        orderTotal: Number(o.total_value) || 0,
      });
    }
  }
  return rows;
}

// One row per shop (current state), not one row per historical balance
// snapshot — that's what the old /stats/balances dump returned, useful for
// an audit trail but not for "what's every shop's situation right now."
function getBalancesReport(companyId) {
  return getAllEnrichedShops(companyId, { includeInactive: true }).map((s) => ({
    shopId: s.id,
    name: s.name,
    balance: s.balance,
    lastOrderDate: s.lastOrderDate,
    balanceDate: s.balance_date,
    classification: s.classification || 'غير مصنّف',
    status: STATUS_LABEL[s.status] || s.status,
    active: s.active ? 'نشط' : 'معطّل',
  }));
}

// Merges car_inventory + factory_inventory into one row per material
// (joined by product_id when both warehouses stock the product master
// item, falling back to a name match for legacy rows without one) instead
// of the two separate per-warehouse dumps the old export had.
function getInventoryReport(companyId) {
  const car = db.prepare('SELECT * FROM car_inventory WHERE company_id = ?').all(companyId);
  const factory = db.prepare('SELECT * FROM factory_inventory WHERE company_id = ?').all(companyId);
  const map = new Map();
  const keyOf = (row) => (row.product_id != null ? `p${row.product_id}` : `n:${row.item_name}`);

  for (const row of car) {
    const k = keyOf(row);
    const entry = map.get(k) || { name: row.item_name, carQty: null, carMin: null, factoryQty: null, factoryMin: null };
    entry.name = row.item_name;
    entry.carQty = row.current_quantity;
    entry.carMin = row.min_quantity;
    map.set(k, entry);
  }
  for (const row of factory) {
    const k = keyOf(row);
    const entry = map.get(k) || { name: row.item_name, carQty: null, carMin: null, factoryQty: null, factoryMin: null };
    entry.name = row.item_name;
    entry.factoryQty = row.current_quantity;
    entry.factoryMin = row.min_quantity;
    map.set(k, entry);
  }

  return Array.from(map.values())
    .map((e) => {
      const carLow = e.carQty != null && e.carMin != null && e.carQty <= e.carMin;
      const factoryLow = e.factoryQty != null && e.factoryMin != null && e.factoryQty <= e.factoryMin;
      return { ...e, status: carLow || factoryLow ? 'منخفض' : 'طبيعي' };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

// Clean object for KPI cards — the old computeOverview() in lib/stats.js
// returns a metric/value array meant for a generic table dump, kept as-is
// for backward compatibility with that route; this is the shape the new
// Overview tab's cards actually want.
function getOverviewKpis(companyId) {
  const activeShops = getAllEnrichedShops(companyId);
  const statusCounts = { red: 0, yellow: 0, green: 0 };
  let totalOutstandingBalance = 0;
  activeShops.forEach((s) => {
    statusCounts[s.status]++;
    if (s.balance > 0) totalOutstandingBalance += s.balance;
  });

  const totalSalesAllTime = db
    .prepare('SELECT COALESCE(SUM(total_value), 0) v FROM orders WHERE company_id = ? AND deleted_at IS NULL')
    .get(companyId).v;
  const lowStockCount = db
    .prepare('SELECT COUNT(*) c FROM car_inventory WHERE company_id = ? AND current_quantity <= min_quantity')
    .get(companyId).c;
  const factoryLowStockCount = db
    .prepare('SELECT COUNT(*) c FROM factory_inventory WHERE company_id = ? AND current_quantity <= min_quantity')
    .get(companyId).c;
  const monthlyTarget = computeMonthlyTarget(companyId);

  return {
    activeShopsCount: activeShops.length,
    totalSalesAllTime,
    shopStatusCounts: statusCounts,
    totalOutstandingBalance,
    lowStockCombinedCount: lowStockCount + factoryLowStockCount,
    monthlyTarget: monthlyTarget.target,
    monthlyActualSales: monthlyTarget.actualSales,
    monthlyTargetPercent: monthlyTarget.percent,
  };
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Last `months` calendar months (including the current, partial one),
// zero-filled, plus a flag on whichever month is the highest-grossing in
// the ENTIRE order history (not just within this window) so a genuinely
// record month outside the last 12 doesn't get silently outranked by a
// merely-locally-highest one.
function getMonthlySales(companyId, months = 12) {
  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    buckets.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }

  const rows = db
    .prepare(
      `SELECT substr(order_date, 1, 7) as month, COALESCE(SUM(total_value),0) as total, COUNT(*) as cnt
       FROM orders WHERE company_id = ? AND deleted_at IS NULL GROUP BY month`
    )
    .all(companyId);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const allTimeMax = db
    .prepare(
      `SELECT substr(order_date, 1, 7) as month, COALESCE(SUM(total_value),0) as total
       FROM orders WHERE company_id = ? AND deleted_at IS NULL GROUP BY month ORDER BY total DESC LIMIT 1`
    )
    .get(companyId);

  let prevTotal = null;
  return buckets.map((month) => {
    const row = byMonth.get(month);
    const total = row ? row.total : 0;
    const orderCount = row ? row.cnt : 0;
    const changePct = prevTotal != null && prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null;
    prevTotal = total;
    return { month, total, orderCount, changePct, isHighestEver: !!allTimeMax && allTimeMax.month === month };
  });
}

// Drill-down for a single "YYYY-MM" clicked from the monthly sales table.
function getMonthDetail(companyId, month) {
  const orders = db
    .prepare(
      `SELECT o.shop_id, s.name as shop_name, o.items_json, o.total_value
       FROM orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.deleted_at IS NULL AND o.company_id = ? AND substr(o.order_date, 1, 7) = ?`
    )
    .all(companyId, month);

  const shopTotals = new Map();
  const materialTotals = new Map();
  let totalSales = 0;
  for (const o of orders) {
    totalSales += Number(o.total_value) || 0;
    const shopEntry = shopTotals.get(o.shop_id) || { shopId: o.shop_id, shopName: o.shop_name, total: 0 };
    shopEntry.total += Number(o.total_value) || 0;
    shopTotals.set(o.shop_id, shopEntry);

    const items = JSON.parse(o.items_json || '[]');
    for (const it of items) {
      const name = it.product_name || 'غير محدد';
      const entry = materialTotals.get(name) || { productName: name, totalQty: 0 };
      entry.totalQty += Number(it.qty) || 0;
      materialTotals.set(name, entry);
    }
  }

  return {
    month,
    totalSales,
    orderCount: orders.length,
    topShops: Array.from(shopTotals.values()).sort((a, b) => b.total - a.total).slice(0, 10),
    topMaterials: Array.from(materialTotals.values()).sort((a, b) => b.totalQty - a.totalQty).slice(0, 10),
  };
}

module.exports = {
  getSalesReport,
  getBalancesReport,
  getInventoryReport,
  getOverviewKpis,
  getMonthlySales,
  getMonthDetail,
};
