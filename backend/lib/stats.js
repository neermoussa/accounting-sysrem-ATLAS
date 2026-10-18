const db = require('../db/init');
const { getAllEnrichedShops } = require('./shopData');
const { defaultRepId, computeProgress } = require('./targets');

const STATUS_LABEL = { red: 'رصيد مستحق', yellow: 'تجاوز الموعد', green: 'سليم' };

function computeOverview(companyId) {
  const activeShops = getAllEnrichedShops(companyId);
  const inactiveCount = db.prepare('SELECT COUNT(*) c FROM shops WHERE company_id = ? AND active = 0').get(companyId).c;

  const statusCounts = { red: 0, yellow: 0, green: 0 };
  const classificationCounts = { A: 0, B: 0, C: 0, unclassified: 0 };
  let totalOutstandingBalance = 0;
  activeShops.forEach((s) => {
    statusCounts[s.status]++;
    classificationCounts[s.classification || 'unclassified']++;
    if (s.balance > 0) totalOutstandingBalance += s.balance;
  });

  const totalSalesAllTime = db
    .prepare('SELECT COALESCE(SUM(total_value), 0) v FROM orders WHERE company_id = ? AND deleted_at IS NULL')
    .get(companyId).v;
  const ordersCount = db.prepare('SELECT COUNT(*) c FROM orders WHERE company_id = ? AND deleted_at IS NULL').get(companyId).c;
  const lowStockCount = db
    .prepare('SELECT COUNT(*) c FROM car_inventory WHERE company_id = ? AND current_quantity <= min_quantity')
    .get(companyId).c;
  const factoryLowStockCount = db
    .prepare('SELECT COUNT(*) c FROM factory_inventory WHERE company_id = ? AND current_quantity <= min_quantity')
    .get(companyId).c;
  const factoryLastUpdate = db.prepare('SELECT MAX(updated_at) v FROM factory_inventory WHERE company_id = ?').get(companyId).v;
  const monthlyTarget = computeMonthlyTarget(companyId);

  return [
    { metric: 'عدد المحلات النشطة', value: activeShops.length },
    { metric: 'عدد المحلات المعطّلة', value: inactiveCount },
    { metric: 'محلات برصيد مستحق', value: statusCounts.red },
    { metric: 'محلات تجاوزت موعد الطلب', value: statusCounts.yellow },
    { metric: 'محلات بوضع سليم', value: statusCounts.green },
    { metric: 'تصنيف A', value: classificationCounts.A },
    { metric: 'تصنيف B', value: classificationCounts.B },
    { metric: 'تصنيف C', value: classificationCounts.C },
    { metric: 'غير مصنّف', value: classificationCounts.unclassified },
    { metric: 'إجمالي الرصيد المستحق (كل المحلات)', value: totalOutstandingBalance },
    { metric: 'إجمالي المبيعات (كل الطلبات، كل الوقت)', value: totalSalesAllTime },
    { metric: 'عدد الطلبات المسجّلة', value: ordersCount },
    { metric: 'أصناف وصلت للحد الأدنى بمستودع السيارة', value: lowStockCount },
    { metric: 'أصناف وصلت للحد الأدنى بمستودع المعمل', value: factoryLowStockCount },
    { metric: 'تاريخ آخر تحديث جرد المعمل', value: factoryLastUpdate || 'لا يوجد جرد بعد' },
    { metric: 'هدف مبيعات الشهر الحالي', value: monthlyTarget.target ?? 'غير محدد' },
    { metric: 'مبيعات الشهر الحالي حتى تاريخه', value: monthlyTarget.actualSales },
    { metric: 'نسبة تحقيق الهدف', value: monthlyTarget.percent != null ? `${monthlyTarget.percent}%` : '—' },
  ];
}

// Superseded by per-rep targets in sales_targets (see lib/targets.js) —
// this now reads the first approved rep's monthly target, kept as the
// single company-wide figure the older KPI card/report expect.
function computeMonthlyTarget(companyId) {
  const repId = defaultRepId(companyId);
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (!repId) return { target: null, actualSales: 0, percent: null, daysRemaining: null, daysInMonth };

  const { monthly } = computeProgress(companyId, repId);
  return {
    target: monthly.target,
    actualSales: monthly.actual,
    percent: monthly.percent,
    daysRemaining: monthly.daysRemaining,
    daysInMonth,
  };
}

function getProductsSection(companyId) {
  return db.prepare('SELECT * FROM products WHERE company_id = ? ORDER BY sort_order, name COLLATE NOCASE').all(companyId);
}

function getShopsSection(companyId) {
  return getAllEnrichedShops(companyId, { includeInactive: true }).map((s) => ({
    name: s.name,
    phone: s.phone,
    address: s.address || '',
    balance: s.balance ?? '',
    status: STATUS_LABEL[s.status] || s.status,
    classification: s.classification || 'غير مصنّف',
    active: s.active ? 'نشط' : 'معطّل',
  }));
}

function getBalancesSection(companyId) {
  return db
    .prepare(
      `SELECT s.name as shop_name, b.report_date, b.balance, b.source_file
       FROM balances b JOIN shops s ON s.id = b.shop_id
       WHERE s.company_id = ?
       ORDER BY b.report_date DESC, s.name COLLATE NOCASE`
    )
    .all(companyId);
}

function getInventorySection(companyId) {
  return db
    .prepare('SELECT * FROM car_inventory WHERE company_id = ? ORDER BY item_name COLLATE NOCASE')
    .all(companyId)
    .map((i) => ({
      item_name: i.item_name,
      current_quantity: i.current_quantity,
      min_quantity: i.min_quantity,
      state: i.current_quantity <= i.min_quantity ? 'منخفض' : 'طبيعي',
    }));
}

function getFactoryInventorySection(companyId) {
  return db
    .prepare('SELECT * FROM factory_inventory WHERE company_id = ? ORDER BY item_name COLLATE NOCASE')
    .all(companyId)
    .map((i) => ({
      item_name: i.item_name,
      current_quantity: i.current_quantity,
      min_quantity: i.min_quantity,
      state: i.current_quantity <= i.min_quantity ? 'منخفض' : 'طبيعي',
    }));
}

module.exports = {
  STATUS_LABEL,
  computeOverview,
  computeMonthlyTarget,
  getProductsSection,
  getShopsSection,
  getBalancesSection,
  getInventorySection,
  getFactoryInventorySection,
};
