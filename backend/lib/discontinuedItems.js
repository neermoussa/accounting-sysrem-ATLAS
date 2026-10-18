const db = require('../db/init');

function daysBetween(a, b) {
  return Math.floor((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

// A product this shop used to order on a regular rhythm (at least
// minOccurrences separate orders, with an average gap comfortably inside
// silenceDays) but hasn't appeared in any order for more than silenceDays —
// as opposed to a one-off item bought a couple of times long ago, which
// never had a "rhythm" to break.
function computeDiscontinuedItems(companyId, shopId, { minOccurrences = 3, silenceDays = 30 } = {}) {
  const orders = db
    .prepare('SELECT order_date, items_json FROM orders WHERE company_id = ? AND shop_id = ? AND deleted_at IS NULL ORDER BY order_date ASC')
    .all(companyId, shopId);

  const byProduct = new Map();
  for (const order of orders) {
    let items;
    try {
      items = JSON.parse(order.items_json || '[]');
    } catch {
      items = [];
    }
    for (const item of items) {
      if (!item.product_id) continue;
      if (!byProduct.has(item.product_id)) {
        byProduct.set(item.product_id, { productName: item.product_name, dates: [] });
      }
      byProduct.get(item.product_id).dates.push(order.order_date);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  for (const [productId, entry] of byProduct) {
    const dates = entry.dates;
    if (dates.length < minOccurrences) continue;
    const lastOrderedDate = dates[dates.length - 1];
    const daysSince = daysBetween(lastOrderedDate, today);
    if (daysSince <= silenceDays) continue;

    let totalGap = 0;
    for (let i = 1; i < dates.length; i++) totalGap += daysBetween(dates[i - 1], dates[i]);
    const avgIntervalDays = Math.round(totalGap / (dates.length - 1));
    if (avgIntervalDays >= silenceDays) continue; // never had a tight rhythm to begin with

    results.push({ productId, productName: entry.productName, occurrences: dates.length, lastOrderedDate, daysSince, avgIntervalDays });
  }
  return results.sort((a, b) => b.daysSince - a.daysSince);
}

module.exports = { computeDiscontinuedItems };
