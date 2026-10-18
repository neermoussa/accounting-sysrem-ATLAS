// /api/payroll — Prompt 11-lite: the accounting side of payroll (import
// from the HR program, accrual posting, payments and advances through
// treasury, labour cost rates, reports). Rules: lib/payroll.js.

const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const PR = require('../lib/payroll');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const db = require('../db/init');

const router = express.Router();
const ANY = ['manage_payroll_intake', 'approve_payroll_posting'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError || err instanceof require('../lib/purchasing').PurchasingError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}
const created = (res, x) => { res.status(201); return x; };

router.get('/meta', requireAnyPermission(...ANY), handle((req) => ({
  settings: PR.getSettings(req.companyId),
  digits: ledger.getBaseCurrency(req.companyId).minor_unit_digits,
  base_currency: ledger.getBaseCurrency(req.companyId).code,
  accounts: db.prepare('SELECT id, code, name_ar, type FROM accounts WHERE company_id = ? AND is_postable = 1 AND is_active = 1 ORDER BY code').all(req.companyId),
  cost_centers: db.prepare('SELECT id, code, name FROM cost_centers WHERE company_id = ? AND is_active = 1 ORDER BY code').all(req.companyId),
  currency_digits: Object.fromEntries(db.prepare('SELECT code, minor_unit_digits d FROM currencies WHERE company_id = ?').all(req.companyId).map((r) => [r.code, r.d])),
  boxes: db.prepare('SELECT id, name, currency_code FROM cash_boxes WHERE company_id = ? AND is_active = 1 ORDER BY id').all(req.companyId),
})));
router.put('/settings', requirePermission('manage_payroll_intake'), handle((req) => PR.saveSettings(req.companyId, req.body || {}, req.user)));

router.get('/periods', requireAnyPermission(...ANY), handle((req) => PR.listPeriods(req.companyId, req.query)));
router.get('/periods/:id', requireAnyPermission(...ANY), handle((req) => PR.getPeriod(req.companyId, req.params.id)));
router.post('/periods/import', requirePermission('manage_payroll_intake'), handle((req, res) => {
  const r = PR.importPeriod(req.companyId, req.body || {}, req.user);
  if (r.import_count === 1 && !r.replay) res.status(201);
  return r;
}));
router.post('/periods/import-csv', requirePermission('manage_payroll_intake'), handle((req, res) => {
  const r = PR.importCsv(req.companyId, req.body || {}, req.user);
  if (r.import_count === 1 && !r.replay) res.status(201);
  return r;
}));
router.post('/periods/:id/post', requirePermission('approve_payroll_posting'), handle((req) => require('../lib/postingQueue').guard(req.companyId, { kind: 'payroll_period.post', sourceId: Number(req.params.id), label: `رواتب #${req.params.id}` }, () => PR.postPeriod(req.companyId, req.params.id, req.body || {}, req.user), req.user)));
router.post('/periods/:id/reopen', requirePermission('approve_payroll_posting'), handle((req) => PR.reopenPeriod(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/periods/:id/payments', requirePermission('approve_payroll_posting'), handle((req, res) => created(res, PR.createPayment(req.companyId, req.params.id, req.body || {}, req.user))));

router.get('/deduction-types', requireAnyPermission(...ANY), handle((req) => PR.listDeductionTypes(req.companyId)));
router.post('/deduction-types', requirePermission('manage_payroll_intake'), handle((req, res) => created(res, PR.saveDeductionType(req.companyId, null, req.body || {}, req.user))));
router.put('/deduction-types/:id', requirePermission('manage_payroll_intake'), handle((req) => PR.saveDeductionType(req.companyId, req.params.id, req.body || {}, req.user)));
router.post('/deduction-payments', requirePermission('approve_payroll_posting'), handle((req, res) => created(res, PR.createDeductionPayment(req.companyId, req.body || {}, req.user))));
router.get('/reports/deductions', requireAnyPermission(...ANY), handle((req) => PR.deductionsReport(req.companyId)));
router.post('/advances', requirePermission('manage_payroll_intake'), handle((req, res) => created(res, PR.recordAdvance(req.companyId, req.body || {}, req.user))));
router.get('/reports/advances', requireAnyPermission(...ANY), handle((req) => PR.advancesReport(req.companyId)));
router.get('/reports/cost', requireAnyPermission(...ANY), handle((req) => PR.costReport(req.companyId, req.query)));
router.get('/reports/payables', requireAnyPermission(...ANY), handle((req) => PR.payablesReport(req.companyId)));

router.get('/labor-rates', requireAnyPermission(...ANY), handle((req) => PR.listLaborRates(req.companyId)));
router.post('/labor-rates', requirePermission('manage_payroll_intake'), handle((req, res) => created(res, PR.addLaborRate(req.companyId, req.body || {}, req.user))));

module.exports = router;
