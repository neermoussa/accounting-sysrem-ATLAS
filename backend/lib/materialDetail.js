const db = require('../db/init');

function lastNMonths(n) {
  const now = new Date();
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

// Quantity-only detail for one product (no price-over-time chart here —
// see routes/invoices.js's comment on the reconciliation engine: nothing in
// this app's data model records a per-sale price, so a "price history"
// chart would have to be fabricated). Matches product_id when the order
// line item has one (everything entered via QuickOrderForm does), falling
// back to a name match for any legacy rows that predate that field.
function computeMaterialDetail(companyId, productId) {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(productId, companyId);
  if (!product) return null;

  const orders = db
    .prepare(
      `SELECT o.order_date, o.shop_id, s.name as shop_name, o.items_json
       FROM orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.deleted_at IS NULL AND o.company_id = ?`
    )
    .all(companyId);

  const monthly = new Map();
  const yearly = new Map();
  const byShop = new Map();

  for (const o of orders) {
    const items = JSON.parse(o.items_json || '[]');
    for (const it of items) {
      const matches = it.product_id != null ? String(it.product_id) === String(productId) : it.product_name === product.name;
      if (!matches) continue;
      const qty = Number(it.qty) || 0;
      const month = o.order_date.slice(0, 7);
      const year = o.order_date.slice(0, 4);
      monthly.set(month, (monthly.get(month) || 0) + qty);
      yearly.set(year, (yearly.get(year) || 0) + qty);
      const shopEntry = byShop.get(o.shop_id) || { shopId: o.shop_id, shopName: o.shop_name, totalQty: 0 };
      shopEntry.totalQty += qty;
      byShop.set(o.shop_id, shopEntry);
    }
  }

  const monthlySeries = lastNMonths(12).map((m) => ({ month: m, qty: Math.round((monthly.get(m) || 0) * 100) / 100 }));
  const yearlySeries = Array.from(yearly.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, qty]) => ({ year, qty: Math.round(qty * 100) / 100 }));
  const topShops = Array.from(byShop.values())
    .sort((a, b) => b.totalQty - a.totalQty)
    .slice(0, 10);

  return {
    product: { id: product.id, name: product.name, unit: product.unit },
    monthly: monthlySeries,
    yearly: yearlySeries,
    topShops,
  };
}

module.exports = { computeMaterialDetail };
