// backend/test/openItems.test.js
//
// Legacy debt in aging + the go-live open-items import (owner request after
// Prompt 3): migrated debt with no real invoice age is its own 'legacy'
// bucket (never 0-30); imported open items are aged by their real due dates
// from day one; the residual vs the snapshot stays one legacy line.

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer } = require('./helpers');
const h = require('./salesHelpers');

let server;
let ctx;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function cookieFor(c) {
  const r = await fetch(`${server.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: c.managerContact, password: c.managerPassword }) });
  return r.headers.get('set-cookie').split(';')[0];
}

async function upload(rows, header = ['الزبون', 'رقم الفاتورة', 'تاريخ الفاتورة', 'تاريخ الاستحقاق', 'المبلغ']) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('open items');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  const form = new FormData();
  form.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'open-items.xlsx');
  const res = await fetch(`${server.baseUrl}/api/sales/go-live/open-items`, { method: 'POST', headers: { Cookie: ctx.cookie }, body: form });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  server = await startServer();
  const company = await h.createUsdCompany(server.baseUrl, 'شركة البنود المفتوحة');
  ctx = { company, m: company.manager, cid: company.companyId };
  await h.setupLedger(ctx.m);
  ctx.cookie = await cookieFor(company);
  ctx.shopA = await h.mkShop(ctx.m, 'زبون أ');
  ctx.shopB = await h.mkShop(ctx.m, 'زبون ب');
  ctx.shopC = await h.mkShop(ctx.m, 'زبون ج');
  h.seedSnapshot(server.dbPath, ctx.shopA, 1000);
  h.seedSnapshot(server.dbPath, ctx.shopB, 300);
});

test.after(() => server.stop());

test('an invalid file stages nothing and lists every row error', async () => {
  const res = await upload([
    ['زبون غير موجود', 'X-1', daysAgo(10), daysAgo(5), 10],
    [String(ctx.shopA), '', daysAgo(10), daysAgo(5), 10],
    [String(ctx.shopA), 'A-9', 'not a date', daysAgo(5), 10],
    [String(ctx.shopA), 'A-8', daysAgo(5), daysAgo(10), 10],
    [String(ctx.shopA), 'A-7', daysAgo(5), daysAgo(1), -3],
    [String(ctx.shopA), 'A-6', daysAgo(5), daysAgo(1), 3],
    [String(ctx.shopA), 'A-6', daysAgo(5), daysAgo(1), 3],
  ]);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_rows');
  assert.equal(res.body.import_id, null);
  assert.equal(res.body.error_count, 6);
  assert.equal((await ctx.m.get('/api/sales/go-live/open-items')).body.import, null);
  const badHeaders = await upload([['x']], ['customer', 'amount']);
  assert.equal(badHeaders.body.error, 'invalid_headers');
});

test('valid file: per-customer sum vs latest snapshot, difference shown, residual kept as legacy', async () => {
  const res = await upload([
    ['زبون أ', 'A-1', daysAgo(100), daysAgo(90), 400],
    [String(ctx.shopA), 'A-2', daysAgo(20), daysAgo(10), '350.00'],
    ['زبون ب', 'B-1', daysAgo(45), daysAgo(40), 300],
    [new Date(Date.now()).getTime() && 'زبون ج', 'C-1', daysAgo(3), daysAgo(1), 12.5],
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ctx.importId = res.body.import_id;
  const by = (id) => res.body.customers.find((c) => c.shop_id === id);
  assert.deepEqual([by(ctx.shopA).items_minor, by(ctx.shopA).snapshot_minor, by(ctx.shopA).legacy_minor], [75000, 100000, 25000]);
  assert.equal(by(ctx.shopB).legacy_minor, 0);
  assert.equal(by(ctx.shopC).legacy_minor, -1250);
  assert.equal(by(ctx.shopC).warning, 'items_exceed_snapshot');
});

test('go-live dry run and execution use the open items; aging is correct from day one', async () => {
  const dry = await ctx.m.post('/api/sales/go-live/dry-run', {});
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.open_items_import_id, ctx.importId);
  const a = dry.body.rows.find((r) => r.shop_id === ctx.shopA);
  assert.equal(a.items.length, 2);
  assert.equal(a.legacy_minor, 25000);
  assert.equal(a.opening_minor, 100000);
  const exec = await ctx.m.post('/api/sales/go-live', { dryRunId: dry.body.dry_run_id, confirmText: 'Invoices will be created in Atlas from now on' });
  assert.equal(exec.status, 200, JSON.stringify(exec.body));
  // A: 2 items + legacy; B: 1 item; C: 1 item + negative legacy.
  assert.equal(exec.body.entry_ids.length, 6);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopA), 1000);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopB), 300);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopC), 0);
  assert.equal((await ctx.m.get('/api/sales/go-live/open-items')).body.import, null, 'import consumed');

  const agingA = (await ctx.m.get(`/api/receivables/aging/customer/${ctx.shopA}`)).body;
  assert.deepEqual({ b0_30: agingA.totals.b0_30, b61_90: agingA.totals.b61_90, legacy: agingA.totals.legacy }, { b0_30: 35000, b61_90: 40000, legacy: 25000 });
  assert.ok(agingA.items.find((i) => i.number === 'A-1' && i.due_date === daysAgo(90)));
  const agingB = (await ctx.m.get(`/api/receivables/aging/customer/${ctx.shopB}`)).body;
  assert.equal(agingB.totals.b31_60, 30000);
  const agingC = (await ctx.m.get(`/api/receivables/aging/customer/${ctx.shopC}`)).body;
  assert.equal(agingC.totals.b0_30, 1250);
  assert.equal(agingC.totals.credits, -1250);
  const all = (await ctx.m.get('/api/receivables/aging')).body;
  assert.equal(all.totals.total, all.control_minor);
  assert.equal(all.totals.legacy, 25000);
});

test('aging Excel export has the legacy column', async () => {
  const res = await fetch(`${server.baseUrl}/api/receivables/aging?format=xlsx`, { headers: { Cookie: ctx.cookie } });
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const text = [];
  wb.worksheets[0].eachRow((r) => text.push(r.values.join('|')));
  assert.ok(text.some((t) => t.includes('رصيد سابق غير مؤرخ')));
  assert.ok(text.some((t) => t.includes('250.00')));
});

test('without open items every migrated balance is legacy, not 0-30', async () => {
  const other = await h.createUsdCompany(server.baseUrl, 'شركة بلا بنود');
  await h.setupLedger(other.manager);
  const shop = await h.mkShop(other.manager, 'زبون قديم');
  h.seedSnapshot(server.dbPath, shop, 500);
  const { res } = await h.goLive(other.manager);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const aging = (await other.manager.get('/api/receivables/aging')).body;
  assert.equal(aging.totals.legacy, 50000);
  assert.equal(aging.totals.b0_30, 0);
  ctx.other = { ...other, shop };
});

test('credit control treats legacy debt as overdue by default; legacy_debt_policy=current turns that off', async () => {
  const m = ctx.other.manager;
  await m.put('/api/receivables/settings', { invoiceCreditPolicy: 'block' });
  const draft = async () => (await m.post('/api/sales/invoices', { shopId: ctx.other.shop, lines: [{ description: 'x', qty: 1, unitPrice: '5' }] })).body;
  const blocked = await m.post(`/api/sales/invoices/${(await draft()).id}/post`, {});
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.body.reasons, ['overdue_debt']);
  assert.equal(blocked.body.overdue_legacy, true);
  assert.equal((await m.put('/api/receivables/settings', { legacyDebtPolicy: 'current' })).status, 200);
  const ok = await m.post(`/api/sales/invoices/${(await draft()).id}/post`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await m.get('/api/receivables/settings')).body.legacyDebtPolicy, 'current');
  assert.equal((await m.put('/api/receivables/settings', { legacyDebtPolicy: 'nope' })).status, 400);
});

test('a re-uploaded file after the dry run forces a new dry run', async () => {
  const c = await h.createUsdCompany(server.baseUrl, 'شركة إعادة الرفع');
  await h.setupLedger(c.manager);
  const shop = await h.mkShop(c.manager, 'زبون');
  h.seedSnapshot(server.dbPath, shop, 100);
  const saved = ctx.cookie;
  ctx.cookie = await cookieFor(c);
  assert.equal((await upload([[String(shop), 'Z-1', daysAgo(5), daysAgo(1), 60]])).status, 201);
  const dry = await c.manager.post('/api/sales/go-live/dry-run', {});
  assert.equal((await upload([[String(shop), 'Z-1', daysAgo(5), daysAgo(1), 70]])).status, 201);
  const exec = await c.manager.post('/api/sales/go-live', { dryRunId: dry.body.dry_run_id, confirmText: 'Invoices will be created in Atlas from now on' });
  assert.equal(exec.status, 409);
  assert.ok(['open_items_not_staged', 'plan_changed'].includes(exec.body.error));
  ctx.cookie = saved;
});
