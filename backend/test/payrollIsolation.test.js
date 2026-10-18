// backend/test/payrollIsolation.test.js
//
// Payroll isolation (before Prompt 12, item 5): a user holding every
// permission EXCEPT the payroll ones gets 403 on every payroll / advance
// endpoint (enumerated from the router itself, so a new endpoint is covered
// automatically), and no payroll data — employee references and names,
// department names of the HR batch — appears in any other response: every
// parameter-less GET endpoint of the app (enumerated from server.js), plus
// the ledger entry / general ledger / treasury voucher / audit log views
// of the payroll and advance documents.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-piso-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';
process.env.ATLAS_TEST_NOW = process.env.ATLAS_TEST_NOW || '2026-11-20';
require('../lib/clock').install();

const app = require('../server');
const db = require('../db/init');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');
const { ALL_PERMISSION_KEYS } = require('../lib/permissions');

const SECRETS = ['EMP-SECRET-77', 'سرّيّ الاسم', 'قسم-سرّي-X'];
const PAYROLL_PERMS = ['manage_payroll_intake', 'approve_payroll_posting'];
let listener;
let base;
let c;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const leaks = (text) => SECRETS.filter((s) => String(text).includes(s));

// Routes of an express.Router: [{ method, path }].
const routesOf = (router) => router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => ({ method: m, path: l.route.path })));
// Every router mounted under /api in server.js.
function mountedRouters() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const vars = Object.fromEntries([...src.matchAll(/const (\w+) = require\('(\.\/routes\/[^']+)'\)/g)].map((m) => [m[1], m[2]]));
  return [...src.matchAll(/app\.use\('(\/api\/[^']+)',\s*(?:(\w+)|require\('(\.\/routes\/[^']+)'\))\)/g)].map((m) => ({ mount: m[1], file: m[3] || vars[m[2]] })).filter((x) => x.file);
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة السرية');
  const m = co.manager;
  await h.setupLedger(m, 'trading');
  ok((await h.goLive(m, '2026-01-01')).res);
  const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(co.companyId, code).id;
  ok(await m.put('/api/payroll/settings', { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2120'), advancesAccountId: acc('1160') }));
  const main = ok(await m.get('/api/treasury/boxes'))[0];
  const adv = ok(await m.post('/api/payroll/advances', { employeeRef: SECRETS[0], employeeName: SECRETS[1], cashBoxId: main.id, amount: '40', date: '2026-02-01' }), 201);
  ok(await m.post(`/api/treasury/vouchers/${adv.voucher_id}/approve`, {}));
  const p = ok(await m.post('/api/payroll/periods/import', { period: '2026-03', externalId: 'B-1', lines: [{ department: SECRETS[2], currencyCode: 'USD', gross: '1000', deductions: '40', net: '960' }], advanceRecoveries: [{ employeeRef: SECRETS[0], currencyCode: 'USD', amount: '40' }] }), 201);
  const posted = ok(await m.post(`/api/payroll/periods/${p.id}/post`, {}));
  const pay = ok(await m.post(`/api/payroll/periods/${p.id}/payments`, { cashBoxId: main.id, date: '2026-04-02' }), 201);
  ok(await m.post(`/api/treasury/vouchers/${pay.voucher_id}/approve`, {}));
  const outsider = await createRep(base, m, { name: 'محاسب بلا رواتب', permissions: ALL_PERMISSION_KEYS.filter((x) => !PAYROLL_PERMS.includes(x)) });
  c = { ...co, m, acc, outsider: outsider.client, period: p, posted, adv, pay, main };
  // The data exists and the payroll users see it.
  assert.ok(leaks(JSON.stringify(ok(await m.get(`/api/payroll/periods/${p.id}`)))).length >= 2);
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('every payroll / advance endpoint answers 403 to a user without the payroll permissions', async () => {
  const routes = routesOf(require('../routes/payroll'));
  assert.ok(routes.length >= 20, `${routes.length} payroll routes found`);
  const fill = (p) => p.replace(/:id/g, String(c.period.id)).replace(/:\w+/g, '1');
  for (const r of routes) {
    const res = await c.outsider[r.method === 'delete' ? 'del' : r.method](`/api/payroll${fill(r.path)}`, r.method === 'get' ? undefined : {});
    assert.equal(res.status, 403, `${r.method.toUpperCase()} /api/payroll${r.path}`);
    assert.deepEqual(leaks(JSON.stringify(res.body)), []);
  }
});

test('no payroll data in any other response: every parameter-less GET endpoint of the app', async () => {
  let checked = 0;
  for (const { mount, file } of mountedRouters()) {
    if (mount === '/api/payroll') continue;
    let router;
    try { router = require(path.join(__dirname, '..', file)); } catch { continue; }
    if (!router?.stack) continue;
    for (const r of routesOf(router).filter((x) => x.method === 'get' && !x.path.includes(':'))) {
      const viaClient = await c.outsider.get(`${mount}${r.path === '/' ? '' : r.path}`);
      checked += 1;
      assert.deepEqual(leaks(typeof viaClient.body === 'string' ? viaClient.body : JSON.stringify(viaClient.body)), [], `GET ${mount}${r.path}`);
    }
  }
  assert.ok(checked >= 100, `${checked} GET endpoints checked`);
});

test('no payroll data in the documents an accountant can open: entries, general ledger, vouchers, audit log, reports', async () => {
  const o = c.outsider;
  const views = [
    `/api/ledger/entries/${c.posted.journal_entry_id}`,
    `/api/ledger/entries?from=2026-01-01&to=2026-12-31`,
    `/api/financial-reports/general-ledger?accountId=${c.acc('1160')}&from=2026-01-01&to=2026-12-31`,
    `/api/financial-reports/general-ledger?accountId=${c.acc('6100')}&from=2026-01-01&to=2026-12-31`,
    `/api/financial-reports/trial-balance?from=2026-01-01&to=2026-12-31`,
    `/api/financial-reports/income-statement?from=2026-01-01&to=2026-12-31`,
    `/api/treasury/vouchers/${c.adv.voucher_id}`,
    `/api/treasury/vouchers/${c.pay.voucher_id}`,
    '/api/treasury/vouchers',
    `/api/treasury/reports/daily-cash?boxId=${c.main.id}&from=2026-01-01&to=2026-12-31`,
    '/api/audit-log?limit=500',
  ];
  for (const v of views) {
    const r = await o.get(v);
    assert.ok(r.status < 500, `${v}: ${r.status}`);
    assert.deepEqual(leaks(JSON.stringify(r.body)), [], v);
  }
  // The audit log still has the payroll rows for payroll users.
  const all = ok(await c.m.get('/api/audit-log?limit=500'));
  assert.ok(all.some((x) => x.action.startsWith('payroll.')));
  assert.ok(!ok(await o.get('/api/audit-log?limit=500')).some((x) => x.action.startsWith('payroll.')));
});
