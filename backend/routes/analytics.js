// /api/analytics — Prompt 12a: ready reports over the fact tables.
//  GET  /catalog            reports the caller may run (payroll needs payroll permissions)
//  GET  /run/:key           runs a report in a worker thread (read-only
//                           connection, timeout, row cap) + freshness stamp
//  GET  /drill              fact rows behind an operational amount
//  GET  /freshness          fact refresh state
//  POST /refresh            incremental refresh now; POST /rebuild full rebuild
// Every client-supplied id goes through tenantRefs (or a company-scoped
// lookup for the tables tenantRefs does not list).

const express = require('express');
const { requireAnyPermission } = require('../middleware/auth');
const tenantRefs = require('../lib/tenantRefs');
const facts = require('../lib/analytics/facts');
const reports = require('../lib/analytics/reports');
const runner = require('../lib/analytics/runner');
const { logAudit } = require('../lib/auditLog');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_financial_reports'];
const PAYROLL = ['manage_payroll_intake', 'approve_payroll_posting'];
const hasPayroll = (u) => PAYROLL.some((p) => u.permissions.includes(p));

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof reports.ReportError || err instanceof tenantRefs.ForeignRefError) {
        if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
        return res.status(err.status || 400).json({ error: err.code, message: err.message });
      }
      next(err);
    }
  };
}
const bad = (code, message, status = 400) => { throw new reports.ReportError(code, message, status); };

// Ids in report params / drill filters -> the tenantRefs kind that owns them.
const ID_KINDS = {
  accountId: 'account', account_id: 'account', branchId: 'branch', expense_account_id: 'account',
  product_id: 'product', customer_id: 'shop', supplier_id: 'supplier',
  cost_center_id: 'cost_center', project_id: 'project', branch_id: 'branch',
  warehouse_id: 'warehouse', rep_id: 'user', employee_id: 'user', entry_id: 'journal_entry',
};
const SCOPED = { budgetId: 'budgets', lotId: 'stock_lots', period_id: 'payroll_periods', order_id: 'mfg_orders' };
function checkIds(cid, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (ID_KINDS[k]) tenantRefs.requireOwned(cid, ID_KINDS[k], v);
    else if (SCOPED[k]) {
      if (!db.prepare(`SELECT 1 FROM ${SCOPED[k]} WHERE id = ? AND company_id = ?`).get(Number(v), cid)) bad('foreign_ref', 'المعرّف لا يخص هذه الشركة');
    }
  }
}

const visible = (u) => reports.CATALOG.filter((r) => r.permission !== 'payroll' || hasPayroll(u));

router.get('/catalog', requireAnyPermission(...VIEW), handle((req) => ({
  reports: visible(req.user).map((r) => ({ key: r.key, family: r.family, name_ar: r.name_ar, name_en: r.name_en, params: r.params || [], dims: r.dims || null, as_of: Boolean(r.asOf), live: Boolean(r.live) })),
  freshness: facts.freshness(req.companyId),
})));

router.get('/freshness', requireAnyPermission(...VIEW), handle((req) => facts.freshness(req.companyId)));

router.post('/refresh', requireAnyPermission(...VIEW), handle((req) => {
  const r = facts.refresh(req.companyId);
  logAudit({ companyId: req.companyId, actor: { id: req.user.id, name: req.user.name }, action: 'analytics.refresh', entityType: 'fact_state', entityId: req.companyId, after: { documents: r.documents, mode: r.mode } });
  return { ...r, freshness: facts.freshness(req.companyId) };
}));
router.post('/rebuild', requireAnyPermission(...VIEW), handle((req) => {
  const r = facts.rebuild(req.companyId);
  logAudit({ companyId: req.companyId, actor: { id: req.user.id, name: req.user.name }, action: 'analytics.rebuild', entityType: 'fact_state', entityId: req.companyId, after: { documents: r.documents } });
  return { ...r, freshness: facts.freshness(req.companyId) };
}));

router.get('/run/:key', requireAnyPermission(...VIEW), handle(async (req) => {
  const def = reports.BY_KEY[req.params.key];
  if (!def || (def.permission === 'payroll' && !hasPayroll(req.user))) bad('unknown_report', 'تقرير غير معروف', 404);
  const params = { ...req.query };
  checkIds(req.companyId, params);
  if (def.key === 'cost_variances') {
    const rows = require('../lib/manufacturingOrders').variances(req.companyId, params).map((r) => ({ ...r, variance: r.actual_materials_minor + r.actual_labour_minor + r.actual_overhead_minor - (r.theoretical_materials_minor + r.theoretical_labour_minor + r.theoretical_overhead_minor) }));
    return { key: def.key, live: true, columns: [{ key: 'order_number', type: 'text', label_ar: 'الأمر', label_en: 'Order' }, { key: 'product_name', type: 'text', label_ar: 'المنتج', label_en: 'Product' }, { key: 'materials_variance_minor', type: 'money', label_ar: 'انحراف المواد', label_en: 'Materials variance' }, { key: 'labour_variance_minor', type: 'money', label_ar: 'انحراف العمل', label_en: 'Labour variance' }, { key: 'variance', type: 'money', label_ar: 'الانحراف الكلي', label_en: 'Total variance' }], rows, totals: { variance: rows.reduce((t, r) => t + r.variance, 0) }, freshness: { live: true, as_of: new Date().toISOString() } };
  }
  if (def.live) {
    if (!params.lotId) bad('lot_required', 'اختر الدفعة');
    const S = require('../lib/stockOps');
    const result = def.key === 'recall' ? S.recallReport(req.companyId, Number(params.lotId)) : { forward: S.forwardTrace(req.companyId, Number(params.lotId)), made_from: require('../lib/manufacturingOrders').madeFrom(req.companyId, Number(params.lotId)) };
    return { key: def.key, live: true, result, freshness: { live: true, as_of: new Date().toISOString() } };
  }
  // Bring the facts up to date first (bounded); the stamp says what is left.
  try { facts.refresh(req.companyId); } catch (err) { console.error('[analytics] refresh failed:', err.message); }
  const result = await runner.runReport(req.companyId, def.key, params);
  return { key: def.key, name_ar: def.name_ar, name_en: def.name_en, ...result, freshness: facts.freshness(req.companyId) };
}));

const DRILL = {
  journal: ['fact_journal_lines', 'entry_date'], expenses: ['fact_expenses', 'entry_date'],
  receivables: ['fact_receivables', 'entry_date'], payables: ['fact_payables', 'entry_date'],
  sales: ['fact_sales_lines', 'doc_date'], purchases: ['fact_purchase_lines', 'doc_date'],
  inventory: ['fact_inventory_moves', 'move_date'], production: ['fact_production_batches', 'production_date'],
  payroll: ['fact_payroll', 'period'],
};
const DRILL_CAP = 1000;
router.get('/drill', requireAnyPermission(...VIEW), handle((req) => {
  const d = DRILL[req.query.fact];
  if (!d || (req.query.fact === 'payroll' && !hasPayroll(req.user))) bad('unknown_fact', 'جدول غير معروف', 404);
  const [table, dateCol] = d;
  let filters = {};
  try { filters = req.query.filters ? JSON.parse(req.query.filters) : {}; } catch { bad('invalid_filters', 'فلاتر غير صالحة'); }
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) bad('invalid_filters', 'فلاتر غير صالحة');
  checkIds(req.companyId, filters);
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const where = ['company_id = ?']; const args = [req.companyId];
  for (const [k, v] of Object.entries(filters)) {
    if (k === 'from') { where.push(`${dateCol} >= ?`); args.push(String(v)); continue; }
    if (k === 'to') { where.push(`${dateCol} <= ?`); args.push(String(v)); continue; }
    if (!cols.has(k) || k === 'company_id') bad('invalid_filters', `فلتر غير مدعوم: ${k}`);
    if (v === null) where.push(`${k} IS NULL`); else { where.push(`${k} = ?`); args.push(v); }
  }
  const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${dateCol}, rowid LIMIT ${DRILL_CAP + 1}`).all(...args);
  return { fact: req.query.fact, rows: rows.slice(0, DRILL_CAP), truncated: rows.length > DRILL_CAP, freshness: facts.freshness(req.companyId) };
}));

module.exports = router;
