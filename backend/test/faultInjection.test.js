// backend/test/faultInjection.test.js
//
// Atomicity: for each multi-write operation, force an error AFTER the first
// write (lib/faultInjection.js checkpoints) and assert that nothing at all
// persisted — then run it again unarmed and assert it succeeds once.
//
// Runs the real Express app in-process (server.js exports it when it is not
// the main module) so the test can arm checkpoints inside the same process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fault-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const faults = require('../lib/faultInjection');
const h = require('./salesHelpers');

let listener;
let base;
let ctx;

const one = (sql, ...p) => db.prepare(sql).get(...p);
const snapshotTables = (companyId) => ({
  entries: one('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', companyId).c,
  lines: one('SELECT COUNT(*) c FROM journal_lines WHERE company_id = ?', companyId).c,
  balances: one('SELECT COUNT(*) c, COALESCE(SUM(balance), 0) s FROM balances b JOIN shops s ON s.id = b.shop_id WHERE s.company_id = ?', companyId),
  collections: db.prepare('SELECT id, status FROM collections WHERE company_id = ? ORDER BY id').all(companyId).map((r) => ({ ...r })),
  collectionChanges: one('SELECT COUNT(*) c FROM collection_changes WHERE company_id = ?', companyId).c,
  returns: db.prepare('SELECT id, status, financial_adjustment_applied FROM return_requests WHERE company_id = ? ORDER BY id').all(companyId).map((r) => ({ ...r })),
  returnChanges: one('SELECT COUNT(*) c FROM return_changes WHERE company_id = ?', companyId).c,
  creditNotes: one('SELECT COUNT(*) c FROM sales_credit_notes WHERE company_id = ?', companyId).c,
  invoices: db.prepare('SELECT id, status, invoice_number, journal_entry_id FROM sales_invoices WHERE company_id = ? ORDER BY id').all(companyId).map((r) => ({ ...r })),
  numbering: db.prepare('SELECT document_type, next_number FROM document_number_sequences WHERE company_id = ? ORDER BY document_type').all(companyId).map((r) => ({ ...r })),
  audit: one('SELECT COUNT(*) c FROM audit_log WHERE company_id = ?', companyId).c,
});

function assertUnchanged(before, companyId, label) {
  const after = snapshotTables(companyId);
  assert.deepEqual({ ...after, balances: { ...after.balances } }, { ...before, balances: { ...before.balances } }, `${label}: something persisted after the injected failure`);
}

async function newCollection(m, shopId, amount) {
  const c = await m.post('/api/collections', { shopId, method: 'cash', amount });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  return c.body.id;
}

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;

  // Company 1: NOT live (legacy snapshot path).
  const legacy = await h.createUsdCompany(base, 'شركة غير مفعّلة');
  const legacyShop = await h.mkShop(legacy.manager, 'زبون قديم');
  db.prepare("INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, '2026-01-01', 500, 'seed')").run(legacyShop);

  // Company 2: live on the ledger.
  const live = await h.createUsdCompany(base, 'شركة مفعّلة');
  await h.setupLedger(live.manager);
  const liveShop = await h.mkShop(live.manager, 'زبون الدفتر');
  db.prepare("INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, '2026-01-01', 300, 'seed')").run(liveShop);
  const { res } = await h.goLive(live.manager);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await live.manager.put('/api/returns/settings/financial', { autoFinancialAdjustment: true });

  ctx = { legacy, legacyShop, live, liveShop };
});

test.after(() => {
  faults.disarmAll();
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

for (const point of ['collections.confirm.after_status', 'collections.confirm.after_balance']) {
  test(`NOT live: collection confirm rolls back fully when it fails at ${point}`, async () => {
    const { manager: m, companyId } = ctx.legacy;
    const id = await newCollection(m, ctx.legacyShop, 40);
    const before = snapshotTables(companyId);
    faults.arm(point);
    const res = await m.post(`/api/collections/${id}/confirm`, {});
    assert.equal(res.status, 500);
    assertUnchanged(before, companyId, point);
    // Unarmed: succeeds exactly once, with the original snapshot behaviour.
    const ok = await m.post(`/api/collections/${id}/confirm`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(one('SELECT status FROM collections WHERE id = ?', id).status, 'confirmed');
  });
}

for (const point of ['collections.confirm.after_status', 'collections.confirm.after_balance']) {
  test(`LIVE: collection confirm rolls back status, entry and balance when it fails at ${point}`, async () => {
    const { manager: m, companyId } = ctx.live;
    const id = await newCollection(m, ctx.liveShop, 25);
    const before = snapshotTables(companyId);
    faults.arm(point);
    const res = await m.post(`/api/collections/${id}/confirm`, {});
    assert.equal(res.status, 500);
    assertUnchanged(before, companyId, point);
    const ok = await m.post(`/api/collections/${id}/confirm`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(one("SELECT COUNT(*) c FROM journal_entries WHERE source_type = 'collection' AND source_id = ?", id).c, 1);
  });
}

async function inspectedReturn(m, shopId) {
  const r = await m.post('/api/returns', { shopId, items: [{ productName: 'مادة', qty: 2, unitValue: 7.5 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const it of r.body.items) await m.put(`/api/returns/${r.body.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: 2 });
  return r.body.id;
}

for (const point of ['returns.approve.after_status', 'sales.credit_note.after_entry', 'returns.credit.after_applied']) {
  test(`LIVE: return approval + credit note rolls back fully when it fails at ${point}`, async () => {
    const { manager: m, companyId } = ctx.live;
    const id = await inspectedReturn(m, ctx.liveShop);
    const before = snapshotTables(companyId);
    faults.arm(point);
    const res = await m.post(`/api/returns/${id}/approve`, {});
    assert.equal(res.status, 500);
    assertUnchanged(before, companyId, point);
    const ok = await m.post(`/api/returns/${id}/approve`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.creditApplied, 15);
    assert.equal(one('SELECT COUNT(*) c FROM sales_credit_notes WHERE return_request_id = ?', id).c, 1);
  });
}

test('LIVE: collection reversal rolls back the entry, receipt and status when it fails after the entry', async () => {
  const { manager: m, companyId } = ctx.live;
  const id = await newCollection(m, ctx.liveShop, 9);
  assert.equal((await m.post(`/api/collections/${id}/confirm`, {})).status, 200);
  const before = snapshotTables(companyId);
  faults.arm('collections.reverse.after_entry');
  const res = await m.post(`/api/collections/${id}/reverse`, { reason: 'اختبار' });
  assert.equal(res.status, 500);
  assertUnchanged(before, companyId, 'collection reverse');
  assert.equal(one('SELECT status FROM customer_receipts WHERE collection_id = ?', id).status, 'posted');
  const ok = await m.post(`/api/collections/${id}/reverse`, { reason: 'اختبار' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('LIVE: invoice posting rolls back the entry, number and status when it fails after the entry', async () => {
  const { manager: m, companyId } = ctx.live;
  const inv = await m.post('/api/sales/invoices', { shopId: ctx.liveShop, lines: [{ description: 'بضاعة', qty: 2, unitPrice: '4.99' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const before = snapshotTables(companyId);
  faults.arm('sales.invoice.post.after_entry');
  const res = await m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(res.status, 500);
  assertUnchanged(before, companyId, 'invoice post');
  const ok = await m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(one("SELECT COUNT(*) c FROM journal_entries WHERE source_type = 'sales_invoice' AND source_id = ?", inv.body.id).c, 1);
});

test('LIVE: balances still equal the ledger and integrity is clean after all injected failures', async () => {
  const { manager: m, companyId } = ctx.live;
  const shown = await h.displayedBalance(m, ctx.liveShop);
  assert.equal(Math.round(shown * 100), h.arSumMinor(process.env.ATLAS_DB_PATH, companyId, ctx.liveShop));
  assert.deepEqual((await m.get('/api/ledger/integrity-check')).body.violations, []);
});

test('fault injection cannot be armed outside NODE_ENV=test', () => {
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => faults.arm('anything'));
  } finally {
    process.env.NODE_ENV = 'test';
  }
});
