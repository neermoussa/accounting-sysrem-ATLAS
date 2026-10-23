// /api/report-builder — Prompt 12b: the Report Builder.
//  GET  /catalog              sources, dimensions and measures the caller may use
//  POST /run                  { spec } -> validated, run in a report worker
//  GET  /drill                fact rows behind a builder row (cost / payroll
//                             columns removed without the permission)
//  GET  /dimension-values     values of one dimension (for the filter picker)
// The query spec, its validation and every permission check live in the
// engine (lib/analytics/query.js); this router only passes the caller's
// company, permissions and the injected clock's "today".

const express = require('express');
const db = require('../db/init');
const { requireAnyPermission } = require('../middleware/auth');
const tenantRefs = require('../lib/tenantRefs');
const facts = require('../lib/analytics/facts');
const reports = require('../lib/analytics/reports');
const runner = require('../lib/analytics/runner');
const Q = require('../lib/analytics/query');
const E = require('../lib/analytics/expr');
const clock = require('../lib/clock');

const router = express.Router();
const VIEW = [Q.REPORTS_PERM];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof reports.ReportError || err instanceof tenantRefs.ForeignRefError || err instanceof E.ExprError || err.status) {
        if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
        return res.status(err.status || 400).json({ error: err.code || 'error', message: err.message });
      }
      next(err);
    }
  };
}
const ctxOf = (req) => ({ companyId: req.companyId, permissions: req.user.permissions, now: clock.today() });

// Validate on the main thread, bring the facts up to date (bounded), run
// in a worker. Used by /run and by saved / scheduled reports.
async function runSpec(companyId, permissions, spec, now) {
  const normalized = Q.validate(spec, { companyId, permissions, now });
  try { facts.refresh(companyId); } catch (err) { console.error('[report-builder] refresh failed:', err.message); }
  const result = await runner.runReport(companyId, '__query', { spec: normalized });
  return { spec: normalized, ...result, freshness: facts.freshness(companyId) };
}

router.get('/catalog', requireAnyPermission(...VIEW), handle((req) => ({ sources: Q.catalogFor(req.user.permissions), presets: ['this_month', 'last_month', 'mtd', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'ytd', 'last_n_days'] })));

router.post('/run', requireAnyPermission(...VIEW), handle((req) => runSpec(req.companyId, req.user.permissions, (req.body || {}).spec, clock.today())));

router.get('/drill', requireAnyPermission(...VIEW), handle((req) => {
  let filters;
  try { filters = req.query.filters ? JSON.parse(req.query.filters) : {}; } catch { throw new reports.ReportError('invalid_filters', 'فلاتر غير صالحة'); }
  return { ...Q.drill(db, req.companyId, { source: req.query.source, filters }, req.user.permissions), freshness: facts.freshness(req.companyId) };
}));

router.get('/dimension-values', requireAnyPermission(...VIEW), handle((req) => {
  const acc = Q.access(req.user.permissions);
  const src = Object.prototype.hasOwnProperty.call(Q.CATALOG, req.query.source) ? Q.CATALOG[req.query.source] : null;
  if (!src) throw new reports.ReportError('invalid_source', 'مصدر البيانات غير معروف');
  const dim = Object.prototype.hasOwnProperty.call(src.dims, req.query.dim) ? src.dims[req.query.dim] : null;
  if (!dim) throw new reports.ReportError('invalid_dimension', 'بُعد غير معروف');
  for (const need of [src.needs, dim.needs]) if (need && !acc[need]) throw new reports.ReportError(`forbidden_${need}`, 'لا تملك صلاحية هذه البيانات', 403);
  const values = db.prepare(`SELECT DISTINCT ${dim.col} v FROM ${src.table} WHERE company_id = ? ORDER BY ${dim.col} LIMIT 300`).all(req.companyId).map((r) => r.v);
  const q = String(req.query.q || '').trim();
  return values.map((v) => ({ value: v, label: dim.text ? (v ?? '—') : reports.label(db, dim.labelAs, v) })).filter((x) => !q || String(x.label).includes(q));
}));

module.exports = router;
module.exports.runSpec = runSpec;
module.exports.ctxOf = ctxOf;
