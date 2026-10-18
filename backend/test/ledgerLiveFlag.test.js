// backend/test/ledgerLiveFlag.test.js
//
// With companies.modules_json.ledger_live OFF, the existing balance flows
// (collections, returns, financial adjustments) must behave byte-for-byte
// as before the ledger existed. The golden snapshot was recorded from the
// baseline commit (cfd63a6) with test/fixtures/legacyScenario.js; this
// replays the same scenario on the current code and compares.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createCompany } = require('./helpers');
const { runLegacyScenario } = require('./fixtures/legacyScenario');
const { count } = require('./salesHelpers');

let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('ledger_live off: legacy collections/returns/balances are byte-for-byte unchanged vs baseline', async () => {
  const company = await createCompany(server.baseUrl);
  // A chart of accounts and fiscal year exist, so a wrong hook WOULD post.
  assert.equal((await company.manager.post('/api/ledger/coa-templates/trading/apply', {})).status, 200);
  assert.equal((await company.manager.post('/api/ledger/fiscal-years', { year: new Date().getFullYear() })).status, 201);
  const snapshot = await runLegacyScenario({ manager: company.manager, dbPath: server.dbPath, companyId: company.companyId });
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacyScenario.golden.json'), 'utf8'));
  assert.equal(JSON.stringify(snapshot, null, 2), JSON.stringify(golden, null, 2));
  assert.equal(count(server.dbPath, 'SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', company.companyId), 0, 'no journal entries while not live');
  assert.equal(count(server.dbPath, 'SELECT COUNT(*) c FROM sales_credit_notes WHERE company_id = ?', company.companyId), 0);
});
