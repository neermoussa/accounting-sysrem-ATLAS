// /api/report-builder — Prompt 12b: the Report Builder.
//  GET  /catalog              sources, dimensions and measures the caller may use
//  POST /run                  { spec } -> validated, run in a report worker
//  GET  /drill                fact rows behind a builder row (cost / payroll
//                             columns removed without the permission)
//  GET  /dimension-values     values of one dimension (for the filter picker)
//  POST /export               { spec, format, lang } -> the file now (nothing stored)
//  /saved, /saved/:id[/run|/runs|/schedules], /runs/:id/file, /schedules/:id,
//  /runs/:id/sends, /sends[/:id/approve|reject] — saved, scheduled and sent
//  reports (lib/reportBuilder.js)
// The query spec, its validation and every permission check live in the
// engine (lib/analytics/query.js); this router only passes the caller's
// company, permissions and the injected clock's "today".

const express = require('express');
const db = require('../db/init');
const fs = require('fs');
const { requireAnyPermission, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../lib/auditLog');
const RB = require('../lib/reportBuilder');
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
      if (err instanceof reports.ReportError || err instanceof tenantRefs.ForeignRefError || err instanceof E.ExprError || err instanceof RB.BuilderError || err.status) {
        if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
        // Extra fields an error carries (e.g. break_glass_available) go to the client.
        const { code, status, retryAfter, ...extra } = err;
        return res.status(status || 400).json({ ...extra, error: code || 'error', message: err.message });
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

router.get('/catalog', requireAnyPermission(...VIEW), handle((req) => ({ sources: Q.catalogFor(req.user.permissions), digits: db.prepare('SELECT minor_unit_digits d FROM currencies WHERE company_id = ? AND is_base = 1').get(req.companyId)?.d ?? 2, presets: ['this_month', 'last_month', 'mtd', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'ytd', 'last_n_days'] })));

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

// ---------------------------------------------------------------------
// Export of an unsaved spec (download now; nothing stored)
// ---------------------------------------------------------------------
router.post('/export', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const { spec, format = 'xlsx', lang = 'ar', title } = req.body || {};
  if (!RB.MIME[format]) throw new RB.BuilderError('invalid_format', 'الصيغة: xlsx أو pdf أو csv');
  const result = await runSpec(req.companyId, req.user.permissions, spec, clock.today());
  const name = String(title || result.label_ar).slice(0, 80);
  const file = await RB.renderFile(req.companyId, result, { format, lang: lang === 'en' ? 'en' : 'ar', title: name });
  logAudit({ companyId: req.companyId, actor: { id: req.user.id, name: req.user.name }, action: 'report.export', entityType: 'report_spec', entityId: null, before: null, after: { format, spec: result.spec, rows: result.row_count } });
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `attachment; filename="report.${file.ext}"; filename*=UTF-8''${encodeURIComponent(`${name}-${result.period.to}.${file.ext}`)}`);
  res.end(file.buffer);
}));

// ---------------------------------------------------------------------
// Saved reports, runs, schedules, sends (lib/reportBuilder.js)
// ---------------------------------------------------------------------
router.get('/saved', requireAnyPermission(...VIEW), handle((req) => RB.listSaved(req.companyId, req.user)));
router.post('/saved', requireAnyPermission(...VIEW), handle((req, res) => { res.status(201); return RB.createSaved(req.companyId, req.user, req.body || {}); }));
router.get('/saved/:id', requireAnyPermission(...VIEW), handle((req) => RB.getSaved(req.companyId, req.params.id, req.user)));
router.put('/saved/:id', requireAnyPermission(...VIEW), handle((req) => RB.updateSaved(req.companyId, req.params.id, req.user, req.body || {})));
router.delete('/saved/:id', requireAnyPermission(...VIEW), handle((req) => RB.deleteSaved(req.companyId, req.params.id, req.user)));
// Run a saved report and return the rows (no file).
router.post('/saved/:id/run', requireAnyPermission(...VIEW), handle((req) => {
  const row = RB.getSaved(req.companyId, req.params.id, req.user);
  return runSpec(req.companyId, req.user.permissions, row.spec, clock.today());
}));
// Produce a file now (a manual run).
router.post('/saved/:id/runs', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const run = await RB.runNow(req.companyId, req.params.id, req.user, req.body || {}, runSpec);
  res.status(run.status === 'done' ? 201 : 422);
  return run;
}));
router.get('/saved/:id/runs', requireAnyPermission(...VIEW), handle((req) => RB.listRuns(req.companyId, req.params.id, req.user)));
router.get('/runs/:id/file', requireAnyPermission(...VIEW), handle((req, res) => {
  const f = RB.runFile(req.companyId, req.params.id, req.user);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename="report"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.end(fs.readFileSync(f.path));
}));
router.get('/saved/:id/schedules', requireAnyPermission(...VIEW), handle((req) => RB.listSchedules(req.companyId, req.params.id, req.user)));
router.post('/saved/:id/schedules', requirePermission('schedule_reports'), handle((req, res) => { res.status(201); return RB.createSchedule(req.companyId, req.params.id, req.user, req.body || {}); }));
router.put('/schedules/:id', requirePermission('schedule_reports'), handle((req) => RB.updateSchedule(req.companyId, req.params.id, req.user, req.body || {})));
router.delete('/schedules/:id', requirePermission('schedule_reports'), handle((req) => RB.deleteSchedule(req.companyId, req.params.id, req.user)));
// Company users a send can name (no contact details: only which channel
// they can receive on and whether they may receive cost / payroll data).
router.get('/recipients', requirePermission('send_reports'), handle((req) => {
  const { getUserPermissions } = require('../lib/permissions');
  return db.prepare("SELECT id, name, contact FROM users WHERE company_id = ? AND status = 'approved' ORDER BY name").all(req.companyId).map((u) => {
    const perms = getUserPermissions(u.id);
    const c = String(u.contact || '');
    return { id: u.id, name: u.name, email: /@/.test(c), phone: /^\+?[\d\s-]{8,20}$/.test(c), costs: perms.includes(Q.COSTS_PERM), payroll: Q.PAYROLL_PERMS.some((p) => perms.includes(p)) };
  });
}));
router.post('/runs/:id/sends', requirePermission('send_reports'), handle((req, res) => { res.status(201); return RB.requestSend(req.companyId, req.params.id, req.user, req.body || {}); }));
router.get('/sends', requirePermission('send_reports'), handle((req) => RB.listSends(req.companyId, { status: req.query.status })));
router.get('/sends/:id/file', requirePermission('send_reports'), handle((req, res) => {
  const f = RB.sendFile(req.companyId, req.params.id, req.user);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename="report"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.end(fs.readFileSync(f.path));
}));
router.post('/sends/:id/approve', requirePermission('send_reports'), handle((req) => RB.approveSend(req.companyId, req.params.id, req.user, req.body || {})));
router.post('/sends/:id/reject', requirePermission('send_reports'), handle((req) => RB.rejectSend(req.companyId, req.params.id, req.user, req.body || {})));

module.exports = router;
module.exports.runSpec = runSpec;
module.exports.ctxOf = ctxOf;
