// backend/test/pivotGolden.test.js
//
// Golden recorded BEFORE Prompt 12b touched the /api/reports pivot and
// heatmap routes: the legacy order-based pivot (region / city / branch /
// rep / product / month x totalValue / qty / orderCount) and the geographic
// heatmap must answer exactly as on the baseline commit 505b407
// (test/fixtures/pivotScenario.js, recorded there into
// pivotScenario.golden.json). 12b only adds a facts mode behind
// `source=facts`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createCompany } = require('./helpers');
const { runPivotScenario } = require('./fixtures/pivotScenario');

let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('legacy pivot and heatmap: byte-for-byte as on the baseline commit', async () => {
  const co = await createCompany(server.baseUrl);
  const out = await runPivotScenario(co.manager);
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pivotScenario.golden.json'), 'utf8'));
  assert.equal(JSON.stringify(out, null, 2), JSON.stringify(golden, null, 2));
});
