const db = require('../db/init');
const { daysBetween } = require('./status');

// Thresholds live entirely in settings (admin-editable) rather than being computed
// automatically, since the business's sales scale and targets shift over time.
// Any missing threshold means classification can't run yet — shops stay unclassified.
function thresholdsFromSettings(globalSettings) {
  const windowDays = Number(globalSettings.classification_window_days || 90);
  const salesAMin = globalSettings.classification_sales_a_min;
  const salesBMin = globalSettings.classification_sales_b_min;
  const cvAMax = globalSettings.classification_regularity_cv_a_max;
  const cvBMax = globalSettings.classification_regularity_cv_b_max;

  const configured =
    salesAMin !== '' && salesAMin != null &&
    salesBMin !== '' && salesBMin != null &&
    cvAMax !== '' && cvAMax != null &&
    cvBMax !== '' && cvBMax != null;

  if (!configured) return null;

  return {
    windowDays,
    salesAMin: Number(salesAMin),
    salesBMin: Number(salesBMin),
    cvAMax: Number(cvAMax),
    cvBMax: Number(cvBMax),
  };
}

function coefficientOfVariation(orderDates) {
  if (orderDates.length < 2) return null;
  const sorted = [...orderDates].sort();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1], sorted[i]));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return 0;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

// Returns 'A' | 'B' | 'C' | null (null = thresholds not configured yet, "غير مصنّف").
function computeClassification(shopId, globalSettings) {
  const t = thresholdsFromSettings(globalSettings);
  if (!t) return null;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - t.windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const orders = db
    .prepare(
      'SELECT order_date, total_value FROM orders WHERE shop_id = ? AND order_date >= ? AND deleted_at IS NULL ORDER BY order_date ASC'
    )
    .all(shopId, cutoffStr);

  const totalSales = orders.reduce((sum, o) => sum + (o.total_value || 0), 0);
  const cv = coefficientOfVariation(orders.map((o) => o.order_date));
  const effectiveCv = cv === null ? Infinity : cv; // not enough orders to confirm regularity -> can't be A/B

  if (totalSales >= t.salesAMin && effectiveCv <= t.cvAMax) return 'A';
  if (totalSales >= t.salesBMin && effectiveCv <= t.cvBMax) return 'B';
  return 'C';
}

function recomputeShopClassification(shopId, globalSettings) {
  const classification = computeClassification(shopId, globalSettings);
  db.prepare(
    `UPDATE shops SET classification = ?, classification_computed_at = datetime('now') WHERE id = ?`
  ).run(classification, shopId);
  return classification;
}

function recomputeAllClassifications(companyId, globalSettings) {
  const ids = db.prepare('SELECT id FROM shops WHERE company_id = ?').all(companyId).map((r) => r.id);
  const counts = { A: 0, B: 0, C: 0, unclassified: 0 };
  for (const id of ids) {
    const c = recomputeShopClassification(id, globalSettings);
    counts[c || 'unclassified']++;
  }
  return { total: ids.length, counts };
}

module.exports = { computeClassification, recomputeShopClassification, recomputeAllClassifications };
