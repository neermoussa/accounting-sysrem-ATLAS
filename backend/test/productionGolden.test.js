// backend/test/productionGolden.test.js
//
// The existing production flows (prep lead-time policies, order approval
// routing to replenish / production requests, request statuses) must
// behave byte-for-byte as recorded BEFORE Prompt 9 changed any code.
// Golden: test/fixtures/productionScenario.golden.json. Re-record only
// deliberately: WRITE_PRODUCTION_GOLDEN=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createCompany, createRep } = require('./helpers');
const { runProductionScenario } = require('./fixtures/productionScenario');
const { count } = require('./salesHelpers');

const GOLDEN = path.join(__dirname, 'fixtures', 'productionScenario.golden.json');
let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('existing production requests, replenish requests and prep policies are byte-for-byte unchanged', async () => {
  const company = await createCompany(server.baseUrl);
  assert.equal((await company.manager.post('/api/ledger/coa-templates/trading/apply', {})).status, 200);
  assert.equal((await company.manager.post('/api/ledger/fiscal-years', { year: new Date().getFullYear() })).status, 201);
  const snapshot = await runProductionScenario({ base: server.baseUrl, manager: company.manager, dbPath: server.dbPath, companyId: company.companyId, createRep });
  const text = JSON.stringify(snapshot, null, 2);
  if (process.env.WRITE_PRODUCTION_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${text}\n`);
  const golden = fs.readFileSync(GOLDEN, 'utf8').trimEnd();
  assert.equal(text, golden);
  assert.equal(count(server.dbPath, 'SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', company.companyId), 0, 'no journal entries');
});
