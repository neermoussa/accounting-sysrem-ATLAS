// backend/test/warehouseGolden.test.js
//
// The existing warehouse flows (factory/car stock screens, counts, custody
// transfers, returns restock, offline count) must behave byte-for-byte as
// recorded BEFORE Prompt 8 changed any warehouse code, on a company that
// has not activated the stock ledger. Golden: test/fixtures/
// warehouseScenario.golden.json (recorded at commit 37e8948 and checked
// identical at d12a7da, i.e. before the one-row-per-product change).
// Re-record only deliberately: WRITE_WAREHOUSE_GOLDEN=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createCompany, createRep } = require('./helpers');
const { runWarehouseScenario } = require('./fixtures/warehouseScenario');
const { count } = require('./salesHelpers');

const GOLDEN = path.join(__dirname, 'fixtures', 'warehouseScenario.golden.json');
let server;
test.before(async () => {
  server = await startServer();
});
test.after(() => server.stop());

test('stock ledger not activated: warehouse screens, counts, custody transfers, returns restock and offline counts are byte-for-byte unchanged', async () => {
  const company = await createCompany(server.baseUrl);
  // A chart of accounts and fiscal year exist, so a wrong hook WOULD post.
  assert.equal((await company.manager.post('/api/ledger/coa-templates/trading/apply', {})).status, 200);
  assert.equal((await company.manager.post('/api/ledger/fiscal-years', { year: new Date().getFullYear() })).status, 201);
  const snapshot = await runWarehouseScenario({ base: server.baseUrl, manager: company.manager, dbPath: server.dbPath, companyId: company.companyId, createRep });
  const text = JSON.stringify(snapshot, null, 2);
  if (process.env.WRITE_WAREHOUSE_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${text}\n`);
  const golden = fs.readFileSync(GOLDEN, 'utf8').trimEnd();
  assert.equal(text, golden);
  assert.equal(count(server.dbPath, 'SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', company.companyId), 0, 'no journal entries');
  const hasMoves = count(server.dbPath, "SELECT COUNT(*) c FROM sqlite_master WHERE name = 'stock_moves'");
  if (hasMoves) assert.equal(count(server.dbPath, 'SELECT COUNT(*) c FROM stock_moves WHERE company_id = ?', company.companyId), 0, 'no stock moves while not activated');
});

test('a count row with an invalid classification is refused (400) instead of hanging the request', async () => {
  const company = await createCompany(server.baseUrl);
  const p = (await company.manager.post('/api/products', { name: 'مادة' })).body.id;
  const row = (await company.manager.post('/api/factory-inventory', { product_id: p, current_quantity: 5 })).body;
  const r = await company.manager.post('/api/factory-inventory/count/confirm', { rows: [{ itemName: 'مادة', matchedItemId: row.id, countedQuantity: 4, classification: 'match' }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_classification');
  assert.equal(count(server.dbPath, 'SELECT current_quantity c FROM factory_inventory WHERE id = ?', row.id), 5, 'nothing applied');
});
