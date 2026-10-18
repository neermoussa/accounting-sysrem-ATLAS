// backend/test/sales.test.js
//
// Prompt 2 — sales invoices, credit notes, automatic postings of existing
// events (collections, returns), derived balances, go-live backfill and
// the Amin external snapshot. Company base currency USD (2 digits).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, createRep } = require('./helpers');
const h = require('./salesHelpers');

let server;
let ctx;

const entriesFor = (sourceType, sourceId) =>
  h.count(server.dbPath, "SELECT COUNT(*) c FROM journal_entries WHERE company_id = ? AND source_type = ? AND source_id = ? AND status <> 'draft'", ctx.cid, sourceType, sourceId);
const allEntries = () => h.count(server.dbPath, 'SELECT COUNT(*) c FROM journal_entries WHERE company_id = ?', ctx.cid);

function entryBalanced(entryId) {
  const d = h.raw(server.dbPath);
  const r = d.prepare('SELECT SUM(debit_minor) d, SUM(credit_minor) c FROM journal_lines WHERE entry_id = ?').get(entryId);
  d.close();
  assert.equal(r.d, r.c, `entry ${entryId} not balanced`);
  return r.d;
}

async function newCollection(shopId, amount, method = 'cash') {
  const c = await ctx.m.post('/api/collections', { shopId, method, amount, transferReference: method === 'transfer' ? 'T-1' : undefined });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  return c.body.id;
}

test.before(async () => {
  server = await startServer();
  const company = await h.createUsdCompany(server.baseUrl);
  ctx = { company, m: company.manager, cid: company.companyId };
  const { accounts } = await h.setupLedger(ctx.m);
  ctx.acc = (code) => accounts.find((a) => a.code === code).id;
  ctx.shopA = await h.mkShop(ctx.m, 'بقالة الأمل');
  ctx.shopB = await h.mkShop(ctx.m, 'سوبرماركت النور');
  ctx.nuts = await h.mkProduct(ctx.m, { name: 'كاجو 500غ', category: 'مكسرات', base_price: 12.5, cost_price: 8.25 });
  ctx.plain = await h.mkProduct(ctx.m, { name: 'كيس ورقي', base_price: 0.1 });
  h.seedSnapshot(server.dbPath, ctx.shopA, 1000);
  h.seedSnapshot(server.dbPath, ctx.shopB, -50.25);
});

test.after(() => server.stop());

// ---------------------------------------------------------------------
// Invoices (before go-live)
// ---------------------------------------------------------------------

test('invoice draft: priced by the existing pricing engine, rounded per line, residue to rounding_difference', async () => {
  const res = await ctx.m.post('/api/sales/invoices', {
    shopId: ctx.shopA, invoiceDate: h.TODAY,
    lines: [
      { productId: ctx.nuts, qty: 2 }, // pricing engine: base_price 12.50
      { description: 'خدمة 1', qty: 0.5, unitPrice: '0.01' }, // 0.5 cent -> 1
      { description: 'خدمة 2', qty: 0.5, unitPrice: '0.01' }, // 0.5 cent -> 1
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const inv = res.body;
  assert.equal(inv.status, 'draft');
  assert.equal(inv.lines[0].unit_price_minor, 1250);
  assert.equal(inv.lines[0].price_source, 'base_price');
  assert.equal(inv.lines[1].net_minor, 1);
  assert.equal(inv.lines[2].net_minor, 1);
  // exact total 2500 + 0.5 + 0.5 = 2501 cents; lines sum to 2502 -> -1 residue
  assert.equal(inv.total_minor, 2501);
  assert.equal(inv.rounding_minor, -1);
  ctx.invA = inv;
});

test('posting an invoice creates exactly one balanced entry and records its id; replay posts nothing', async () => {
  const before = h.count(server.dbPath, 'SELECT COUNT(*) c FROM balances WHERE shop_id = ?', ctx.shopA);
  const res = await ctx.m.post(`/api/sales/invoices/${ctx.invA.id}/post`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const inv = res.body;
  assert.equal(inv.status, 'posted');
  assert.match(inv.invoice_number, /^SI-/);
  assert.ok(inv.journal_entry);
  assert.equal(entriesFor('sales_invoice', inv.id), 1);
  entryBalanced(inv.journal_entry_id);

  const d = h.raw(server.dbPath);
  const lines = d
    .prepare('SELECT a.system_key, a.code, l.debit_minor, l.credit_minor, l.party_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?')
    .all(inv.journal_entry_id);
  d.close();
  const by = (k) => lines.find((l) => l.system_key === k);
  assert.equal(by('ar_control').debit_minor, 2501);
  assert.equal(by('ar_control').party_id, ctx.shopA);
  assert.equal(by('sales_revenue').credit_minor, 2502);
  assert.equal(by('rounding_difference').debit_minor, 1);
  assert.equal(by('cogs').debit_minor, 1650); // 2 x 8.25
  assert.equal(by('inventory').credit_minor, 1650);

  const replay = await ctx.m.post(`/api/sales/invoices/${ctx.invA.id}/post`, {});
  assert.equal(replay.status, 409);
  assert.equal(entriesFor('sales_invoice', inv.id), 1);
  // Not live yet: the legacy balances table is untouched by ledger postings.
  assert.equal(h.count(server.dbPath, 'SELECT COUNT(*) c FROM balances WHERE shop_id = ?', ctx.shopA), before);
  ctx.invA = inv;
});

test('revenue goes to the product category account when one is mapped', async () => {
  const map = await ctx.m.put('/api/sales/category-accounts', { category: 'مكسرات', accountId: ctx.acc('4900') });
  assert.equal(map.status, 200, JSON.stringify(map.body));
  const inv = await ctx.m.post('/api/sales/invoices', { shopId: ctx.shopB, lines: [{ productId: ctx.nuts, qty: 1, unitPrice: '10', taxRate: '5' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.lines[0].revenue_account_id, ctx.acc('4900'));
  assert.equal(inv.body.tax_minor, 50);
  assert.equal(inv.body.total_minor, 1050);
  const posted = await ctx.m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(posted.status, 200);
  entryBalanced(posted.body.journal_entry_id);
  ctx.invB = posted.body;
  await ctx.m.put('/api/sales/category-accounts', { category: 'مكسرات', accountId: null });
});

test('posted invoices cannot be edited or deleted; a foreign-currency invoice needs a rate to post (Prompt 5)', async () => {
  assert.equal((await ctx.m.put(`/api/sales/invoices/${ctx.invA.id}`, { notes: 'x' })).status, 409);
  assert.equal((await ctx.m.del(`/api/sales/invoices/${ctx.invA.id}`)).status, 409);
  const eur = await ctx.m.post('/api/sales/invoices', { shopId: ctx.shopA, currencyCode: 'EUR', lines: [{ description: 'x', qty: 1, unitPrice: '1' }] });
  assert.equal(eur.status, 201, JSON.stringify(eur.body));
  const noRate = await ctx.m.post(`/api/sales/invoices/${eur.body.id}/post`, {});
  assert.equal(noRate.status, 409);
  assert.equal(noRate.body.error, 'rate_missing');
  assert.equal((await ctx.m.del(`/api/sales/invoices/${eur.body.id}`)).status, 200);
  const draft = await ctx.m.post('/api/sales/invoices', { shopId: ctx.shopA, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] });
  const upd = await ctx.m.put(`/api/sales/invoices/${draft.body.id}`, { lines: [{ description: 'y', qty: 2, unitPrice: '3' }] });
  assert.equal(upd.body.total_minor, 600);
  assert.equal((await ctx.m.del(`/api/sales/invoices/${draft.body.id}`)).status, 200);
});

test('credit note against an invoice: partial, then over-credit refused, then cancel credits the rest', async () => {
  const line = ctx.invB.lines[0];
  const cn = await ctx.m.post('/api/sales/credit-notes', { invoiceId: ctx.invB.id, reason: 'جزئي', lines: [{ invoiceLineId: line.id, qty: 0.5 }] });
  assert.equal(cn.status, 201, JSON.stringify(cn.body));
  assert.equal(cn.body.total_minor, 525);
  assert.equal(entriesFor('sales_credit_note', cn.body.id), 1);
  entryBalanced(cn.body.journal_entry_id);
  const over = await ctx.m.post('/api/sales/credit-notes', { invoiceId: ctx.invB.id, lines: [{ invoiceLineId: line.id, qty: 0.6 }] });
  assert.equal(over.body.error, 'qty_exceeds_invoice');
  const cancel = await ctx.m.post(`/api/sales/invoices/${ctx.invB.id}/cancel`, { reason: 'إلغاء', restock: true });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const inv = (await ctx.m.get(`/api/sales/invoices/${ctx.invB.id}`)).body;
  assert.equal(inv.status, 'cancelled');
  assert.equal(inv.credited_minor, inv.total_minor);
  assert.equal(h.arSumMinor(server.dbPath, ctx.cid, ctx.shopB), 0, 'fully credited invoice nets to zero');
});

// ---------------------------------------------------------------------
// Go-live
// ---------------------------------------------------------------------

test('modules endpoint cannot switch ledger_live on', async () => {
  await ctx.m.put('/api/companies/modules', { modules: { ledger_live: true } });
  const me = await ctx.m.get('/api/sales/meta');
  assert.equal(me.body.live, false);
});

test('go-live dry run records a report, writes no entries, and plans opening = snapshot - existing ledger balance', async () => {
  const before = allEntries();
  const plan = await ctx.m.post('/api/sales/go-live/dry-run', { date: h.TODAY });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.dry_run, true);
  assert.ok(plan.body.dry_run_id);
  assert.equal(plan.body.ok, true, JSON.stringify(plan.body.problems));
  const a = plan.body.rows.find((r) => r.shop_id === ctx.shopA);
  assert.equal(a.snapshot_minor, 100000);
  assert.equal(a.existing_ledger_minor, 2501);
  assert.equal(a.opening_minor, 100000 - 2501);
  const b = plan.body.rows.find((r) => r.shop_id === ctx.shopB);
  assert.equal(b.opening_minor, -5025);
  assert.equal(allEntries(), before);
  ctx.dryRunId = plan.body.dry_run_id;
});

test('go-live refuses: wrong/missing confirmation text, no dry run, stale (>24h) dry run, plan changed since the dry run', async () => {
  const before = allEntries();
  const OK = 'Invoices will be created in Atlas from now on';
  for (const confirmText of [undefined, 'yes', OK.toLowerCase()]) {
    const r = await ctx.m.post('/api/sales/go-live', { dryRunId: ctx.dryRunId, confirmText });
    assert.equal(r.body.error, 'confirmation_text_required');
  }
  assert.equal((await ctx.m.post('/api/sales/go-live', { confirmText: OK })).body.error, 'dry_run_required');
  // A dry run older than 24h does not count.
  const d = h.raw(server.dbPath);
  const old = d.prepare("INSERT INTO ledger_go_live_runs (company_id, kind, go_live_date, plan_json, created_at) SELECT company_id, 'dry_run', go_live_date, plan_json, datetime('now', '-25 hours') FROM ledger_go_live_runs WHERE id = ?").run(ctx.dryRunId);
  d.close();
  assert.equal((await ctx.m.post('/api/sales/go-live', { dryRunId: Number(old.lastInsertRowid), confirmText: OK })).body.error, 'dry_run_required');
  // Data changed after the dry run -> must dry-run again.
  h.seedSnapshot(server.dbPath, ctx.shopB, -60, `${h.YEAR}-01-02`);
  assert.equal((await ctx.m.post('/api/sales/go-live', { dryRunId: ctx.dryRunId, confirmText: OK })).body.error, 'plan_changed');
  const d2 = h.raw(server.dbPath);
  d2.prepare("DELETE FROM balances WHERE shop_id = ? AND report_date = ?").run(ctx.shopB, `${h.YEAR}-01-02`);
  d2.close();
  assert.equal(allEntries(), before);
  assert.equal((await ctx.m.get('/api/sales/meta')).body.live, false);
});

test('going live takes a verified backup first, saves the dry-run report, and derived balances match the snapshots', async () => {
  const fs = require('fs');
  const OK = 'Invoices will be created in Atlas from now on';
  const res = await ctx.m.post('/api/sales/go-live', { dryRunId: ctx.dryRunId, confirmText: OK });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.live, true);
  assert.equal(res.body.entry_ids.length, 2);
  assert.ok(fs.existsSync(res.body.backup_path), 'backup file exists');
  // The backup is the state BEFORE go-live: not live, no opening entries.
  const backup = new (require('node:sqlite').DatabaseSync)(res.body.backup_path, { readOnly: true });
  const bModules = JSON.parse(backup.prepare('SELECT modules_json FROM companies WHERE id = ?').get(ctx.cid).modules_json || '{}');
  assert.notEqual(bModules.ledger_live, true);
  assert.equal(backup.prepare("SELECT COUNT(*) c FROM journal_entries WHERE source_type = 'customer_opening'").get().c, 0);
  backup.close();
  const runs = (await ctx.m.get('/api/sales/go-live/runs')).body;
  const executed = runs.runs.find((r) => r.kind === 'executed');
  assert.equal(executed.dry_run_id, ctx.dryRunId);
  assert.equal(executed.backup_path, res.body.backup_path);
  assert.equal(executed.confirmation_text, OK);
  const stored = h.raw(server.dbPath).prepare('SELECT plan_json FROM ledger_go_live_runs WHERE id = ?').get(executed.id).plan_json;
  assert.equal(JSON.parse(stored).rows.length, 2, 'dry-run report saved with the go-live record');

  assert.equal(await h.displayedBalance(ctx.m, ctx.shopA), 1000);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopB), -50.25);
  assert.equal(h.arSumMinor(server.dbPath, ctx.cid, ctx.shopA), 100000);
  for (const id of res.body.entry_ids) entryBalanced(id);
  const again = await ctx.m.post('/api/sales/go-live/dry-run', {});
  assert.equal(again.body.ok, false);
  const exec = await ctx.m.post('/api/sales/go-live', { dryRunId: again.body.dry_run_id, confirmText: OK });
  assert.equal(exec.status, 409);
  assert.equal(exec.body.error, 'already_live');
});

// ---------------------------------------------------------------------
// Live: existing events post to the ledger
// ---------------------------------------------------------------------

test('confirming a collection posts one entry (cash vs transfer) and the balance follows the ledger', async () => {
  const cash = await newCollection(ctx.shopA, 100.1);
  const res = await ctx.m.post(`/api/collections/${cash}/confirm`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(entriesFor('collection', cash), 1);
  const transfer = await newCollection(ctx.shopA, 49.9, 'transfer');
  assert.equal((await ctx.m.post(`/api/collections/${transfer}/confirm`, {})).status, 200);
  // Two events on the same day both count.
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopA), 850);
  const d = h.raw(server.dbPath);
  const keys = d
    .prepare(
      `SELECT a.system_key, l.debit_minor FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'collection' AND e.source_id = ? AND l.debit_minor > 0`
    )
    .all(transfer);
  d.close();
  assert.deepEqual(keys.map((k) => ({ ...k })), [{ system_key: 'bank_in_transit', debit_minor: 4990 }]);
  const replay = await ctx.m.post(`/api/collections/${cash}/confirm`, {});
  assert.equal(replay.status, 409);
  assert.equal(entriesFor('collection', cash), 1);
});

test('a collection whose posting fails is not confirmed (same transaction)', async () => {
  const periods = (await ctx.m.get('/api/ledger/periods')).body;
  const current = periods.find((p) => p.start_date <= h.TODAY && p.end_date >= h.TODAY);
  assert.equal((await ctx.m.post(`/api/ledger/periods/${current.id}/close`, {})).status, 200);
  const id = await newCollection(ctx.shopA, 10);
  const res = await ctx.m.post(`/api/collections/${id}/confirm`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'period_closed');
  assert.equal((await ctx.m.get(`/api/collections/${id}`)).body.status, 'pending_accountant_confirmation');
  assert.equal(entriesFor('collection', id), 0);
  assert.equal((await ctx.m.post(`/api/ledger/periods/${current.id}/reopen`, {})).status, 200);
  assert.equal((await ctx.m.post(`/api/collections/${id}/confirm`, {})).status, 200);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopA), 840);
});

test('approving a return with financial adjustment posts one credit-note entry incl. restock at cost', async () => {
  await ctx.m.put('/api/returns/settings/financial', { autoFinancialAdjustment: true });
  const r = await ctx.m.post('/api/returns', {
    shopId: ctx.shopA, reason: 'تالف',
    items: [{ productId: ctx.nuts, productName: 'كاجو 500غ', qty: 2, unitValue: 12.5 }, { productName: 'مادة بلا بطاقة', qty: 3, unitValue: 0.333 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const it of r.body.items) {
    await ctx.m.put(`/api/returns/${r.body.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: it.requested_qty });
  }
  const res = await ctx.m.post(`/api/returns/${r.body.id}/approve`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // 25.00 + 3 x 0.333 = 25.999 -> 26.00
  assert.equal(res.body.creditApplied, 26);
  const cn = h.raw(server.dbPath).prepare('SELECT * FROM sales_credit_notes WHERE return_request_id = ?').get(r.body.id);
  assert.ok(cn);
  assert.equal(entriesFor('sales_credit_note', cn.id), 1);
  const lines = h.raw(server.dbPath)
    .prepare('SELECT a.system_key, l.debit_minor, l.credit_minor FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?')
    .all(cn.journal_entry_id);
  const by = (k) => lines.find((l) => l.system_key === k);
  assert.equal(by('ar_control').credit_minor, 2600);
  assert.equal(by('inventory').debit_minor, 1650);
  assert.equal(by('cogs').credit_minor, 1650);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopA), 814);
  const again = await ctx.m.post(`/api/returns/${r.body.id}/apply-financial-adjustment`, {});
  assert.equal(again.status, 409);
  assert.equal(entriesFor('sales_credit_note', cn.id), 1);
});

test('manual return adjustment endpoint posts through the ledger when live', async () => {
  await ctx.m.put('/api/returns/settings/financial', { autoFinancialAdjustment: false });
  const r = await ctx.m.post('/api/returns', { shopId: ctx.shopB, items: [{ productName: 'مادة', qty: 1, unitValue: 5 }] });
  for (const it of r.body.items) await ctx.m.put(`/api/returns/${r.body.id}/items/${it.id}/inspect`, { inspectionStatus: 'valid', inspectedQty: 1 });
  const approved = await ctx.m.post(`/api/returns/${r.body.id}/approve`, {});
  assert.equal(approved.body.creditApplied, null);
  const res = await ctx.m.post(`/api/returns/${r.body.id}/apply-financial-adjustment`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.creditApplied, 5);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopB), -55.25);
});

test('posting an invoice when live moves the displayed balance; cancelling it (not a generic reverse) moves it back', async () => {
  const inv = await ctx.m.post('/api/sales/invoices', { shopId: ctx.shopB, lines: [{ description: 'بضاعة', qty: 3, unitPrice: '7.15' }] });
  const posted = await ctx.m.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(posted.status, 200);
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopB), -33.8);
  const generic = await ctx.m.post(`/api/ledger/entries/${posted.body.journal_entry_id}/reverse`, { reason: 'اختبار' });
  assert.equal(generic.status, 409);
  assert.equal(generic.body.error, 'reverse_via_source');
  assert.match(generic.body.message, /إلغاء الفاتورة/);
  const cancel = await ctx.m.post(`/api/sales/invoices/${inv.body.id}/cancel`, { reason: 'اختبار' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopB), -55.25);
});

test('after go-live an Amin import is stored as an external snapshot and shown on reconciliation, not applied', async () => {
  const d = h.raw(server.dbPath);
  const batch = d.prepare("INSERT INTO import_batches (company_id, filename, report_date, status) VALUES (?, 'amin.xlsx', ?, 'pending')").run(ctx.cid, h.TODAY);
  d.prepare("INSERT INTO import_batch_rows (batch_id, phone_raw, balance_raw, matched_shop_id, status) VALUES (?, '0999', 900, ?, 'matched')").run(batch.lastInsertRowid, ctx.shopA);
  d.close();
  const res = await ctx.m.post(`/api/import/batches/${batch.lastInsertRowid}/commit`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await h.displayedBalance(ctx.m, ctx.shopA), 814, 'ledger balance not overwritten');
  assert.equal(h.count(server.dbPath, 'SELECT COUNT(*) c FROM external_balance_snapshots WHERE shop_id = ?', ctx.shopA), 1);
  const rec = await ctx.m.get('/api/sales/reconciliation');
  const row = rec.body.rows.find((r) => r.shop_id === ctx.shopA);
  assert.equal(row.ledger_minor, 81400);
  assert.equal(row.external_minor, 90000);
  assert.equal(row.difference_minor, -8600);
});

test('customer ledger tab: every line with running balance, source links, ends at the displayed balance', async () => {
  const res = await ctx.m.get(`/api/sales/customers/${ctx.shopA}/ledger`);
  assert.equal(res.status, 200);
  const types = new Set(res.body.lines.map((l) => l.source_type));
  for (const t of ['sales_invoice', 'customer_opening', 'collection', 'sales_credit_note']) assert.ok(types.has(t), `missing ${t}`);
  assert.equal(res.body.balance, '814.00');
  assert.equal(res.body.displayed_balance.balance, 814);
  assert.ok(res.body.lines.find((l) => l.source_type === 'sales_invoice').source_number.startsWith('SI-'));
});

test('print layout renders through the existing document renderer', async () => {
  const res = await fetch(`${server.baseUrl}/api/sales/invoices/${ctx.invA.id}/print`, { headers: { Cookie: await cookie() } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /dir="rtl"/);
  assert.ok(html.includes(ctx.invA.invoice_number));
  assert.ok(html.includes('فرق التقريب'));
});

async function cookie() {
  const r = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact: ctx.company.managerContact, password: ctx.company.managerPassword }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}

test('existing readers still work: dashboard, statement, collections report, WhatsApp balance source', async () => {
  assert.equal((await ctx.m.get('/api/departments/accounting')).status, 200);
  const st = await ctx.m.get(`/api/collections/statement/${ctx.shopA}`);
  assert.equal(st.status, 200);
  const rep = await ctx.m.get('/api/collections/report/summary');
  assert.equal(rep.status, 200);
  // The WhatsApp bot reads the latest balances row — now the ledger-derived one.
  const row = h.raw(server.dbPath).prepare('SELECT balance, source_file FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(ctx.shopA);
  assert.deepEqual({ ...row }, { balance: 814, source_file: 'ledger' });
});

test('permissions: a user without sales permissions cannot create, post or credit', async () => {
  const rep = await createRep(server.baseUrl, ctx.m, { permissions: ['view_sales_invoices'] });
  assert.equal((await rep.client.get('/api/sales/invoices')).status, 200);
  assert.equal((await rep.client.post('/api/sales/invoices', { shopId: ctx.shopA, lines: [] })).status, 403);
  assert.equal((await rep.client.post(`/api/sales/invoices/${ctx.invA.id}/post`, {})).status, 403);
  assert.equal((await rep.client.post('/api/sales/credit-notes', {})).status, 403);
  assert.equal((await rep.client.post('/api/sales/go-live', { confirmText: 'x' })).status, 403);
  assert.equal((await rep.client.post('/api/sales/go-live/dry-run', {})).status, 403);
});

test('audit log has a row for every sales action and the go-live', async () => {
  const actions = new Set((await ctx.m.get('/api/audit-log?limit=500')).body.map((r) => r.action));
  for (const a of ['sales.invoice.create', 'sales.invoice.update', 'sales.invoice.delete', 'sales.invoice.post', 'sales.credit_note.create', 'ledger.go_live']) {
    assert.ok(actions.has(a), `missing ${a}`);
  }
});

test('integrity check is clean and the AR control equals the sum of customer sub-ledgers', async () => {
  const res = await ctx.m.get('/api/ledger/integrity-check');
  assert.deepEqual(res.body.violations, []);
  const d = h.raw(server.dbPath);
  const control = d
    .prepare(
      `SELECT SUM(l.debit_minor - l.credit_minor) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id WHERE e.company_id = ? AND a.system_key = 'ar_control'`
    )
    .get(ctx.cid).s;
  d.close();
  assert.equal(control, h.arSumMinor(server.dbPath, ctx.cid, ctx.shopA) + h.arSumMinor(server.dbPath, ctx.cid, ctx.shopB));
});
