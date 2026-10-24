const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { parseReportFilters } = require('../lib/reportFilters');
const {
  getFilteredSalesReport,
  getReturnsAndDamagedReport,
  getDiscrepanciesReport,
  getRepPerformanceReport,
  getTargetsCommissionsReport,
  getVisitsReport,
  getRouteAdherenceReport,
  getCustomerLifecycleReport,
  getAvgOrderFrequencyReport,
  getProfitReport,
  getInventoryMovementReport,
  getWarehouseVehicleMovementReport,
  getHeatmapData,
  getBranchComparisonReport,
  getPivotReport,
} = require('../lib/reportsExtra');
const { summarizeReport, decideRecommendation } = require('../lib/aiRecommendations');

const router = express.Router();
router.use(requireCompany);
router.use(requirePermission('view_statistics'));

// Every one of these accepts the same combined filter set — spec item 5:
// period (from/to), city, region, rep, customer (shopId), product,
// warehouse, vehicle, branch — see lib/reportFilters.js.
function filters(req) {
  return parseReportFilters(req.query);
}

const REPORTS = {
  sales: (req) => getFilteredSalesReport(req.companyId, filters(req)),
  'returns-damaged': (req) => getReturnsAndDamagedReport(req.companyId, filters(req)),
  discrepancies: (req) => getDiscrepanciesReport(req.companyId, filters(req)),
  'rep-performance': (req) => getRepPerformanceReport(req.companyId, filters(req)),
  'targets-commissions': (req) => getTargetsCommissionsReport(req.companyId, { period: req.query.period || 'monthly' }),
  visits: (req) => getVisitsReport(req.companyId, filters(req)),
  'route-adherence': (req) => getRouteAdherenceReport(req.companyId, filters(req)),
  'customer-lifecycle': (req) => getCustomerLifecycleReport(req.companyId, filters(req)),
  'order-frequency': (req) => getAvgOrderFrequencyReport(req.companyId, filters(req)),
  profit: (req) => getProfitReport(req.companyId, filters(req)),
  'inventory-movement': (req) => getInventoryMovementReport(req.companyId, { lookbackDays: req.query.lookbackDays ? Number(req.query.lookbackDays) : undefined }),
  'warehouse-vehicle-movement': (req) => getWarehouseVehicleMovementReport(req.companyId, filters(req)),
  'branch-comparison': (req) => getBranchComparisonReport(req.companyId, filters(req)),
};

router.get('/:reportKey', (req, res) => {
  const build = REPORTS[req.params.reportKey];
  if (!build) return res.status(404).json({ error: 'unknown_report' });
  try {
    res.json(build(req));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

// Prompt 12b: `source=facts` runs a Report Builder spec (two dimensions,
// one measure) through the query engine (lib/analytics/query.js: catalog
// whitelist, company scoping, view_financial_reports / costs / payroll
// checks, report worker). Without it the order-based pivot and heatmap
// below answer exactly as before (test/pivotGolden.test.js).
async function factsMatrix(req) {
  let spec;
  try { spec = JSON.parse(req.query.spec || 'null'); } catch { throw Object.assign(new Error('invalid_spec'), { status: 400, code: 'invalid_spec' }); }
  if (!spec || !Array.isArray(spec.dimensions) || spec.dimensions.length !== 2 || !Array.isArray(spec.measures) || spec.measures.length !== 1 || (spec.calcs && spec.calcs.length)) {
    throw Object.assign(new Error('pivot_needs_two_dimensions_one_measure'), { status: 400, code: 'invalid_spec' });
  }
  const { runSpec } = require('./reportBuilder');
  const out = await runSpec(req.companyId, req.user.permissions, { ...spec, compare: null }, require('../lib/clock').today());
  const [rd, cd] = out.spec.dimensions;
  const m = out.spec.measures[0];
  return { out, rd, cd, m };
}
function factsError(res, err) {
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
  res.status(err.status || 500).json({ error: err.code || err.message || 'server_error', message: err.message });
}

router.get('/heatmap/data', async (req, res) => {
  if (req.query.source === 'facts') {
    try {
      const { out, rd, cd, m } = await factsMatrix(req);
      const max = out.rows.reduce((x, r) => Math.max(x, Math.abs(r[m] || 0)), 0);
      return res.json({
        source: 'facts', measure: m, rows: [...new Set(out.rows.map((r) => r[rd]))], columns: [...new Set(out.rows.map((r) => r[cd]))], max,
        cells: out.rows.map((r) => ({ row: r[rd], col: r[cd], value: r[m], intensity: max ? Math.round((Math.abs(r[m] || 0) / max) * 1000) / 1000 : 0, drill: r.drill })),
        period: out.period, freshness: out.freshness,
      });
    } catch (err) { return factsError(res, err); }
  }
  const metric = req.query.metric === 'customers' ? 'customers' : 'sales';
  res.json(getHeatmapData(req.companyId, { metric, filters: filters(req) }));
});

router.get('/pivot/table', async (req, res) => {
  if (req.query.source === 'facts') {
    try {
      const { out, rd, cd, m } = await factsMatrix(req);
      const table = new Map();
      for (const r of out.rows) {
        if (!table.has(r[rd])) table.set(r[rd], {});
        table.get(r[rd])[r[cd]] = (table.get(r[rd])[r[cd]] || 0) + (r[m] || 0);
      }
      return res.json({
        source: 'facts', measure: m, columns: [...new Set(out.rows.map((r) => r[cd]))],
        rows: [...table.entries()].map(([dimension, values]) => ({ dimension, values, total: Object.values(values).reduce((s, v) => s + v, 0) })),
        totals: out.totals, period: out.period, freshness: out.freshness,
      });
    } catch (err) { return factsError(res, err); }
  }
  const { rowDim, colDim, measure } = req.query;
  try {
    res.json(getPivotReport(req.companyId, { rowDim, colDim, measure, filters: filters(req) }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

// ---------------------------------------------------------------------
// AI report summary — reuses the exact advisory layer from the AI
// prompt (lib/aiRecommendations.js): same shape (reason/data/confidence,
// human decision), never a separate mechanism.
// ---------------------------------------------------------------------

router.post('/:reportKey/ai-summary', async (req, res) => {
  const build = REPORTS[req.params.reportKey];
  if (!build) return res.status(404).json({ error: 'unknown_report' });
  try {
    const reportData = build(req);
    const rec = await summarizeReport(req.companyId, req.params.reportKey, reportData, req.user);
    res.status(201).json({ ...rec, data: JSON.parse(rec.data_json), reportData });
  } catch (err) {
    console.error('[reports] AI summary failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/ai-summary/:id/decide', (req, res) => {
  const { status, reason } = req.body || {};
  try {
    const row = decideRecommendation(req.companyId, req.params.id, { status, reason, user: req.user });
    res.json(row);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error', currentStatus: err.currentStatus });
  }
});

// ---------------------------------------------------------------------
// Saved filter presets
// ---------------------------------------------------------------------

router.get('/saved-filters/:reportKey', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM saved_report_filters WHERE company_id = ? AND user_id = ? AND report_key = ? ORDER BY name COLLATE NOCASE')
      .all(req.companyId, req.user.id, req.params.reportKey)
      .map((r) => ({ ...r, filters: JSON.parse(r.filters_json) }))
  );
});

router.post('/saved-filters/:reportKey', (req, res) => {
  const { name, filters: filterValues } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
  try {
    const info = db
      .prepare('INSERT INTO saved_report_filters (company_id, user_id, report_key, name, filters_json) VALUES (?, ?, ?, ?, ?)')
      .run(req.companyId, req.user.id, req.params.reportKey, name.trim(), JSON.stringify(filterValues || {}));
    res.status(201).json(db.prepare('SELECT * FROM saved_report_filters WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'name_already_used' });
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/saved-filters/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_report_filters WHERE id = ? AND company_id = ? AND user_id = ?').get(req.params.id, req.companyId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM saved_report_filters WHERE id = ?').run(row.id);
  res.status(204).end();
});

module.exports = router;
