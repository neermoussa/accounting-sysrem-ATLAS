const db = require('../db/init');
const { getFilteredOrders, getFilteredOrderItems, shopMatchesGeo } = require('./reportFilters');
const { parseGeo } = require('./marketIntelligence');
const { getAllEnrichedShops } = require('./shopData');
const { computeCommissionStatement, periodRange } = require('./commissions');

// ---------------------------------------------------------------------
// Sales, filterable across every dimension: period, city, region, rep,
// customer, product, warehouse, branch.
// ---------------------------------------------------------------------

function getFilteredSalesReport(companyId, filters) {
  const rows = getFilteredOrderItems(companyId, filters);
  const orderIds = new Set(rows.map((r) => r.order.id));
  const seenOrderTotals = new Map();
  for (const r of rows) seenOrderTotals.set(r.order.id, r.order.total_value || 0);
  const totalValue = [...seenOrderTotals.values()].reduce((sum, v) => sum + v, 0);
  const distinctShops = new Set(rows.map((r) => r.order.shop_id)).size;
  return {
    lines: rows.map((r) => ({
      orderId: r.order.id,
      date: r.order.order_date,
      shopId: r.order.shop_id,
      shopName: r.order.shop_name,
      repId: r.order.rep_id,
      productName: r.productName,
      qty: Number(r.item.qty) || 0,
      lineTotal: r.item.line_total ?? null,
    })),
    summary: {
      orderCount: orderIds.size,
      totalValue,
      avgOrderValue: orderIds.size ? totalValue / orderIds.size : 0,
      distinctCustomers: distinctShops,
    },
  };
}

// ---------------------------------------------------------------------
// Returns / damaged goods
// ---------------------------------------------------------------------

function getReturnsAndDamagedReport(companyId, filters) {
  let sql = `SELECT ri.product_name, ri.inspection_status, ri.requested_qty, rr.shop_id, rr.created_at, s.region, s.branch, s.warehouse_id
             FROM return_items ri JOIN return_requests rr ON rr.id = ri.return_request_id JOIN shops s ON s.id = rr.shop_id
             WHERE ri.company_id = ?`;
  const params = [companyId];
  if (filters.from) {
    sql += ' AND rr.created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND rr.created_at <= ?';
    params.push(`${filters.to} 23:59:59`);
  }
  const rows = db
    .prepare(sql)
    .all(...params)
    .filter((r) => shopMatchesGeo({ id: r.shop_id, region: r.region, branch: r.branch, warehouse_id: r.warehouse_id }, filters))
    .filter((r) => !filters.productName || r.product_name.toLowerCase().includes(filters.productName.toLowerCase()));

  const damaged = rows.filter((r) => r.inspection_status === 'damaged');
  return {
    returnsCount: rows.length,
    returnsQty: rows.reduce((s, r) => s + r.requested_qty, 0),
    damagedCount: damaged.length,
    damagedQty: damaged.reduce((s, r) => s + r.requested_qty, 0),
    byProduct: Object.values(
      rows.reduce((acc, r) => {
        acc[r.product_name] = acc[r.product_name] || { productName: r.product_name, returnsCount: 0, damagedCount: 0 };
        acc[r.product_name].returnsCount += 1;
        if (r.inspection_status === 'damaged') acc[r.product_name].damagedCount += 1;
        return acc;
      }, {})
    ),
  };
}

// ---------------------------------------------------------------------
// Custody-transfer discrepancies
// ---------------------------------------------------------------------

function getDiscrepanciesReport(companyId, filters) {
  let sql = `SELECT ct.*, v.label as vehicle_label FROM custody_transfers ct LEFT JOIN vehicles v ON v.id = ct.vehicle_id WHERE ct.company_id = ?`;
  const params = [companyId];
  if (filters.from) {
    sql += ' AND ct.created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND ct.created_at <= ?';
    params.push(`${filters.to} 23:59:59`);
  }
  if (filters.repId) {
    sql += ' AND ct.rep_id = ?';
    params.push(filters.repId);
  }
  if (filters.warehouseId) {
    sql += ' AND ct.warehouse_id = ?';
    params.push(filters.warehouseId);
  }
  if (filters.vehicleId) {
    sql += ' AND ct.vehicle_id = ?';
    params.push(filters.vehicleId);
  }
  const transfers = db.prepare(sql).all(...params);
  const mismatched = transfers.filter((t) => t.status === 'discrepancy' || t.status === 'closed');
  return {
    totalTransfers: transfers.length,
    discrepancyCount: transfers.filter((t) => t.status === 'discrepancy').length,
    byVehicle: Object.values(
      transfers.reduce((acc, t) => {
        const key = t.vehicle_label || 'غير محدد';
        acc[key] = acc[key] || { vehicle: key, total: 0, discrepancies: 0 };
        acc[key].total += 1;
        if (t.status === 'discrepancy') acc[key].discrepancies += 1;
        return acc;
      }, {})
    ),
  };
}

// ---------------------------------------------------------------------
// Rep performance + targets/commissions
// ---------------------------------------------------------------------

function getRepPerformanceReport(companyId, filters) {
  const reps = db.prepare("SELECT id, name FROM users WHERE company_id = ? AND status = 'approved'").all(companyId);
  return reps.map((rep) => {
    const orders = getFilteredOrders(companyId, { ...filters, repId: rep.id });
    const totalSales = orders.reduce((s, o) => s + (o.total_value || 0), 0);
    const visits = db
      .prepare('SELECT COUNT(*) c, SUM(CASE WHEN result = ? THEN 1 ELSE 0 END) ot FROM visit_records WHERE company_id = ? AND rep_id = ?')
      .get('order_taken', companyId, rep.id);
    return {
      repId: rep.id,
      repName: rep.name,
      orderCount: orders.length,
      totalSales,
      visitCount: visits.c || 0,
      visitToOrderConversionPct: visits.c ? Math.round(((visits.ot || 0) / visits.c) * 1000) / 10 : null,
    };
  });
}

function getTargetsCommissionsReport(companyId, { period = 'monthly' } = {}) {
  const reps = db.prepare('SELECT DISTINCT user_id FROM rep_targets WHERE company_id = ?').all(companyId);
  return reps.map(({ user_id }) => {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(user_id);
    const statement = computeCommissionStatement(companyId, user_id, period);
    return { repId: user_id, repName: user?.name, ...statement };
  });
}

// ---------------------------------------------------------------------
// Visits + conversion + route adherence
// ---------------------------------------------------------------------

function getVisitsReport(companyId, filters) {
  let sql = `SELECT vr.*, s.region, s.branch, s.warehouse_id FROM visit_records vr JOIN shops s ON s.id = vr.shop_id WHERE vr.company_id = ?`;
  const params = [companyId];
  if (filters.from) {
    sql += ' AND date(vr.recorded_at) >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND date(vr.recorded_at) <= ?';
    params.push(filters.to);
  }
  if (filters.repId) {
    sql += ' AND vr.rep_id = ?';
    params.push(filters.repId);
  }
  const rows = db
    .prepare(sql)
    .all(...params)
    .filter((r) => shopMatchesGeo({ id: r.shop_id, region: r.region, branch: r.branch, warehouse_id: r.warehouse_id }, filters));

  const byResult = rows.reduce((acc, r) => {
    acc[r.result] = (acc[r.result] || 0) + 1;
    return acc;
  }, {});
  return {
    totalVisits: rows.length,
    byResult,
    conversionToOrderPct: rows.length ? Math.round(((byResult.order_taken || 0) / rows.length) * 1000) / 10 : null,
  };
}

function getRouteAdherenceReport(companyId, filters) {
  let sql = `SELECT * FROM wave_instances WHERE company_id = ?`;
  const params = [companyId];
  if (filters.from) {
    sql += ' AND plan_date >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND plan_date <= ?';
    params.push(filters.to);
  }
  if (filters.repId) {
    sql += ' AND rep_id = ?';
    params.push(filters.repId);
  }
  const instances = db.prepare(sql).all(...params);
  const completed = instances.filter((i) => i.status === 'completed');
  const lateNotifications = db
    .prepare("SELECT COUNT(*) c FROM notifications WHERE company_id = ? AND type = 'rep_late'")
    .get(companyId).c;
  return {
    totalWaves: instances.length,
    completedWaves: completed.length,
    completionRatePct: instances.length ? Math.round((completed.length / instances.length) * 1000) / 10 : null,
    lateWaveAlerts: lateNotifications,
  };
}

// ---------------------------------------------------------------------
// New / churned customers, avg order value & purchase frequency
// ---------------------------------------------------------------------

function getCustomerLifecycleReport(companyId, filters) {
  const shops = getAllEnrichedShops(companyId).filter((s) => shopMatchesGeo(s, filters));
  const from = filters.from || '1970-01-01';
  const to = filters.to || '9999-12-31';
  const churnDays = 60;
  const newCustomers = shops.filter((s) => s.created_at?.slice(0, 10) >= from && s.created_at?.slice(0, 10) <= to);
  const churned = shops.filter((s) => s.daysSinceOrder != null && s.daysSinceOrder > churnDays);
  return {
    newCustomersCount: newCustomers.length,
    churnedCustomersCount: churned.length,
    churnThresholdDays: churnDays,
    totalActiveCustomers: shops.length,
  };
}

function getAvgOrderFrequencyReport(companyId, filters) {
  const orders = getFilteredOrders(companyId, filters);
  const byShop = orders.reduce((acc, o) => {
    acc[o.shop_id] = acc[o.shop_id] || { shopId: o.shop_id, shopName: o.shop_name, orders: [] };
    acc[o.shop_id].orders.push(o);
    return acc;
  }, {});
  const rows = Object.values(byShop).map((s) => {
    const dates = s.orders.map((o) => o.order_date).sort();
    const total = s.orders.reduce((sum, o) => sum + (o.total_value || 0), 0);
    let avgDaysBetween = null;
    if (dates.length > 1) {
      const first = new Date(dates[0]);
      const last = new Date(dates[dates.length - 1]);
      avgDaysBetween = Math.round(((last - first) / 86400000 / (dates.length - 1)) * 10) / 10;
    }
    return { shopId: s.shopId, shopName: s.shopName, orderCount: s.orders.length, avgOrderValue: total / s.orders.length, avgDaysBetweenOrders: avgDaysBetween };
  });
  return rows.sort((a, b) => b.orderCount - a.orderCount);
}

// ---------------------------------------------------------------------
// Profit / discounts / returns / damaged (single combined view)
// ---------------------------------------------------------------------

// Load-test finding: this used to run one SELECT per line item to look up
// its product's cost_price — fine at a few thousand items, but scales
// linearly with order volume rather than product catalog size. All of a
// company's cost prices fit in one query and one Map, built once before
// the loop.
function getCostPriceMap(companyId) {
  return new Map(
    db.prepare('SELECT id, cost_price FROM products WHERE company_id = ?').all(companyId).map((p) => [p.id, p.cost_price])
  );
}

function getProfitReport(companyId, filters) {
  const rows = getFilteredOrderItems(companyId, filters);
  const costPrices = getCostPriceMap(companyId);
  let revenue = 0;
  let cost = 0;
  for (const { order, item } of rows) {
    if (item.is_free) continue;
    revenue += item.line_total ?? (Number(item.unit_price || item.price || 0) * Number(item.qty || 0));
    const costPrice = item.product_id ? costPrices.get(item.product_id) : null;
    if (costPrice) cost += costPrice * (Number(item.qty) || 0);
  }
  const freeGoods = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) qty FROM free_goods_log WHERE company_id = ?${filters.from ? ' AND created_at >= ?' : ''}${filters.to ? ' AND created_at <= ?' : ''}`
    )
    .get(companyId, ...(filters.from ? [filters.from] : []), ...(filters.to ? [`${filters.to} 23:59:59`] : []));
  const returnsAndDamaged = getReturnsAndDamagedReport(companyId, filters);
  return {
    revenue,
    estimatedCost: cost,
    estimatedProfit: revenue - cost,
    freeGoodsQty: freeGoods.qty,
    returnsCount: returnsAndDamaged.returnsCount,
    damagedCount: returnsAndDamaged.damagedCount,
  };
}

// ---------------------------------------------------------------------
// Inventory: fast / slow movers, warehouse & vehicle movement
// ---------------------------------------------------------------------

function getInventoryMovementReport(companyId, { lookbackDays = 30 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const orders = db.prepare('SELECT items_json FROM orders WHERE company_id = ? AND deleted_at IS NULL AND order_date >= ?').all(companyId, since);
  const velocity = new Map();
  for (const o of orders) {
    for (const it of JSON.parse(o.items_json || '[]')) {
      if (it.is_free || !it.product_id) continue;
      velocity.set(it.product_id, (velocity.get(it.product_id) || 0) + (Number(it.qty) || 0));
    }
  }
  const products = db.prepare('SELECT id, name FROM products WHERE company_id = ? AND active = 1').all(companyId);
  const rows = products.map((p) => {
    const totalQty = velocity.get(p.id) || 0;
    const car = db.prepare('SELECT current_quantity FROM car_inventory WHERE company_id = ? AND product_id = ?').get(companyId, p.id);
    const factory = db.prepare('SELECT current_quantity FROM factory_inventory WHERE company_id = ? AND product_id = ?').get(companyId, p.id);
    return {
      productId: p.id,
      productName: p.name,
      dailyRate: totalQty / lookbackDays,
      currentStock: (car?.current_quantity || 0) + (factory?.current_quantity || 0),
      movement: totalQty === 0 ? 'راكد' : totalQty / lookbackDays >= 1 ? 'سريع' : 'بطيء',
    };
  });
  return rows.sort((a, b) => b.dailyRate - a.dailyRate);
}

function getWarehouseVehicleMovementReport(companyId, filters) {
  let sql = `SELECT ct.*, w.name as warehouse_name, v.label as vehicle_label FROM custody_transfers ct
             LEFT JOIN warehouses w ON w.id = ct.warehouse_id LEFT JOIN vehicles v ON v.id = ct.vehicle_id
             WHERE ct.company_id = ?`;
  const params = [companyId];
  if (filters.from) {
    sql += ' AND ct.created_at >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND ct.created_at <= ?';
    params.push(`${filters.to} 23:59:59`);
  }
  const rows = db.prepare(sql).all(...params);
  return {
    totalTransfers: rows.length,
    byWarehouse: Object.values(
      rows.reduce((acc, r) => {
        const key = r.warehouse_name || 'غير محدد';
        acc[key] = acc[key] || { warehouse: key, count: 0 };
        acc[key].count += 1;
        return acc;
      }, {})
    ),
    byVehicle: Object.values(
      rows.reduce((acc, r) => {
        const key = r.vehicle_label || 'غير محدد';
        acc[key] = acc[key] || { vehicle: key, count: 0 };
        acc[key].count += 1;
        return acc;
      }, {})
    ),
  };
}

// ---------------------------------------------------------------------
// Heatmap + branch comparison + pivot
// ---------------------------------------------------------------------

// Grid-bins shop coordinates to ~1km cells (0.01 deg) so points don't leak
// exact addresses at a glance while still showing real density.
function getHeatmapData(companyId, { metric = 'sales', filters = {} } = {}) {
  const orders = getFilteredOrders(companyId, filters);
  const byShop = orders.reduce((acc, o) => {
    acc[o.shop_id] = (acc[o.shop_id] || 0) + (metric === 'sales' ? o.total_value || 0 : 1);
    return acc;
  }, {});
  const shops = db.prepare('SELECT id, lat, lng FROM shops WHERE company_id = ? AND lat IS NOT NULL AND lng IS NOT NULL').all(companyId);
  const cells = new Map();
  for (const s of shops) {
    const weight = byShop[s.id] || 0;
    if (weight <= 0) continue;
    const key = `${Math.round(s.lat * 100) / 100}|${Math.round(s.lng * 100) / 100}`;
    cells.set(key, (cells.get(key) || 0) + weight);
  }
  return [...cells.entries()].map(([key, weight]) => {
    const [lat, lng] = key.split('|').map(Number);
    return { lat, lng, weight };
  });
}

function getBranchComparisonReport(companyId, filters) {
  const rows = getFilteredOrderItems(companyId, filters);
  const costPrices = getCostPriceMap(companyId);
  const byBranch = new Map();
  for (const { order, item } of rows) {
    if (item.is_free) continue;
    const branch = order.shop_branch || 'غير محدد';
    const entry = byBranch.get(branch) || { branch, revenue: 0, cost: 0 };
    const lineRevenue = item.line_total ?? (Number(item.unit_price || item.price || 0) * Number(item.qty || 0));
    entry.revenue += lineRevenue;
    const costPrice = item.product_id ? costPrices.get(item.product_id) : null;
    if (costPrice) entry.cost += costPrice * (Number(item.qty) || 0);
    byBranch.set(branch, entry);
  }
  return [...byBranch.values()]
    .map((e) => ({ ...e, margin: e.revenue - e.cost, marginPct: e.revenue ? Math.round(((e.revenue - e.cost) / e.revenue) * 1000) / 10 : null }))
    .sort((a, b) => b.revenue - a.revenue);
}

const PIVOT_DIMS = {
  region: (r) => parseGeo(r.order.shop_region).governorate || 'غير محدد',
  city: (r) => parseGeo(r.order.shop_region).city || 'غير محدد',
  branch: (r) => r.order.shop_branch || 'غير محدد',
  repId: (r) => String(r.order.rep_id || 'غير محدد'),
  productName: (r) => r.productName,
  month: (r) => r.order.order_date?.slice(0, 7),
};

function getPivotReport(companyId, { rowDim, colDim, measure = 'totalValue', filters = {} }) {
  if (!PIVOT_DIMS[rowDim] || !PIVOT_DIMS[colDim]) {
    throw Object.assign(new Error('invalid_pivot_dimension'), { status: 400 });
  }
  const rows = getFilteredOrderItems(companyId, filters);
  const table = new Map(); // rowKey -> Map(colKey -> value)
  const colKeys = new Set();
  for (const r of rows) {
    const rowKey = PIVOT_DIMS[rowDim](r);
    const colKey = PIVOT_DIMS[colDim](r);
    colKeys.add(colKey);
    if (!table.has(rowKey)) table.set(rowKey, new Map());
    const cell = table.get(rowKey);
    const value = measure === 'qty' ? Number(r.item.qty) || 0 : measure === 'orderCount' ? 1 : r.item.line_total ?? Number(r.item.unit_price || r.item.price || 0) * (Number(r.item.qty) || 0);
    cell.set(colKey, (cell.get(colKey) || 0) + value);
  }
  return {
    rows: [...table.entries()].map(([rowKey, cols]) => ({
      dimension: rowKey,
      values: Object.fromEntries(cols),
      total: [...cols.values()].reduce((s, v) => s + v, 0),
    })),
    columns: [...colKeys],
  };
}

module.exports = {
  getFilteredSalesReport,
  getReturnsAndDamagedReport,
  getDiscrepanciesReport,
  getRepPerformanceReport,
  getTargetsCommissionsReport,
  getVisitsReport,
  getRouteAdherenceReport,
  getCustomerLifecycleReport,
  getAvgOrderFrequencyReport,
  getProfitReport,
  getInventoryMovementReport,
  getWarehouseVehicleMovementReport,
  getHeatmapData,
  getBranchComparisonReport,
  getPivotReport,
};
