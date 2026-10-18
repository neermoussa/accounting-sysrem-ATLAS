// /api/currency — exchange-rate history, balances by currency, FX gain/loss
// report and the period-end revaluation (Prompt 5). Business rules:
// lib/currency.js.

const express = require('express');
const ExcelJS = require('exceljs');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const currency = require('../lib/currency');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { fromMinor } = require('../lib/ledgerCurrencies');
const { sendTablePdf } = require('../lib/pdfExport');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['manage_exchange_rates', 'view_ledger', 'view_financial_reports', 'view_receivables'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof currency.CurrencyError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}

async function sendTable(req, res, { title, columns, rows, from, to, file }) {
  const lang = langFromQuery(req);
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId)?.name;
  if (req.query.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, title, columns, rows, { title, companyName: company, dateRange: { from, to }, lang });
    return sendWorkbook(res, wb, `${file}.xlsx`);
  }
  if (req.query.format === 'pdf') return sendTablePdf(res, { title, subtitle: from ? `${from} → ${to}` : to, columns, rows, meta: [company].filter(Boolean), lang }, `${file}.pdf`);
  throw new currency.CurrencyError('invalid_format', 'صيغة غير مدعومة');
}

// ---- rates ----
router.get('/rates', requireAnyPermission(...VIEW), handle((req) => currency.listRates(req.companyId, req.query)));
router.post('/rates', requirePermission('manage_exchange_rates'), handle((req, res) => {
  const { currencyCode, rate, rateQuote, effectiveAt, source, notes } = req.body || {};
  res.status(201);
  return currency.addRate(req.companyId, { currencyCode, rate, rateQuote, effectiveAt, source: source || 'manual', notes }, req.user);
}));
router.get('/rates/current', requireAnyPermission(...VIEW, 'create_sales_invoices', 'manage_receipts'), handle((req) => {
  const r = currency.rateFor(req.companyId, req.query.currencyCode, req.query.date || new Date().toISOString().slice(0, 10));
  return r ? { ...r, rate: r.rate_e8 ? require('../lib/fxRate').formatRate(r.rate_e8) : '1' } : null;
}));

// ---- balances by currency ----
router.get('/balances', requireAnyPermission(...VIEW), handle((req, res) => {
  const data = currency.balancesByCurrency(req.companyId, { asOf: req.query.asOf });
  if (!req.query.format) return data;
  const lang = langFromQuery(req);
  const bd = data.digits[data.base_currency] ?? 2;
  const rows = [
    ...data.customers.map((c) => ({ name: c.shop_name, cur: c.currency_code, bal: fromMinor(c.balance_minor, data.digits[c.currency_code] ?? 2), base: fromMinor(c.base_minor, bd) })),
    ...data.accounts.map((a) => ({ name: `${a.code} ${a.name_ar}`, cur: a.currency_code, bal: fromMinor(a.original_minor, data.digits[a.currency_code] ?? 2), base: fromMinor(a.base_minor, bd) })),
  ];
  return sendTable(req, res, {
    title: lang === 'en' ? 'Balances by currency' : 'الأرصدة حسب العملة',
    columns: [
      { header: 'الزبون / الحساب', headerEn: 'Customer / account', key: 'name', width: 34 },
      { header: 'العملة', headerEn: 'Currency', key: 'cur', width: 10 },
      { header: 'الرصيد بالعملة', headerEn: 'Balance (currency)', key: 'bal' },
      { header: `بالعملة الأساسية (${data.base_currency})`, headerEn: `Base (${data.base_currency})`, key: 'base' },
    ],
    rows, to: data.as_of, file: `balances-by-currency-${data.as_of}`,
  });
}));

// ---- FX gain/loss report ----
router.get('/fx-report', requireAnyPermission('view_financial_reports', 'view_ledger'), handle((req, res) => {
  const data = currency.fxGainLossReport(req.companyId, req.query);
  if (!req.query.format) return data;
  const lang = langFromQuery(req);
  const d = ledger.getBaseCurrency(req.companyId).minor_unit_digits;
  const kinds = { realized: ['محقق', 'Realized'], unrealized: ['غير محقق', 'Unrealized'], unrealized_reversal: ['عكس غير المحقق', 'Unrealized reversal'], other: ['أخرى', 'Other'] };
  return sendTable(req, res, {
    title: lang === 'en' ? 'FX gain / loss' : 'أرباح وخسائر فروقات الصرف',
    columns: [
      { header: 'التاريخ', headerEn: 'Date', key: 'date', width: 12 },
      { header: 'القيد', headerEn: 'Entry', key: 'entry', width: 14 },
      { header: 'النوع', headerEn: 'Kind', key: 'kind', width: 16 },
      { header: 'البيان', headerEn: 'Description', key: 'desc', width: 40 },
      { header: 'ربح (+) / خسارة (-)', headerEn: 'Gain (+) / loss (-)', key: 'amt' },
    ],
    rows: [
      ...data.rows.map((r) => ({ date: r.entry_date, entry: r.entry_number, kind: kinds[r.kind][lang === 'en' ? 1 : 0], desc: r.description, amt: fromMinor(r.gain_minor, d) })),
      { date: '', entry: '', kind: '', desc: lang === 'en' ? 'Net' : 'الصافي', amt: fromMinor(data.totals.net, d) },
    ],
    from: data.from, to: data.to, file: `fx-gain-loss-${data.to}`,
  });
}));

// ---- revaluation ----
router.get('/revaluations', requireAnyPermission('run_fx_revaluation', 'view_ledger', 'view_financial_reports'), handle((req) => currency.listRevaluations(req.companyId)));
router.post('/revaluations/preview', requireAnyPermission('run_fx_revaluation', 'view_ledger'), handle((req) => currency.revaluationPreview(req.companyId, { asOf: req.body?.asOf })));
router.post('/revaluations', requirePermission('run_fx_revaluation'), handle((req, res) => {
  res.status(201);
  return currency.postRevaluation(req.companyId, { asOf: req.body?.asOf }, req.user);
}));

module.exports = router;
