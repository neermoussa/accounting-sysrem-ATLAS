// Shared setup for the Prompt 2 (sales / customer sub-ledger) tests.

const assert = require('node:assert/strict');
const { openLiveDb } = require('./liveDb');
const { makeClient } = require('./helpers');

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = Number(TODAY.slice(0, 4));

// helpers.createCompany always uses SYP (0 minor digits); rounding tests
// need cents, so this creates a USD company the same way.
async function createUsdCompany(baseUrl, name = 'شركة دولار') {
  const contact = `usd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const manager = makeClient(baseUrl);
  const res = await manager.post('/api/companies', {
    companyName: name, adminName: 'مدير', adminContact: contact, adminPassword: 'Something1234!', currency: 'USD', acceptedPrivacyPolicy: true,
  });
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
  return { companyId: res.body.user.company_id, manager, managerContact: contact, managerPassword: 'Something1234!' };
}

async function setupLedger(manager, template = 'trading') {
  const applied = await manager.post(`/api/ledger/coa-templates/${template}/apply`, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const fy = await manager.post('/api/ledger/fiscal-years', { year: YEAR });
  assert.equal(fy.status, 201, JSON.stringify(fy.body));
  return { accounts: applied.body.accounts, fy: fy.body };
}

async function mkShop(manager, name) {
  const res = await manager.post('/api/shops', { name, lat: 33.5 + Math.random() / 100, lng: 36.3 + Math.random() / 100 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

async function mkProduct(manager, fields) {
  const res = await manager.post('/api/products', fields);
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
  return res.body.id;
}

function raw(dbPath) {
  return openLiveDb(dbPath);
}

// The legacy way a balance existed before the ledger (an Amin import row).
function seedSnapshot(dbPath, shopId, balance, date = `${YEAR}-01-01`) {
  const d = raw(dbPath);
  d.prepare("INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, ?, ?, 'amin.xlsx')").run(shopId, date, balance);
  d.close();
}

// Independent of lib/customerLedger.js: sums the shop's receivable lines.
function arSumMinor(dbPath, companyId, shopId) {
  const d = raw(dbPath);
  const r = d
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND a.system_key = 'ar_control'
         AND l.party_type = 'customer' AND l.party_id = ?`
    )
    .get(companyId, shopId).s;
  d.close();
  return r;
}

function count(dbPath, sql, ...p) {
  const d = raw(dbPath);
  const r = d.prepare(sql).get(...p);
  d.close();
  return Object.values(r)[0];
}

async function displayedBalance(manager, shopId) {
  const res = await manager.get(`/api/shops/${shopId}`);
  assert.equal(res.status, 200);
  return res.body.balance;
}

module.exports = { TODAY, YEAR, createUsdCompany, setupLedger, mkShop, mkProduct, raw, seedSnapshot, arSumMinor, count, displayedBalance };

// Go-live through the real two-step API: recorded dry run, then execute
// with the confirmation sentence.
async function goLive(manager, date = TODAY) {
  const dry = await manager.post('/api/sales/go-live/dry-run', { date });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const res = await manager.post('/api/sales/go-live', { dryRunId: dry.body.dry_run_id, confirmText: 'Invoices will be created in Atlas from now on' });
  return { dry, res };
}
module.exports.goLive = goLive;
