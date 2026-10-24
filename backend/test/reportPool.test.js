// backend/test/reportPool.test.js
//
// NEXT ACTION item 2: report workers are capped (config, default 2); the
// rest wait in a bounded queue, in order; when the queue is full the API
// answers 503 reports_busy with a Retry-After header. A queued report's
// timeout starts when it starts running; a failed report frees its slot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pool-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000);

const app = require('../server');
const db = require('../db/init');
const runner = require('../lib/analytics/runner');
const h = require('./salesHelpers');

const Y = h.YEAR;
const P = { from: `${Y}-01-01`, to: `${Y}-12-31` };
let listener;
let ctx;

test.before(async () => {
  listener = app.listen(0);
  const co = await h.createUsdCompany(`http://localhost:${listener.address().port}`, 'شركة طابور التقارير');
  await h.setupLedger(co.manager);
  ctx = { cid: co.companyId, m: co.manager };
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const waitIdle = async () => {
  for (let i = 0; i < 200 && (runner.stats().running || runner.stats().queued); i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual([runner.stats().running, runner.stats().queued], [0, 0]);
};

test('defaults: 2 workers; environment overrides; bad values fall back', () => {
  const backend = path.join(__dirname, '..');
  const read = (env) => JSON.parse(execFileSync(process.execPath, ['-e', "const r=require('./lib/analytics/runner');console.log(JSON.stringify(r.DEFAULTS))"], { cwd: backend, env: { ...process.env, ATLAS_DB_PATH: path.join(scratch, 'x.sqlite'), ATLAS_REPORT_WORKERS: '', ATLAS_REPORT_QUEUE: '', ATLAS_REPORT_RETRY_AFTER_S: '', ...env }, encoding: 'utf8' }).trim());
  const d = read({});
  assert.deepEqual([d.maxWorkers, d.maxQueue, d.retryAfterS], [2, 8, 5]);
  const o = read({ ATLAS_REPORT_WORKERS: '3', ATLAS_REPORT_QUEUE: '0', ATLAS_REPORT_RETRY_AFTER_S: '9' });
  assert.deepEqual([o.maxWorkers, o.maxQueue, o.retryAfterS], [3, 0, 9]);
  const bad = read({ ATLAS_REPORT_WORKERS: '0', ATLAS_REPORT_QUEUE: '-1', ATLAS_REPORT_RETRY_AFTER_S: 'x' });
  assert.deepEqual([bad.maxWorkers, bad.maxQueue, bad.retryAfterS], [2, 8, 5]);
});

test('cap: never more than maxWorkers at once; the rest queue in order; a full queue answers 503 + Retry-After', async () => {
  const { cid, m } = ctx;
  runner.configure({ maxWorkers: 2, maxQueue: 2, retryAfterS: 7 });
  const order = [];
  const jobs = [0, 1, 2, 3].map((i) => runner.runReport(cid, 'trial_balance', P, { testDelayMs: 700 }).then((r) => { order.push(i); return r; }));
  assert.deepEqual([runner.stats().running, runner.stats().queued], [2, 2]);
  // Fifth: refused directly ...
  await assert.rejects(runner.runReport(cid, 'trial_balance', P), (e) => e.code === 'reports_busy' && e.status === 503 && e.retryAfter === 7);
  // ... and over HTTP.
  const busy = await m.get(`/api/analytics/run/trial_balance?from=${P.from}&to=${P.to}`);
  assert.equal(busy.status, 503, JSON.stringify(busy.body));
  assert.equal(busy.body.error, 'reports_busy');
  assert.equal(busy.headers.get('retry-after'), '7');
  const results = await Promise.all(jobs);
  for (const r of results) assert.ok(Array.isArray(r.rows));
  assert.equal(runner.stats().peak, 2, 'never more than two workers at once');
  assert.deepEqual(order.slice(2).sort(), [2, 3], 'queued reports run after the first two');
  await waitIdle();
  assert.equal((await m.get(`/api/analytics/run/trial_balance?from=${P.from}&to=${P.to}`)).status, 200, 'free again');
});

test('a queued report\'s timeout counts from when it starts running; a failing report frees its slot', async () => {
  const { cid } = ctx;
  runner.configure({ maxWorkers: 1, maxQueue: 3 });
  const slow = runner.runReport(cid, 'trial_balance', P, { testDelayMs: 2000 });
  const quick = runner.runReport(cid, 'trial_balance', P, { timeoutMs: 1200 });
  const failing = runner.runReport(cid, 'trial_balance', { from: 'nope', to: P.to });
  const after = runner.runReport(cid, 'trial_balance', P);
  assert.ok(Array.isArray((await slow).rows));
  assert.ok(Array.isArray((await quick).rows), 'waited ~2 s in the queue, longer than its own 1.2 s timeout, and still ran');
  await assert.rejects(failing, (e) => e.code === 'invalid_dates');
  assert.ok(Array.isArray((await after).rows), 'the failed report released its worker');
  await waitIdle();
  // A timed-out report also releases its worker.
  await assert.rejects(runner.runReport(cid, 'trial_balance', P, { timeoutMs: 100, testDelayMs: 2000 }), (e) => e.code === 'report_timeout');
  assert.ok(Array.isArray((await runner.runReport(cid, 'trial_balance', P)).rows));
  await waitIdle();
  runner.configure({ maxWorkers: 2, maxQueue: 8, retryAfterS: 5 });
});

test('configure is test-only', () => {
  const backend = path.join(__dirname, '..');
  assert.throws(() => execFileSync(process.execPath, ['-e', "require('./lib/analytics/runner').configure({ maxWorkers: 9 })"], { cwd: backend, env: { ...process.env, NODE_ENV: 'production', ATLAS_DB_PATH: path.join(scratch, 'y.sqlite') }, stdio: 'pipe' }), /test-only/);
});
