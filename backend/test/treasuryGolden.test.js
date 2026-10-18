// backend/test/treasuryGolden.test.js
//
// Treasury vouchers of a company that does not use payroll must stay
// byte-for-byte as recorded BEFORE Prompt 11-lite. Golden:
// fixtures/treasuryScenario.golden.json; re-record only deliberately with
// WRITE_TREASURY_GOLDEN=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createRep } = require('./helpers');
const h = require('./salesHelpers');
const { runTreasuryScenario } = require('./fixtures/treasuryScenario');

const GOLDEN = path.join(__dirname, 'fixtures', 'treasuryScenario.golden.json');
let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('company without payroll: treasury vouchers (all types, FX box, salaries-payable payment, reversal, SoD) are byte-for-byte unchanged', async () => {
  const co = await h.createUsdCompany(server.baseUrl, 'خزينة بلا رواتب');
  const approver = await createRep(server.baseUrl, co.manager, { name: 'معتمد', permissions: ['view_app', 'view_treasury', 'approve_vouchers'] });
  const D = new Date().toISOString().slice(0, 10);
  const snapshot = await runTreasuryScenario({ manager: co.manager, approver, dbPath: server.dbPath, companyId: co.companyId, h, D });
  const text = JSON.stringify(snapshot, null, 2);
  if (process.env.WRITE_TREASURY_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${text}\n`);
  assert.equal(text, fs.readFileSync(GOLDEN, 'utf8').trimEnd());
});
