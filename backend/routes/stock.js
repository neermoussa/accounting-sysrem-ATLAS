// /api/stock — stock ledger (Prompt 8a): activation (dry run, execute),
// valuation methods, standard costs, valuation, moves, transfers,
// adjustments, reconciliation. Rules: lib/stockLedger.js.

const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const S = require('../lib/stockLedger');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { toMinor } = require('../lib/ledgerCurrencies');
const { logAudit } = require('../lib/auditLog');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_stock_valuation', 'manage_stock_ledger'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof S.StockError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError || err instanceof require('../lib/purchasing').PurchasingError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}
const holderId = (req, v) => S.holderById(req.companyId, Number(v)).id;

router.get('/meta', requireAnyPermission(...VIEW), handle((req) => ({
  active: S.isActive(req.companyId),
  method: db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'inventory_valuation_method'").get(req.companyId)?.value || 'average',
  category_methods: db.prepare('SELECT category, method FROM stock_category_methods WHERE company_id = ? ORDER BY category').all(req.companyId),
  categories: db.prepare("SELECT DISTINCT category FROM products WHERE company_id = ? AND category IS NOT NULL AND category <> '' ORDER BY category").all(req.companyId).map((r) => r.category),
  holders: db.prepare('SELECT * FROM stock_holders WHERE company_id = ? ORDER BY kind, id').all(req.companyId),
  warehouses: db.prepare("SELECT id, name, kind FROM warehouses WHERE company_id = ? ORDER BY id").all(req.companyId),
  products: db.prepare('SELECT p.id, p.name, p.category, p.cost_price, s.standard_cost_minor FROM products p LEFT JOIN product_standard_costs s ON s.product_id = p.id WHERE p.company_id = ? AND p.active = 1 ORDER BY p.name').all(req.companyId),
  digits: ledger.getBaseCurrency(req.companyId).minor_unit_digits,
  last_reconciliation: db.prepare('SELECT * FROM stock_reconciliation_checks WHERE company_id = ? ORDER BY id DESC LIMIT 1').get(req.companyId) || null,
  runs: db.prepare('SELECT id, kind, created_at, dry_run_id, journal_entry_id FROM stock_activation_runs WHERE company_id = ? ORDER BY id DESC LIMIT 10').all(req.companyId),
})));

router.post('/activation/dry-run', requirePermission('manage_stock_ledger'), handle((req) => S.activationDryRun(req.companyId, { date: req.body?.date }, req.user)));
router.post('/activation/cost-acknowledgements', requirePermission('manage_stock_ledger'), handle((req, res) => {
  res.status(201);
  return S.acknowledgeZeroCost(req.companyId, req.body?.productId, { reason: req.body?.reason }, req.user);
}));
router.post('/activation', requirePermission('manage_stock_ledger'), handle((req) => S.activate(req.companyId, { dryRunId: req.body?.dryRunId }, req.user)));
router.put('/method', requirePermission('manage_stock_ledger'), handle((req) => S.setMethod(req.companyId, { category: req.body?.category || null, method: req.body?.method }, req.user)));
router.put('/standard-costs/:productId', requirePermission('manage_stock_ledger'), handle((req) => S.setStandardCost(req.companyId, req.params.productId, req.body?.standardCostMinor ?? toMinor(req.body?.standardCost, ledger.getBaseCurrency(req.companyId).minor_unit_digits), req.user)));

function requireActive(req) {
  if (!S.isActive(req.companyId)) throw new S.StockError('stock_ledger_not_active', 'دفتر المخزون غير مفعّل لهذه الشركة', 409);
}
router.get('/valuation', requireAnyPermission(...VIEW), handle((req) => S.valuation(req.companyId, { holderId: req.query.holderId ? holderId(req, req.query.holderId) : null, productId: req.query.productId ? S.productRow(req.companyId, req.query.productId).id : null })));
router.get('/reconciliation', requireAnyPermission(...VIEW), handle((req) => S.reconcile(req.companyId, { store: req.query.store === '1' })));
router.get('/moves', requireAnyPermission(...VIEW), handle((req) => {
  const pid = S.productRow(req.companyId, req.query.productId).id;
  const hid = req.query.holderId ? holderId(req, req.query.holderId) : null;
  let qty = 0;
  let value = 0;
  return db.prepare(`SELECT m.*, h.name AS holder_name FROM stock_moves m JOIN stock_holders h ON h.id = m.holder_id WHERE m.company_id = ? AND m.product_id = ? ${hid ? 'AND m.holder_id = ?' : ''} ORDER BY m.move_date, m.id`)
    .all(...[req.companyId, pid, ...(hid ? [hid] : [])])
    .map((m) => { qty += m.qty; value += m.value_minor; return { ...m, running_qty: Math.round(qty * 1e6) / 1e6, running_value_minor: value }; });
}));
router.post('/transfers', requirePermission('manage_stock_ledger'), handle((req, res) => {
  requireActive(req);
  const b = req.body || {};
  res.status(201);
  return S.transferDoc(req.companyId, { productId: b.productId, fromHolderId: holderId(req, b.fromHolderId), toHolderId: holderId(req, b.toHolderId), qty: b.qty, date: b.date, reference: b.reference }, req.user);
}));
router.post('/adjustments', requirePermission('manage_stock_ledger'), handle((req, res) => {
  requireActive(req);
  const b = req.body || {};
  const pid = S.productRow(req.companyId, b.productId).id;
  const hid = holderId(req, b.holderId);
  if (!String(b.reasonCode || '').trim()) throw new S.StockError('reason_required', 'سبب التسوية مطلوب');
  const r = ledger.transaction(() => S.adjustHolder(req.companyId, { productId: pid, holderId: hid, newQty: Number(b.newQty), reasonCode: String(b.reasonCode).trim(), date: b.date, legacy: true, actor: req.user }));
  logAudit({ companyId: req.companyId, actor: req.user, action: 'stock.adjustment', entityType: 'product', entityId: pid, before: null, after: { holder_id: hid, ...r } });
  res.status(201);
  return r || { delta: 0 };
}));
router.post('/holders', requirePermission('manage_stock_ledger'), handle((req, res) => {
  const b = req.body || {};
  let h;
  if (b.kind === 'warehouse') h = S.warehouseHolder(req.companyId, b.refId);
  else if (b.kind === 'vehicle') h = S.vehicleHolder(req.companyId, b.refId);
  else if (b.kind === 'rep') h = S.repHolder(req.companyId, b.refId);
  else h = S.carPoolHolder(req.companyId);
  res.status(201);
  return h;
}));

// ---- Prompt 8b: counts, wastage, repack, lots, trace/recall, reports ----
const O = require('../lib/stockOps');
const COUNT_VIEW = [...VIEW, 'manage_stock_counts', 'approve_stock_counts'];
router.get('/reason-codes', requireAnyPermission(...COUNT_VIEW, 'post_stock_wastage'), handle((req) => O.reasonCodes(req.companyId)));
router.get('/counts', requireAnyPermission(...COUNT_VIEW), handle((req) => O.listCounts(req.companyId)));
router.get('/counts/:id', requireAnyPermission(...COUNT_VIEW), handle((req) => O.getCount(req.companyId, req.params.id)));
router.post('/counts', requirePermission('manage_stock_counts'), handle((req, res) => {
  const b = req.body || {};
  res.status(201);
  return O.createCount(req.companyId, { holderId: holderId(req, b.holderId), countDate: b.countDate, notes: b.notes, lines: b.lines }, req.user);
}));
router.post('/counts/:id/approve', requirePermission('approve_stock_counts'), handle((req) => O.approveCount(req.companyId, req.params.id, { breakGlassReason: req.body?.breakGlassReason }, req.user)));
router.post('/counts/:id/reject', requirePermission('approve_stock_counts'), handle((req) => O.rejectCount(req.companyId, req.params.id, { reason: req.body?.reason }, req.user)));
router.get('/documents', requireAnyPermission(...VIEW, 'post_stock_wastage'), handle((req) => O.listDocs(req.companyId, { kind: req.query.kind })));
router.get('/documents/:id', requireAnyPermission(...VIEW, 'post_stock_wastage'), handle((req) => O.getDoc(req.companyId, req.params.id)));
router.post('/wastage', requirePermission('post_stock_wastage'), handle((req, res) => {
  const b = req.body || {};
  res.status(201);
  return O.postWastage(req.companyId, { holderId: holderId(req, b.holderId), date: b.date, reasonCode: b.reasonCode, notes: b.notes, lines: b.lines }, req.user);
}));
router.post('/repack', requirePermission('manage_stock_ledger'), handle((req, res) => {
  const b = req.body || {};
  res.status(201);
  return O.postRepack(req.companyId, { holderId: holderId(req, b.holderId), date: b.date, reasonCode: b.reasonCode, notes: b.notes, from: b.from, to: b.to }, req.user);
}));
router.get('/lots', requireAnyPermission(...VIEW, 'manage_lots'), handle((req) => O.listLots(req.companyId, { productId: req.query.productId, status: req.query.status, expiringWithin: req.query.expiringWithin })));
router.put('/lots/:id/status', requirePermission('manage_lots'), handle((req) => O.setLotStatus(req.companyId, req.params.id, { status: req.body?.status, reason: req.body?.reason }, req.user)));
router.get('/lots/:id/trace', requireAnyPermission(...VIEW, 'manage_lots'), handle((req) => O.forwardTrace(req.companyId, req.params.id)));
router.get('/lots/:id/recall', requireAnyPermission(...VIEW, 'manage_lots'), handle((req) => O.recallReport(req.companyId, req.params.id)));
router.get('/trace/reverse', requireAnyPermission(...VIEW, 'manage_lots'), handle((req) => O.reverseTrace(req.companyId, { shopId: req.query.shopId, invoiceId: req.query.invoiceId })));
router.put('/products/:id/settings', requirePermission('manage_stock_ledger'), handle((req) => S.setProductSettings(req.companyId, req.params.id, { trackLots: req.body?.trackLots, reorderPoint: req.body?.reorderPoint, reorderQty: req.body?.reorderQty }, req.user)));
router.get('/reorder', requireAnyPermission(...VIEW), handle((req) => O.reorderSuggestions(req.companyId)));
const REPORTS = {
  'item-balance': (c) => O.itemBalance(c),
  ageing: (c, q) => O.ageing(c, { asOf: q.asOf }),
  'slow-moving': (c, q) => O.slowMoving(c, { days: q.days ? Number(q.days) : undefined }),
  'near-expiry': (c, q) => O.listLots(c, { expiringWithin: q.days || 30 }).filter((l) => l.qty > 1e-9),
  'count-variances': (c, q) => O.countVariances(c, q),
  'inventory-cost': (c) => S.valuation(c),
  turnover: (c, q) => O.turnover(c, q),
  profitability: (c, q) => O.profitability(c, q),
  wastage: (c, q) => O.wastageAnalysis(c, q),
};
router.get('/reports/:name', requireAnyPermission(...VIEW), handle((req) => {
  const fn = REPORTS[req.params.name];
  if (!fn) throw new S.StockError('unknown_report', 'تقرير غير معروف', 404);
  return fn(req.companyId, { from: req.query.from, to: req.query.to, asOf: req.query.asOf, days: req.query.days });
}));
router.get('/items/:id', requireAnyPermission(...VIEW), handle((req) => O.itemCard(req.companyId, req.params.id)));

module.exports = router;
