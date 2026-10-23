// backend/test/reportSaved.test.js
//
// Prompt 12b — saved reports: private or shared, permission-gated.
//  - private: only the owner sees it; shared: needs share_reports, and is
//    visible to users holding view_financial_reports AND what the spec needs
//    (view_costs / payroll) — a report with cost data is invisible to a user
//    without view_costs, and disappears when the permission is taken away;
//  - only the owner edits; the owner or a share_reports holder deletes (soft;
//    its schedules stop); names unique per owner;
//  - the stored spec keeps presets (re-resolved on every run) and is
//    validated on save (a spec the user may not run cannot be saved);
//  - every write is audited with before / after; another company sees and
//    touches nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-saved-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000);

const app = require('../server');
const db = require('../db/init');
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
const SALES = { source: 'sales', measures: ['net', 'qty'], dimensions: ['item'], period: { preset: 'last_month' } };
const COSTS = { source: 'sales', measures: ['net', 'margin'], dimensions: ['item'], period: { from: `${Y}-01-01`, to: `${Y}-12-31` } };
const audits = (action, id) => db.prepare('SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id').all(action, id);

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة التقارير المحفوظة');
  ctx = { co, m: co.manager, cid: co.companyId };
  ctx.s = await buildReportsScenario({ manager: co.manager, dbPath: process.env.ATLAS_DB_PATH, companyId: co.companyId, h, createRep, baseUrl: base });
  const mk = (name, perms) => createRep(base, co.manager, { name, permissions: ['view_app', ...perms] });
  ctx.alice = await mk('أليس (مشاركة + تكاليف)', ['view_financial_reports', 'share_reports', 'view_costs']);
  ctx.bob = await mk('بوب (تقارير فقط)', ['view_financial_reports']);
  ctx.carol = await mk('كارول (تقارير + تكاليف)', ['view_financial_reports', 'view_costs']);
  ctx.dave = await mk('ديف (بلا تقارير مالية)', ['view_statistics']);
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const names = async (client) => ok(await client.get('/api/report-builder/saved')).map((r) => r.name).sort();

test('private report: only the owner sees it; presets are stored as presets and resolved per run', async () => {
  const { bob, alice } = ctx;
  const r = ok(await bob.client.post('/api/report-builder/saved', { name: 'مبيعات الشهر الماضي', spec: SALES }), 201);
  assert.equal(r.visibility, 'private');
  assert.deepEqual(r.spec.period, { preset: 'last_month' });
  assert.deepEqual(r.needs, []);
  assert.deepEqual(await names(bob.client), ['مبيعات الشهر الماضي']);
  assert.deepEqual(await names(alice.client), []);
  assert.equal((await alice.client.get(`/api/report-builder/saved/${r.id}`)).status, 404);
  const ran = ok(await bob.client.post(`/api/report-builder/saved/${r.id}/run`, {}));
  assert.deepEqual(ran.period, { from: '2026-10-01', to: '2026-10-31' }, 'last_month on the injected clock (2026-11-20)');
  assert.equal(audits('report.saved.create', r.id).length, 1);
  ctx.bobReport = r.id;
});

test('sharing needs share_reports; shared reports are visible to holders of what they need', async () => {
  const { bob, alice, carol, dave } = ctx;
  assert.equal((await bob.client.post('/api/report-builder/saved', { name: 'مشترك؟', visibility: 'shared', spec: SALES })).body.error, 'forbidden_share');
  const shared = ok(await alice.client.post('/api/report-builder/saved', { name: 'مبيعات مشتركة', visibility: 'shared', spec: SALES }), 201);
  const costly = ok(await alice.client.post('/api/report-builder/saved', { name: 'هامش مشترك', visibility: 'shared', spec: COSTS }), 201);
  assert.deepEqual(costly.needs, ['costs']);
  assert.deepEqual(await names(bob.client), ['مبيعات الشهر الماضي', 'مبيعات مشتركة'], 'bob: own + shared without cost data');
  assert.deepEqual(await names(carol.client), ['مبيعات مشتركة', 'هامش مشترك'], 'carol has view_costs');
  assert.equal((await bob.client.get(`/api/report-builder/saved/${costly.id}`)).status, 404, 'a cost report does not exist for bob');
  assert.equal((await bob.client.post(`/api/report-builder/saved/${costly.id}/run`, {})).status, 404);
  assert.equal((await dave.client.get('/api/report-builder/saved')).status, 403, 'no view_financial_reports');
  ok(await carol.client.post(`/api/report-builder/saved/${costly.id}/run`, {}));
  // Take view_costs away from carol: the report disappears for her.
  ok(await ctx.m.put(`/api/permissions/users/${carol.userId}/permissions`, { permissions: ['view_app', 'view_financial_reports'] }));
  assert.deepEqual(await names(carol.client), ['مبيعات مشتركة']);
  ctx.shared = shared.id;
  ctx.costly = costly.id;
});

test('a spec the user may not run cannot be saved; invalid specs are refused', async () => {
  const { bob } = ctx;
  assert.equal((await bob.client.post('/api/report-builder/saved', { name: 'تكاليف', spec: COSTS })).status, 403);
  assert.equal((await bob.client.post('/api/report-builder/saved', { name: 'رواتب', spec: { source: 'payroll', measures: ['gross'], period: { preset: 'this_year' } } })).body.error, 'forbidden_payroll');
  assert.equal((await bob.client.post('/api/report-builder/saved', { name: 'خطأ', spec: { source: 'sales', measures: ['DROP'] , period: { preset: 'this_year' } } })).body.error, 'invalid_measure');
  assert.equal((await bob.client.post('/api/report-builder/saved', { name: '', spec: SALES })).body.error, 'invalid_name');
  assert.equal((await bob.client.post('/api/report-builder/saved', { name: 'مبيعات الشهر الماضي', spec: SALES })).status, 409, 'name unique per owner');
  ok(await ctx.alice.client.post('/api/report-builder/saved', { name: 'مبيعات الشهر الماضي', spec: SALES }), 201);
});

test('only the owner edits (audited before / after); un-sharing needs share_reports', async () => {
  const { bob, alice } = ctx;
  assert.equal((await bob.client.put(`/api/report-builder/saved/${ctx.shared}`, { name: 'سرقة' })).status, 403);
  const upd = ok(await alice.client.put(`/api/report-builder/saved/${ctx.shared}`, { name: 'مبيعات مشتركة حسب الفرع', spec: { ...SALES, dimensions: ['branch'] } }));
  assert.deepEqual(upd.spec.dimensions, ['branch']);
  const a = audits('report.saved.update', ctx.shared).at(-1);
  assert.deepEqual(JSON.parse(a.before_json).spec.dimensions, ['item']);
  assert.deepEqual(JSON.parse(a.after_json).spec.dimensions, ['branch']);
  assert.equal((await bob.client.put(`/api/report-builder/saved/${ctx.bobReport}`, { visibility: 'shared' })).body.error, 'forbidden_share');
});

test('delete: owner or share_reports holder for shared ones; soft; schedules stop', async () => {
  const { bob, alice, carol } = ctx;
  const sched = ok(await ctx.m.post(`/api/report-builder/saved/${ctx.shared}/schedules`, { frequency: 'daily', time: '08:00' }), 201);
  assert.equal((await bob.client.del(`/api/report-builder/saved/${ctx.shared}`)).status, 403, 'not owner, no share_reports');
  assert.equal((await carol.client.del(`/api/report-builder/saved/${ctx.shared}`)).status, 403);
  const del = ok(await alice.client.del(`/api/report-builder/saved/${ctx.shared}`));
  assert.deepEqual(del.schedules_stopped, [sched.id]);
  assert.equal(db.prepare('SELECT is_active FROM report_schedules WHERE id = ?').get(sched.id).is_active, 0);
  assert.ok(db.prepare('SELECT deleted_at FROM saved_reports WHERE id = ?').get(ctx.shared).deleted_at, 'row kept (soft delete)');
  assert.equal((await alice.client.get(`/api/report-builder/saved/${ctx.shared}`)).status, 404);
  assert.equal(audits('report.saved.delete', ctx.shared).length, 1);
  // The name can be reused after a delete.
  ok(await alice.client.post('/api/report-builder/saved', { name: 'مبيعات مشتركة حسب الفرع', spec: SALES }), 201);
});

test('tenant isolation: another company cannot see, run, edit, delete or schedule these reports', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى للتقارير');
  await h.setupLedger(other.manager);
  for (const [method, url, body] of [
    ['get', `/api/report-builder/saved/${ctx.bobReport}`],
    ['post', `/api/report-builder/saved/${ctx.bobReport}/run`, {}],
    ['put', `/api/report-builder/saved/${ctx.bobReport}`, { name: 'x' }],
    ['del', `/api/report-builder/saved/${ctx.bobReport}`],
    ['post', `/api/report-builder/saved/${ctx.bobReport}/schedules`, { frequency: 'daily', time: '08:00' }],
    ['post', `/api/report-builder/saved/${ctx.bobReport}/runs`, { format: 'csv' }],
  ]) {
    const r = await other.manager[method](url, body);
    assert.equal(r.status, 404, `${method} ${url}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(ok(await other.manager.get('/api/report-builder/saved')), []);
});
