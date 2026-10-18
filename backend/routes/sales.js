// /api/sales — sales invoices, credit notes, the customer ledger, the
// Amin-vs-ledger reconciliation and the go-live backfill. Business rules
// live in lib/salesPosting.js and lib/customerLedger.js.

const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireAllPermissions } = require('../middleware/auth');
const sales = require('../lib/salesPosting');
const customerLedger = require('../lib/customerLedger');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { buildDocumentHtml } = require('../lib/documentRenderer');
const { ReceivablesError } = require('../lib/receivables');
const openItems = require('../lib/openItems');
const multer = require('multer');
const pathMod = require('path');
const fsMod = require('fs');
const OPEN_ITEMS_DIR = pathMod.join(__dirname, '..', 'uploads', 'ledger-imports');
fsMod.mkdirSync(OPEN_ITEMS_DIR, { recursive: true });
const openItemsUpload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, OPEN_ITEMS_DIR), filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.xlsx`) }),
  fileFilter: (req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();
const VIEW_ANY = ['view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes'];

function handle(fn) {
  return (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof sales.SalesError || err instanceof ReceivablesError || err instanceof ledger.LedgerError || err instanceof customerLedger.GoLiveError || err instanceof tenantRefs.ForeignRefError || err instanceof require('../lib/stockLedger').StockError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}

function id(req, name = 'id') {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new sales.SalesError('invalid_id', 'معرّف غير صالح');
  return n;
}

router.get('/meta', requireAnyPermission(...VIEW_ANY), handle((req) => {
  ledger.ensureLedgerSetup(req.companyId);
  return {
    base_currency: ledger.getBaseCurrency(req.companyId),
    live: customerLedger.isLedgerLive(req.companyId),
    shops: db.prepare('SELECT id, name, region FROM shops WHERE company_id = ? AND active = 1 ORDER BY name').all(req.companyId),
    products: db.prepare('SELECT id, name, category, unit, base_price, cost_price FROM products WHERE company_id = ? AND active = 1 ORDER BY name').all(req.companyId),
    branches: ledger.listBranches(req.companyId).filter((b) => b.is_active),
    currencies: ledger.listCurrencies(req.companyId).filter((c) => c.is_active),
  };
}));

// ---------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------

router.get('/invoices', requireAnyPermission(...VIEW_ANY), handle((req) => sales.listInvoices(req.companyId, req.query)));
router.get('/invoices/:id', requireAnyPermission(...VIEW_ANY), handle((req) => {
  const inv = sales.getInvoice(req.companyId, id(req));
  if (!inv) throw new sales.SalesError('not_found', 'الفاتورة غير موجودة', 404);
  return inv;
}));
router.post('/invoices', requirePermission('create_sales_invoices'), handle((req, res) => {
  res.status(201);
  return sales.createInvoice(req.companyId, req.body || {}, req.user);
}));
router.put('/invoices/:id', requirePermission('create_sales_invoices'), handle((req) => sales.updateInvoice(req.companyId, id(req), req.body || {}, req.user)));
router.delete('/invoices/:id', requirePermission('create_sales_invoices'), handle((req) => sales.deleteInvoice(req.companyId, id(req), req.user)));
router.post('/invoices/:id/post', requirePermission('post_sales_invoices'), handle((req) => {
  // A refusal for a date with no fiscal period is kept in the failed-posting queue (lib/postingQueue.js).
  const opts = { overrideReason: req.body?.creditOverrideReason, exchangeRate: req.body?.exchangeRate, rateQuote: req.body?.rateQuote };
  return require('../lib/postingQueue').guard(req.companyId, { kind: 'sales_invoice.post', sourceId: id(req), label: `فاتورة مبيعات #${id(req)}`, payload: opts }, () => sales.postInvoice(req.companyId, id(req), req.user, opts), req.user);
}));

// Prompt 3, item 1: delivered orders that have no live invoice yet, and a
// draft invoice prefilled from one (customer, delivered lines, order prices,
// linked order id) so nothing is typed twice after go-live.
router.get('/invoiceable-orders', requireAnyPermission(...VIEW_ANY), handle((req) => sales.listInvoiceableOrders(req.companyId, req.query)));
router.post('/invoices/from-order/:orderId', requirePermission('create_sales_invoices'), handle((req, res) => {
  res.status(201);
  return sales.createInvoiceFromOrder(req.companyId, id(req, 'orderId'), req.user);
}));
router.post('/invoices/:id/cancel', requirePermission('create_credit_notes'), handle((req) =>
  sales.cancelInvoice(req.companyId, id(req), { reason: req.body?.reason, restock: !!req.body?.restock }, req.user)
));

// Printable HTML through the existing document renderer/templates.
router.get('/invoices/:id/print', requireAnyPermission(...VIEW_ANY), handle((req, res) => {
  const inv = sales.getInvoice(req.companyId, id(req));
  if (!inv) throw new sales.SalesError('not_found', 'الفاتورة غير موجودة', 404);
  const data = {
    title: inv.status === 'draft' ? 'مسودة فاتورة' : 'فاتورة مبيعات',
    documentNumber: inv.invoice_number || '',
    shopName: inv.shop?.name,
    orderDate: inv.invoice_date,
    items: inv.lines.map((l) => ({ product_name: l.description, qty: l.qty, unit_price: l.unit_price, line_total: l.net })),
    extraTotals: [
      ...(inv.discount_minor ? [{ label: 'الخصم', value: inv.discount }] : []),
      ...(inv.tax_minor ? [{ label: 'الضريبة', value: inv.tax }] : []),
      ...(inv.rounding_minor ? [{ label: 'فرق التقريب', value: inv.rounding }] : []),
    ],
    totalValue: `${inv.total} ${inv.currency_code}`,
  };
  res.type('html').send(buildDocumentHtml(req.companyId, 'invoice', data, { thermal: req.query.thermal === '1' }));
}));

// ---------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------

router.get('/credit-notes', requireAnyPermission(...VIEW_ANY), handle((req) => sales.listCreditNotes(req.companyId, req.query)));
router.get('/credit-notes/:id', requireAnyPermission(...VIEW_ANY), handle((req) => {
  const cn = sales.getCreditNote(req.companyId, id(req));
  if (!cn) throw new sales.SalesError('not_found', 'إشعار الدائن غير موجود', 404);
  return cn;
}));
router.post('/credit-notes', requirePermission('create_credit_notes'), handle((req, res) => {
  const { returnRequestId, ...body } = req.body || {}; // return-linked notes come only from the returns flow
  res.status(201);
  return sales.createCreditNote(req.companyId, body, req.user);
}));
router.get('/credit-notes/:id/print', requireAnyPermission(...VIEW_ANY), handle((req, res) => {
  const cn = sales.getCreditNote(req.companyId, id(req));
  if (!cn) throw new sales.SalesError('not_found', 'إشعار الدائن غير موجود', 404);
  const data = {
    title: 'إشعار دائن',
    documentNumber: cn.credit_note_number,
    shopName: cn.shop?.name,
    orderDate: cn.note_date,
    items: cn.lines.map((l) => ({ product_name: l.description, qty: l.qty, unit_price: l.unit_price, line_total: l.net })),
    extraTotals: [
      ...(cn.invoice ? [{ label: 'عن الفاتورة', value: cn.invoice.invoice_number }] : []),
      ...(cn.tax_minor ? [{ label: 'الضريبة', value: cn.tax }] : []),
    ],
    totalValue: `${cn.total} ${cn.currency_code}`,
  };
  res.type('html').send(buildDocumentHtml(req.companyId, 'invoice', data));
}));

// ---------------------------------------------------------------------
// Customer ledger, reconciliation, category accounts
// ---------------------------------------------------------------------

router.get('/customers/:shopId/ledger', requireAnyPermission('view_ledger', ...VIEW_ANY), handle((req) => {
  const shop = tenantRefs.requireOwned(req.companyId, 'shop', req.params.shopId);
  const latest = db.prepare('SELECT balance, report_date, source_file FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shop.id);
  return { shop: { id: shop.id, name: shop.name }, live: customerLedger.isLedgerLive(req.companyId), displayed_balance: latest || null, ...customerLedger.customerLedgerLines(req.companyId, shop.id) };
}));

router.get('/reconciliation', requirePermission('view_ledger'), handle((req) => customerLedger.reconciliation(req.companyId)));

router.get('/category-accounts', requireAnyPermission('view_ledger', 'manage_accounts'), handle((req) => ({
  categories: db.prepare("SELECT DISTINCT category FROM products WHERE company_id = ? AND category IS NOT NULL AND category <> '' ORDER BY category").all(req.companyId).map((r) => r.category),
  mappings: db.prepare('SELECT * FROM product_category_accounts WHERE company_id = ? ORDER BY category').all(req.companyId),
})));
router.put('/category-accounts', requirePermission('manage_accounts'), handle((req) => {
  const category = String(req.body?.category || '').trim();
  if (!category) throw new sales.SalesError('category_required', 'الفئة مطلوبة');
  if (!req.body?.accountId) {
    db.prepare('DELETE FROM product_category_accounts WHERE company_id = ? AND category = ?').run(req.companyId, category);
    return { ok: true };
  }
  const acc = tenantRefs.requireOwned(req.companyId, 'account', req.body.accountId, { active: true });
  if (acc.type !== 'revenue' || !acc.is_postable) throw new sales.SalesError('invalid_account', 'اختر حساب إيرادات فرعيًا');
  db.prepare(
    `INSERT INTO product_category_accounts (company_id, category, revenue_account_id) VALUES (?, ?, ?)
     ON CONFLICT(company_id, category) DO UPDATE SET revenue_account_id = excluded.revenue_account_id`
  ).run(req.companyId, category, acc.id);
  return { ok: true };
}));

// ---------------------------------------------------------------------
// Go-live. 1) POST /go-live/dry-run records a dry run (writes no entries).
// 2) POST /go-live with { dryRunId, confirmText } executes it — backup
// first, then one transaction. See docs/go-live-rollback.md.
// ---------------------------------------------------------------------

router.get('/go-live/runs', requireAnyPermission('view_ledger', 'manage_settings'), handle((req) => ({
  live: customerLedger.isLedgerLive(req.companyId),
  confirmation_text: customerLedger.GO_LIVE_CONFIRMATION,
  runs: customerLedger.listRuns(req.companyId),
})));
router.post('/go-live/dry-run', requireAllPermissions('manage_settings', 'post_journal_entries'), handle((req) =>
  customerLedger.recordDryRun(req.companyId, { date: req.body?.date, openItemsImportId: req.body?.withoutOpenItems ? null : undefined }, req.user)
));

// Open-items import for go-live (customer, invoice number, invoice date,
// due date, amount). Validated, compared with each customer's snapshot,
// staged; the next dry run / execution uses it automatically.
router.get('/go-live/open-items', requireAnyPermission('view_ledger', 'manage_settings'), handle((req) => openItems.stagedSummary(req.companyId)));
router.post('/go-live/open-items', requireAllPermissions('manage_settings', 'post_journal_entries'), openItemsUpload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'file_required', message: 'الملف مطلوب' });
  try {
    const result = await openItems.importOpenItems(req.companyId, req.file.path, req.file.originalname, req.user);
    res.status(result.import_id ? 201 : 400).json(result.import_id ? result : { error: 'invalid_rows', message: 'توجد أخطاء في الملف — لم يُحفظ شيء', ...result });
  } catch (err) {
    if (err instanceof openItems.OpenItemsError) return res.status(err.status).json({ error: err.code, message: err.message, missing: err.missing });
    next(err);
  } finally {
    require('fs').rmSync(req.file.path, { force: true });
  }
});
router.delete('/go-live/open-items', requireAllPermissions('manage_settings', 'post_journal_entries'), handle((req) => openItems.discardImport(req.companyId, req.user)));
router.post('/go-live', requireAllPermissions('manage_settings', 'post_journal_entries'), handle((req) =>
  customerLedger.executeGoLive(req.companyId, { dryRunId: req.body?.dryRunId, confirmText: req.body?.confirmText }, req.user)
));

module.exports = router;
