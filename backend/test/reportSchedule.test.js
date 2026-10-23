// backend/test/reportSchedule.test.js
//
// Prompt 12b — scheduled runs and exports, on the injected clock.
//  - slot maths: daily / weekly / monthly (31 -> last day of the month, 29
//    Feb), the local time at a fixed UTC offset, across 31 Dec -> 1 Jan;
//  - the sweep is idempotent per (schedule, slot): two sweeps at the same
//    instant produce one run; a missed stretch runs ONCE (the latest slot)
//    with the missed count recorded, and next_run_at moves past now;
//  - a period preset is resolved on the slot's local date (a 1 January run
//    of "last month" reports December of the year before);
//  - runs use the schedule owner's CURRENT permissions (lost -> a failed run
//    recorded, no file); a deleted report stops its schedule;
//  - files through the existing export path: xlsx (ExcelJS reads it back),
//    csv (BOM, RFC 4180, formula-injection guard), pdf (%PDF; strict when a
//    Chromium is configured); downloads are permission-checked and audited;
//  - a run left 'running' by a crash is closed as failed by the next sweep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sched-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.ATLAS_REPORT_RUNS_DIR = path.join(scratch, 'runs');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000);

const app = require('../server');
const db = require('../db/init');
const RB = require('../lib/reportBuilder');
const { runSpec } = require('../routes/reportBuilder');
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
const at = (iso) => new Date(iso);
const sweep = (iso) => RB.sweepSchedules({ runSpec, now: at(iso) });
const runsOf = (scheduleId) => db.prepare('SELECT * FROM report_runs WHERE schedule_id = ? ORDER BY id').all(scheduleId);
const sched = (id) => db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id);

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الجدولة');
  ctx = { co, m: co.manager, cid: co.companyId };
  ctx.s = await buildReportsScenario({ manager: co.manager, dbPath: process.env.ATLAS_DB_PATH, companyId: co.companyId, h, createRep, baseUrl: base });
  ctx.scheduler = await createRep(base, co.manager, { name: 'مجدول التقارير', permissions: ['view_app', 'view_financial_reports', 'schedule_reports', 'view_costs'] });
  ctx.reader = await createRep(base, co.manager, { name: 'قارئ', permissions: ['view_app', 'view_financial_reports'] });
  ctx.lastMonth = ok(await ctx.scheduler.client.post('/api/report-builder/saved', { name: 'مبيعات الشهر الماضي', visibility: 'private', spec: { source: 'sales', measures: ['net', 'qty'], dimensions: ['item'], period: { preset: 'last_month' } } }), 201);
  ctx.margin = ok(await ctx.scheduler.client.post('/api/report-builder/saved', { name: 'الهامش السنوي', spec: { source: 'sales', measures: ['net', 'margin'], dimensions: ['region'], period: { from: `${Y}-01-01`, to: `${Y}-12-31` } } }), 201);
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('slot maths: daily, weekly, monthly (31 -> month end, 29 Feb), local time, year boundary', () => {
  const S = (o) => ({ utc_offset_minutes: 180, weekday: null, day_of_month: null, ...o });
  const iso = (ms) => new Date(ms).toISOString();
  const daily = S({ frequency: 'daily', time_of_day: '08:00' });
  assert.equal(iso(RB.nextSlot(daily, Date.parse('2026-12-31T04:59:00Z'))), '2026-12-31T05:00:00.000Z', '08:00 Damascus = 05:00 UTC');
  assert.equal(iso(RB.nextSlot(daily, Date.parse('2026-12-31T05:00:00Z'))), '2027-01-01T05:00:00.000Z', 'strictly after; across the year');
  const late = S({ frequency: 'daily', time_of_day: '01:30' });
  assert.equal(iso(RB.nextSlot(late, Date.parse('2026-12-31T21:00:00Z'))), '2026-12-31T22:30:00.000Z', '01:30 on 1 Jan local is still 31 Dec UTC');
  const weekly = S({ frequency: 'weekly', time_of_day: '09:00', weekday: 0 });
  assert.equal(iso(RB.nextSlot(weekly, Date.parse('2026-12-30T00:00:00Z'))), '2027-01-03T06:00:00.000Z', 'next Sunday');
  const monthly = S({ frequency: 'monthly', time_of_day: '23:30', day_of_month: 31 });
  const seq = [];
  for (let t = Date.parse('2026-11-01T00:00:00Z'), i = 0; i < 5; i++) { t = RB.nextSlot(monthly, t); seq.push(iso(t)); }
  assert.deepEqual(seq, ['2026-11-30T20:30:00.000Z', '2026-12-31T20:30:00.000Z', '2027-01-31T20:30:00.000Z', '2027-02-28T20:30:00.000Z', '2027-03-31T20:30:00.000Z']);
  const leap = S({ frequency: 'monthly', time_of_day: '10:00', day_of_month: 30 });
  assert.equal(iso(RB.nextSlot(leap, Date.parse('2028-02-01T00:00:00Z'))), '2028-02-29T07:00:00.000Z');
  assert.equal(iso(RB.lastSlot(daily, Date.parse('2027-01-01T04:00:00Z'))), '2026-12-31T05:00:00.000Z');
});

test('schedules need schedule_reports; inputs validated; audited', async () => {
  assert.equal((await ctx.reader.client.post(`/api/report-builder/saved/${ctx.lastMonth.id}/schedules`, { frequency: 'daily', time: '08:00' })).status, 403);
  const bad = [[{ frequency: 'hourly', time: '08:00' }, 'invalid_frequency'], [{ frequency: 'daily', time: '8am' }, 'invalid_time'], [{ frequency: 'weekly', time: '08:00', weekday: 7 }, 'invalid_weekday'], [{ frequency: 'monthly', time: '08:00', dayOfMonth: 0 }, 'invalid_day'], [{ frequency: 'daily', time: '08:00', format: 'docx' }, 'invalid_format']];
  for (const [body, code] of bad) assert.equal((await ctx.scheduler.client.post(`/api/report-builder/saved/${ctx.lastMonth.id}/schedules`, body)).body.error, code);
  const s = ok(await ctx.scheduler.client.post(`/api/report-builder/saved/${ctx.lastMonth.id}/schedules`, { frequency: 'daily', time: '08:00', format: 'xlsx' }), 201);
  assert.equal(s.next_run_at, '2026-11-21 05:00:00', 'created on the injected clock (2026-11-20, after 08:00 local)');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'report.schedule.create' AND entity_id = ?").get(s.id).n, 1);
  ctx.daily = s.id;
});

test('idempotent per slot; a missed stretch runs once (the latest slot) and next_run_at moves past now', async () => {
  const a = await sweep('2026-11-21T05:00:30Z');
  const b = await sweep('2026-11-21T05:00:30Z');
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, 'same instant again: nothing');
  await Promise.all([sweep('2026-11-21T06:00:00Z'), sweep('2026-11-21T06:00:00Z')]);
  assert.equal(runsOf(ctx.daily).length, 1, 'concurrent sweeps before the next slot: still one run');
  const r1 = runsOf(ctx.daily)[0];
  assert.deepEqual([r1.status, r1.scheduled_for, r1.missed_slots, r1.period_from, r1.period_to], ['done', '2026-11-21 05:00:00', 0, '2026-10-01', '2026-10-31']);
  assert.equal(sched(ctx.daily).next_run_at, '2026-11-22 05:00:00');
  // The server was down for 10 days: ONE run, for the latest slot.
  const c = await sweep('2026-12-02T09:00:00Z');
  assert.equal(c.length, 1);
  const r2 = runsOf(ctx.daily).at(-1);
  assert.deepEqual([r2.scheduled_for, r2.missed_slots, r2.period_from, r2.period_to], ['2026-12-02 05:00:00', 10, '2026-11-01', '2026-11-30']);
  assert.equal(sched(ctx.daily).next_run_at, '2026-12-03 05:00:00');
  assert.equal(runsOf(ctx.daily).length, 2);
});

test('year boundary: the 1 January run of "last month" reports December of the year before', async () => {
  await sweep('2026-12-31T05:01:00Z');
  await sweep('2027-01-01T05:01:00Z');
  const [dec31, jan1] = runsOf(ctx.daily).slice(-2);
  assert.deepEqual([dec31.scheduled_for, dec31.period_from, dec31.period_to], ['2026-12-31 05:00:00', '2026-11-01', '2026-11-30']);
  assert.deepEqual([jan1.scheduled_for, jan1.period_from, jan1.period_to], ['2027-01-01 05:00:00', '2026-12-01', '2026-12-31']);
  assert.equal(sched(ctx.daily).next_run_at, '2027-01-02 05:00:00');
  // A monthly schedule on the 31st across the year end: Dec 31, Jan 31, Feb 28.
  const m = ok(await ctx.scheduler.client.post(`/api/report-builder/saved/${ctx.lastMonth.id}/schedules`, { frequency: 'monthly', time: '23:30', dayOfMonth: 31, format: 'csv' }), 201);
  assert.equal(m.next_run_at, '2026-11-30 20:30:00');
  for (const t of ['2026-11-30T20:31:00Z', '2026-12-31T20:31:00Z', '2027-01-31T20:31:00Z', '2027-02-28T20:31:00Z']) await sweep(t);
  assert.deepEqual(runsOf(m.id).map((r) => [r.scheduled_for, r.period_from]), [['2026-11-30 20:30:00', '2026-10-01'], ['2026-12-31 20:30:00', '2026-11-01'], ['2027-01-31 20:30:00', '2026-12-01'], ['2027-02-28 20:30:00', '2027-01-01']]);
  ok(await ctx.scheduler.client.del(`/api/report-builder/schedules/${m.id}`));
  await sweep('2027-03-31T20:31:00Z');
  assert.equal(runsOf(m.id).length, 4, 'a stopped schedule does not run');
});

test('runs use the owner\'s CURRENT permissions; a deleted report stops its schedule', async () => {
  const s = ok(await ctx.scheduler.client.post(`/api/report-builder/saved/${ctx.margin.id}/schedules`, { frequency: 'daily', time: '07:00', format: 'csv' }), 201);
  await sweep(new Date(Date.parse(s.next_run_at.replace(' ', 'T') + 'Z') + 1000).toISOString());
  assert.equal(runsOf(s.id).at(-1).status, 'done');
  // view_costs is taken away: the next run fails, recorded, without a file.
  ok(await ctx.m.put(`/api/permissions/users/${ctx.scheduler.userId}/permissions`, { permissions: ['view_app', 'view_financial_reports', 'schedule_reports'] }));
  await sweep(new Date(Date.parse(sched(s.id).next_run_at.replace(' ', 'T') + 'Z') + 1000).toISOString());
  const failed = runsOf(s.id).at(-1);
  assert.deepEqual([failed.status, failed.file_path], ['failed', null]);
  assert.ok(['report_not_visible', 'forbidden_costs'].includes(failed.error_code), failed.error_code);
  ok(await ctx.m.put(`/api/permissions/users/${ctx.scheduler.userId}/permissions`, { permissions: ['view_app', 'view_financial_reports', 'schedule_reports', 'view_costs'] }));
  ok(await ctx.scheduler.client.del(`/api/report-builder/saved/${ctx.margin.id}`));
  assert.equal(sched(s.id).is_active, 0);
});

test('files: xlsx reads back, csv is safe, pdf renders; downloads are permission-checked and audited', async () => {
  const { scheduler, reader } = ctx;
  const rep = ok(await scheduler.client.post('/api/report-builder/saved', { name: 'تصدير', visibility: 'private', spec: { source: 'sales', measures: ['net', 'qty', 'margin'], dimensions: ['region'], period: { from: `${Y}-01-01`, to: `${Y}-12-31` }, calcs: [{ key: 'avg', label: 'متوسط', expr: 'net / qty', format: 'money' }] } }), 201);
  const xr = ok(await scheduler.client.post(`/api/report-builder/saved/${rep.id}/runs`, { format: 'xlsx' }), 201);
  assert.equal(xr.status, 'done');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(db.prepare('SELECT file_path FROM report_runs WHERE id = ?').get(xr.id).file_path);
  const ws = wb.worksheets[0];
  const values = [];
  ws.eachRow((row) => values.push(row.values.slice(1)));
  assert.ok(values.some((r) => r.includes('الإجمالي')), 'totals row');
  assert.ok(values.some((r) => r.includes('دمشق')), 'Arabic labels');
  // CSV through the API, with the bytes checked.
  const cr = ok(await scheduler.client.post(`/api/report-builder/saved/${rep.id}/runs`, { format: 'csv', lang: 'en' }), 201);
  const csv = fs.readFileSync(db.prepare('SELECT file_path FROM report_runs WHERE id = ?').get(cr.id).file_path, 'utf8');
  assert.ok(csv.startsWith('﻿'), 'BOM');
  assert.match(csv.split('\r\n')[0], /^﻿Region,Net sales,Qty,Margin,متوسط$/);
  const csvText = RB.toCsv([{ key: 'a', header: 'أ', role: 'dimension', type: 'text' }, { key: 'b', header: 'ب', role: 'measure', type: 'money' }], [{ a: '=HYPERLINK("x")', b: '-12.50' }, { a: 'عادي, مع "اقتباس"', b: '3.00' }], 'ar');
  assert.equal(csvText, '﻿أ,ب\r\n"\'=HYPERLINK(""x"")",-12.50\r\n"عادي, مع ""اقتباس""",3.00\r\n', 'formula guard on text, numbers untouched, RFC 4180 quoting');
  // PDF (needs a Chromium: strict when one is configured, like the other PDF tests).
  const pr = await scheduler.client.post(`/api/report-builder/saved/${rep.id}/runs`, { format: 'pdf' });
  if (pr.status === 201 || process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    assert.equal(pr.status, 201, JSON.stringify(pr.body));
    const file = await scheduler.client.get(`/api/report-builder/runs/${pr.body.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(fs.readFileSync(db.prepare('SELECT file_path FROM report_runs WHERE id = ?').get(pr.body.id).file_path).subarray(0, 4).toString(), '%PDF');
  } else {
    console.log('# NOTE: PDF export could not render here (no Chromium); set PLAYWRIGHT_CHROMIUM_PATH');
    assert.equal(pr.body.status, 'failed');
  }
  // Download: the owner yes (audited); a reader who cannot see the report no.
  const dl = await scheduler.client.get(`/api/report-builder/runs/${xr.id}/file`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), RB.MIME.xlsx);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'report.run.download' AND entity_id = ?").get(xr.id).n, 1);
  assert.equal((await reader.client.get(`/api/report-builder/runs/${xr.id}/file`)).status, 404);
  // Unsaved spec, exported directly.
  const direct = await scheduler.client.post('/api/report-builder/export', { spec: { source: 'sales', measures: ['net'], dimensions: ['item'], period: { preset: 'this_year' } }, format: 'csv' });
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get('content-type'), RB.MIME.csv);
  assert.equal((await reader.client.post('/api/report-builder/export', { spec: { source: 'sales', measures: ['margin'], period: { preset: 'this_year' } }, format: 'csv' })).status, 403, 'export goes through the same engine checks');
});

test('a run left running by a crash is closed as failed by the next sweep', async () => {
  const id = db.prepare("INSERT INTO report_runs (company_id, report_id, run_kind, run_by, format, created_at, status) VALUES (?, ?, 'manual', ?, 'csv', '2026-11-20 08:00:00', 'running')").run(ctx.cid, ctx.lastMonth.id, ctx.scheduler.userId).lastInsertRowid;
  await sweep('2026-11-20T09:00:00Z');
  const r = db.prepare('SELECT status, error_code FROM report_runs WHERE id = ?').get(id);
  assert.deepEqual([r.status, r.error_code], ['failed', 'interrupted']);
});
