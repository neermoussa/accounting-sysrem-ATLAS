// backend/test/receivables.test.js
//
// Prompt 3 — invoice from a delivered order, receipts & allocation, cheques,
// aging, forecast, reconciliation, statements, credit control, dashboards.
// Ledger-live USD company.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createRep } = require('./helpers');
const h = require('./salesHelpers');

let server;
let ctx;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function postedInvoice(shopId, amount, { invoiceDate = h.TODAY, dueDate } = {}) {
  const inv = await ctx.m.post('/api/sales/invoices', { shopId, invoiceDate, dueDate, lines: [{ description: 'بضاعة', qty: 1, unitPrice: amount }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const p = await ctx.m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body;
}
const invoiceOpen = async (id) => {
  const d = h.raw(server.dbPath);
  const r = d.prepare(`SELECT i.total_minor - i.credited_minor - COALESCE((SELECT SUM(a.amount_minor) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = i.id AND r.status = 'posted'), 0) o FROM sales_invoices i WHERE i.id = ?`).get(id).o;
  d.close();
  return r;
};

test.before(async () => {
  server = await startServer();
  const company = await h.createUsdCompany(server.baseUrl, 'شركة الذمم');
  ctx = { company, m: company.manager, cid: company.companyId };
  const { accounts } = await h.setupLedger(ctx.m);
  ctx.acc = (code) => accounts.find((a) => a.code === code).id;
  ctx.rep = await createRep(server.baseUrl, ctx.m, { permissions: ['view_app'], name: 'مندوب الشمال' });
  ctx.shopA = await h.mkShop(ctx.m, 'محل الأعمار');
  ctx.shopB = await h.mkShop(ctx.m, 'محل الشيكات');
  ctx.shopC = await h.mkShop(ctx.m, 'محل الحد الائتماني');
  const d = h.raw(server.dbPath);
  d.prepare("UPDATE shops SET region = 'دمشق', branch = 'المركز', assigned_rep_id = ? WHERE id IN (?, ?)").run(ctx.rep.userId, ctx.shopA, ctx.shopB);
  d.prepare("UPDATE shops SET region = 'حلب', branch = 'الشمال' WHERE id = ?").run(ctx.shopC);
  d.close();
  h.seedSnapshot(server.dbPath, ctx.shopA, 120);
  const { res } = await h.goLive(ctx.m, daysAgo(0));
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test.after(() => server.stop());

// ---------------------------------------------------------------------
// Item 1: draft invoice from a delivered order
// ---------------------------------------------------------------------

test('draft invoice from a delivered order: customer, delivered qty, order prices and order id prefilled', async () => {
  const d = h.raw(server.dbPath);
  const items = [
    { product_name: 'لوز 1كغ', qty: 4, unit_price: 9.75, line_total: 39 },
    { product_name: 'فستق 500غ', qty: 2, unit_price: 6.5, line_total: 13 },
    { product_name: 'كيس هدية', qty: 1, unit_price: 0, line_total: 0, is_free: true },
  ];
  const order = d.prepare("INSERT INTO orders (company_id, shop_id, order_date, items_json, total_value, status) VALUES (?, ?, ?, ?, 52, 'approved')").run(ctx.cid, ctx.shopA, h.TODAY, JSON.stringify(items));
  const undelivered = d.prepare("INSERT INTO orders (company_id, shop_id, order_date, items_json, total_value, status) VALUES (?, ?, ?, ?, 10, 'approved')").run(ctx.cid, ctx.shopA, h.TODAY, JSON.stringify([{ product_name: 'x', qty: 1, unit_price: 10 }]));
  d.close();
  ctx.orderId = Number(order.lastInsertRowid);
  // Partial delivery through the real endpoint: 3 of 4 almonds, all pistachio, the gift.
  const del = await ctx.m.post(`/api/orders/${ctx.orderId}/deliver`, {
    deliveredItems: [{ product_name: 'لوز 1كغ', qty: 3 }, { product_name: 'فستق 500غ', qty: 2 }, { product_name: 'كيس هدية', qty: 1 }],
  });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  const list = await ctx.m.get('/api/sales/invoiceable-orders');
  assert.ok(list.body.some((o) => o.id === ctx.orderId));
  assert.ok(!list.body.some((o) => o.id === Number(undelivered.lastInsertRowid)), 'only delivered orders are invoiceable');

  const res = await ctx.m.post(`/api/sales/invoices/from-order/${ctx.orderId}`, {});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const inv = res.body;
  assert.equal(inv.status, 'draft');
  assert.equal(inv.shop_id, ctx.shopA);
  assert.equal(inv.order_id, ctx.orderId);
  assert.deepEqual(inv.lines.map((l) => [l.description, l.qty, l.unit_price_minor]), [['لوز 1كغ', 3, 975], ['فستق 500غ', 2, 650], ['كيس هدية (مجاني)', 1, 0]]);
  assert.equal(inv.total_minor, 4225);
  ctx.orderInvoice = inv;

  const again = await ctx.m.post(`/api/sales/invoices/from-order/${ctx.orderId}`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'order_already_invoiced');
  const notDelivered = await ctx.m.post(`/api/sales/invoices/from-order/${undelivered.lastInsertRowid}`, {});
  assert.equal(notDelivered.body.error, 'order_not_delivered');
  assert.ok(!(await ctx.m.get('/api/sales/invoiceable-orders')).body.some((o) => o.id === ctx.orderId));
  const posted = await ctx.m.post(`/api/sales/invoices/${inv.id}/post`, {});
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  ctx.orderInvoice = posted.body;
});

// ---------------------------------------------------------------------
// Receipts and allocation
// ---------------------------------------------------------------------

test('confirmed collection becomes a receipt auto-allocated oldest-first, remainder on account', async () => {
  const old = await postedInvoice(ctx.shopB, '30.00', { invoiceDate: daysAgo(40), dueDate: daysAgo(35) });
  const newer = await postedInvoice(ctx.shopB, '50.00', { invoiceDate: daysAgo(5), dueDate: daysAgo(1) });
  const c = await ctx.m.post('/api/collections', { shopId: ctx.shopB, method: 'cash', amount: 100 });
  assert.equal((await ctx.m.post(`/api/collections/${c.body.id}/confirm`, {})).status, 200);
  const receipts = (await ctx.m.get(`/api/receivables/receipts?shopId=${ctx.shopB}`)).body;
  assert.equal(receipts.length, 1);
  const r = (await ctx.m.get(`/api/receivables/receipts/${receipts[0].id}`)).body;
  assert.equal(r.collection_id, c.body.id);
  assert.deepEqual(r.allocations.map((a) => [a.invoice_id, a.amount_minor, a.method]), [[old.id, 3000, 'auto'], [newer.id, 5000, 'auto']]);
  assert.equal(r.unallocated_minor, 2000);
  assert.equal(await invoiceOpen(old.id), 0);
  ctx.receiptB = r;
  ctx.invB = { old, newer };
});

test('allocations cannot exceed an invoice open amount or the receipt amount', async () => {
  const inv = await postedInvoice(ctx.shopB, '15.00');
  const r = ctx.receiptB;
  const tooMuchForInvoice = await ctx.m.put(`/api/receivables/receipts/${r.id}/allocations`, { allocations: [{ invoiceId: inv.id, amount: '15.01' }] });
  assert.equal(tooMuchForInvoice.status, 409);
  assert.equal(tooMuchForInvoice.body.error, 'exceeds_invoice_open');
  const tooMuchForReceipt = await ctx.m.put(`/api/receivables/receipts/${r.id}/allocations`, {
    allocations: [{ invoiceId: ctx.invB.old.id, amount: '30' }, { invoiceId: ctx.invB.newer.id, amount: '50' }, { invoiceId: inv.id, amount: '15' }, { invoiceId: ctx.orderInvoice.id, amount: '10' }],
  });
  assert.equal(tooMuchForReceipt.body.error, 'invoice_shop_mismatch');
  const overReceipt = await ctx.m.post('/api/receivables/receipts', { shopId: ctx.shopB, amount: '10', autoAllocate: false });
  const over = await ctx.m.put(`/api/receivables/receipts/${overReceipt.body.id}/allocations`, { allocations: [{ invoiceId: inv.id, amount: '10.01' }] });
  assert.equal(over.body.error, 'exceeds_receipt');
  // A failed allocation leaves the previous allocation set untouched.
  assert.deepEqual((await ctx.m.get(`/api/receivables/receipts/${r.id}`)).body.allocations.length, 2);
  // Manual override: move the on-account 20 onto the new invoice (partial 15).
  const ok = await ctx.m.put(`/api/receivables/receipts/${r.id}/allocations`, {
    allocations: [{ invoiceId: ctx.invB.old.id, amount: '30' }, { invoiceId: ctx.invB.newer.id, amount: '50' }, { invoiceId: inv.id, amount: '15' }],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.unallocated_minor, 500);
  assert.equal(await invoiceOpen(inv.id), 0);
  ctx.invB.small = inv;
});

test('credit note on a paid invoice is refused until its receipt is un-allocated', async () => {
  const line = ctx.invB.small.lines[0];
  const cn = await ctx.m.post('/api/sales/credit-notes', { invoiceId: ctx.invB.small.id, lines: [{ invoiceLineId: line.id, qty: 1 }] });
  assert.equal(cn.status, 409);
  assert.equal(cn.body.error, 'exceeds_invoice_open');
});

// ---------------------------------------------------------------------
// Cheques
// ---------------------------------------------------------------------

test('cheque received settles invoices; a bounced cheque restores the invoice open amount via reversal', async () => {
  const inv = await postedInvoice(ctx.shopC, '40.00');
  const before = h.arSumMinor(server.dbPath, ctx.cid, ctx.shopC);
  const chq = await ctx.m.post('/api/receivables/cheques', { shopId: ctx.shopC, chequeNumber: '778899', bankName: 'المصرف التجاري', dueDate: daysAhead(30), amount: '40.00' });
  assert.equal(chq.status, 201, JSON.stringify(chq.body));
  assert.equal(chq.body.status, 'in_portfolio');
  assert.equal(await invoiceOpen(inv.id), 0);
  assert.equal(h.arSumMinor(server.dbPath, ctx.cid, ctx.shopC), before - 4000);
  const dup = await ctx.m.post('/api/receivables/cheques', { shopId: ctx.shopC, chequeNumber: '778899', bankName: 'المصرف التجاري', dueDate: daysAhead(30), amount: '1' });
  assert.equal(dup.body.error, 'duplicate_cheque');

  assert.equal((await ctx.m.post(`/api/receivables/cheques/${chq.body.id}/deposit`, {})).status, 200);
  const bounced = await ctx.m.post(`/api/receivables/cheques/${chq.body.id}/bounce`, { reason: 'رصيد غير كافٍ' });
  assert.equal(bounced.status, 200, JSON.stringify(bounced.body));
  assert.equal(bounced.body.status, 'bounced');
  assert.equal(await invoiceOpen(inv.id), 4000, 'invoice open again');
  assert.equal(h.arSumMinor(server.dbPath, ctx.cid, ctx.shopC), before, 'customer owes again');
  const receipt = (await ctx.m.get(`/api/receivables/receipts/${chq.body.receipt.id}`)).body;
  assert.equal(receipt.status, 'reversed');
  assert.ok(receipt.reversal_entry_id);
  assert.equal((await ctx.m.post(`/api/receivables/cheques/${chq.body.id}/bounce`, {})).body.error, 'already_bounced');

  const good = await ctx.m.post('/api/receivables/cheques', { shopId: ctx.shopC, chequeNumber: '778900', dueDate: daysAhead(10), amount: '40.00' });
  const cleared = await ctx.m.post(`/api/receivables/cheques/${good.body.id}/clear`, {});
  assert.equal(cleared.body.status, 'cleared');
  assert.equal((await ctx.m.post(`/api/receivables/cheques/${good.body.id}/bounce`, {})).body.error, 'cheque_already_cleared');
  ctx.invC = inv;
});

test('a collection entry cannot be reversed from the journal screen; the collection reverse action reverses it and frees allocations', async () => {
  const inv = await postedInvoice(ctx.shopC, '12.00');
  const c = await ctx.m.post('/api/collections', { shopId: ctx.shopC, method: 'cash', amount: 12 });
  await ctx.m.post(`/api/collections/${c.body.id}/confirm`, {});
  assert.equal(await invoiceOpen(inv.id), 0);
  const collectedBefore = h.raw(server.dbPath).prepare("SELECT SUM(amount) s FROM collections WHERE company_id = ? AND status = 'confirmed'").get(ctx.cid).s;
  const entry = h.raw(server.dbPath).prepare("SELECT id FROM journal_entries WHERE source_type = 'collection' AND source_id = ?").get(c.body.id);
  const generic = await ctx.m.post(`/api/ledger/entries/${entry.id}/reverse`, { reason: 'خطأ' });
  assert.equal(generic.status, 409);
  assert.equal(generic.body.error, 'reverse_via_source');
  assert.match(generic.body.message, /عكس التحصيل/);
  assert.equal((await ctx.m.post(`/api/collections/${c.body.id}/reverse`, {})).body.error, 'reason_required');
  const viewer = await createRep(server.baseUrl, ctx.m, { permissions: ['confirm_collections'] });
  assert.equal((await viewer.client.post(`/api/collections/${c.body.id}/reverse`, { reason: 'x' })).status, 403, 'needs reverse_journal_entries too');
  const rev = await ctx.m.post(`/api/collections/${c.body.id}/reverse`, { reason: 'شيك مرتجع نقدًا' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal(rev.body.status, 'reversed');
  assert.equal(await invoiceOpen(inv.id), 1200);
  const receipt = h.raw(server.dbPath).prepare('SELECT status FROM customer_receipts WHERE collection_id = ?').get(c.body.id);
  assert.equal(receipt.status, 'reversed');
  assert.equal((await ctx.m.post(`/api/collections/${c.body.id}/reverse`, { reason: 'x' })).body.error, 'already_reversed');
  // Totals exclude reversed collections.
  const collectedAfter = h.raw(server.dbPath).prepare("SELECT SUM(amount) s FROM collections WHERE company_id = ? AND status = 'confirmed'").get(ctx.cid).s;
  assert.equal(collectedBefore - collectedAfter, 12);
  const dash = JSON.stringify((await ctx.m.get('/api/departments/accounting')).body);
  assert.ok(dash.includes('collectedTotal'));
  const report = (await ctx.m.get('/api/collections/report/summary')).body;
  assert.equal(JSON.stringify(report).includes('"reversed"'), false);
  const changes = (await ctx.m.get(`/api/collections/${c.body.id}/changes`)).body;
  assert.ok(changes.some((ch) => ch.action === 'reverse'));
});

test('every document-sourced entry type is refused by the generic reverse with an Arabic message naming its action', async () => {
  const cn = await ctx.m.post('/api/sales/credit-notes', { shopId: ctx.shopA, reason: 'تسوية', lines: [{ description: 'خصم', qty: 1, unitPrice: '1' }] });
  assert.equal(cn.status, 201, JSON.stringify(cn.body));
  const d = h.raw(server.dbPath);
  const bySource = d.prepare("SELECT source_type, MIN(id) id FROM journal_entries WHERE company_id = ? AND status = 'posted' AND source_type NOT IN ('manual', 'reversal') GROUP BY source_type").all(ctx.cid);
  d.close();
  const types = bySource.map((r) => r.source_type).sort();
  for (const t of ['collection', 'customer_opening', 'customer_receipt', 'sales_credit_note', 'sales_invoice']) assert.ok(types.includes(t), `no ${t} entry to test`);
  for (const r of bySource) {
    const res = await ctx.m.post(`/api/ledger/entries/${r.id}/reverse`, {});
    assert.equal(res.status, 409, r.source_type);
    assert.equal(res.body.error, 'reverse_via_source');
    assert.equal(res.body.source_type, r.source_type);
    assert.match(res.body.message, /لا يمكن عكس هذا القيد من شاشة القيود/);
  }
  // A manual entry still reverses normally.
  const manual = await ctx.m.post('/api/ledger/entries', { date: h.TODAY, post: true, lines: [{ accountId: ctx.acc('6500'), debit: '1' }, { accountId: ctx.acc('1110'), credit: '1' }] });
  assert.equal((await ctx.m.post(`/api/ledger/entries/${manual.body.id}/reverse`, {})).status, 200);
});

// ---------------------------------------------------------------------
// Aging, forecast, reconciliation
// ---------------------------------------------------------------------

test('aging totals equal the receivable control account on every test date, for every grouping', async () => {
  for (const asOf of [daysAgo(60), daysAgo(36), daysAgo(3), h.TODAY, daysAhead(45), daysAhead(120)]) {
    for (const groupBy of ['customer', 'rep', 'region', 'branch']) {
      const res = await ctx.m.get(`/api/receivables/aging?asOf=${asOf}&groupBy=${groupBy}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.totals.total, res.body.control_minor, `asOf ${asOf} by ${groupBy}`);
      assert.equal(res.body.rows.reduce((s, r) => s + r.total, 0), res.body.control_minor);
      const bucketSum = ['b0_30', 'b31_60', 'b61_90', 'b90_plus', 'legacy', 'credits'].reduce((s, k) => s + res.body.totals[k], 0);
      assert.equal(bucketSum, res.body.totals.total);
    }
  }
});

test('aging buckets by due date and drills down to invoices', async () => {
  const shop = await h.mkShop(ctx.m, 'محل الأعمار المتعددة');
  await postedInvoice(shop, '10.00', { invoiceDate: daysAgo(100), dueDate: daysAgo(95) });
  await postedInvoice(shop, '20.00', { invoiceDate: daysAgo(70), dueDate: daysAgo(65) });
  await postedInvoice(shop, '30.00', { invoiceDate: daysAgo(50), dueDate: daysAgo(45) });
  await postedInvoice(shop, '40.00', { invoiceDate: daysAgo(10), dueDate: daysAhead(20) });
  const rec = await ctx.m.post('/api/receivables/receipts', { shopId: shop, amount: '5.00', autoAllocate: false });
  assert.equal(rec.status, 201);
  const res = await ctx.m.get(`/api/receivables/aging/customer/${shop}`);
  assert.deepEqual(
    { b0_30: res.body.totals.b0_30, b31_60: res.body.totals.b31_60, b61_90: res.body.totals.b61_90, b90_plus: res.body.totals.b90_plus, credits: res.body.totals.credits },
    { b0_30: 4000, b31_60: 3000, b61_90: 2000, b90_plus: 1000, credits: -500 }
  );
  assert.ok(res.body.items.filter((i) => i.document?.type === 'sales_invoice').length === 4);
  assert.ok(res.body.items.find((i) => i.document?.type === 'customer_receipt'));
  // As of 60 days ago only the two oldest existed.
  const past = await ctx.m.get(`/api/receivables/aging/customer/${shop}?asOf=${daysAgo(60)}`);
  assert.equal(past.body.totals.total, 3000);
});

test('collection forecast spreads open items into weeks and adds up to the open debit items', async () => {
  const res = await ctx.m.get('/api/receivables/forecast?weeks=8');
  assert.equal(res.status, 200);
  assert.equal(res.body.weeks.length, 9);
  const sum = res.body.weeks.reduce((s, w) => s + w.amount_minor, 0);
  assert.equal(sum, res.body.customers.reduce((s, c) => s + c.open_minor, 0));
  assert.ok(sum > 0);
  assert.equal(typeof res.body.customers[0].delay_days, 'number');
});

test('reconciliation: zero difference on clean data, differences listed when one is forced', async () => {
  const clean = await ctx.m.get('/api/receivables/reconciliation');
  assert.equal(clean.body.current.difference_minor, 0);
  assert.deepEqual(clean.body.current.differences, []);
  // Forced: an AR line with no customer, and a tampered displayed balance.
  const forced = await ctx.m.post('/api/ledger/entries', {
    date: h.TODAY, post: true, description: 'قيد على الذمم بلا زبون',
    lines: [{ accountId: ctx.acc('1130'), debit: '7.00' }, { accountId: ctx.acc('4900'), credit: '7.00' }],
  });
  assert.equal(forced.status, 201);
  const d = h.raw(server.dbPath);
  d.prepare("UPDATE balances SET balance = balance + 1 WHERE shop_id = ? AND source_file = 'ledger'").run(ctx.shopA);
  d.close();
  const res = await ctx.m.post('/api/receivables/reconciliation/run', {});
  assert.equal(res.body.difference_minor, 700);
  const types = res.body.differences.map((x) => x.type).sort();
  assert.deepEqual(types, ['displayed_balance', 'no_customer']);
  assert.equal(res.body.differences.find((x) => x.type === 'displayed_balance').shop_id, ctx.shopA);
  const hist = await ctx.m.get('/api/receivables/reconciliation');
  assert.equal(hist.body.history[0].difference_count, 2);
  // The aging shows the unassigned amount instead of hiding it.
  const aging = await ctx.m.get('/api/receivables/aging');
  assert.equal(aging.body.unassigned_minor, 700);
  // Undo the forced differences.
  await ctx.m.post(`/api/ledger/entries/${forced.body.id}/reverse`, {});
  const d2 = h.raw(server.dbPath);
  d2.prepare("UPDATE balances SET balance = balance - 1 WHERE shop_id = ? AND source_file = 'ledger'").run(ctx.shopA);
  d2.close();
  assert.equal((await ctx.m.post('/api/receivables/reconciliation/run', {})).body.differences.length, 0);
});

// ---------------------------------------------------------------------
// Credit control
// ---------------------------------------------------------------------

test('credit control on invoices: warn by default, block when configured, override needs permission + reason', async () => {
  const d = h.raw(server.dbPath);
  d.prepare('UPDATE shops SET debt_threshold_override = 100 WHERE id = ?').run(ctx.shopC);
  d.close();
  const draft = async () => (await ctx.m.post('/api/sales/invoices', { shopId: ctx.shopC, lines: [{ description: 'كمية كبيرة', qty: 1, unitPrice: '500' }] })).body;
  const warned = await ctx.m.post(`/api/sales/invoices/${(await draft()).id}/post`, {});
  assert.equal(warned.status, 200);
  assert.equal(warned.body.credit_check.warning, true);

  assert.equal((await ctx.m.put('/api/receivables/settings', { invoiceCreditPolicy: 'block' })).status, 200);
  const blockedDraft = await draft();
  const poster = await createRep(server.baseUrl, ctx.m, { permissions: ['post_sales_invoices', 'view_sales_invoices'] });
  const blocked = await poster.client.post(`/api/sales/invoices/${blockedDraft.id}/post`, { creditOverrideReason: 'زبون مهم' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'credit_limit_blocked');
  const noReason = await ctx.m.post(`/api/sales/invoices/${blockedDraft.id}/post`, {});
  assert.equal(noReason.body.error, 'credit_override_reason_required');
  const overridden = await ctx.m.post(`/api/sales/invoices/${blockedDraft.id}/post`, { creditOverrideReason: 'موافقة المدير' });
  assert.equal(overridden.status, 200, JSON.stringify(overridden.body));
  assert.equal(overridden.body.credit_check.overridden, true);
  await ctx.m.put('/api/receivables/settings', { invoiceCreditPolicy: 'warn' });
});

test('credit control on orders: a hard block can be overridden only with override_credit_limit and a reason', async () => {
  await ctx.m.put('/api/orders/settings/lifecycle', { creditLimitEnforcement: 'blocked' });
  const body = { order_date: h.TODAY, items: [{ product_name: 'x', qty: 1, unit_price: 900, line_total: 900 }], total_value: 900 };
  const rep = await createRep(server.baseUrl, ctx.m, { permissions: ['add_orders', 'view_app'] });
  const repTry = await rep.client.post(`/api/shops/${ctx.shopC}/orders`, { ...body, credit_override_reason: 'أرجو' });
  assert.equal(repTry.status, 403);
  assert.equal(repTry.body.error, 'credit_limit_blocked');
  assert.equal((await ctx.m.post(`/api/shops/${ctx.shopC}/orders`, body)).status, 403);
  const ok = await ctx.m.post(`/api/shops/${ctx.shopC}/orders`, { ...body, credit_override_reason: 'استثناء موافق عليه' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const row = h.raw(server.dbPath).prepare('SELECT credit_limit_exceeded, credit_override_reason FROM orders WHERE id = ?').get(ok.body.id);
  assert.deepEqual({ ...row }, { credit_limit_exceeded: 1, credit_override_reason: 'استثناء موافق عليه' });
  await ctx.m.put('/api/orders/settings/lifecycle', { creditLimitEnforcement: 'rep_decides' });
});

// ---------------------------------------------------------------------
// Statements, dashboards, permissions, audit
// ---------------------------------------------------------------------

test('customer statement from the ledger: opening + lines + closing, Excel and PDF exports', async () => {
  const st = await ctx.m.get(`/api/receivables/customers/${ctx.shopB}/statement?from=${daysAgo(20)}&to=${h.TODAY}`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.opening_minor, 3000, 'the 40-day-old invoice is before the period');
  assert.equal(st.body.closing_minor, h.arSumMinor(server.dbPath, ctx.cid, ctx.shopB));
  const login = await fetch(`${server.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: ctx.company.managerContact, password: ctx.company.managerPassword }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const xlsx = await fetch(`${server.baseUrl}/api/receivables/customers/${ctx.shopB}/statement?format=xlsx`, { headers: { Cookie: cookie } });
  assert.equal(xlsx.status, 200);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
  const text = [];
  wb.worksheets[0].eachRow((r) => text.push(r.values.join('|')));
  assert.ok(text.some((t) => t.includes('الرصيد الختامي')), 'Arabic text in the Excel export');
  const pdf = await fetch(`${server.baseUrl}/api/receivables/customers/${ctx.shopB}/statement?format=pdf`, { headers: { Cookie: cookie } });
  if (pdf.status === 200 || process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    // With a browser available the export must work (strict).
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  } else {
    // pdfExport.js needs a headless Chromium; report, don't hide.
    assert.equal((await pdf.json()).error, 'pdf_export_failed');
    console.log('# NOTE: PDF statement export could not render in this environment (no Chromium for playwright)');
  }
});

test('sending a statement by WhatsApp is guarded by send_account_statements and logged', async () => {
  const noPerm = await createRep(server.baseUrl, ctx.m, { permissions: ['view_receivables'] });
  assert.equal((await noPerm.client.post(`/api/receivables/customers/${ctx.shopB}/statement/send`, {})).status, 403);
  const res = await ctx.m.post(`/api/receivables/customers/${ctx.shopB}/statement/send`, {});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.message, /الرصيد الختامي/);
  assert.equal(res.body.intent, 'account_statement');
});

test('dashboard receivables and overdue fields read from the ledger (keys unchanged)', async () => {
  const dash = await ctx.m.get('/api/departments/accounting');
  assert.equal(dash.status, 200);
  const fields = JSON.stringify(dash.body);
  assert.ok(fields.includes('receivables') && fields.includes('overdueShops'));
  const d = h.raw(server.dbPath);
  const positive = d.prepare(`SELECT SUM(b) s FROM (SELECT SUM(l.debit_minor - l.credit_minor) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND a.system_key = 'ar_control' AND l.party_type = 'customer' GROUP BY l.party_id HAVING b > 0)`).get(ctx.cid).s;
  d.close();
  const find = (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (obj.key === key) return obj;
    for (const v of Object.values(obj)) {
      const f = find(v, key);
      if (f) return f;
    }
    return undefined;
  };
  const rec = find(dash.body, 'receivables');
  assert.ok(rec, JSON.stringify(dash.body).slice(0, 400));
  assert.equal(Math.round(rec.value * 100), positive);
  assert.ok(find(dash.body, 'overdueShops').value >= 1);
});

test('permissions: view-only cannot allocate, receive cheques or reverse receipts', async () => {
  const viewer = await createRep(server.baseUrl, ctx.m, { permissions: ['view_receivables'] });
  assert.equal((await viewer.client.get('/api/receivables/aging')).status, 200);
  assert.equal((await viewer.client.put(`/api/receivables/receipts/${ctx.receiptB.id}/allocations`, { allocations: [] })).status, 403);
  assert.equal((await viewer.client.post('/api/receivables/cheques', {})).status, 403);
  assert.equal((await viewer.client.post(`/api/receivables/receipts/${ctx.receiptB.id}/reverse`, {})).status, 403);
  const outsider = await createRep(server.baseUrl, ctx.m, { permissions: ['view_app'] });
  assert.equal((await outsider.client.get('/api/receivables/aging')).status, 403);
});

test('audit log covers receivables actions', async () => {
  const actions = new Set((await ctx.m.get('/api/audit-log?limit=500')).body.map((r) => r.action));
  for (const a of ['sales.invoice.from_order', 'receivables.receipt.create', 'receivables.allocation.auto', 'receivables.allocation.set', 'receivables.receipt.reverse',
    'receivables.cheque.receive', 'receivables.cheque.deposit', 'receivables.cheque.bounce', 'receivables.cheque.clear', 'receivables.statement.send', 'receivables.settings.update']) {
    assert.ok(actions.has(a), `missing ${a}`);
  }
});

test('integrity check clean at the end', async () => {
  assert.deepEqual((await ctx.m.get('/api/ledger/integrity-check')).body.violations, []);
});

test('receipt backfill for collections confirmed before receipts existed is idempotent and makes them allocatable', async () => {
  const inv = await postedInvoice(ctx.shopB, '6.00');
  const c = await ctx.m.post('/api/collections', { shopId: ctx.shopB, method: 'transfer', amount: 6, transferReference: 'OLD' });
  await ctx.m.post(`/api/collections/${c.body.id}/confirm`, {});
  // Simulate a collection confirmed in the Prompt 2 era: entry, no receipt.
  const d = h.raw(server.dbPath);
  const rid = d.prepare('SELECT id FROM customer_receipts WHERE collection_id = ?').get(c.body.id).id;
  d.prepare('DELETE FROM receipt_allocations WHERE receipt_id = ?').run(rid);
  d.prepare('DELETE FROM customer_receipts WHERE id = ?').run(rid);
  d.close();
  assert.equal(await invoiceOpen(inv.id), 600);

  const dry = await ctx.m.post('/api/receivables/backfill-receipts', {});
  assert.equal(dry.body.dry_run, true);
  assert.ok(dry.body.plan.some((p) => p.collection_id === c.body.id && p.amount_minor === 600 && p.method === 'transfer'));
  // A collection reversed through its action is not "missing" a receipt.
  assert.ok(!dry.body.plan.some((p) => p.entry_id === undefined));
  const countReceipts = () => h.count(server.dbPath, 'SELECT COUNT(*) c FROM customer_receipts WHERE company_id = ?', ctx.cid);
  const before = countReceipts();
  const first = await ctx.m.post('/api/receivables/backfill-receipts', { execute: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.created, dry.body.to_create);
  assert.equal(countReceipts(), before + first.body.created);
  const r = h.raw(server.dbPath).prepare('SELECT * FROM customer_receipts WHERE collection_id = ?').get(c.body.id);
  assert.equal(r.amount_minor, 600);
  assert.equal(await invoiceOpen(inv.id), 0, 'auto-allocated oldest-first');
  const snapshot = () => JSON.stringify(h.raw(server.dbPath).prepare('SELECT id, collection_id, amount_minor, status FROM customer_receipts ORDER BY id').all().concat(h.raw(server.dbPath).prepare('SELECT receipt_id, invoice_id, amount_minor FROM receipt_allocations ORDER BY id').all()));
  const s1 = snapshot();
  const second = await ctx.m.post('/api/receivables/backfill-receipts', { execute: true });
  assert.equal(second.body.created, 0);
  assert.equal(snapshot(), s1, 'second run changes nothing');
  // No journal entries were created by the backfill.
  assert.equal(h.count(server.dbPath, "SELECT COUNT(*) c FROM journal_entries WHERE source_type = 'collection' AND source_id = ?", c.body.id), 1);
});
