const db = require('../db/init');
const { parseGeo } = require('./marketIntelligence');

// Every report/dashboard in lib/reports.js that needs "filter by period,
// city, region, rep, customer, product, warehouse, vehicle, branch" reads
// this same shape — one place defines what a filter object looks like and
// how it's applied, so every report stays consistent instead of each
// hand-rolling its own subset of dimensions.
function parseReportFilters(query = {}) {
  return {
    from: query.from || undefined,
    to: query.to || undefined,
    repId: query.repId ? Number(query.repId) : undefined,
    shopId: query.shopId ? Number(query.shopId) : undefined,
    region: query.region || undefined, // matches shops.region's governorate segment
    city: query.city || undefined, // matches shops.region's city segment
    branch: query.branch || undefined,
    warehouseId: query.warehouseId ? Number(query.warehouseId) : undefined,
    vehicleId: query.vehicleId ? Number(query.vehicleId) : undefined,
    productName: query.productName || undefined,
  };
}

function shopMatchesGeo(shop, filters) {
  if (filters.shopId && shop.id !== filters.shopId) return false;
  if (filters.branch && shop.branch !== filters.branch) return false;
  if (filters.warehouseId && shop.warehouse_id !== filters.warehouseId) return false;
  if (filters.region || filters.city) {
    const geo = parseGeo(shop.region);
    if (filters.region && geo.governorate !== filters.region) return false;
    if (filters.city && geo.city !== filters.city) return false;
  }
  return true;
}

// Orders joined with their shop, filtered by every dimension that applies
// at the order level — repId (orders.rep_id), date range, and the shop's
// own geo/branch/warehouse (via shopMatchesGeo). Item-level filtering
// (productName) happens separately per-line since one order can have both
// matching and non-matching items.
function getFilteredOrders(companyId, filters) {
  let sql = `SELECT o.*, s.name as shop_name, s.region as shop_region, s.branch as shop_branch, s.warehouse_id as shop_warehouse_id
             FROM orders o JOIN shops s ON s.id = o.shop_id
             WHERE o.company_id = ? AND o.deleted_at IS NULL`;
  const params = [companyId];
  if (filters.from) {
    sql += ' AND o.order_date >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND o.order_date <= ?';
    params.push(filters.to);
  }
  if (filters.repId) {
    sql += ' AND o.rep_id = ?';
    params.push(filters.repId);
  }
  const orders = db.prepare(sql).all(...params);
  return orders.filter((o) =>
    shopMatchesGeo({ id: o.shop_id, region: o.shop_region, branch: o.shop_branch, warehouse_id: o.shop_warehouse_id }, filters)
  );
}

// Explodes filtered orders into line items, applying productName last
// (it's the one dimension that only makes sense at item granularity).
function getFilteredOrderItems(companyId, filters) {
  const orders = getFilteredOrders(companyId, filters);
  const rows = [];
  for (const o of orders) {
    const items = JSON.parse(o.items_json || '[]');
    for (const it of items) {
      const name = it.product_name || 'غير محدد';
      if (filters.productName && !name.toLowerCase().includes(String(filters.productName).toLowerCase())) continue;
      rows.push({ order: o, item: it, productName: name });
    }
  }
  return rows;
}

module.exports = { parseReportFilters, shopMatchesGeo, getFilteredOrders, getFilteredOrderItems };
