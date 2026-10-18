// /api/manufacturing — Prompt 9: recipes and versions, allergens and label
// declaration, effective-dated cost inputs, theoretical cost, quality
// checks, plans (allergen sequencing, MRP, purchase request), production
// orders (release / issue / return / output / QC / close / reject), lot
// trace through production, reports, certificate of analysis.
// Rules: lib/manufacturing.js, lib/manufacturingOrders.js.

const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const M = require('../lib/manufacturing');
const O = require('../lib/manufacturingOrders');
const S = require('../lib/stockLedger');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { toMinor } = require('../lib/ledgerCurrencies');
const { buildDocumentHtml, renderDocumentPdf } = require('../lib/documentRenderer');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_manufacturing', 'manage_recipes', 'plan_production', 'manage_production_orders', 'record_production', 'approve_production_qc', 'manage_production_costs'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof M.MfgError || err instanceof S.StockError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError || err instanceof require('../lib/purchasing').PurchasingError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}
const created = (res, x) => { res.status(201); return x; };
const minor = (req, v) => (v === undefined || v === null || v === '' ? undefined : toMinor(v, ledger.getBaseCurrency(req.companyId).minor_unit_digits));

router.get('/meta', requireAnyPermission(...VIEW), handle((req) => ({
  stock_ledger_active: S.isActive(req.companyId),
  allergens: M.ALLERGENS, stages: M.STAGES,
  products: db.prepare('SELECT id, name, category, sku FROM products WHERE company_id = ? AND active = 1 ORDER BY name').all(req.companyId),
  warehouses: db.prepare('SELECT id, name FROM warehouses WHERE company_id = ? ORDER BY id').all(req.companyId),
  digits: ledger.getBaseCurrency(req.companyId).minor_unit_digits,
})));

// Recipes and versions
router.get('/recipes', requireAnyPermission(...VIEW), handle((req) => M.listRecipes(req.companyId)));
router.get('/versions/:id', requireAnyPermission(...VIEW), handle((req) => M.getVersion(req.companyId, req.params.id)));
router.post('/versions', requirePermission('manage_recipes'), handle((req, res) => created(res, M.createVersion(req.companyId, req.body || {}, req.user))));
router.put('/versions/:id', requirePermission('manage_recipes'), handle((req) => M.updateVersion(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/versions/:id/copy', requirePermission('manage_recipes'), handle((req, res) => created(res, M.copyVersion(req.companyId, req.params.id, req.user))));
router.post('/versions/:id/activate', requirePermission('manage_recipes'), handle((req) => M.activateVersion(req.companyId, req.params.id, req.user)));
router.get('/versions/:id/cost', requireAnyPermission(...VIEW), handle((req) => M.versionCost(req.companyId, req.params.id, { date: req.query.date, basis: req.query.basis, batches: req.query.batches || 1, sellingPriceMinor: req.query.sellingPriceMinor ?? minor(req, req.query.sellingPrice) })));

// Allergens and labels
router.get('/products/:id/allergens', requireAnyPermission(...VIEW), handle((req) => ({ own: M.productAllergens(tenantRefs.requireOwned(req.companyId, 'product', req.params.id).id), effective: M.effectiveAllergens(req.companyId, Number(req.params.id)) })));
router.put('/products/:id/allergens', requirePermission('manage_recipes'), handle((req) => M.setAllergens(req.companyId, req.params.id, { contains: req.body?.contains || [], mayContain: req.body?.mayContain || [] }, req.user)));
router.get('/products/:id/label', requireAnyPermission(...VIEW), handle((req) => M.labelDeclaration(req.companyId, req.params.id)));

// Cost inputs (effective-dated)
router.get('/cost-rates', requireAnyPermission(...VIEW), handle((req) => M.listRates(req.companyId)));
router.post('/cost-rates', requirePermission('manage_production_costs'), handle((req, res) => {
  const b = req.body || {};
  return created(res, M.addRate(req.companyId, { kind: b.kind, basis: b.basis, productId: b.productId, rateMinor: b.rateMinor ?? minor(req, b.rate), effectiveFrom: b.effectiveFrom, notes: b.notes }, req.user));
}));
router.delete('/cost-rates/:id', requirePermission('manage_production_costs'), handle((req) => M.deleteRate(req.companyId, req.params.id, req.user)));

// Quality checks
router.get('/qc-checks', requireAnyPermission(...VIEW), handle((req) => O.listQcChecks(req.companyId, { productId: req.query.productId })));
router.post('/qc-checks', requirePermission('manage_recipes'), handle((req, res) => created(res, O.saveQcCheck(req.companyId, null, req.body || {}, req.user))));
router.put('/qc-checks/:id', requirePermission('manage_recipes'), handle((req) => O.saveQcCheck(req.companyId, req.params.id, req.body || {}, req.user)));

// Plans, sequencing, MRP
router.get('/settings', requireAnyPermission(...VIEW), handle((req) => O.mrpSettings(req.companyId)));
router.put('/settings', requirePermission('plan_production'), handle((req) => O.setMrpSettings(req.companyId, { includeSalesReservations: Boolean(req.body?.includeSalesReservations) }, req.user)));
router.get('/plans', requireAnyPermission(...VIEW), handle((req) => O.listPlans(req.companyId)));
router.get('/plans/:id', requireAnyPermission(...VIEW), handle((req) => O.getPlan(req.companyId, req.params.id)));
router.post('/plans', requirePermission('plan_production'), handle((req, res) => created(res, O.savePlan(req.companyId, null, req.body || {}, req.user))));
router.put('/plans/:id', requirePermission('plan_production'), handle((req) => O.savePlan(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/plans/:id/confirm', requirePermission('plan_production'), handle((req) => O.confirmPlan(req.companyId, req.params.id, { overrideReason: req.body?.overrideReason }, req.user)));
router.get('/plans/:id/mrp', requireAnyPermission(...VIEW), handle((req) => O.mrp(req.companyId, req.params.id)));
router.post('/plans/:id/purchase-request', requirePermission('plan_production'), handle((req, res) => created(res, O.mrpPurchaseRequest(req.companyId, req.params.id, req.user))));

// Production orders
router.get('/orders', requireAnyPermission(...VIEW), handle((req) => O.listOrders(req.companyId, { status: req.query.status })));
// Prompt 11-lite: the labour cost rate (payroll side, effective-dated, per
// cost center / product line) that applies to an order — read-only; the
// order's own costing is unchanged until Prompt 16.
router.get('/orders/:id/labor-rate', requireAnyPermission(...VIEW), handle((req) => {
  const o = db.prepare('SELECT o.*, p.category FROM mfg_orders o JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.company_id = ?').get(Number(req.params.id), req.companyId);
  if (!o) throw new M.MfgError('invalid_order', 'أمر الإنتاج غير موجود', 404);
  const costCenterId = req.query.costCenterId ? tenantRefs.requireOwned(req.companyId, 'cost_center', req.query.costCenterId).id : null;
  const date = req.query.date || o.planned_date || o.created_at?.slice(0, 10);
  return { order_id: o.id, product_line: o.category || null, rate: require('../lib/payroll').laborRateFor(req.companyId, { costCenterId, productLine: req.query.productLine || o.category || null, date }) };
}));
router.get('/orders/:id', requireAnyPermission(...VIEW), handle((req) => O.getOrder(req.companyId, req.params.id)));
router.post('/orders', requirePermission('manage_production_orders'), handle((req, res) => created(res, O.createOrder(req.companyId, req.body || {}, req.user))));
router.post('/orders/from-request/:requestId', requirePermission('manage_production_orders'), handle((req, res) => created(res, O.createFromRequest(req.companyId, req.params.requestId, req.body || {}, req.user))));
router.post('/orders/:id/release', requirePermission('manage_production_orders'), handle((req) => O.releaseOrder(req.companyId, req.params.id, req.user)));
router.post('/orders/:id/cancel', requirePermission('manage_production_orders'), handle((req) => O.cancelOrder(req.companyId, req.params.id, { reason: req.body?.reason }, req.user)));
router.post('/orders/:id/issue', requirePermission('record_production'), handle((req) => O.issueMaterials(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/return', requirePermission('record_production'), handle((req) => O.returnMaterials(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/events', requirePermission('record_production'), handle((req) => O.recordEvent(req.companyId, req.params.id, req.body || {}, req.user)));
router.put('/orders/:id/hours', requirePermission('record_production'), handle((req) => O.setHours(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/qc', requirePermission('approve_production_qc'), handle((req) => O.recordQc(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/close', requirePermission('manage_production_orders'), handle((req) => O.closeOrder(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/orders/:id/reject', requirePermission('manage_production_orders'), handle((req) => O.rejectOrder(req.companyId, req.params.id, req.body || {}, req.user)));
router.get('/orders/:id/coa', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const data = O.coaData(req.companyId, req.params.id);
  if (req.query.format === 'pdf') {
    try {
      const pdf = await renderDocumentPdf(req.companyId, 'coa', data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="coa-${encodeURIComponent(data.lotCode)}.pdf"`);
      return res.send(pdf);
    } catch (err) {
      return res.status(500).json({ error: 'pdf_export_failed', message: 'تعذر إنشاء ملف PDF — استخدم نسخة HTML' });
    }
  }
  if (req.query.format === 'json') return data;
  res.type('html').send(buildDocumentHtml(req.companyId, 'coa', data));
  return undefined;
}));

// Lot trace through production
router.get('/lots/:id/made-from', requireAnyPermission(...VIEW), handle((req) => {
  const lot = S.checkLot(req.companyId, db.prepare('SELECT product_id FROM stock_lots WHERE id = ? AND company_id = ?').get(Number(req.params.id), req.companyId)?.product_id ?? 0, Number(req.params.id));
  return O.madeFrom(req.companyId, lot.id) || { order_id: null, components: [] };
}));

// Reports
const REPORTS = {
  'batch-cost': (c, q) => O.batchCost(c, q),
  yield: (c, q) => O.yieldReport(c, q),
  wastage: (c, q) => O.wastageReport(c, q),
  consumption: (c, q) => O.consumption(c, q),
  variances: (c, q) => O.variances(c, q),
  profitability: (c, q) => O.profitability(c, q),
};
router.get('/reports/:name', requireAnyPermission(...VIEW), handle((req) => {
  const fn = REPORTS[req.params.name];
  if (!fn) throw new M.MfgError('unknown_report', 'تقرير غير معروف', 404);
  return fn(req.companyId, { from: req.query.from, to: req.query.to, basis: req.query.basis });
}));

module.exports = router;
