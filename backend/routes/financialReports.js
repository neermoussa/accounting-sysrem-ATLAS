// /api/financial-reports — financial statements, budgets, year-end close and
// the month-end checklist (Prompt 4). Business rules: lib/financialReports.js.
// (/api/reports is the older operational-reports router.)
//
// Every GET report accepts ?format=xlsx|pdf&lang=ar|en and then returns the
// same rows as a file.

const express = require('express');
const ExcelJS = require('exceljs');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const fr = require('../lib/financialReports');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { sendTablePdf } = require('../lib/pdfExport');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_financial_reports', 'view_ledger'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof fr.ReportError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}

// ---- export ----

const L = (lang, ar, en) => (lang === 'en' ? en : ar);

// Each flattener turns a report into { title, columns, rows } (strings, so
// Arabic and amounts render identically in Excel and PDF).
const FLAT = {
  'trial-balance': (r, lang, f) => ({
    title: L(lang, 'ميزان المراجعة', 'Trial balance'),
    columns: [
      { header: 'الرمز', headerEn: 'Code', key: 'code', width: 12 },
      { header: 'الحساب', headerEn: 'Account', key: 'name', width: 34 },
      { header: 'افتتاحي مدين', headerEn: 'Opening Dr', key: 'od' },
      { header: 'افتتاحي دائن', headerEn: 'Opening Cr', key: 'oc' },
      { header: 'حركة مدين', headerEn: 'Period Dr', key: 'pd' },
      { header: 'حركة دائن', headerEn: 'Period Cr', key: 'pc' },
      { header: 'ختامي مدين', headerEn: 'Closing Dr', key: 'cd' },
      { header: 'ختامي دائن', headerEn: 'Closing Cr', key: 'cc' },
    ],
    rows: [
      ...r.rows.map((x) => ({ code: x.code, name: `${'  '.repeat(x.depth)}${lang === 'en' && x.name_en ? x.name_en : x.name_ar}`, od: f(x.opening_debit), oc: f(x.opening_credit), pd: f(x.period_debit), pc: f(x.period_credit), cd: f(x.closing_debit), cc: f(x.closing_credit) })),
      { code: '', name: L(lang, 'الإجمالي', 'Total'), od: f(r.totals.opening_debit), oc: f(r.totals.opening_credit), pd: f(r.totals.period_debit), pc: f(r.totals.period_credit), cd: f(r.totals.closing_debit), cc: f(r.totals.closing_credit) },
    ],
  }),
  'general-ledger': (r, lang, f) => ({
    title: `${L(lang, 'كشف حساب', 'Account statement')}${r.account ? ` — ${r.account.code} ${r.account.name_ar}` : ''}`,
    columns: [
      { header: 'التاريخ', headerEn: 'Date', key: 'date', width: 12 },
      { header: 'القيد', headerEn: 'Entry', key: 'entry', width: 16 },
      { header: 'المستند', headerEn: 'Document', key: 'doc', width: 16 },
      { header: 'البيان', headerEn: 'Description', key: 'desc', width: 40 },
      { header: 'مدين', headerEn: 'Debit', key: 'dr' },
      { header: 'دائن', headerEn: 'Credit', key: 'cr' },
      { header: 'الرصيد', headerEn: 'Balance', key: 'bal' },
    ],
    rows: [
      { date: r.from, entry: '', doc: '', desc: L(lang, 'رصيد افتتاحي', 'Opening balance'), dr: '', cr: '', bal: f(r.opening_minor) },
      ...r.lines.map((l) => ({ date: l.entry_date, entry: l.entry_number, doc: l.source_number || '', desc: l.memo || l.description || '', dr: l.debit_minor ? f(l.debit_minor) : '', cr: l.credit_minor ? f(l.credit_minor) : '', bal: f(l.running_minor) })),
      { date: r.to, entry: '', doc: '', desc: L(lang, 'رصيد ختامي', 'Closing balance'), dr: f(r.period_debit_minor), cr: f(r.period_credit_minor), bal: f(r.closing_minor) },
    ],
  }),
  'income-statement': (r, lang, f) => {
    const cols = r.columns.map((c, i) => ({ header: c.label, key: `c${i}` }));
    const amt = (arr) => Object.fromEntries(arr.map((v, i) => [`c${i}`, f(v)]));
    const head = (label) => ({ name: label, ...Object.fromEntries(r.columns.map((_, i) => [`c${i}`, ''])) });
    const sec = (key, label) => [head(label), ...r.sections[key].map((x) => ({ name: `  ${x.code} ${lang === 'en' && x.name_en ? x.name_en : x.name_ar}`, ...amt(x.amounts) }))];
    return {
      title: L(lang, 'قائمة الدخل', 'Income statement'),
      columns: [{ header: 'البند', headerEn: 'Line', key: 'name', width: 40 }, ...cols],
      rows: [
        ...sec('revenue', L(lang, 'الإيرادات', 'Revenue')),
        { name: L(lang, 'إجمالي الإيرادات', 'Total revenue'), ...amt(r.totals.revenue) },
        ...sec('cost_of_sales', L(lang, 'تكلفة المبيعات', 'Cost of sales')),
        { name: L(lang, 'مجمل الربح', 'Gross profit'), ...amt(r.totals.gross_profit) },
        ...sec('expenses', L(lang, 'المصاريف', 'Expenses')),
        { name: L(lang, 'إجمالي المصاريف', 'Total expenses'), ...amt(r.totals.expenses) },
        { name: L(lang, 'الربح التشغيلي', 'Operating income'), ...amt(r.totals.operating_income) },
        ...(r.sections.other.length ? [...sec('other', L(lang, 'إيرادات ومصاريف أخرى', 'Other income / expenses')), { name: L(lang, 'صافي الأخرى', 'Net other'), ...amt(r.totals.other) }] : []),
        { name: L(lang, 'صافي الربح / الخسارة', 'Net income'), ...amt(r.totals.net_income) },
      ],
    };
  },
  'balance-sheet': (r, lang, f) => {
    const amt = (arr) => Object.fromEntries(arr.map((v, i) => [`c${i}`, f(v)]));
    const blank = Object.fromEntries(r.columns.map((_, i) => [`c${i}`, '']));
    const names = { current_assets: ['الأصول المتداولة', 'Current assets'], fixed_assets: ['الأصول الثابتة', 'Fixed assets'], current_liabilities: ['الخصوم المتداولة', 'Current liabilities'], long_term_liabilities: ['الخصوم طويلة الأجل', 'Long-term liabilities'], equity: ['حقوق الملكية', 'Equity'] };
    const rows = [];
    for (const [k, [ar, en]] of Object.entries(names)) {
      rows.push({ name: L(lang, ar, en), ...blank });
      for (const x of r.sections[k]) rows.push({ name: `  ${x.code} ${lang === 'en' && x.name_en ? x.name_en : x.name_ar}`, ...amt(x.amounts) });
      if (k === 'equity') rows.push({ name: `  ${L(lang, 'أرباح الفترة غير المقفلة', 'Current earnings')}`, ...amt(r.current_earnings) });
      if (k === 'fixed_assets') rows.push({ name: L(lang, 'إجمالي الأصول', 'Total assets'), ...amt(r.totals.assets) });
    }
    rows.push({ name: L(lang, 'إجمالي الخصوم وحقوق الملكية', 'Total liabilities & equity'), ...amt(r.totals.liabilities_and_equity) });
    return { title: L(lang, 'الميزانية العمومية', 'Balance sheet'), columns: [{ header: 'البند', headerEn: 'Line', key: 'name', width: 40 }, ...r.columns.map((c, i) => ({ header: c.label, key: `c${i}` }))], rows };
  },
  'cash-flow': (r, lang, f) => {
    const names = { operating: ['الأنشطة التشغيلية', 'Operating'], investing: ['الأنشطة الاستثمارية', 'Investing'], financing: ['الأنشطة التمويلية', 'Financing'] };
    const rows = [{ name: L(lang, 'النقد أول الفترة', 'Opening cash'), amount: f(r.opening_cash) }];
    for (const [k, [ar, en]] of Object.entries(names)) {
      rows.push({ name: L(lang, ar, en), amount: '' });
      for (const x of r.direct.sections[k]) rows.push({ name: `  ${x.code} ${x.name_ar}`, amount: f(x.amount) });
      rows.push({ name: `${L(lang, 'صافي', 'Net')} ${L(lang, ar, en)}`, amount: f(r.direct.totals[k]) });
    }
    rows.push({ name: L(lang, 'صافي التغير في النقد', 'Net change in cash'), amount: f(r.net_change) }, { name: L(lang, 'النقد آخر الفترة', 'Closing cash'), amount: f(r.closing_cash) });
    return { title: L(lang, 'قائمة التدفقات النقدية (المباشرة)', 'Cash flow (direct)'), columns: [{ header: 'البند', headerEn: 'Line', key: 'name', width: 40 }, { header: 'المبلغ', headerEn: 'Amount', key: 'amount' }], rows };
  },
  'expense-analysis': (r, lang, f) => ({
    title: L(lang, 'تحليل المصاريف', 'Expense analysis'),
    columns: [{ header: 'البند', headerEn: 'Item', key: 'label', width: 40 }, { header: 'المبلغ', headerEn: 'Amount', key: 'amount' }, { header: '%', key: 'pct', width: 10 }],
    rows: [...r.rows.map((x) => ({ label: x.label || L(lang, 'غير محدد', 'Unassigned'), amount: f(x.amount), pct: String(x.pct) })), { label: L(lang, 'الإجمالي', 'Total'), amount: f(r.total), pct: '100' }],
  }),
  'budget-vs-actual': (r, lang, f) => ({
    title: `${L(lang, 'الموازنة مقابل الفعلي', 'Budget vs actual')} — ${r.budget.name}`,
    columns: [
      { header: 'الحساب', headerEn: 'Account', key: 'name', width: 34 },
      { header: 'مركز التكلفة', headerEn: 'Cost center', key: 'cc', width: 18 },
      { header: 'الموازنة', headerEn: 'Budget', key: 'budget' },
      { header: 'الفعلي', headerEn: 'Actual', key: 'actual' },
      { header: 'الانحراف', headerEn: 'Variance', key: 'variance' },
      { header: '%', key: 'pct', width: 10 },
    ],
    rows: r.rows.map((x) => ({ name: `${x.code} ${x.name_ar}`, cc: x.cost_center_name || '', budget: f(x.budget), actual: f(x.actual), variance: f(x.variance), pct: x.variance_pct === null ? '' : String(x.variance_pct) })),
  }),
};

async function maybeExport(req, res, key, data) {
  const format = req.query.format;
  if (!format) return data;
  if (!['xlsx', 'pdf'].includes(format)) throw new fr.ReportError('invalid_format', 'صيغة غير مدعومة');
  const lang = langFromQuery(req);
  const f = (m) => fr.fmt(req.companyId, m);
  const { title, columns, rows } = FLAT[key](data, lang, f);
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId)?.name;
  const from = data.from || null;
  const to = data.to || data.as_of || null;
  const file = `${key}-${to || 'report'}`;
  const banner = data.inventory_opening_missing ? L(lang, 'المخزون بلا رصيد افتتاحي - الأرقام غير نهائية', 'Inventory has no opening value — figures are not final') : null;
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, title, columns, rows, { title, companyName: company, dateRange: { from, to }, filterLabel: banner || undefined, lang });
    return sendWorkbook(res, wb, `${file}.xlsx`);
  }
  return sendTablePdf(res, { title, subtitle: from ? `${from} → ${to}` : to, columns, rows, meta: [company, banner].filter(Boolean), lang }, `${file}.pdf`);
}

const report = (key, fn) =>
  router.get(`/${key}`, requireAnyPermission(...VIEW), handle((req, res) => maybeExport(req, res, key, fn(req.companyId, req.query))));

report('trial-balance', fr.trialBalance);
report('general-ledger', fr.generalLedger);
report('income-statement', fr.incomeStatement);
report('balance-sheet', fr.balanceSheet);
report('cash-flow', fr.cashFlow);
report('expense-analysis', fr.expenseAnalysis);

// ---- budgets ----
router.get('/budgets', requireAnyPermission('manage_budgets', ...VIEW), handle((req) => fr.listBudgets(req.companyId)));
router.get('/budgets/:id', requireAnyPermission('manage_budgets', ...VIEW), handle((req) => fr.budgetDetail(req.companyId, req.params.id)));
router.post('/budgets', requirePermission('manage_budgets'), handle((req, res) => {
  res.status(201);
  return fr.createBudget(req.companyId, req.body || {}, req.user);
}));
router.put('/budgets/:id/lines', requirePermission('manage_budgets'), handle((req) => fr.setBudgetLines(req.companyId, req.params.id, req.body?.lines, req.user)));
router.post('/budgets/:id/status', requirePermission('manage_budgets'), handle((req) => fr.setBudgetStatus(req.companyId, req.params.id, req.body?.status, req.user)));
router.get('/budgets/:id/vs-actual', requireAnyPermission('manage_budgets', ...VIEW), handle((req, res) => maybeExport(req, res, 'budget-vs-actual', fr.budgetVsActual(req.companyId, req.params.id, req.query))));

// ---- closing ----
router.get('/year-end', requireAnyPermission('run_year_end_close', ...VIEW), handle((req) => fr.yearEndStatus(req.companyId)));
router.post('/year-end/:fiscalYearId/close', requirePermission('run_year_end_close'), handle((req) => fr.closeYear(req.companyId, req.params.fiscalYearId, req.user)));
router.post('/year-end/:fiscalYearId/reopen', requirePermission('run_year_end_close'), handle((req) => fr.reopenYear(req.companyId, req.params.fiscalYearId, req.body || {}, req.user)));
router.get('/month-end/:periodId', requireAnyPermission(...VIEW), handle((req) => fr.monthEndChecklist(req.companyId, req.params.periodId)));

module.exports = router;
