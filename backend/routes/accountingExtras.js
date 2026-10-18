// /api/accounting — Prompt 10: tax codes and the tax report, fixed assets
// (categories, register, depreciation, disposal, schedule), recurring
// templates (recurring / accrual / prepayment).
// Rules: lib/taxCodes.js, lib/fixedAssets.js, lib/recurringEntries.js.

const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const TC = require('../lib/taxCodes');
const FA = require('../lib/fixedAssets');
const RE = require('../lib/recurringEntries');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { toMinor } = require('../lib/ledgerCurrencies');
const db = require('../db/init');

const router = express.Router();

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}
const created = (res, x) => { res.status(201); return x; };
const digits = (req) => ledger.getBaseCurrency(req.companyId).minor_unit_digits;
const minor = (req, v) => (v === undefined || v === null || v === '' ? undefined : toMinor(v, digits(req)));

router.get('/meta', requireAnyPermission('manage_fixed_assets', 'manage_tax_codes', 'manage_recurring_entries'), handle((req) => ({
  digits: digits(req),
  price_display_mode: db.prepare('SELECT price_display_mode m FROM companies WHERE id = ?').get(req.companyId)?.m ?? null,
  price_mode: TC.getPriceMode(req.companyId).mode,
  accounts: db.prepare('SELECT id, code, name_ar, name_en, type, report_class FROM accounts WHERE company_id = ? AND is_postable = 1 AND is_active = 1 ORDER BY code').all(req.companyId),
})));

// Price mode: shown on every invoice screen (any invoice permission);
// chosen with the first tax code or changed here (manage_tax_codes).
router.get('/price-mode', requireAnyPermission('manage_tax_codes', 'view_financial_reports', 'view_sales_invoices', 'create_sales_invoices', 'post_sales_invoices', 'create_credit_notes', 'view_purchases', 'post_supplier_invoices'), handle((req) => TC.getPriceMode(req.companyId)));
router.put('/price-mode', requirePermission('manage_tax_codes'), handle((req) => TC.setPriceMode(req.companyId, req.body || {}, req.user)));

// Tax codes
router.get('/tax-codes', requireAnyPermission('manage_tax_codes', 'view_financial_reports', 'create_sales_invoices', 'post_supplier_invoices'), handle((req) => TC.listCodes(req.companyId)));
router.post('/tax-codes', requirePermission('manage_tax_codes'), handle((req, res) => created(res, TC.createCode(req.companyId, req.body || {}, req.user))));
router.put('/tax-codes/:id', requirePermission('manage_tax_codes'), handle((req) => TC.updateCode(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/tax-codes/:id/rates', requirePermission('manage_tax_codes'), handle((req, res) => created(res, TC.addRate(req.companyId, req.params.id, req.body || {}, req.user))));
router.get('/tax-report', requireAnyPermission('manage_tax_codes', 'view_financial_reports'), handle((req) => TC.taxReport(req.companyId, { from: req.query.from, to: req.query.to })));

// Fixed assets
router.get('/asset-categories', requirePermission('manage_fixed_assets'), handle((req) => FA.listCategories(req.companyId)));
router.post('/asset-categories', requirePermission('manage_fixed_assets'), handle((req, res) => created(res, FA.saveCategory(req.companyId, null, req.body || {}, req.user))));
router.put('/asset-categories/:id', requirePermission('manage_fixed_assets'), handle((req) => FA.saveCategory(req.companyId, req.params.id, req.body || {}, req.user)));
router.get('/assets', requirePermission('manage_fixed_assets'), handle((req) => FA.listAssets(req.companyId, { status: req.query.status, categoryId: req.query.categoryId })));
router.get('/assets/:id', requirePermission('manage_fixed_assets'), handle((req) => FA.getAsset(req.companyId, req.params.id)));
router.get('/assets/:id/schedule', requirePermission('manage_fixed_assets'), handle((req) => FA.schedule(req.companyId, req.params.id)));
router.post('/assets', requirePermission('manage_fixed_assets'), handle((req, res) => {
  const b = req.body || {};
  return created(res, FA.createAsset(req.companyId, { ...b, costMinor: b.costMinor ?? minor(req, b.cost), salvageMinor: b.salvageMinor ?? minor(req, b.salvage), openingAccumulatedMinor: b.openingAccumulatedMinor ?? minor(req, b.openingAccumulated) }, req.user));
}));
router.post('/assets/:id/dispose', requirePermission('manage_fixed_assets'), handle((req) => {
  const b = req.body || {};
  return FA.dispose(req.companyId, req.params.id, { ...b, proceedsMinor: b.proceedsMinor ?? minor(req, b.proceeds) ?? 0 }, req.user);
}));
router.post('/depreciation/run', requirePermission('manage_fixed_assets'), handle((req) => FA.runDepreciation(req.companyId, { period: req.body?.period }, req.user)));
router.get('/asset-schedule', requireAnyPermission('manage_fixed_assets', 'view_financial_reports'), handle((req) => FA.scheduleReport(req.companyId, { from: req.query.from, to: req.query.to })));

// Recurring templates
router.get('/recurring', requirePermission('manage_recurring_entries'), handle((req) => RE.listTemplates(req.companyId)));
router.get('/recurring/:id', requirePermission('manage_recurring_entries'), handle((req) => RE.getTemplate(req.companyId, req.params.id)));
router.post('/recurring', requirePermission('manage_recurring_entries'), handle((req, res) => created(res, RE.saveTemplate(req.companyId, null, { ...req.body, totalMinor: req.body?.totalMinor ?? minor(req, req.body?.total) }, req.user))));
router.put('/recurring/:id', requirePermission('manage_recurring_entries'), handle((req) => RE.saveTemplate(req.companyId, req.params.id, { ...req.body, totalMinor: req.body?.totalMinor ?? minor(req, req.body?.total) }, req.user)));
router.post('/recurring/run', requirePermission('manage_recurring_entries'), handle((req) => RE.runDue(req.companyId, { asOf: req.body?.asOf, templateId: req.body?.templateId }, req.user)));

module.exports = router;
