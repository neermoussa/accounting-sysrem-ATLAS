// backend/test/clock.test.js
//
// The test-only clock override (lib/clock.js): ATLAS_TEST_NOW shifts
// JavaScript's Date and SQLite's 'now' (incl. column defaults) together,
// and is ignored outside NODE_ENV=test. `npm test` pins every file to the
// same instant, so no test depends on the real date (verified by running
// the whole suite under libfaketime in January and September).

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const probe = `
  const c = require('./lib/clock');
  const { DatabaseSync } = require('node:sqlite');
  const d = c.attachSqlite(new DatabaseSync(':memory:'));
  d.exec("CREATE TABLE t (a TEXT DEFAULT (datetime('now')), b INT)");
  d.prepare('INSERT INTO t (b) VALUES (1)').run();
  const r = d.prepare("SELECT date('now') today, date('now', '-1 day') y, strftime('%Y', 'now') yr, a FROM t").get();
  console.log(JSON.stringify({ js: new Date().toISOString().slice(0, 10), now: Date.now() > 0, ...r }));
`;
const run = (env) => JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

test('ATLAS_TEST_NOW shifts JS Date and SQLite now (incl. defaults) together under NODE_ENV=test', () => {
  const r = run({ NODE_ENV: 'test', ATLAS_TEST_NOW: '2031-03-01' });
  assert.equal(r.js, '2031-03-01');
  assert.equal(r.today, '2031-03-01');
  assert.equal(r.y, '2031-02-28');
  assert.equal(r.yr, '2031');
  assert.equal(r.a.slice(0, 10), '2031-03-01');
});

test('ATLAS_TEST_NOW is ignored outside NODE_ENV=test (production uses the real clock)', () => {
  const r = run({ NODE_ENV: 'production', ATLAS_TEST_NOW: '2031-03-01' });
  assert.notEqual(r.js, '2031-03-01');
  assert.equal(r.js, r.today, 'JS and SQLite agree on the real date');
});

test('npm test runs pinned: this process sees the pinned date', () => {
  if (!process.env.ATLAS_TEST_NOW) return; // run directly without the pin: nothing to check
  assert.equal(new Date().toISOString().slice(0, 10), process.env.ATLAS_TEST_NOW.slice(0, 10));
});
