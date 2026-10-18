// backend/test/lockedPeriods.test.js
//
// After Prompt 10, item 4: automatic postings that target a locked (or
// closed) period refuse with a message naming the item and the period, and
// post NOTHING from that run — depreciation (a run and its catch-up),
// disposals, recurring templates and accrual reversals; the background
// sweeps report the refusal per company and post nothing either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lock-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const FA = require('../lib/fixedAssets');
const RE = require('../lib/recurringEntries');
const h = require('./salesHelpers');

const Y = '2026';
let listener;
let base;
let c;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const api = (method, url, body) => c.m[method](`/api/accounting${url}`, body);
const snapshot = () => [
  db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE company_id = ?').get(c.companyId).n,
  db.prepare('SELECT COUNT(*) n FROM fa_depreciation WHERE company_id = ?').get(c.companyId).n,
  db.prepare('SELECT COUNT(*) n FROM recurring_runs WHERE company_id = ?').get(c.companyId).n,
  db.prepare('SELECT COUNT(*) n FROM recurring_runs WHERE company_id = ? AND reversal_entry_id IS NOT NULL').get(c.companyId).n,
  db.prepare("SELECT COUNT(*) n FROM fixed_assets WHERE company_id = ? AND status = 'disposed'").get(c.companyId).n,
];
async function refused(call, code, mention) {
  const before = snapshot();
  const r = await call();
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, code);
  assert.match(r.body.message, /لم يُرحَّل شيء/);
  if (mention) assert.ok(r.body.message.includes(mention), r.body.message);
  assert.deepEqual(snapshot(), before, 'nothing posted');
  return r.body;
}
const periodOf = (month) => db.prepare('SELECT id FROM fiscal_periods WHERE company_id = ? AND start_date = ?').get(c.companyId, `${Y}-${month}-01`).id;

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'فترات مقفلة');
  const { accounts } = await h.setupLedger(co.manager, 'trading');
  ok((await h.goLive(co.manager, `${Y}-01-01`)).res);
  const acc = (code) => accounts.find((a) => a.code === code).id;
  c = { ...co, m: co.manager, acc };
  c.cat = ok(await api('post', '/asset-categories', { name: 'أجهزة', assetAccountId: acc('1230'), accumulatedAccountId: acc('1290'), expenseAccountId: acc('6600'), disposalAccountId: acc('4900'), defaultLifeMonths: 12 }), 201);
  // February closed then locked; April closed (not locked).
  ok(await c.m.post(`/api/ledger/periods/${periodOf('02')}/close`, {}));
  ok(await c.m.post(`/api/ledger/periods/${periodOf('02')}/lock`, {}));
  ok(await c.m.post(`/api/ledger/periods/${periodOf('04')}/close`, {}));
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('depreciation: a run whose target month is locked, and a catch-up crossing a locked month, refuse and post nothing (not even the open months)', async () => {
  const feb = ok(await api('post', '/assets', { categoryId: c.cat.id, name: 'جهاز فبراير', cost: '120', purchaseDate: `${Y}-02-10` }), 201);
  await refused(() => api('post', '/depreciation/run', { period: `${Y}-02` }), 'period_locked', feb.asset_number);
  // Catch-up from January: January is open but February is locked -> whole run refused.
  const jan = ok(await api('post', '/assets', { categoryId: c.cat.id, name: 'جهاز يناير', cost: '240', purchaseDate: `${Y}-01-05` }), 201);
  await refused(() => api('post', '/depreciation/run', { period: `${Y}-03` }), 'period_locked', `${Y}-02`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fa_depreciation WHERE asset_id = ?').get(jan.id).n, 0, 'January not posted either');
  // A closed (not locked) month refuses the same way (asset only, via its own run).
  const apr = ok(await api('post', '/assets', { categoryId: c.cat.id, name: 'جهاز أبريل', cost: '60', purchaseDate: `${Y}-04-02` }), 201);
  const before0 = snapshot();
  assert.throws(() => FA.runDepreciation(c.companyId, { period: `${Y}-04`, assetId: apr.id }, null), (e) => e.code === 'period_closed' && e.message.includes(apr.asset_number));
  assert.deepEqual(snapshot(), before0);
  // The sweep reports the refusal per company and posts nothing.
  const before = snapshot();
  const sw = FA.sweep(`${Y}-11-20`).find((x) => x.company_id === c.companyId);
  assert.equal(sw.error, 'period_locked');
  assert.deepEqual(snapshot(), before);
});

test('disposal dated in a locked period refuses and posts nothing', async () => {
  const a = db.prepare("SELECT * FROM fixed_assets WHERE company_id = ? AND name = 'جهاز يناير'").get(c.companyId);
  await refused(() => api('post', `/assets/${a.id}/dispose`, { date: `${Y}-02-15` }), 'period_locked', a.asset_number);
});

test('recurring templates: a scheduled date in a locked period refuses the whole run', async () => {
  ok(await api('post', '/recurring', { name: 'إيجار', kind: 'recurring', startDate: `${Y}-01-01`, dayOfMonth: 1, occurrences: 3, lines: [{ accountId: c.acc('6200'), debitMinor: 1000 }, { accountId: c.acc('2130'), creditMinor: 1000 }] }), 201);
  const body = await refused(() => api('post', '/recurring/run', { asOf: `${Y}-03-15` }), 'period_locked', 'إيجار');
  assert.ok(body.message.includes(`${Y}-02-01`));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recurring_runs WHERE company_id = ?').get(c.companyId).n, 0, 'January not posted either');
  const sw = RE.sweep(`${Y}-03-15`).find((x) => x.company_id === c.companyId);
  assert.equal(sw.error, 'period_locked');
  ok(await api('put', `/recurring/${db.prepare('SELECT id FROM recurring_templates WHERE company_id = ?').get(c.companyId).id}`, { active: false }));
});

test('accrual reversal landing in a locked period refuses (with its accrual) and posts nothing', async () => {
  // Accrual on 31 January (open); its reversal would be on 1 February (locked).
  ok(await api('post', '/recurring', { name: 'كهرباء مستحقة', kind: 'accrual', startDate: `${Y}-01-31`, dayOfMonth: 31, occurrences: 1, lines: [{ accountId: c.acc('6300'), debitMinor: 500 }, { accountId: c.acc('2130'), creditMinor: 500 }] }), 201);
  const body = await refused(() => api('post', '/recurring/run', { asOf: `${Y}-02-10` }), 'period_locked', 'عكس الاستحقاق');
  assert.ok(body.message.includes(`${Y}-02-01`));
  // Up to 31 January only: the accrual posts; the reversal stays pending and is refused when due.
  const r = ok(await api('post', '/recurring/run', { asOf: `${Y}-01-31` }));
  assert.equal(r.posted.length, 1);
  await refused(() => api('post', '/recurring/run', { asOf: `${Y}-02-10` }), 'period_locked', 'عكس الاستحقاق');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recurring_runs WHERE company_id = ? AND reversal_entry_id IS NULL').get(c.companyId).n, 1, 'still awaiting reversal');
});
