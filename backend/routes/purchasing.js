// /api/purchasing — suppliers, purchase requests, quotations, purchase
// orders, goods receipts, supplier invoices (three-way match), payments,
// debit notes and the payables reports (Prompt 6). Business rules:
// lib/purchasing.js, lib/payables.js. Every id from the client is resolved
// through lib/tenantRefs.js inside those modules.

const express = require('express');
const ExcelJS = require('exceljs');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const P = require('../lib/purchasing');
const pay = require('../lib/payables');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { fromMinor, toMinor } = require('../lib/ledgerCurrencies');
const { sendTablePdf } = require('../lib/pdfExport');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const { logAudit } = require('../lib/auditLog');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_purchases', 'manage_suppliers', 'create_purchase_requests', 'approve_purchase_orders', 'receive_goods', 'post_supplier_invoices', 'make_supplier_payments', 'approve_purchase_mismatch'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof P.PurchasingError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError || err instanceof require('../lib/stockLedger').StockError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}
const created = (res, v) => {
  res.status(201);
  return v;
};

// ---- meta + settings ----
router.get('/meta', requireAnyPermission(...VIEW), handle((req) => {
  ledger.ensureLedgerSetup(req.companyId);
  return {
    base_currency: ledger.getBaseCurrency(req.companyId),
    currencies: ledger.listCurrencies(req.companyId).filter((c) => c.is_active),
    suppliers: db.prepare('SELECT id, name, currency_code, payment_terms_days, default_tax_rate_bp FROM suppliers WHERE company_id = ? AND is_active = 1 ORDER BY name').all(req.companyId),
    products: db.prepare('SELECT id, name, unit, cost_price, box_weight_grams FROM products WHERE company_id = ? AND active = 1 ORDER BY name').all(req.companyId),
    warehouses: db.prepare('SELECT id, name FROM warehouses WHERE company_id = ? ORDER BY name').all(req.companyId),
    expense_accounts: db.prepare("SELECT id, code, name_ar FROM accounts WHERE company_id = ? AND is_active = 1 AND is_postable = 1 AND type IN ('expense','asset') ORDER BY code").all(req.companyId),
    approvers: db.prepare(`SELECT DISTINCT u.id, u.name FROM users u JOIN user_permissions p ON p.user_id = u.id WHERE u.company_id = ? AND u.status = 'approved' AND p.permission = 'approve_purchase_orders' ORDER BY u.name`).all(req.companyId),
    settings: settings(req.companyId),
  };
}));

function settings(companyId) {
  return {
    po_approval_threshold_minor: Number(P.getSetting(companyId, 'po_approval_threshold_minor', '0')),
    purchase_qty_tolerance_bp: Number(P.getSetting(companyId, 'purchase_qty_tolerance_bp', '0')),
    purchase_price_tolerance_bp: Number(P.getSetting(companyId, 'purchase_price_tolerance_bp', '200')),
    enforce_purchasing_separation: P.separationEnforced(companyId),
    separation_steps: P.sodStatus(companyId),
    base_digits: ledger.getBaseCurrency(companyId).minor_unit_digits,
  };
}
router.get('/settings', requireAnyPermission(...VIEW), handle((req) => settings(req.companyId)));
router.put('/settings', requireAnyPermission('manage_settings', 'approve_purchase_orders'), handle((req) => {
  const before = settings(req.companyId);
  const b = req.body || {};
  const d = ledger.getBaseCurrency(req.companyId).minor_unit_digits;
  if (b.poApprovalThreshold !== undefined) {
    const v = toMinor(b.poApprovalThreshold, d);
    if (v < 0) throw new P.PurchasingError('invalid_threshold', 'حد الاعتماد غير صالح');
    P.setSetting(req.companyId, 'po_approval_threshold_minor', v);
  }
  for (const [k, key] of [['qtyTolerance', 'purchase_qty_tolerance_bp'], ['priceTolerance', 'purchase_price_tolerance_bp']]) {
    if (b[k] === undefined) continue;
    const bp = toMinor(b[k], 2);
    if (bp < 0 || bp > 10000) throw new P.PurchasingError('invalid_tolerance', 'نسبة السماح غير صالحة');
    P.setSetting(req.companyId, key, bp);
  }
  if (b.enforcePurchasingSeparation !== undefined) {
    if (!req.user.permissions.includes('manage_settings')) throw new P.PurchasingError('forbidden', 'تعديل فصل المهام يتطلب صلاحية إدارة الإعدادات', 403);
    P.setSetting(req.companyId, 'enforce_purchasing_separation', b.enforcePurchasingSeparation ? '1' : '0');
  }
  const after = settings(req.companyId);
  logAudit({ companyId: req.companyId, actor: req.user, action: 'purchasing.settings.update', entityType: 'settings', entityId: null, before, after });
  return after;
}));

// ---- suppliers ----
router.get('/suppliers', requireAnyPermission(...VIEW), handle((req) => P.listSuppliers(req.companyId, req.query)));
router.get('/suppliers/:id', requireAnyPermission(...VIEW), handle((req) => P.getSupplier(req.companyId, req.params.id)));
router.post('/suppliers', requirePermission('manage_suppliers'), handle((req, res) => created(res, P.saveSupplier(req.companyId, null, req.body, req.user))));
router.put('/suppliers/:id', requirePermission('manage_suppliers'), handle((req) => P.saveSupplier(req.companyId, req.params.id, req.body, req.user)));
router.get('/suppliers/:id/price-history', requireAnyPermission(...VIEW), handle((req) => P.priceHistory(req.companyId, { supplierId: req.params.id, productId: req.query.productId })));
router.get('/price-history', requireAnyPermission(...VIEW), handle((req) => P.priceHistory(req.companyId, req.query)));
router.get('/suppliers/:id/statement', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const st = pay.supplierStatement(req.companyId, req.params.id, req.query);
  if (!req.query.format) return st;
  const lang = langFromQuery(req);
  const f = (m) => fromMinor(m, st.digits);
  const columns = [
    { header: 'التاريخ', headerEn: 'Date', key: 'date', width: 12 },
    { header: 'القيد', headerEn: 'Entry', key: 'entry', width: 14 },
    { header: 'البيان', headerEn: 'Description', key: 'desc', width: 40 },
    { header: 'مدين', headerEn: 'Debit', key: 'dr' },
    { header: 'دائن', headerEn: 'Credit', key: 'cr' },
    { header: 'الرصيد', headerEn: 'Balance', key: 'bal' },
  ];
  const rows = [
    { date: st.from, entry: '', desc: lang === 'en' ? 'Opening balance' : 'رصيد افتتاحي', dr: '', cr: '', bal: f(st.opening_minor) },
    ...st.lines.map((l) => ({ date: l.entry_date, entry: l.entry_number, desc: l.memo || l.description, dr: l.debit_minor ? f(l.debit_minor) : '', cr: l.credit_minor ? f(l.credit_minor) : '', bal: f(l.balance_minor) })),
  ];
  const title = `${lang === 'en' ? 'Supplier statement' : 'كشف حساب مورد'} — ${st.supplier.name}`;
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId)?.name;
  if (req.query.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, 'statement', columns, rows, { title, companyName: company, dateRange: { from: st.from, to: st.to }, lang });
    return sendWorkbook(res, wb, `supplier-statement-${st.supplier.id}.xlsx`);
  }
  if (req.query.format === 'pdf') return sendTablePdf(res, { title, subtitle: `${st.from} → ${st.to}`, columns, rows, meta: [company].filter(Boolean), lang }, `supplier-statement-${st.supplier.id}.pdf`);
  throw new P.PurchasingError('invalid_format', 'صيغة غير مدعومة');
}));

// ---- purchase requests ----
router.get('/requests', requireAnyPermission(...VIEW), handle((req) => P.listRequests(req.companyId, req.query)));
router.get('/requests/:id', requireAnyPermission(...VIEW), handle((req) => P.getRequest(req.companyId, req.params.id)));
router.post('/requests', requirePermission('create_purchase_requests'), handle((req, res) => created(res, P.saveRequest(req.companyId, null, req.body || {}, req.user))));
router.put('/requests/:id', requirePermission('create_purchase_requests'), handle((req) => P.saveRequest(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/requests/:id/submit', requirePermission('create_purchase_requests'), handle((req) => P.requestAction(req.companyId, req.params.id, 'submit', {}, req.user)));
router.post('/requests/:id/cancel', requirePermission('create_purchase_requests'), handle((req) => P.requestAction(req.companyId, req.params.id, 'cancel', req.body || {}, req.user)));
router.post('/requests/:id/approve', requirePermission('approve_purchase_orders'), handle((req) => P.requestAction(req.companyId, req.params.id, 'approve', req.body || {}, req.user)));
router.post('/requests/:id/reject', requirePermission('approve_purchase_orders'), handle((req) => P.requestAction(req.companyId, req.params.id, 'reject', req.body || {}, req.user)));
router.get('/requests/:id/comparison', requireAnyPermission(...VIEW), handle((req) => P.compareQuotations(req.companyId, req.params.id)));

// ---- quotations ----
router.post('/quotations', requirePermission('create_purchase_requests'), handle((req, res) => created(res, P.createQuotation(req.companyId, req.body || {}, req.user))));
router.get('/quotations/:id', requireAnyPermission(...VIEW), handle((req) => P.getQuotation(req.companyId, req.params.id)));

// ---- purchase orders ----
router.get('/orders', requireAnyPermission(...VIEW), handle((req) => P.listPurchaseOrders(req.companyId, req.query)));
router.get('/orders/:id', requireAnyPermission(...VIEW), handle((req) => P.getPurchaseOrder(req.companyId, req.params.id)));
router.post('/orders', requirePermission('create_purchase_requests'), handle((req, res) => created(res, P.savePurchaseOrder(req.companyId, null, req.body || {}, req.user))));
router.put('/orders/:id', requirePermission('create_purchase_requests'), handle((req) => P.savePurchaseOrder(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/submit', requirePermission('create_purchase_requests'), handle((req) => P.submitPurchaseOrder(req.companyId, req.params.id, req.user)));
router.post('/orders/:id/approve', requirePermission('approve_purchase_orders'), handle((req) => P.approvePurchaseOrder(req.companyId, req.params.id, { decision: 'approve', breakGlassReason: req.body?.breakGlassReason }, req.user)));
router.post('/orders/:id/reject', requirePermission('approve_purchase_orders'), handle((req) => P.approvePurchaseOrder(req.companyId, req.params.id, { decision: 'reject', reason: req.body?.reason }, req.user)));
router.post('/orders/:id/cancel', requirePermission('create_purchase_requests'), handle((req) => P.cancelPurchaseOrder(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/receive', requirePermission('receive_goods'), handle((req, res) => created(res, P.receiveGoods(req.companyId, req.params.id, req.body || {}, req.user))));

// ---- goods receipts ----
router.get('/receipts', requireAnyPermission(...VIEW), handle((req) => P.listReceipts(req.companyId, req.query)));
router.get('/receipts/:id', requireAnyPermission(...VIEW), handle((req) => P.getReceipt(req.companyId, req.params.id)));

// ---- supplier invoices ----
router.get('/invoices', requireAnyPermission(...VIEW), handle((req) => pay.listInvoices(req.companyId, req.query)));
router.get('/invoices/:id', requireAnyPermission(...VIEW), handle((req) => pay.getInvoice(req.companyId, req.params.id)));
router.post('/invoices', requirePermission('post_supplier_invoices'), handle((req, res) => created(res, pay.saveInvoice(req.companyId, null, req.body || {}, req.user))));
router.put('/invoices/:id', requirePermission('post_supplier_invoices'), handle((req) => pay.saveInvoice(req.companyId, req.params.id, req.body || {}, req.user)));
router.delete('/invoices/:id', requirePermission('post_supplier_invoices'), handle((req) => pay.deleteInvoice(req.companyId, req.params.id, req.user)));
router.get('/invoices/:id/match', requireAnyPermission(...VIEW), handle((req) => {
  const inv = P.owned(req.companyId, 'supplier_invoice', req.params.id);
  return pay.threeWayMatch(req.companyId, inv.id, { store: inv.status === 'draft' });
}));
router.post('/invoices/:id/approve-mismatch', requirePermission('approve_purchase_mismatch'), handle((req) => pay.approveMismatch(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/invoices/:id/post', requirePermission('post_supplier_invoices'), handle((req) => {
  const opts = { exchangeRate: req.body?.exchangeRate, rateQuote: req.body?.rateQuote };
  return require('../lib/postingQueue').guard(req.companyId, { kind: 'supplier_invoice.post', sourceId: Number(req.params.id), label: `فاتورة مورد #${req.params.id}`, payload: opts }, () => pay.postInvoice(req.companyId, req.params.id, opts, req.user), req.user);
}));
router.get('/suppliers/:id/open-invoices', requireAnyPermission(...VIEW), handle((req) => pay.openSupplierInvoices(req.companyId, P.owned(req.companyId, 'supplier', req.params.id).id)));

// ---- supplier opening balances (reclass of unassigned AP, or new) ----
router.get('/opening-balances', requireAnyPermission(...VIEW), handle((req) => ({ unassigned_minor: pay.unassignedAp(req.companyId), invoices: pay.listInvoices(req.companyId, { kind: 'opening' }) })));
router.post('/opening-balances/bills', requirePermission('post_supplier_invoices'), handle((req, res) => created(res, pay.importOpenBills(req.companyId, req.body || {}, req.user))));
router.post('/opening-balances', requirePermission('post_supplier_invoices'), handle((req, res) => created(res, pay.createOpeningBalances(req.companyId, req.body || {}, req.user))));

// ---- payments ----
router.get('/payments', requireAnyPermission(...VIEW), handle((req) => pay.listPayments(req.companyId, req.query)));
router.get('/payments/:id', requireAnyPermission(...VIEW), handle((req) => pay.getPayment(req.companyId, req.params.id)));
router.post('/payments', requirePermission('make_supplier_payments'), handle((req, res) => created(res, pay.createPayment(req.companyId, req.body || {}, req.user))));
router.post('/payments/:id/auto-allocate', requirePermission('make_supplier_payments'), handle((req) => pay.autoAllocatePayment(req.companyId, req.params.id, req.user)));
router.put('/payments/:id/allocations', requirePermission('make_supplier_payments'), handle((req) => pay.setPaymentAllocations(req.companyId, req.params.id, req.body?.allocations || [], req.user, { breakGlassReason: req.body?.breakGlassReason })));
router.post('/payments/:id/reverse', requirePermission('make_supplier_payments'), handle((req) => pay.reversePayment(req.companyId, req.params.id, req.body || {}, req.user)));

// ---- debit notes ----
router.get('/debit-notes', requireAnyPermission(...VIEW), handle((req) => pay.listDebitNotes(req.companyId, req.query)));
router.get('/debit-notes/:id', requireAnyPermission(...VIEW), handle((req) => pay.getDebitNote(req.companyId, req.params.id)));
router.post('/debit-notes', requirePermission('post_supplier_invoices'), handle((req, res) => created(res, pay.createDebitNote(req.companyId, req.body || {}, req.user))));

// ---- reports ----
router.get('/reports/aging', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const a = pay.payablesAging(req.companyId, { asOf: req.query.asOf });
  if (!req.query.format) return a;
  const lang = langFromQuery(req);
  const f = (m) => fromMinor(m, a.digits);
  const columns = [
    { header: 'المورد', headerEn: 'Supplier', key: 'name', width: 30 },
    { header: 'غير مستحق', headerEn: 'Current', key: 'current' },
    { header: '1-30', key: 'b1_30' }, { header: '31-60', key: 'b31_60' }, { header: '61-90', key: 'b61_90' }, { header: '+90', key: 'b90_plus' }, { header: lang === 'en' ? 'Legacy / undated' : 'قديم / بدون تاريخ', key: 'legacy' },
    { header: 'دفعات مقدمة', headerEn: 'Advances', key: 'advances' },
    { header: 'الإجمالي', headerEn: 'Total', key: 'total' },
  ];
  const row = (name, b) => ({ name, current: f(b.current), b1_30: f(b.b1_30), b31_60: f(b.b31_60), b61_90: f(b.b61_90), b90_plus: f(b.b90_plus), legacy: f(b.legacy), advances: f(b.advances), total: f(b.total) });
  const rows = [...a.rows.map((r) => row(r.supplier_name, r)), row(lang === 'en' ? 'Total' : 'الإجمالي', a.totals)];
  const title = lang === 'en' ? 'Payables aging' : 'أعمار الذمم الدائنة';
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId)?.name;
  if (req.query.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    addSheet(wb, 'aging', columns, rows, { title, companyName: company, dateRange: { to: a.as_of }, lang });
    return sendWorkbook(res, wb, `payables-aging-${a.as_of}.xlsx`);
  }
  if (req.query.format === 'pdf') return sendTablePdf(res, { title, subtitle: a.as_of, columns, rows, meta: [company].filter(Boolean), lang }, `payables-aging-${a.as_of}.pdf`);
  throw new P.PurchasingError('invalid_format', 'صيغة غير مدعومة');
}));
router.get('/reports/reconciliation', requireAnyPermission(...VIEW, 'view_ledger'), handle((req) => pay.apReconciliation(req.companyId, { asOf: req.query.asOf })));
router.get('/reports/ppv', requireAnyPermission(...VIEW), handle((req) => pay.ppvReport(req.companyId, req.query)));
router.get('/reports/purchases', requireAnyPermission(...VIEW), handle((req) => pay.purchasesBy(req.companyId, req.query)));
router.get('/reports/ratings', requireAnyPermission(...VIEW), handle((req) => db.prepare('SELECT id, name, manual_rating FROM suppliers WHERE company_id = ? ORDER BY name').all(req.companyId).map((s) => ({ ...s, ...P.supplierRatings(req.companyId, s.id) }))));
router.get('/dashboard', requireAnyPermission(...VIEW), handle((req) => pay.dashboard(req.companyId)));

module.exports = router;
