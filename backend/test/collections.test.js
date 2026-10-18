// backend/test/collections.test.js
//
// Focused regression coverage for the Collections permission/isolation
// class (fbaab69 fixed the read leak; 64f57d6 fixed the
// manage_waves-vs-confirm_collections elevation bug).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;

test.before(async () => {
  server = await startServer();
  const { baseUrl } = server;
  const company = await createCompany(baseUrl);

  const shop = await company.manager.post('/api/shops', { name: 'محل التحصيل', lat: 33.5, lng: 36.3 });
  assert.equal(shop.status, 201, JSON.stringify(shop.body));

  const repX = await createRep(baseUrl, company.manager, { permissions: ['record_collections', 'view_app'] });
  const repY = await createRep(baseUrl, company.manager, { permissions: ['record_collections', 'view_app'] });
  const viewOnlyRep = await createRep(baseUrl, company.manager, { permissions: ['view_app'] });
  // Holds manage_waves but NOT confirm_collections — the exact bug fixed
  // in 64f57d6 (manage_waves used to act as an accidental elevated signal
  // for collections). Must now behave like any other non-elevated caller.
  const manageWavesOnlyRep = await createRep(baseUrl, company.manager, {
    permissions: ['manage_waves', 'view_app'],
  });

  const colX = await repX.client.post('/api/collections', { shopId: shop.body.id, method: 'cash', amount: 500 });
  assert.equal(colX.status, 201, JSON.stringify(colX.body));
  const colY = await repY.client.post('/api/collections', { shopId: shop.body.id, method: 'cash', amount: 700 });
  assert.equal(colY.status, 201, JSON.stringify(colY.body));

  ctx = { company, repX, repY, viewOnlyRep, manageWavesOnlyRep, colX: colX.body, colY: colY.body };
});

test.after(() => {
  server.stop();
});

test('rep can read their own collection', async () => {
  const res = await ctx.repX.client.get(`/api/collections/${ctx.colX.id}`);
  assert.equal(res.status, 200);
});

test("rep cannot read another rep's collection (403)", async () => {
  const res = await ctx.repX.client.get(`/api/collections/${ctx.colY.id}`);
  assert.equal(res.status, 403);
});

test("manage_waves-only holder still gets 403 on another rep's collection", async () => {
  const res = await ctx.manageWavesOnlyRep.client.get(`/api/collections/${ctx.colY.id}`);
  assert.equal(res.status, 403);
});

test('confirm_collections holder (manager) reads every collection company-wide', async () => {
  const a = await ctx.company.manager.get(`/api/collections/${ctx.colX.id}`);
  const b = await ctx.company.manager.get(`/api/collections/${ctx.colY.id}`);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('view_app-only user cannot confirm a collection (needs confirm_collections)', async () => {
  const res = await ctx.viewOnlyRep.client.post(`/api/collections/${ctx.colX.id}/confirm`, {});
  assert.equal(res.status, 403);
});

test('manager (real permission holder) can confirm a collection', async () => {
  const res = await ctx.company.manager.post(`/api/collections/${ctx.colX.id}/confirm`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
});
