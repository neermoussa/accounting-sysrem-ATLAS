// backend/test/waves.test.js
//
// Focused regression coverage for Waves/Day-Plan: rep-scoped visit
// recording ownership (fixed in ee47d90/591bd2b) and view_app not
// substituting for manage_waves on supervisor-only writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;

test.before(async () => {
  server = await startServer();
  const { baseUrl } = server;
  const company = await createCompany(baseUrl);

  const shopA = await company.manager.post('/api/shops', { name: 'محل اللفة أ', lat: 33.5, lng: 36.3 });
  const shopB = await company.manager.post('/api/shops', { name: 'محل اللفة ب', lat: 33.6, lng: 36.4 });
  assert.equal(shopA.status, 201);
  assert.equal(shopB.status, 201);

  const repX = await createRep(baseUrl, company.manager, { permissions: ['view_app'] });
  const repY = await createRep(baseUrl, company.manager, { permissions: ['view_app'] });

  const today = new Date().toISOString().slice(0, 10);
  const dayOfWeek = new Date(`${today}T00:00:00Z`).getUTCDay();

  const tpl = await company.manager.post(`/api/waves/reps/${repX.userId}/templates`, {
    day_of_week: dayOfWeek,
    wave_number: 1,
    label: 'wave-test',
  });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));

  // GET /day for repX (as manager) creates today's wave_instance from the
  // template and returns it inside report.waves.
  const dayReport = await company.manager.get(`/api/waves/day?repId=${repX.userId}&date=${today}`);
  assert.equal(dayReport.status, 200, JSON.stringify(dayReport.body));
  const instanceId = dayReport.body.waves[0]?.id;
  assert.ok(instanceId, JSON.stringify(dayReport.body));

  const addPoint = await company.manager.post(`/api/waves/instances/${instanceId}/points`, { shopId: shopA.body.id });
  assert.equal(addPoint.status, 201, JSON.stringify(addPoint.body));
  const pointId = addPoint.body.id;

  ctx = { company, repX, repY, shopA: shopA.body, shopB: shopB.body, instanceId, pointId };
});

test.after(() => {
  server.stop();
});

test('owning rep can record a planned visit on their own point', async () => {
  const res = await ctx.repX.client.post(`/api/waves/points/${ctx.pointId}/visit`, { result: 'order_taken' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("another rep cannot record a visit on repX's point (403)", async () => {
  const res = await ctx.repY.client.post(`/api/waves/points/${ctx.pointId}/visit`, { result: 'order_taken' });
  assert.equal(res.status, 403);
});

test('an unplanned visit against an unassigned shop succeeds (regression: was a 500)', async () => {
  const res = await ctx.repY.client.post('/api/waves/points/unplanned/visit', {
    shopId: ctx.shopB.id,
    result: 'no_order',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.wave_point_id, null);
});

test('view_app-only rep cannot create a wave template (needs manage_waves)', async () => {
  const res = await ctx.repX.client.post(`/api/waves/reps/${ctx.repX.userId}/templates`, {
    day_of_week: 1,
    wave_number: 2,
  });
  assert.equal(res.status, 403);
});

test('manager (manage_waves holder) can create a wave template', async () => {
  const res = await ctx.company.manager.post(`/api/waves/reps/${ctx.repX.userId}/templates`, {
    day_of_week: (new Date().getUTCDay() + 1) % 7,
    wave_number: 3,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});
