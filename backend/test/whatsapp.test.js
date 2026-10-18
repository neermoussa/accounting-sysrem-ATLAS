// backend/test/whatsapp.test.js
//
// Focused regression coverage for WhatsApp bot endpoints:
//   - the 4-endpoint view_app-bypass leak fixed in 05442ed
//   - item 3 from the QA report's DECISION REQUIRED list, fixed in this
//     pass: view_whatsapp_log (a read-only permission by its own catalog
//     label) must no longer be sufficient to send an outbound reply —
//     only respond_whatsapp_alerts may.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;

test.before(async () => {
  server = await startServer();
  const { baseUrl } = server;
  const company = await createCompany(baseUrl);
  const shop = await company.manager.post('/api/shops', { name: 'محل واتساب', phone: '0999111222', lat: 33.5, lng: 36.3 });
  assert.equal(shop.status, 201);

  const viewLogOnlyRep = await createRep(baseUrl, company.manager, {
    permissions: ['view_app', 'view_whatsapp_log'],
  });
  const respondRep = await createRep(baseUrl, company.manager, {
    permissions: ['view_app', 'respond_whatsapp_alerts'],
  });
  const orderOnlyRep = await createRep(baseUrl, company.manager, { permissions: ['view_app', 'add_orders'] });

  ctx = { company, shop: shop.body, viewLogOnlyRep, respondRep, orderOnlyRep };
});

test.after(() => {
  server.stop();
});

test('view_whatsapp_log alone (a read permission) cannot send an outbound reply (403)', async () => {
  const res = await ctx.viewLogOnlyRep.client.post(`/api/whatsapp-bot/messages/shop/${ctx.shop.id}/reply`, {
    message: 'رد تجريبي',
  });
  assert.equal(res.status, 403);
});

test('respond_whatsapp_alerts holder can send an outbound reply (200/201)', async () => {
  const res = await ctx.respondRep.client.post(`/api/whatsapp-bot/messages/shop/${ctx.shop.id}/reply`, {
    message: 'رد تجريبي',
  });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
});

test('a rep with only order permissions cannot read the WhatsApp conversation log (403, not view_app bypass)', async () => {
  const res = await ctx.orderOnlyRep.client.get('/api/whatsapp-bot/messages');
  assert.equal(res.status, 403);
});

test('view_whatsapp_log holder can read the conversation log', async () => {
  const res = await ctx.viewLogOnlyRep.client.get('/api/whatsapp-bot/messages');
  assert.equal(res.status, 200);
});

test('a rep with only order permissions cannot manage WhatsApp tickets (403, not view_app bypass)', async () => {
  const res = await ctx.orderOnlyRep.client.get('/api/whatsapp-bot/tickets');
  assert.equal(res.status, 403);
});

test('manager (holds everything) can reach the tickets and log endpoints', async () => {
  const tickets = await ctx.company.manager.get('/api/whatsapp-bot/tickets');
  const log = await ctx.company.manager.get('/api/whatsapp-bot/messages');
  assert.equal(tickets.status, 200);
  assert.equal(log.status, 200);
});
