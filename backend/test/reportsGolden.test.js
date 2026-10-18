// backend/test/reportsGolden.test.js
//
// The EXISTING report endpoints (financial statements, aging, purchases,
// stock, payroll cost) on the reports scenario must stay byte-for-byte as
// recorded BEFORE Prompt 12a added the analytics layer (triggers on the
// source tables, fact tables). Golden: fixtures/reportsScenario.golden.json;
// re-record only deliberately with WRITE_REPORTS_GOLDEN=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createRep } = require('./helpers');
const h = require('./salesHelpers');
const { buildReportsScenario, captureExistingReports } = require('./fixtures/reportsScenario');

const GOLDEN = path.join(__dirname, 'fixtures', 'reportsScenario.golden.json');
let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('existing reports on the reports scenario are byte-for-byte unchanged', async () => {
  const co = await h.createUsdCompany(server.baseUrl, 'شركة التقارير');
  await buildReportsScenario({ manager: co.manager, dbPath: server.dbPath, companyId: co.companyId, h, createRep, baseUrl: server.baseUrl });
  const snap = await captureExistingReports(co.manager);
  for (const [k, v] of Object.entries(snap)) assert.ok(v.status < 400, `${k}: ${v.status} ${JSON.stringify(v.body).slice(0, 200)}`);
  const text = JSON.stringify(snap, null, 2);
  if (process.env.WRITE_REPORTS_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${text}\n`);
  assert.equal(text, fs.readFileSync(GOLDEN, 'utf8').trimEnd());
});
