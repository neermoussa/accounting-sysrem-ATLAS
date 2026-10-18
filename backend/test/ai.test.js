// backend/test/ai.test.js
//
// Focused regression coverage: GET /api/ai/recommendations must require
// view_ai_recommendations specifically — accepting 'view_app' (held by
// every user) made the permission a no-op for every rep (fixed fbaab69).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;

test.before(async () => {
  server = await startServer();
  const { baseUrl } = server;
  const company = await createCompany(baseUrl);
  const viewOnlyRep = await createRep(baseUrl, company.manager, { permissions: ['view_app'] });
  const aiRep = await createRep(baseUrl, company.manager, { permissions: ['view_app', 'view_ai_recommendations'] });
  ctx = { company, viewOnlyRep, aiRep };
});

test.after(() => {
  server.stop();
});

test('view_app-only user gets 403 on AI recommendations feed', async () => {
  const res = await ctx.viewOnlyRep.client.get('/api/ai/recommendations');
  assert.equal(res.status, 403);
});

test('view_ai_recommendations holder gets 200 on AI recommendations feed', async () => {
  const res = await ctx.aiRep.client.get('/api/ai/recommendations');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('manager (holds everything) gets 200 on AI recommendations feed', async () => {
  const res = await ctx.company.manager.get('/api/ai/recommendations');
  assert.equal(res.status, 200);
});
