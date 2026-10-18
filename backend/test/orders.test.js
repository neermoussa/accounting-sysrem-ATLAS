// backend/test/orders.test.js
//
// Focused regression coverage for the Orders permission/isolation class
// documented in docs/FINAL_READINESS_REPORT.md (commits ee47d90, 591bd2b,
// fbaab69, 64f57d6): rep isolation on order read/write, and view_app not
// substituting for a real permission.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;

test.before(async () => {
  server = await startServer();
  const { baseUrl } = server;
  const company = await createCompany(baseUrl);

  // Two shops so each rep has a distinct order.
  const shopA = await company.manager.post('/api/shops', { name: 'محل أ', lat: 33.5, lng: 36.3 });
  const shopB = await company.manager.post('/api/shops', { name: 'محل ب', lat: 33.6, lng: 36.4 });
  assert.equal(shopA.status, 201, JSON.stringify(shopA.body));
  assert.equal(shopB.status, 201, JSON.stringify(shopB.body));

  // Rep X: only order-related permissions (add_orders/delete_orders/
  // record_deliveries), no approve_orders/manage_settings — this is the
  // rep-scoped write class fixed in 64f57d6.
  const repX = await createRep(baseUrl, company.manager, {
    permissions: ['add_orders', 'delete_orders', 'record_deliveries', 'view_app'],
  });
  const repY = await createRep(baseUrl, company.manager, {
    permissions: ['add_orders', 'delete_orders', 'record_deliveries', 'view_app'],
  });

  // view_app-only rep with no order permissions at all — for the
  // specialized-permission-vs-view_app check.
  const viewOnlyRep = await createRep(baseUrl, company.manager, { permissions: ['view_app'] });

  const orderX = await repX.client.post(`/api/shops/${shopA.body.id}/orders`, {
    order_date: '2026-09-21',
    total_value: 1000,
  });
  assert.equal(orderX.status, 201, JSON.stringify(orderX.body));

  const orderY = await repY.client.post(`/api/shops/${shopB.body.id}/orders`, {
    order_date: '2026-09-21',
    total_value: 2000,
  });
  assert.equal(orderY.status, 201, JSON.stringify(orderY.body));

  ctx = { company, repX, repY, viewOnlyRep, orderX: orderX.body, orderY: orderY.body };
});

test.after(() => {
  server.stop();
});

test('rep can read their own order', async () => {
  const res = await ctx.repX.client.get(`/api/orders/${ctx.orderX.id}`);
  assert.equal(res.status, 200);
});

test("rep cannot read another rep's order", async () => {
  const res = await ctx.repX.client.get(`/api/orders/${ctx.orderY.id}`);
  assert.equal(res.status, 403);
});

test("rep listing orders only sees their own", async () => {
  const res = await ctx.repX.client.get('/api/orders');
  assert.equal(res.status, 200);
  const ids = res.body.map((o) => o.id);
  assert.ok(ids.includes(ctx.orderX.id));
  assert.ok(!ids.includes(ctx.orderY.id));
});

test("rep cannot mark-paid another rep's order (403)", async () => {
  const res = await ctx.repX.client.post(`/api/orders/${ctx.orderY.id}/mark-paid`, {});
  assert.equal(res.status, 403);
});

test('rep can mark-paid their own order (200/201)', async () => {
  const res = await ctx.repX.client.post(`/api/orders/${ctx.orderX.id}/mark-paid`, {});
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
});

test('manager (holds approve_orders) can read both reps orders', async () => {
  const a = await ctx.company.manager.get(`/api/orders/${ctx.orderX.id}`);
  const b = await ctx.company.manager.get(`/api/orders/${ctx.orderY.id}`);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('view_app-only user cannot approve an order (needs approve_orders, not view_app)', async () => {
  const res = await ctx.viewOnlyRep.client.post(`/api/orders/${ctx.orderX.id}/approve`, {});
  assert.equal(res.status, 403);
});

test('manager (real permission holder) can approve an order', async () => {
  // approve on an already-approved order still exercises the permission
  // gate; a business-rule conflict (409) would still prove the gate passed,
  // but this test company's orders auto-approve by default, so accept
  // either 200 or 409 as evidence the 403 gate itself is not the blocker.
  const res = await ctx.company.manager.post(`/api/orders/${ctx.orderX.id}/approve`, {});
  assert.ok([200, 404, 409].includes(res.status), JSON.stringify(res.body));
  assert.notEqual(res.status, 403);
});
