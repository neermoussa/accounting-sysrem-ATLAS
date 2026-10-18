// backend/test/departments.test.js
//
// Department dashboards: per-department access follows the existing
// per-action permissions, and a field shared between departments is
// computed once (identical value everywhere it appears).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;

test.before(async () => {
  server = await startServer();
  const { baseUrl } = server;
  const company = await createCompany(baseUrl);
  const accountant = await createRep(baseUrl, company.manager, { permissions: ['confirm_collections'] });
  const storekeeper = await createRep(baseUrl, company.manager, { permissions: ['manage_factory_inventory'] });
  const nobody = await createRep(baseUrl, company.manager, { permissions: ['view_app'] });
  ctx = { company, accountant, storekeeper, nobody };
});

test.after(() => {
  server?.stop();
});

test('list of departments is scoped to the caller permissions', async () => {
  const mgr = await ctx.company.manager.get('/api/departments');
  assert.equal(mgr.status, 200);
  assert.deepEqual(mgr.body.departments.sort(), ['accounting', 'vendors', 'warehouse']);

  const acc = await ctx.accountant.client.get('/api/departments');
  assert.deepEqual(acc.body.departments, ['accounting']);

  const wh = await ctx.storekeeper.client.get('/api/departments');
  assert.deepEqual(wh.body.departments, ['warehouse']);

  const none = await ctx.nobody.client.get('/api/departments');
  assert.deepEqual(none.body.departments, []);
});

test('a department dashboard is forbidden without its permissions', async () => {
  assert.equal((await ctx.accountant.client.get('/api/departments/warehouse')).status, 403);
  assert.equal((await ctx.accountant.client.get('/api/departments/vendors')).status, 403);
  assert.equal((await ctx.storekeeper.client.get('/api/departments/accounting')).status, 403);
  assert.equal((await ctx.nobody.client.get('/api/departments/accounting')).status, 403);
  assert.equal((await ctx.company.manager.get('/api/departments/nope')).status, 404);
});

test('shared fields are identical across the departments that list them', async () => {
  const [wh, acc, ven] = await Promise.all(
    ['warehouse', 'accounting', 'vendors'].map((d) => ctx.company.manager.get(`/api/departments/${d}`))
  );
  for (const r of [wh, acc, ven]) assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = (r, key) => r.body.fields.find((x) => x.key === key);

  for (const key of ['stockValue', 'openOrders', 'pendingReturns']) {
    assert.deepEqual(f(wh, key).value, f(acc, key).value, key);
    assert.deepEqual(f(wh, key).sharedWith, ['accounting'], key);
  }
  assert.deepEqual(f(wh, 'factoryLowStock').value, f(ven, 'factoryLowStock').value);
  assert.deepEqual(f(wh, 'factoryLowStock').sharedWith, ['vendors']);

  // Prompt 6: vendor fields are computed from real data now (same value on
  // every department that shows them).
  for (const key of ['payables', 'incomingPurchases', 'activeVendors']) assert.equal(f(ven, key).tracked, true, key);
  assert.equal(f(ven, 'payables').value, f(acc, 'payables').value);
  assert.equal(f(ven, 'incomingPurchases').value, f(wh, 'incomingPurchases').value);
});
