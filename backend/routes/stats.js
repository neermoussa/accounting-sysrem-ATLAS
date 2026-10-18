const express = require('express');
const ExcelJS = require('exceljs');
const { requirePermission } = require('../middleware/auth');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const db = require('../db/init');
const { sendTablePdf } = require('../lib/pdfExport');
const { computeMonthlyTarget } = require('../lib/stats');
const {
  getSalesReport,
  getBalancesReport,
  getInventoryReport,
  getOverviewKpis,
  getMonthlySales,
  getMonthDetail,
} = require('../lib/reports');

const router = express.Router();
router.use(requirePermission('view_statistics'));

router.get('/overview', (req, res) => res.json(getOverviewKpis(req.companyId)));
router.get('/monthly-target', (req, res) => res.json(computeMonthlyTarget(req.companyId)));
router.get('/monthly-sales', (req, res) => res.json(getMonthlySales(req.companyId, 12)));
router.get('/monthly-sales/:month', (req, res) => res.json(getMonthDetail(req.companyId, req.params.month)));

function salesFiltersFromQuery(req) {
  return {
    from: req.query.from || undefined,
    to: req.query.to || undefined,
    shopId: req.query.shopId || undefined,
    productQuery: req.query.productQuery || undefined,
  };
}

router.get('/sales-report', (req, res) => res.json(getSalesReport(req.companyId, salesFiltersFromQuery(req))));
router.get('/balances-report', (req, res) => res.json(getBalancesReport(req.companyId)));
router.get('/inventory-report', (req, res) => res.json(getInventoryReport(req.companyId)));

// `label` names the sheet/PDF title (Arabic reads fine there); `slug` names
// the downloaded file — kept ASCII because Chromium's blob-download
// `download` attribute doesn't reliably honor non-ASCII values.
const REPORTS = {
  sales: {
    label: 'تقرير المبيعات',
    labelEn: 'Sales report',
    slug: 'sales-report',
    dateScoped: true,
    getRows: (req) => getSalesReport(req.companyId, salesFiltersFromQuery(req)),
    columns: [
      { header: 'التاريخ', headerEn: 'Date', key: 'date', width: 14 },
      { header: 'المحل', headerEn: 'Shop', key: 'shopName', width: 26 },
      { header: 'المادة', headerEn: 'Product', key: 'productName', width: 22 },
      { header: 'الكمية', headerEn: 'Quantity', key: 'enteredQty', width: 12 },
      { header: 'الوحدة', headerEn: 'Unit', key: 'enteredUnit', width: 10 },
      { header: 'إجمالي قيمة الطلب', headerEn: 'Order total', key: 'orderTotal', width: 16 },
    ],
  },
  balances: {
    label: 'تقرير الأرصدة',
    labelEn: 'Balances report',
    slug: 'balances-report',
    getRows: (req) => getBalancesReport(req.companyId),
    columns: [
      { header: 'المحل', headerEn: 'Shop', key: 'name', width: 26 },
      { header: 'الرصيد الحالي', headerEn: 'Current balance', key: 'balance', width: 14 },
      { header: 'تاريخ آخر حركة', headerEn: 'Last order date', key: 'lastOrderDate', width: 16 },
      { header: 'تاريخ آخر تحديث أمين', headerEn: 'Last collector update', key: 'balanceDate', width: 18 },
      { header: 'التصنيف', headerEn: 'Classification', key: 'classification', width: 12 },
      { header: 'الحالة', headerEn: 'Status', key: 'status', width: 14 },
    ],
  },
  inventory: {
    label: 'تقرير المخزون',
    labelEn: 'Inventory report',
    slug: 'inventory-report',
    getRows: (req) => getInventoryReport(req.companyId),
    columns: [
      { header: 'الصنف', headerEn: 'Item', key: 'name', width: 24 },
      { header: 'كمية السيارة', headerEn: 'Car quantity', key: 'carQty', width: 14 },
      { header: 'حد السيارة الأدنى', headerEn: 'Car min', key: 'carMin', width: 16 },
      { header: 'كمية المعمل', headerEn: 'Factory quantity', key: 'factoryQty', width: 14 },
      { header: 'حد المعمل الأدنى', headerEn: 'Factory min', key: 'factoryMin', width: 16 },
      { header: 'الحالة', headerEn: 'Status', key: 'status', width: 12 },
    ],
  },
  'monthly-sales': {
    label: 'المبيعات الشهرية',
    labelEn: 'Monthly sales',
    slug: 'monthly-sales',
    getRows: (req) => getMonthlySales(req.companyId, 12),
    columns: [
      { header: 'الشهر', headerEn: 'Month', key: 'month', width: 12 },
      { header: 'إجمالي المبيعات', headerEn: 'Total sales', key: 'total', width: 16 },
      { header: 'عدد الفواتير', headerEn: 'Invoice count', key: 'orderCount', width: 14 },
      { header: 'نسبة التغيّر', headerEn: 'Change %', key: 'changePct', width: 14 },
    ],
  },
};

router.get('/export', requirePermission('export_data'), async (req, res) => {
  const report = REPORTS[req.query.report];
  if (!report) return res.status(400).json({ error: 'invalid_report' });
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  const rows = report.getRows(req);
  const lang = langFromQuery(req);

  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId);
  if (format === 'pdf') {
    const metaLabels = lang === 'en'
      ? ['Atlas', company?.name, report.dateScoped ? `${req.query.from || '—'} → ${req.query.to || '—'}` : null, 'English']
      : ['Atlas', company?.name, report.dateScoped ? `${req.query.from || '—'} → ${req.query.to || '—'}` : null, 'العربية'];
    await sendTablePdf(
      res,
      { title: lang === 'en' ? report.labelEn || report.label : report.label, columns: report.columns, rows, lang, meta: metaLabels.filter(Boolean) },
      `${report.slug}.pdf`
    );
    return;
  }
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, report.label, report.columns, rows, {
    title: lang === 'en' ? report.labelEn || report.label : report.label,
    lang,
    companyName: company?.name,
    dateRange: report.dateScoped ? { from: req.query.from, to: req.query.to } : undefined,
  });
  await sendWorkbook(res, workbook, `${report.slug}.xlsx`);
});

module.exports = router;
