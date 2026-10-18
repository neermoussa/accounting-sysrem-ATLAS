// /api/receivables — receipts & allocation, cheques received, aging,
// collection forecast, AR reconciliation, customer statements (Prompt 3).
// Business rules: lib/receivables.js.

const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const rec = require('../lib/receivables');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { sendTablePdf } = require('../lib/pdfExport');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const { sendToCustomer } = require('../lib/whatsapp');
const { logMessage } = require('../lib/whatsappBot');
const { logAudit } = require('../lib/auditLog');
const ExcelJS = require('exceljs');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_receivables', 'manage_receipts', 'view_ledger'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof rec.ReceivablesError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}

const id = (req, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new rec.ReceivablesError('invalid_id', 'معرّف غير صالح');
  return n;
};

// ---- receipts ----
router.get('/receipts', requireAnyPermission(...VIEW), handle((req) => rec.listReceipts(req.companyId, { ...req.query, unallocated: req.query.unallocated === '1' })));
router.get('/receipts/:id', requireAnyPermission(...VIEW), handle((req) => {
  const r = rec.getReceipt(req.companyId, id(req));
  if (!r) throw new rec.ReceivablesError('not_found', 'سند القبض غير موجود', 404);
  return r;
}));
router.post('/receipts', requirePermission('manage_receipts'), handle((req, res) => {
  const { collectionId, chequeId, entryId, amountMinor, ...body } = req.body || {}; // internal-only fields
  if (body.method === 'cheque') throw new rec.ReceivablesError('use_cheques', 'سجّل الشيكات من شاشة الشيكات الواردة');
  res.status(201);
  return rec.createReceipt(req.companyId, body, req.user);
}));
// Idempotent backfill of receipts for collections confirmed before receipts
// existed. { execute: true } writes; anything else is a dry run.
router.post('/backfill-receipts', requirePermission('manage_receipts'), handle((req) =>
  rec.backfillCollectionReceipts(req.companyId, { dryRun: req.body?.execute !== true, autoAllocate: req.body?.autoAllocate }, req.user)
));
router.post('/receipts/:id/auto-allocate', requirePermission('manage_receipts'), handle((req) => rec.autoAllocate(req.companyId, id(req), req.user)));
router.put('/receipts/:id/allocations', requirePermission('manage_receipts'), handle((req) => rec.setAllocations(req.companyId, id(req), req.body?.allocations || [], req.user)));
router.post('/receipts/:id/reverse', requirePermission('manage_receipts'), handle((req) => rec.reverseReceipt(req.companyId, id(req), { reason: req.body?.reason, date: req.body?.date }, req.user)));
router.get('/customers/:shopId/open-invoices', requireAnyPermission(...VIEW), handle((req) => {
  const shop = tenantRefs.requireOwned(req.companyId, 'shop', req.params.shopId);
  return rec.openInvoices(req.companyId, shop.id);
}));

// ---- cheques ----
router.get('/cheques', requireAnyPermission(...VIEW), handle((req) => rec.listCheques(req.companyId, req.query)));
router.post('/cheques', requirePermission('manage_receipts'), handle((req, res) => {
  res.status(201);
  return rec.receiveCheque(req.companyId, req.body || {}, req.user);
}));
router.post('/cheques/:id/deposit', requirePermission('manage_receipts'), handle((req) => rec.depositCheque(req.companyId, id(req), req.user)));
router.post('/cheques/:id/clear', requirePermission('manage_receipts'), handle((req) => rec.clearCheque(req.companyId, id(req), { date: req.body?.date, cashBoxId: req.body?.cashBoxId, exchangeRate: req.body?.exchangeRate, rateQuote: req.body?.rateQuote }, req.user)));
router.post('/cheques/:id/bounce', requirePermission('manage_receipts'), handle((req) => rec.bounceCheque(req.companyId, id(req), { reason: req.body?.reason, date: req.body?.date }, req.user)));

// ---- aging / forecast / reconciliation ----
const AGING_COLUMNS = [
  ['b0_30', '0–30 يوم', '0–30'], ['b31_60', '31–60', '31–60'], ['b61_90', '61–90', '61–90'], ['b90_plus', 'أكثر من 90', '90+'],
  ['legacy', 'رصيد سابق غير مؤرخ', 'Legacy / undated'], ['credits', 'أرصدة دائنة غير مخصصة', 'Unallocated credits'], ['total', 'الإجمالي', 'Total'],
];
router.get('/aging', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const data = rec.agingReport(req.companyId, req.query);
  if (!req.query.format) return data;
  // Excel / PDF export: every bucket including the legacy column.
  const lang = langFromQuery(req);
  const { fromMinor } = require('../lib/ledgerCurrencies');
  const columns = [
    { key: 'label', header: 'البند', headerEn: 'Group', width: 30 },
    ...AGING_COLUMNS.map(([key, ar, en]) => ({ key, header: ar, headerEn: en, width: 16 })),
  ];
  const fmt = (r) => Object.fromEntries([['label', r.label], ...AGING_COLUMNS.map(([k]) => [k, fromMinor(r[k], data.digits)])]);
  const rows = [...data.rows.map(fmt), fmt({ ...data.totals, label: lang === 'en' ? 'Total' : 'المجموع' })];
  const title = `${lang === 'en' ? 'Receivables aging' : 'أعمار الذمم المدينة'} — ${data.as_of}`;
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId)?.name;
  if (req.query.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, lang === 'en' ? 'Aging' : 'الأعمار', columns, rows, { title, companyName: company, lang });
    return sendWorkbook(res, wb, `aging-${data.as_of}.xlsx`);
  }
  if (req.query.format === 'pdf') return sendTablePdf(res, { title, columns, rows, meta: [company].filter(Boolean), lang }, `aging-${data.as_of}.pdf`);
  throw new rec.ReceivablesError('invalid_format', 'صيغة غير مدعومة');
}));
router.get('/aging/customer/:shopId', requireAnyPermission(...VIEW), handle((req) => rec.customerAging(req.companyId, req.params.shopId, req.query.asOf)));
router.get('/forecast', requireAnyPermission(...VIEW), handle((req) => rec.collectionForecast(req.companyId, { weeks: Math.min(Number(req.query.weeks) || 12, 52) })));
router.get('/reconciliation', requireAnyPermission(...VIEW), handle((req) => ({ current: rec.reconciliationCheck(req.companyId, { asOf: req.query.asOf || undefined }), history: rec.reconciliationHistory(req.companyId) })));
router.post('/reconciliation/run', requireAnyPermission('view_receivables', 'view_ledger'), handle((req) => rec.reconciliationCheck(req.companyId, { store: true })));

// ---- statements ----
router.get('/customers/:shopId/statement', requireAnyPermission(...VIEW, 'send_account_statements'), handle(async (req, res) => {
  const st = rec.customerStatement(req.companyId, req.params.shopId, req.query);
  const format = req.query.format;
  if (!format) return st;
  const lang = langFromQuery(req);
  const columns = [
    { key: 'entry_date', header: 'التاريخ', headerEn: 'Date', width: 14 },
    { key: 'entry_number', header: 'رقم القيد', headerEn: 'Entry', width: 14 },
    { key: 'description', header: 'البيان', headerEn: 'Description', width: 44 },
    { key: 'debit', header: 'مدين', headerEn: 'Debit', width: 14 },
    { key: 'credit', header: 'دائن', headerEn: 'Credit', width: 14 },
    { key: 'running', header: 'الرصيد', headerEn: 'Balance', width: 16 },
  ];
  const rows = [
    { entry_date: st.from, entry_number: '', description: lang === 'en' ? 'Opening balance' : 'الرصيد الافتتاحي', debit: '', credit: '', running: st.opening },
    ...st.lines,
    { entry_date: st.to, entry_number: '', description: lang === 'en' ? 'Closing balance' : 'الرصيد الختامي', debit: st.total_debit, credit: st.total_credit, running: st.closing },
  ];
  const title = `${lang === 'en' ? 'Account statement' : 'كشف حساب'} — ${st.shop.name}`;
  const filename = `statement-${st.shop.id}-${st.from}-${st.to}`;
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, lang === 'en' ? 'Statement' : 'كشف حساب', columns, rows, { title, companyName: st.company?.name, dateRange: { from: st.from, to: st.to }, lang });
    return sendWorkbook(res, wb, `${filename}.xlsx`);
  }
  if (format === 'pdf') {
    return sendTablePdf(res, { title, subtitle: `${st.from} → ${st.to}`, columns, rows, meta: [st.company?.name, `${lang === 'en' ? 'Closing balance' : 'الرصيد الختامي'}: ${st.closing}`].filter(Boolean), lang }, `${filename}.pdf`);
  }
  throw new rec.ReceivablesError('invalid_format', 'صيغة غير مدعومة');
}));

// Same approval guard as the existing WhatsApp statement (send_account_statements).
router.post('/customers/:shopId/statement/send', requirePermission('send_account_statements'), handle(async (req, res) => {
  const st = rec.customerStatement(req.companyId, req.params.shopId, req.body || {});
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(st.shop.id, req.companyId);
  const message = rec.statementWhatsappText(st);
  const sent = await sendToCustomer(req.companyId, shop, message).catch(() => false);
  const row = logMessage(req.companyId, { shopId: shop.id, direction: 'out', toPhone: shop.phone, body: message, intent: 'account_statement', handledBy: 'employee', repliedBy: req.user });
  logAudit({ companyId: req.companyId, actor: req.user, action: 'receivables.statement.send', entityType: 'shop', entityId: shop.id, shopId: shop.id, before: null, after: { from: st.from, to: st.to, closing: st.closing, sent: !!sent } });
  res.status(201);
  return { ...row, sent: !!sent, message };
}));

// ---- settings ----
router.get('/settings', requireAnyPermission(...VIEW, 'manage_settings'), handle((req) => {
  const get = (k, f) => db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(req.companyId, k)?.value ?? f;
  return { receiptAutoAllocate: get('receipt_auto_allocate', '1') === '1', invoiceCreditPolicy: get('invoice_credit_policy', 'warn'), overdueInvoiceDays: Number(get('overdue_invoice_reminder_days', '30')), legacyDebtPolicy: get('legacy_debt_policy', 'overdue') };
}));
router.put('/settings', requirePermission('manage_settings'), handle((req) => {
  const set = (k, v) => db.prepare('INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value').run(req.companyId, k, String(v));
  const { receiptAutoAllocate, invoiceCreditPolicy, overdueInvoiceDays, legacyDebtPolicy } = req.body || {};
  if (legacyDebtPolicy !== undefined) {
    if (!['overdue', 'current'].includes(legacyDebtPolicy)) throw new rec.ReceivablesError('invalid_policy', 'السياسة يجب أن تكون overdue أو current');
    set('legacy_debt_policy', legacyDebtPolicy);
  }
  if (receiptAutoAllocate !== undefined) set('receipt_auto_allocate', receiptAutoAllocate ? '1' : '0');
  if (invoiceCreditPolicy !== undefined) {
    if (!['warn', 'block'].includes(invoiceCreditPolicy)) throw new rec.ReceivablesError('invalid_policy', 'السياسة يجب أن تكون warn أو block');
    set('invoice_credit_policy', invoiceCreditPolicy);
  }
  if (overdueInvoiceDays !== undefined) set('overdue_invoice_reminder_days', Math.max(1, Number(overdueInvoiceDays) || 30));
  logAudit({ companyId: req.companyId, actor: req.user, action: 'receivables.settings.update', entityType: 'settings', entityId: null, before: null, after: req.body || {} });
  return { ok: true };
}));

module.exports = router;
