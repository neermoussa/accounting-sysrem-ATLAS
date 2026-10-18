// backend/test/tenantIsolation.test.js
//
// Two companies on one backend: company A must never see or touch company
// B's audit rows or ledger data, whatever ids it sends.

const test = require('node:test');
const { openLiveDb } = require('./liveDb');
const assert = require('node:assert/strict');
const { startServer, createCompany } = require('./helpers');

let server;
let A;
let B;
const YEAR = 2026;

test.before(async () => {
  server = await startServer();
  A = await createCompany(server.baseUrl, { name: 'الشركة أ' });
  B = await createCompany(server.baseUrl, { name: 'الشركة ب' });
  for (const c of [A, B]) {
    const applied = await c.manager.post('/api/ledger/coa-templates/trading/apply', {});
    assert.equal(applied.status, 200);
    c.accounts = applied.body.accounts;
    assert.equal((await c.manager.post('/api/ledger/fiscal-years', { year: YEAR })).status, 201);
  }
  const acc = (c, code) => c.accounts.find((a) => a.code === code).id;
  const posted = await B.manager.post('/api/ledger/entries', {
    date: `${YEAR}-02-01`, description: 'سري للشركة ب', post: true,
    lines: [{ accountId: acc(B, '1110'), debit: '777' }, { accountId: acc(B, '4100'), credit: '777' }],
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  B.entry = posted.body;
  A.acc = (code) => acc(A, code);
  B.acc = (code) => acc(B, code);
});

test.after(() => server.stop());

test('company A audit log contains only company A rows', async () => {
  const a = await A.manager.get('/api/audit-log?limit=500');
  assert.equal(a.status, 200);
  assert.ok(a.body.length > 0);
  assert.ok(a.body.every((r) => r.company_id === A.companyId), 'A sees a row from another company');
  assert.ok(!a.body.some((r) => r.entity_type === 'journal_entry' && r.entity_id === B.entry.id));

  const b = await B.manager.get('/api/audit-log?limit=500');
  assert.ok(b.body.some((r) => r.action === 'ledger.entry.post' && r.entity_id === B.entry.id));
  assert.ok(b.body.every((r) => r.company_id === B.companyId));
});

test('audit log filters cannot widen the company scope', async () => {
  const byAction = await A.manager.get('/api/audit-log?action=ledger.entry.post');
  assert.ok(byAction.body.every((r) => r.company_id === A.companyId));
  assert.equal(byAction.body.length, 0, 'A posted nothing');
});

test("company A cannot list, read, reverse or edit company B's ledger entries", async () => {
  const list = await A.manager.get('/api/ledger/entries');
  assert.equal(list.body.total, 0);
  assert.equal((await A.manager.get(`/api/ledger/entries/${B.entry.id}`)).status, 404);
  assert.equal((await A.manager.post(`/api/ledger/entries/${B.entry.id}/reverse`, {})).status, 404);
  assert.equal((await A.manager.put(`/api/ledger/entries/${B.entry.id}`, { description: 'x' })).status, 404);
  assert.equal((await A.manager.del(`/api/ledger/entries/${B.entry.id}`)).status, 404);
  const accounts = await A.manager.get('/api/ledger/accounts');
  assert.ok(!accounts.body.some((a) => a.id === B.acc('1110')));
});

test("company A cannot post to company B's accounts or touch B's periods", async () => {
  const res = await A.manager.post('/api/ledger/entries', {
    date: `${YEAR}-02-02`, post: true,
    lines: [{ accountId: B.acc('1110'), debit: '1' }, { accountId: A.acc('4100'), credit: '1' }],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_account');
  const bPeriods = await B.manager.get('/api/ledger/periods');
  assert.equal((await A.manager.post(`/api/ledger/periods/${bPeriods.body[0].id}/close`, {})).status, 404);
  assert.equal((await A.manager.put(`/api/ledger/accounts/${B.acc('1110')}`, { nameAr: 'x' })).status, 404);
});

test('integrity check and totals are per company', async () => {
  const a = await A.manager.get('/api/ledger/integrity-check');
  assert.equal(a.body.total_debit_minor, 0);
  const b = await B.manager.get('/api/ledger/integrity-check');
  assert.equal(b.body.total_debit_minor, 777);
});

// ---------------------------------------------------------------------
// Standing rule: every client-supplied id is checked against req.companyId
// (lib/tenantRefs.js). One test per ledger create/update endpoint.
// ---------------------------------------------------------------------

async function foreignRefs() {
  if (B.refs) return B.refs;
  const cc = await B.manager.post('/api/ledger/cost-centers', { code: 'BCC', name: 'مركز ب' });
  const pr = await B.manager.post('/api/ledger/projects', { code: 'BPR', name: 'مشروع ب' });
  await B.manager.put('/api/companies/me', { branches: ['فرع ب'] });
  const branch = (await B.manager.get('/api/ledger/meta')).body.branches[0];
  const shop = await B.manager.post('/api/shops', { name: 'زبون ب', lat: 33.5, lng: 36.3 });
  assert.equal(shop.status, 201, JSON.stringify(shop.body));
  const users = await B.manager.get('/api/admin/users');
  const bUser = (Array.isArray(users.body) ? users.body : users.body.users)[0];
  const fy = (await B.manager.get('/api/ledger/fiscal-years')).body[0];
  B.refs = { costCenterId: cc.body.id, projectId: pr.body.id, branchId: branch.id, shopId: shop.body.id, userId: bUser.id, fiscalYearId: fy.id };
  return B.refs;
}

function aLines(extra = {}) {
  return [{ accountId: A.acc('1110'), debit: '5', ...extra }, { accountId: A.acc('4100'), credit: '5' }];
}

for (const [field, make, code] of [
  ['account', (r) => ({ lines: [{ accountId: B.acc('1110'), debit: '5' }, { accountId: A.acc('4100'), credit: '5' }] }), 'invalid_account'],
  ['cost center', (r) => ({ lines: aLines({ costCenterId: r.costCenterId }) }), 'invalid_cost_center'],
  ['project', (r) => ({ lines: aLines({ projectId: r.projectId }) }), 'invalid_project'],
  ['customer party', (r) => ({ lines: aLines({ partyType: 'customer', partyId: r.shopId }) }), 'invalid_shop'],
  ['employee party', (r) => ({ lines: aLines({ partyType: 'employee', partyId: r.userId }) }), 'invalid_user'],
  ['branch', (r) => ({ branchId: r.branchId, lines: aLines() }), 'invalid_branch'],
]) {
  test(`POST /api/ledger/entries rejects a foreign-company ${field} id`, async () => {
    const r = await foreignRefs();
    for (const post of [true, false]) {
      const res = await A.manager.post('/api/ledger/entries', { date: `${YEAR}-02-03`, post, ...make(r) });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, code);
    }
  });

  test(`PUT /api/ledger/entries/:id rejects a foreign-company ${field} id`, async () => {
    const r = await foreignRefs();
    const draft = await A.manager.post('/api/ledger/entries', { date: `${YEAR}-02-03`, lines: aLines() });
    assert.equal(draft.status, 201);
    const res = await A.manager.put(`/api/ledger/entries/${draft.body.id}`, make(r));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, code);
    await A.manager.del(`/api/ledger/entries/${draft.body.id}`);
  });
}

test('a supplier party must be a supplier of this company (Prompt 6)', async () => {
  const res = await A.manager.post('/api/ledger/entries', { date: `${YEAR}-02-03`, lines: aLines({ partyType: 'supplier', partyId: 999999 }) });
  assert.equal(res.body.error, 'invalid_supplier');
  const bogus = await A.manager.post('/api/ledger/entries', { date: `${YEAR}-02-03`, lines: aLines({ partyType: 'vendor', partyId: 1 }) });
  assert.equal(bogus.body.error, 'invalid_party');
});

test('own-company refs are accepted on the same endpoint', async () => {
  const cc = await A.manager.post('/api/ledger/cost-centers', { code: 'ACC', name: 'مركز أ' });
  const shop = await A.manager.post('/api/shops', { name: 'زبون أ', lat: 33.5, lng: 36.3 });
  const res = await A.manager.post('/api/ledger/entries', {
    date: `${YEAR}-02-03`, post: true,
    lines: aLines({ costCenterId: cc.body.id, partyType: 'customer', partyId: shop.body.id }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('POST /api/ledger/accounts rejects a foreign-company parentId', async () => {
  const res = await A.manager.post('/api/ledger/accounts', { code: 'X9', nameAr: 'x', parentId: B.acc('6') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_account');
});

test('PUT on foreign accounts, cost centers and projects is 404', async () => {
  const r = await foreignRefs();
  assert.equal((await A.manager.put(`/api/ledger/accounts/${B.acc('1110')}`, { nameAr: 'x' })).status, 404);
  assert.equal((await A.manager.put(`/api/ledger/cost-centers/${r.costCenterId}`, { name: 'x' })).status, 404);
  assert.equal((await A.manager.put(`/api/ledger/projects/${r.projectId}`, { name: 'x' })).status, 404);
});

test('opening balances reject a foreign accountId and a foreign fiscalYearId', async () => {
  const r = await foreignRefs();
  const prev = await A.manager.post('/api/ledger/opening-balances/preview', { rows: [{ accountId: B.acc('1110'), debit: '5' }] });
  assert.equal(prev.body.error_count, 1);
  const aFy = (await A.manager.get('/api/ledger/fiscal-years')).body[0].id;
  const post = await A.manager.post('/api/ledger/opening-balances', { fiscalYearId: aFy, rows: [{ accountId: B.acc('1110'), debit: '5' }], plugToOpeningEquity: true });
  assert.equal(post.body.error, 'invalid_rows');
  const fy = await A.manager.post('/api/ledger/opening-balances', { fiscalYearId: r.fiscalYearId, rows: [{ accountId: A.acc('1110'), debit: '5' }], plugToOpeningEquity: true });
  assert.equal(fy.status, 404);
});

test("attachments: cannot upload to or download from another company's entry", async () => {
  const login = async (c) => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: c.managerContact, password: c.managerPassword }),
    });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const upload = async (cookie, entryId) => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    return fetch(`${server.baseUrl}/api/ledger/entries/${entryId}/attachments`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  };
  const aCookie = await login(A);
  const bCookie = await login(B);
  assert.equal((await upload(aCookie, B.entry.id)).status, 404);
  const bAtt = await (await upload(bCookie, B.entry.id)).json();
  assert.ok(bAtt.id);
  const dl = await fetch(`${server.baseUrl}/api/ledger/attachments/${bAtt.id}`, { headers: { Cookie: aCookie } });
  assert.equal(dl.status, 404);
  const own = await fetch(`${server.baseUrl}/api/ledger/attachments/${bAtt.id}`, { headers: { Cookie: bCookie } });
  assert.equal(own.status, 200);
});

// ---------------------------------------------------------------------
// Standing rule applied to the Prompt 2 sales endpoints.
// ---------------------------------------------------------------------


async function salesRefs() {
  if (B.sales) return B.sales;
  const r = await foreignRefs();
  const product = await B.manager.post('/api/products', { name: 'مادة ب', base_price: 5 });
  const raw = openLiveDb(server.dbPath);
  const wh = raw.prepare("INSERT INTO warehouses (company_id, name) VALUES (?, 'مستودع ب')").run(B.companyId).lastInsertRowid;
  const order = raw.prepare("INSERT INTO orders (company_id, shop_id, order_date, total_value) VALUES (?, ?, '2026-02-01', 10)").run(B.companyId, r.shopId).lastInsertRowid;
  raw.close();
  const inv = await B.manager.post('/api/sales/invoices', { shopId: r.shopId, lines: [{ description: 'x', qty: 1, unitPrice: '5' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const posted = await B.manager.post(`/api/sales/invoices/${inv.body.id}/post`, {});
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  A.shop = A.shop || (await A.manager.post('/api/shops', { name: 'زبون أ2', lat: 33.5, lng: 36.3 })).body.id;
  B.sales = { ...r, productId: product.body.id, warehouseId: Number(wh), orderId: Number(order), invoice: posted.body };
  return B.sales;
}

for (const [field, make, code] of [
  ['shop', (r) => ({ shopId: r.shopId, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'invalid_shop'],
  ['product', (r) => ({ shopId: A.shop, lines: [{ productId: r.productId, qty: 1, unitPrice: '1' }] }), 'invalid_product'],
  ['branch', (r) => ({ shopId: A.shop, branchId: r.branchId, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'invalid_branch'],
  ['warehouse', (r) => ({ shopId: A.shop, warehouseId: r.warehouseId, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'invalid_warehouse'],
  ['order', (r) => ({ shopId: A.shop, orderId: r.orderId, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] }), 'invalid_order'],
]) {
  test(`POST /api/sales/invoices rejects a foreign-company ${field} id`, async () => {
    const r = await salesRefs();
    const res = await A.manager.post('/api/sales/invoices', make(r));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, code);
  });

  test(`PUT /api/sales/invoices/:id rejects a foreign-company ${field} id`, async () => {
    const r = await salesRefs();
    const draft = await A.manager.post('/api/sales/invoices', { shopId: A.shop, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const res = await A.manager.put(`/api/sales/invoices/${draft.body.id}`, make(r));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, code);
    await A.manager.del(`/api/sales/invoices/${draft.body.id}`);
  });
}

test('POST /api/sales/credit-notes rejects a foreign-company invoiceId, shopId and productId', async () => {
  const r = await salesRefs();
  const byInvoice = await A.manager.post('/api/sales/credit-notes', { invoiceId: r.invoice.id, lines: [{ invoiceLineId: r.invoice.lines[0].id, qty: 1 }] });
  assert.equal(byInvoice.body.error, 'invalid_sales_invoice');
  const byShop = await A.manager.post('/api/sales/credit-notes', { shopId: r.shopId, lines: [{ description: 'x', qty: 1, unitPrice: '1' }] });
  assert.equal(byShop.body.error, 'invalid_shop');
  const byProduct = await A.manager.post('/api/sales/credit-notes', { shopId: A.shop, lines: [{ productId: r.productId, qty: 1, unitPrice: '1' }] });
  assert.equal(byProduct.body.error, 'invalid_product');
});

test("foreign-company sales documents are 404 on read/post/cancel/print; customer ledger and category accounts refuse foreign ids", async () => {
  const r = await salesRefs();
  for (const [method, path] of [
    ['get', `/api/sales/invoices/${r.invoice.id}`],
    ['post', `/api/sales/invoices/${r.invoice.id}/post`],
    ['post', `/api/sales/invoices/${r.invoice.id}/cancel`],
    ['put', `/api/sales/invoices/${r.invoice.id}`],
    ['del', `/api/sales/invoices/${r.invoice.id}`],
    ['get', `/api/sales/invoices/${r.invoice.id}/print`],
  ]) {
    const res = await A.manager[method](path, {});
    assert.equal(res.status, 404, `${method} ${path} -> ${res.status}`);
  }
  assert.equal((await A.manager.get(`/api/sales/customers/${r.shopId}/ledger`)).body.error, 'invalid_shop');
  const map = await A.manager.put('/api/sales/category-accounts', { category: 'x', accountId: B.acc('4100') });
  assert.equal(map.body.error, 'invalid_account');
  const list = await A.manager.get('/api/sales/invoices');
  assert.ok(!list.body.some((i) => i.id === r.invoice.id));
});

// ---------------------------------------------------------------------
// Standing rule applied to the Prompt 3 receivables endpoints.
// ---------------------------------------------------------------------

async function receivableRefs() {
  if (B.rec) return B.rec;
  const r = await salesRefs();
  const receipt = await B.manager.post('/api/receivables/receipts', { shopId: r.shopId, amount: '1', autoAllocate: false });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  const cheque = await B.manager.post('/api/receivables/cheques', { shopId: r.shopId, chequeNumber: 'B-1', dueDate: '2026-12-31', amount: '1' });
  assert.equal(cheque.status, 201, JSON.stringify(cheque.body));
  const raw = openLiveDb(server.dbPath);
  const order = raw.prepare("INSERT INTO orders (company_id, shop_id, order_date, items_json, total_value, status) VALUES (?, ?, '2026-02-01', '[{\"product_name\":\"x\",\"qty\":1,\"unit_price\":5}]', 5, 'delivered')").run(B.companyId, r.shopId).lastInsertRowid;
  raw.close();
  B.rec = { ...r, receiptId: receipt.body.id, chequeId: cheque.body.id, deliveredOrderId: Number(order) };
  return B.rec;
}

test('POST /api/receivables/receipts rejects a foreign-company shopId and foreign invoice allocations', async () => {
  const r = await receivableRefs();
  const byShop = await A.manager.post('/api/receivables/receipts', { shopId: r.shopId, amount: '1' });
  assert.equal(byShop.body.error, 'invalid_shop');
  const byInvoice = await A.manager.post('/api/receivables/receipts', { shopId: A.shop, amount: '1', allocations: [{ invoiceId: r.invoice.id, amount: '1' }] });
  assert.equal(byInvoice.body.error, 'invalid_sales_invoice');
});

test('PUT /api/receivables/receipts/:id/allocations rejects foreign invoice ids; foreign receipt is 404', async () => {
  const r = await receivableRefs();
  const own = await A.manager.post('/api/receivables/receipts', { shopId: A.shop, amount: '1', autoAllocate: false });
  const res = await A.manager.put(`/api/receivables/receipts/${own.body.id}/allocations`, { allocations: [{ invoiceId: r.invoice.id, amount: '1' }] });
  assert.equal(res.body.error, 'invalid_sales_invoice');
  for (const [method, p] of [['get', `/api/receivables/receipts/${r.receiptId}`], ['put', `/api/receivables/receipts/${r.receiptId}/allocations`], ['post', `/api/receivables/receipts/${r.receiptId}/auto-allocate`], ['post', `/api/receivables/receipts/${r.receiptId}/reverse`]]) {
    assert.equal((await A.manager[method](p, { allocations: [] })).status, 404, `${method} ${p}`);
  }
});

test('cheques: foreign shopId rejected; foreign cheque actions are 404', async () => {
  const r = await receivableRefs();
  const res = await A.manager.post('/api/receivables/cheques', { shopId: r.shopId, chequeNumber: 'A-1', dueDate: '2026-12-31', amount: '1' });
  assert.equal(res.body.error, 'invalid_shop');
  for (const action of ['deposit', 'clear', 'bounce']) {
    assert.equal((await A.manager.post(`/api/receivables/cheques/${r.chequeId}/${action}`, {})).status, 404, action);
  }
  assert.ok(!(await A.manager.get('/api/receivables/cheques')).body.some((c) => c.id === r.chequeId));
});

test('aging drill-down, statement, open invoices and statement sending refuse a foreign shopId', async () => {
  const r = await receivableRefs();
  for (const p of [`/api/receivables/aging/customer/${r.shopId}`, `/api/receivables/customers/${r.shopId}/statement`, `/api/receivables/customers/${r.shopId}/open-invoices`]) {
    const res = await A.manager.get(p);
    assert.equal(res.body.error, 'invalid_shop', p);
  }
  assert.equal((await A.manager.post(`/api/receivables/customers/${r.shopId}/statement/send`, {})).body.error, 'invalid_shop');
  const aging = await A.manager.get('/api/receivables/aging');
  assert.ok(!aging.body.rows.some((x) => x.key === r.shopId));
});

test('POST /api/sales/invoices/from-order/:orderId rejects a foreign-company order; invoiceable list is scoped', async () => {
  const r = await receivableRefs();
  const res = await A.manager.post(`/api/sales/invoices/from-order/${r.deliveredOrderId}`, {});
  assert.equal(res.body.error, 'invalid_order');
  assert.ok(!(await A.manager.get('/api/sales/invoiceable-orders')).body.some((o) => o.id === r.deliveredOrderId));
});
