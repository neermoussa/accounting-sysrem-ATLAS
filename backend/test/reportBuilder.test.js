// backend/test/reportBuilder.test.js
//
// Prompt 12b — the ONE query spec (lib/analytics/query.js) behind the
// Report Builder and the extended pivot / heatmap:
//  - results equal independent SQL over the fact tables, and the 12a ready
//    reports where both exist; totals from an ungrouped query;
//  - period presets on the injected clock, previous-period / previous-year
//    comparison (whole months, day ranges, 29 Feb), calculated ratios;
//  - filters in / not_in with null; every client id through tenantRefs;
//  - permissions INSIDE the engine: view_financial_reports for the builder,
//    payroll permissions for payroll data, view_costs for cost data — in the
//    catalog, the run, the drill and the pivot;
//  - hostile specs refused (whitelist only; values bound, never SQL text);
//  - runs in the report worker (cap / 503 apply).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-builder-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000);

const app = require('../server');
const db = require('../db/init');
const facts = require('../lib/analytics/facts');
const runner = require('../lib/analytics/runner');
const Q = require('../lib/analytics/query');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');
const { buildReportsScenario, Y } = require('./fixtures/reportsScenario');

let listener;
let base;
let ctx;
const ok = (r, status) => {
  if (status ? r.status !== status : r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const YEAR = { from: `${Y}-01-01`, to: `${Y}-12-31` };

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة منشئ التقارير');
  ctx = { co, m: co.manager, cid: co.companyId };
  ctx.s = await buildReportsScenario({ manager: co.manager, dbPath: process.env.ATLAS_DB_PATH, companyId: co.companyId, h, createRep, baseUrl: base });
  ctx.viewer = await createRep(base, co.manager, { name: 'محاسب بلا تكاليف', permissions: ['view_app', 'view_financial_reports'] });
  ctx.coster = await createRep(base, co.manager, { name: 'محاسب التكاليف', permissions: ['view_app', 'view_financial_reports', 'view_costs'] });
  ctx.payroller = await createRep(base, co.manager, { name: 'محاسب الرواتب', permissions: ['view_app', 'view_financial_reports', 'manage_payroll_intake'] });
  ctx.noReports = await createRep(base, co.manager, { name: 'مندوب', permissions: ['view_app', 'view_statistics'] });
  facts.refresh(ctx.cid);
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const run = (spec, client = ctx.m) => client.post('/api/report-builder/run', { spec });
const runOk = async (spec, client) => ok(await run(spec, client));
const sql = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);

test('sales by region x month equals independent SQL over the facts; totals; documents counted once', async () => {
  const { cid } = ctx;
  const r = await runOk({ source: 'sales', measures: ['net', 'qty', 'documents'], dimensions: ['region', 'month'], period: YEAR });
  const expected = sql('SELECT region, ym, SUM(net_base_minor) net, SUM(qty) qty FROM fact_sales_lines WHERE company_id = ? AND doc_date BETWEEN ? AND ? GROUP BY region, ym', cid, YEAR.from, YEAR.to);
  assert.ok(expected.length >= 3, 'precondition: several region x month groups');
  assert.equal(r.rows.length, expected.length);
  for (const e of expected) {
    const row = r.rows.find((x) => x.region__id === e.region && x.month__id === e.ym);
    assert.ok(row, `row ${e.region}/${e.ym}`);
    assert.equal(row.net, e.net);
    assert.equal(row.qty, e.qty);
  }
  assert.equal(r.totals.net, one('SELECT SUM(net_base_minor) s FROM fact_sales_lines WHERE company_id = ?', cid).s);
  assert.equal(r.totals.documents, one("SELECT COUNT(DISTINCT doc_type || ':' || doc_id) n FROM fact_sales_lines WHERE company_id = ?", cid).n);
  assert.deepEqual(r.columns.map((c) => [c.key, c.role]), [['region', 'dimension'], ['month', 'dimension'], ['net', 'measure'], ['qty', 'measure'], ['documents', 'measure']]);
  assert.equal(r.freshness.up_to_date, true);
  // Same numbers as the 12a ready report "sales by region".
  const ready = ok(await ctx.m.get(`/api/analytics/run/sales_by?by=region&from=${YEAR.from}&to=${YEAR.to}`));
  const byRegion = await runOk({ source: 'sales', measures: ['net'], dimensions: ['region'], period: YEAR });
  assert.deepEqual(Object.fromEntries(byRegion.rows.map((x) => [x.region, x.net])), Object.fromEntries(ready.rows.map((x) => [x.label, x.net])));
});

test('drill: the fact rows behind a row add up to it; cost columns only with view_costs', async () => {
  const r = await runOk({ source: 'sales', measures: ['net'], dimensions: ['item'], period: YEAR });
  for (const row of r.rows) {
    const q = `source=sales&filters=${encodeURIComponent(JSON.stringify(row.drill.filters))}`;
    const full = ok(await ctx.m.get(`/api/report-builder/drill?${q}`));
    assert.equal(full.rows.reduce((s, x) => s + x.net_base_minor, 0), row.net, `drill ${row.item}`);
    assert.ok('cost_base_minor' in full.rows[0], 'owner sees cost');
    const viewer = ok(await ctx.viewer.client.get(`/api/report-builder/drill?${q}`));
    assert.equal(viewer.rows.length, full.rows.length);
    assert.ok(!('cost_base_minor' in viewer.rows[0]), 'cost column removed without view_costs');
  }
  assert.equal((await ctx.viewer.client.get(`/api/report-builder/drill?source=sales&filters=${encodeURIComponent('{"cost_base_minor":1}')}`)).status, 400, 'a non-dimension column is not a drill filter');
});

test('calculated ratios: safe expressions over the selected measures; division by zero is null', async () => {
  const r = await runOk({ source: 'sales', measures: ['net', 'qty', 'cost'], dimensions: ['item'], period: YEAR, calcs: [{ key: 'avg_price', label: 'متوسط السعر', expr: 'net / qty', format: 'money' }, { key: 'margin_pct', label: 'هامش %', expr: '(net - cost) / net * 100', format: 'percent' }, { key: 'zero', expr: 'net / (qty - qty)' }] });
  for (const row of r.rows) {
    assert.equal(row.avg_price, Math.round(row.net / row.qty));
    assert.equal(row.margin_pct, Math.round(((row.net - row.cost) / row.net) * 100 * 10000) / 10000);
    assert.equal(row.zero, null);
  }
  assert.equal(r.totals.avg_price, Math.round(r.totals.net / r.totals.qty), 'calcs on totals use the total measures');
  const bad = await run({ source: 'sales', measures: ['net'], period: YEAR, calcs: [{ key: 'x', expr: 'net / cost' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'expr_unknown_name', 'a calc reads only measures selected in the spec');
  assert.equal((await run({ source: 'sales', measures: ['net'], period: YEAR, calcs: [{ key: 'x', expr: 'require("fs")' }] })).body.error, 'expr_bad_char');
});

test('period presets follow the injected clock (2026-11-20); comparison periods', async () => {
  const p = (period) => Q.resolvePeriod(period, '2026-11-20');
  assert.deepEqual(p({ preset: 'last_month' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(p({ preset: 'this_month' }), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(p({ preset: 'mtd' }), { from: '2026-11-01', to: '2026-11-20' });
  assert.deepEqual(p({ preset: 'ytd' }), { from: '2026-01-01', to: '2026-11-20' });
  assert.deepEqual(p({ preset: 'this_quarter' }), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(p({ preset: 'last_quarter' }), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(p({ preset: 'last_year' }), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(p({ preset: 'last_n_days', n: 7 }), { from: '2026-11-14', to: '2026-11-20' });
  assert.deepEqual(Q.resolvePeriod({ preset: 'last_month' }, '2027-01-05'), { from: '2026-12-01', to: '2026-12-31' }, 'across the year boundary');
  assert.deepEqual(Q.resolvePeriod({ preset: 'last_quarter' }, '2027-02-10'), { from: '2026-10-01', to: '2026-12-31' });
  for (const bad of [{ preset: 'forever' }, { preset: 'last_n_days', n: 0 }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-03-01', to: '2026-02-01' }, null]) {
    assert.throws(() => p(bad), (e) => e.code === 'invalid_period', JSON.stringify(bad));
  }
  const c = Q.comparePeriod;
  assert.deepEqual(c({ from: '2026-03-01', to: '2026-03-31' }, 'previous_period'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(c({ from: '2026-01-01', to: '2026-03-31' }, 'previous_period'), { from: '2025-10-01', to: '2025-12-31' }, 'a quarter -> the quarter before');
  assert.deepEqual(c({ from: '2026-03-10', to: '2026-03-16' }, 'previous_period'), { from: '2026-03-03', to: '2026-03-09' }, 'days -> the same number of days before');
  assert.deepEqual(c({ from: '2028-02-01', to: '2028-02-29' }, 'previous_year'), { from: '2027-02-01', to: '2027-02-28' }, '29 Feb -> 28 Feb');
  assert.deepEqual(c({ from: '2026-12-01', to: '2026-12-31' }, 'previous_year'), { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(c({ from: '2026-01-01', to: '2026-01-31' }, null), null);
});

test('compare: March vs February per item (previous period) and year over year', async () => {
  const { cid } = ctx;
  const r = await runOk({ source: 'sales', measures: ['net'], dimensions: ['item'], period: { from: `${Y}-03-01`, to: `${Y}-03-31` }, compare: 'previous_period', calcs: [{ key: 'half', expr: 'net / 2' }] });
  assert.deepEqual(r.compare_period, { from: `${Y}-02-01`, to: `${Y}-02-28` });
  const month = (ym, pid) => one('SELECT COALESCE(SUM(net_base_minor), 0) s FROM fact_sales_lines WHERE company_id = ? AND ym = ? AND product_id IS ?', cid, ym, pid).s;
  const items = sql("SELECT DISTINCT product_id p FROM fact_sales_lines WHERE company_id = ? AND ym IN (?, ?)", cid, `${Y}-02`, `${Y}-03`).map((x) => x.p);
  assert.equal(r.rows.length, items.length, 'items sold in either month appear');
  for (const pid of items) {
    const row = r.rows.find((x) => x.item__id === pid);
    const [cur, prev] = [month(`${Y}-03`, pid), month(`${Y}-02`, pid)];
    assert.deepEqual([row.net, row.net__cmp, row.net__chg], [cur, prev, cur - prev]);
    assert.equal(row.net__pct, prev ? Math.round(((cur - prev) / Math.abs(prev)) * 100 * 10000) / 10000 : null);
    assert.equal(row.half__cmp, prev / 2);
  }
  assert.ok(r.columns.some((x) => x.key === 'net__pct' && x.role === 'change_pct'));
  const yoy = await runOk({ source: 'sales', measures: ['net'], period: YEAR, compare: 'previous_year' });
  assert.deepEqual([yoy.rows[0].net__cmp, yoy.rows[0].net__pct], [0, null], 'no sales the year before: change % is null, not Infinity');
});

test('filters: in / not_in, with null; text values are bound, never SQL', async () => {
  const { cid } = ctx;
  const all = await runOk({ source: 'sales', measures: ['net'], dimensions: ['region'], period: YEAR });
  const dam = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'region', op: 'in', values: ['دمشق'] }] });
  const notDam = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'region', op: 'not_in', values: ['دمشق'] }] });
  assert.equal(dam.totals.net + notDam.totals.net, all.totals.net, 'in + not_in = all (NULL rows kept by not_in)');
  // rep: one customer has a rep, the other none (NULL) — not_in keeps NULL rows.
  const repId = ctx.s.rep.userId;
  const nullRep = one('SELECT SUM(net_base_minor) s FROM fact_sales_lines WHERE company_id = ? AND rep_id IS NULL', cid).s;
  assert.ok(nullRep > 0, 'precondition: sales without a rep');
  const notRep = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'rep', op: 'not_in', values: [repId] }] });
  assert.equal(notRep.totals.net, nullRep + one('SELECT COALESCE(SUM(net_base_minor), 0) s FROM fact_sales_lines WHERE company_id = ? AND rep_id <> ?', cid, repId).s);
  const nullBranch = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'branch', values: [null] }] });
  assert.equal(nullBranch.totals.net, one('SELECT SUM(net_base_minor) s FROM fact_sales_lines WHERE company_id = ? AND branch_id IS NULL', cid).s);
  const notNull = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'branch', op: 'not_in', values: [null] }] });
  assert.equal(notNull.totals.net, 0);
  const inj = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'region', values: ["x' OR 1=1 --", 'دمشق"; DROP TABLE shops; --'] }] });
  assert.equal(inj.totals.net, 0, 'quotes in a value are data');
  assert.ok(one('SELECT COUNT(*) n FROM shops WHERE company_id = ?', cid).n > 0);
  const item = await runOk({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim: 'item', values: [ctx.s.nuts] }] });
  assert.equal(item.totals.net, one('SELECT SUM(net_base_minor) s FROM fact_sales_lines WHERE company_id = ? AND product_id = ?', cid, ctx.s.nuts).s);
});

test('tenant isolation: another company\'s ids are refused; its rows never appear', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى للمنشئ');
  await h.setupLedger(other.manager);
  const foreignProduct = await h.mkProduct(other.manager, { name: 'مادة غريبة' });
  const foreignShop = await h.mkShop(other.manager, 'زبون غريب');
  for (const [dim, id] of [['item', foreignProduct], ['customer', foreignShop]]) {
    const r = await run({ source: 'sales', measures: ['net'], period: YEAR, filters: [{ dim, values: [id] }] });
    assert.equal(r.status, 400, `${dim}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await ctx.m.get(`/api/report-builder/drill?source=sales&filters=${encodeURIComponent(JSON.stringify({ product_id: foreignProduct }))}`)).status, 400);
  const empty = await runOk({ source: 'sales', measures: ['net'], period: YEAR }, other.manager);
  assert.equal(empty.totals.net, 0, 'the other company sees none of these rows');
});

test('permissions inside the engine: reports, costs, payroll — catalog, run, drill, dimension values, pivot', async () => {
  const { viewer, coster, payroller, noReports } = ctx;
  assert.equal((await noReports.client.post('/api/report-builder/run', { spec: { source: 'sales', measures: ['net'], period: YEAR } })).status, 403);
  // Engine-level, not only the route: a permission list without the report permission is refused.
  assert.throws(() => Q.validate({ source: 'sales', measures: ['net'], period: YEAR }, { companyId: ctx.cid, permissions: ['view_statistics'], now: '2026-11-20' }), (e) => e.code === 'forbidden_reports' && e.status === 403);
  const cat = (c) => ok(c).sources;
  const vCat = cat(await viewer.client.get('/api/report-builder/catalog'));
  assert.deepEqual(vCat.map((s) => s.key).sort(), ['expenses', 'inventory', 'journal', 'production', 'receivables', 'sales']);
  assert.ok(!vCat.find((s) => s.key === 'sales').measures.some((x) => ['cost', 'margin'].includes(x.key)), 'no cost measures in the catalog');
  assert.ok(!vCat.find((s) => s.key === 'expenses').dimensions.some((x) => x.key === 'employee'), 'no employee dimension without payroll');
  const refused = {
    cost: { source: 'sales', measures: ['net', 'cost'], period: YEAR },
    margin: { source: 'sales', measures: ['margin'], period: YEAR },
    purchases: { source: 'purchases', measures: ['net'], period: YEAR },
    payables: { source: 'payables', measures: ['net'], period: YEAR },
    stock_value: { source: 'inventory', measures: ['value'], period: YEAR },
    production_cost: { source: 'production', measures: ['fg_value'], period: YEAR },
  };
  for (const [name, spec] of Object.entries(refused)) {
    const r = await run(spec, viewer.client);
    assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'forbidden_costs');
    assert.equal((await run(spec, coster.client)).status, 200, `${name} with view_costs`);
  }
  assert.equal((await run({ source: 'inventory', measures: ['qty'], period: YEAR }, viewer.client)).status, 200, 'quantities are not cost data');
  for (const [spec, who] of [[{ source: 'payroll', measures: ['gross'], period: YEAR }, 'payroll source'], [{ source: 'expenses', measures: ['amount'], dimensions: ['employee'], period: YEAR }, 'employee dimension'], [{ source: 'expenses', measures: ['amount'], period: YEAR, filters: [{ dim: 'employee', values: [null] }] }, 'employee filter']]) {
    const r = await run(spec, coster.client);
    assert.equal(r.status, 403, who);
    assert.equal(r.body.error, 'forbidden_payroll', who);
    assert.equal((await run(spec, payroller.client)).status, 200, `${who} with payroll permission`);
  }
  const pay = await runOk({ source: 'payroll', measures: ['gross'], period: YEAR }, payroller.client);
  assert.equal(pay.totals.gross, one('SELECT SUM(gross_base_minor) s FROM fact_payroll WHERE company_id = ?', ctx.cid).s);
  assert.equal((await viewer.client.get('/api/report-builder/dimension-values?source=purchases&dim=supplier')).status, 403);
  assert.equal((await viewer.client.get(`/api/report-builder/drill?source=payroll&filters=${encodeURIComponent('{}')}`)).status, 403);
  // The pivot (facts mode) goes through the same engine.
  const pivotSpec = encodeURIComponent(JSON.stringify({ source: 'sales', measures: ['margin'], dimensions: ['region', 'month'], period: YEAR }));
  const statsAndReports = await createRep(base, ctx.m, { name: 'إحصائيات ومالية', permissions: ['view_app', 'view_statistics', 'view_financial_reports'] });
  assert.equal((await statsAndReports.client.get(`/api/reports/pivot/table?source=facts&spec=${pivotSpec}`)).status, 403);
  assert.equal((await noReports.client.get(`/api/reports/pivot/table?source=facts&spec=${encodeURIComponent(JSON.stringify({ source: 'sales', measures: ['net'], dimensions: ['region', 'month'], period: YEAR }))}`)).status, 403, 'view_statistics alone is not enough for fact data');
});

test('pivot and heatmap facts mode: same totals as the builder; legacy mode untouched', async () => {
  const spec = { source: 'sales', measures: ['net'], dimensions: ['region', 'month'], period: YEAR };
  const q = encodeURIComponent(JSON.stringify(spec));
  const pv = ok(await ctx.m.get(`/api/reports/pivot/table?source=facts&spec=${q}`));
  const b = await runOk(spec);
  assert.equal(pv.rows.reduce((s, r) => s + r.total, 0), b.totals.net);
  assert.deepEqual(pv.columns.sort(), [...new Set(b.rows.map((r) => r.month))].sort());
  const hm = ok(await ctx.m.get(`/api/reports/heatmap/data?source=facts&spec=${q}`));
  assert.equal(hm.cells.reduce((s, c) => s + c.value, 0), b.totals.net);
  assert.ok(hm.cells.every((c) => c.intensity >= 0 && c.intensity <= 1));
  assert.equal(Math.max(...hm.cells.map((c) => c.intensity)), 1);
  assert.equal((await ctx.m.get(`/api/reports/pivot/table?source=facts&spec=${encodeURIComponent(JSON.stringify({ ...spec, dimensions: ['region'] }))}`)).status, 400, 'pivot needs two dimensions');
  assert.equal((await ctx.m.get('/api/reports/pivot/table?source=facts&spec=nope')).status, 400);
});

test('hostile or malformed specs are refused by the whitelist', async () => {
  const bad = [
    [{ source: 'sales; DROP TABLE shops', measures: ['net'], period: YEAR }, 'invalid_source'],
    [{ source: '__proto__', measures: ['net'], period: YEAR }, 'invalid_source'],
    [{ source: 'constructor', measures: ['net'], period: YEAR }, 'invalid_source'],
    [{ source: 'sales', measures: ['SUM(net_base_minor)'], period: YEAR }, 'invalid_measure'],
    [{ source: 'sales', measures: ['toString'], period: YEAR }, 'invalid_measure'],
    [{ source: 'sales', measures: [], period: YEAR }, 'invalid_measures'],
    [{ source: 'sales', measures: ['net', 'net'], period: YEAR }, 'invalid_measures'],
    [{ source: 'sales', measures: ['net'], dimensions: ['product_id'], period: YEAR }, 'invalid_dimension'],
    [{ source: 'sales', measures: ['net'], dimensions: ['item', 'branch', 'month', 'rep'], period: YEAR }, 'invalid_dimensions'],
    [{ source: 'sales', measures: ['net'], filters: [{ dim: 'company_id', values: [1] }], period: YEAR }, 'invalid_filters'],
    [{ source: 'sales', measures: ['net'], filters: [{ dim: 'item', values: ['1 OR 1=1'] }], period: YEAR }, 'invalid_filters'],
    [{ source: 'sales', measures: ['net'], filters: [{ dim: 'item', op: 'like', values: [1] }], period: YEAR }, 'invalid_filters'],
    [{ source: 'sales', measures: ['net'], sort: { by: 'net_base_minor DESC; --' }, period: YEAR }, 'invalid_sort'],
    [{ source: 'sales', measures: ['net'], limit: 999999, period: YEAR }, 'invalid_limit'],
    [{ source: 'sales', measures: ['net'], period: YEAR, compare: 'last_century' }, 'invalid_compare'],
    [{ source: 'sales', measures: ['net'], period: YEAR, includeClosing: true }, 'invalid_spec'],
    [{ source: 'sales', measures: ['net'], period: YEAR, sql: 'SELECT 1' }, 'invalid_spec'],
    [{ source: 'sales', measures: ['net'] }, 'invalid_period'],
    ['not json', 'invalid_spec'],
    [[1, 2], 'invalid_spec'],
  ];
  for (const [spec, code] of bad) {
    const r = await run(spec);
    assert.equal(r.status, 400, `${JSON.stringify(spec)}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, code, JSON.stringify(spec));
  }
});

test('runs in the report worker: the worker cap and 503 apply to the builder', async () => {
  runner.configure({ maxWorkers: 1, maxQueue: 0, retryAfterS: 4 });
  const slow = runner.runReport(ctx.cid, 'trial_balance', YEAR, { testDelayMs: 800 });
  const busy = await run({ source: 'sales', measures: ['net'], period: YEAR });
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error, 'reports_busy');
  assert.equal(busy.headers.get('retry-after'), '4');
  await slow;
  runner.configure({ maxWorkers: 2, maxQueue: 8, retryAfterS: 5 });
  assert.equal((await run({ source: 'journal', measures: ['debit', 'credit'], dimensions: ['account'], period: YEAR })).status, 200);
});

test('journal source: debits = credits; closing entries excluded unless asked', async () => {
  const j = await runOk({ source: 'journal', measures: ['debit', 'credit', 'net_debit'], dimensions: ['account'], period: YEAR });
  assert.equal(j.totals.debit, j.totals.credit);
  assert.equal(j.totals.net_debit, 0);
  const tb = ok(await ctx.m.get(`/api/analytics/run/trial_balance?from=${YEAR.from}&to=${YEAR.to}`));
  assert.equal(j.totals.debit, tb.totals.period_debit, 'period debits = ready trial balance');
  assert.equal((await run({ source: 'journal', measures: ['debit'], period: YEAR, includeClosing: true })).status, 200);
});
