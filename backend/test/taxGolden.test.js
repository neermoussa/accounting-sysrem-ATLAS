// backend/test/taxGolden.test.js
//
// Existing tax behaviour (free per-line rates, output / input tax
// postings, credit notes, supplier expense invoices, trial balance,
// month-end checklist) must stay byte-for-byte as recorded BEFORE Prompt 10
// for a company with no tax codes. Golden: fixtures/taxScenario.golden.json.
// Re-record only deliberately: WRITE_TAX_GOLDEN=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const h = require('./salesHelpers');
const { runTaxScenario } = require('./fixtures/taxScenario');

const GOLDEN = path.join(__dirname, 'fixtures', 'taxScenario.golden.json');
let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('company with no tax codes: sales / purchase tax, credit notes, trial balance and month-end checklist are byte-for-byte unchanged', async () => {
  const co = await h.createUsdCompany(server.baseUrl, 'شركة الضريبة الحالية');
  const snapshot = await runTaxScenario({ manager: co.manager, dbPath: server.dbPath, companyId: co.companyId, h });
  const text = JSON.stringify(snapshot, null, 2);
  if (process.env.WRITE_TAX_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${text}\n`);
  assert.equal(text, fs.readFileSync(GOLDEN, 'utf8').trimEnd());
});
