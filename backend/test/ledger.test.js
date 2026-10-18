// backend/test/ledger.test.js
//
// Prompt 1 — ledger core. Covers every "Done when" rule through the real
// HTTP API, plus raw-SQL checks that the database triggers block changes to
// posted entries even when the API is bypassed.
//
// The test company's base currency is SYP (0 minor digits, see helpers.js).

const test = require('node:test');
const { openLiveDb } = require('./liveDb');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer, createCompany, createRep } = require('./helpers');

let server;
let ctx;
const YEAR = 2026;

function acc(code) {
  const a = ctx.accounts.find((x) => x.code === code);
  assert.ok(a, `account ${code} missing`);
  return a.id;
}

async function post(lines, extra = {}) {
  return ctx.m.post('/api/ledger/entries', { date: `${YEAR}-03-10`, description: 'قيد اختبار', post: true, lines, ...extra });
}

test.before(async () => {
  server = await startServer();
  const company = await createCompany(server.baseUrl);
  ctx = { company, m: company.manager };

  const applied = await ctx.m.post('/api/ledger/coa-templates/trading/apply', {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  ctx.accounts = applied.body.accounts;

  const fy = await ctx.m.post('/api/ledger/fiscal-years', { year: YEAR });
  assert.equal(fy.status, 201, JSON.stringify(fy.body));
  ctx.fy = fy.body;
  ctx.period = (n) => fy.body.periods.find((p) => p.number === n);
});

test.after(() => server.stop());

test('both chart-of-accounts templates apply and carry every system account', async () => {
  const food = await ctx.m.post('/api/ledger/coa-templates/food_manufacturing/apply', {});
  assert.equal(food.status, 200, JSON.stringify(food.body));
  const keys = food.body.accounts.filter((a) => a.system_key && a.is_active).map((a) => a.system_key).sort();
  assert.deepEqual(keys, ['ap_control', 'ar_control', 'bank_charges', 'bank_in_transit', 'cash_default', 'cash_over_short', 'cheques_in_portfolio', 'cheques_payable', 'cogs', 'fx_realized', 'fx_unrealized', 'grni', 'input_tax', 'inventory', 'inventory_adjustments', 'inventory_custody', 'inventory_wastage', 'opening_balance_equity', 'output_tax', 'production_energy', 'production_labour', 'production_overhead', 'purchase_price_variance', 'rep_cash_custody', 'retained_earnings', 'rounding_difference', 'sales_returns', 'sales_revenue', 'wip']);
  assert.ok(food.body.accounts.some((a) => a.code === '1152' && a.is_active), 'WIP account present');
  // Header accounts are not postable.
  assert.equal(food.body.accounts.find((a) => a.code === '1150').is_postable, 0);

  const trading = await ctx.m.post('/api/ledger/coa-templates/trading/apply', {});
  assert.equal(trading.status, 200);
  ctx.accounts = trading.body.accounts;
  assert.equal(ctx.accounts.find((a) => a.code === '1152').is_active, 0, 'accounts outside the template are deactivated, not deleted');
  assert.equal(ctx.accounts.find((a) => a.code === '1150').is_postable, 1);
});

test('rounding_difference is a postable system account in both templates', async () => {
  for (const key of ['food_manufacturing', 'trading']) {
    const res = await ctx.m.post(`/api/ledger/coa-templates/${key}/apply`, {});
    const acct = res.body.accounts.find((a) => a.system_key === 'rounding_difference');
    assert.ok(acct, `${key} lacks rounding_difference`);
    assert.equal(acct.is_postable, 1);
    assert.equal(acct.is_system, 1);
    assert.equal(acct.type, 'expense');
    ctx.accounts = res.body.accounts;
  }
});

test('branches_ref follows branches_json: add, rename (old deactivated), remove', async () => {
  const branchNames = async () => (await ctx.m.get('/api/ledger/meta')).body.branches;
  assert.equal((await ctx.m.put('/api/companies/me', { branches: ['دمشق', 'حلب'] })).status, 200);
  let b = await branchNames();
  assert.deepEqual(b.filter((x) => x.is_active).map((x) => x.name).sort(), ['حلب', 'دمشق']);
  const damascusId = b.find((x) => x.name === 'دمشق').id;

  const draft = await ctx.m.post('/api/ledger/entries', {
    date: `${YEAR}-02-10`, branchId: damascusId,
    lines: [{ accountId: acc('6200'), debit: '1' }, { accountId: acc('1110'), credit: '1' }],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));

  assert.equal((await ctx.m.put('/api/companies/me', { branches: ['دمشق - المزة', 'حلب'] })).status, 200);
  b = await branchNames();
  assert.equal(b.find((x) => x.name === 'دمشق').is_active, 0, 'renamed branch is deactivated, not deleted');
  assert.equal(b.find((x) => x.name === 'دمشق').id, damascusId, 'old id kept for existing entries');
  assert.equal(b.find((x) => x.name === 'دمشق - المزة').is_active, 1);
  const stale = await ctx.m.post('/api/ledger/entries', {
    date: `${YEAR}-02-10`, branchId: damascusId,
    lines: [{ accountId: acc('6200'), debit: '1' }, { accountId: acc('1110'), credit: '1' }],
  });
  assert.equal(stale.body.error, 'invalid_branch', 'inactive branch cannot be used on new entries');

  assert.equal((await ctx.m.put('/api/companies/me', { branches: ['حلب', 'دمشق'] })).status, 200);
  b = await branchNames();
  assert.equal(b.find((x) => x.name === 'دمشق').is_active, 1, 're-added branch is reactivated with the same id');
  assert.equal(b.find((x) => x.name === 'دمشق - المزة').is_active, 0);
  assert.equal((await ctx.m.del(`/api/ledger/entries/${draft.body.id}`)).status, 200);
});

test('fiscal year generates 12 monthly periods', () => {
  assert.equal(ctx.fy.periods.length, 12);
  assert.equal(ctx.period(1).start_date, `${YEAR}-01-01`);
  assert.equal(ctx.period(2).end_date, `${YEAR}-02-28`);
  assert.equal(ctx.period(12).end_date, `${YEAR}-12-31`);
});

test('unbalanced entry is rejected and nothing is written', async () => {
  const before = await ctx.m.get('/api/ledger/entries');
  const res = await post([
    { accountId: acc('1110'), debit: '1000' },
    { accountId: acc('4100'), credit: '999' },
  ]);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unbalanced');
  const after = await ctx.m.get('/api/ledger/entries');
  assert.equal(after.body.total, before.body.total);
});

test('line rules: one side only, no excess decimals, postable active accounts only', async () => {
  const both = await post([{ accountId: acc('1110'), debit: '5', credit: '5' }, { accountId: acc('4100'), credit: '5' }]);
  assert.equal(both.body.error, 'one_side_required');
  const decimals = await post([{ accountId: acc('1110'), debit: '10.5' }, { accountId: acc('4100'), credit: '10.5' }]);
  assert.equal(decimals.status, 400, 'SYP has 0 minor digits');
  const header = await post([{ accountId: acc('11'), debit: '10' }, { accountId: acc('4100'), credit: '10' }]);
  assert.equal(header.body.error, 'non_postable_account');

  const created = await ctx.m.post('/api/ledger/accounts', { code: '6950', nameAr: 'حساب مؤقت', parentId: acc('6') });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const off = await ctx.m.put(`/api/ledger/accounts/${created.body.id}`, { isActive: false });
  assert.equal(off.status, 200);
  const inactive = await post([{ accountId: created.body.id, debit: '10' }, { accountId: acc('1110'), credit: '10' }]);
  assert.equal(inactive.body.error, 'inactive_account');

  const sys = await ctx.m.put(`/api/ledger/accounts/${acc('1130')}`, { isActive: false });
  assert.equal(sys.body.error, 'system_account');
});

test('account currency restriction and FX conversion to base minor units', async () => {
  const eurAcc = await ctx.m.post('/api/ledger/accounts', { code: '1125', nameAr: 'بنك باليورو', parentId: acc('11'), currencyCode: 'EUR' });
  assert.equal(eurAcc.status, 201, JSON.stringify(eurAcc.body));
  ctx.accounts.push(eurAcc.body);

  const wrongCurrency = await post([{ accountId: eurAcc.body.id, debit: '100' }, { accountId: acc('3100'), credit: '100' }]);
  assert.equal(wrongCurrency.body.error, 'currency_not_allowed');

  const noRate = await post([{ accountId: eurAcc.body.id, currencyCode: 'EUR', debit: '100.25' }, { accountId: acc('3100'), credit: '1' }]);
  assert.equal(noRate.body.error, 'rate_required');

  // 100.25 EUR at 14000.5 SYP/EUR = 1403550.125 -> 1403550 SYP
  const ok = await post([
    { accountId: eurAcc.body.id, currencyCode: 'EUR', exchangeRate: '14000.5', debit: '100.25' },
    { accountId: acc('3100'), credit: '1403550' },
  ]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const line = ok.body.lines[0];
  assert.equal(line.debit_minor, 1403550);
  assert.equal(line.amount_original_minor, 10025);
  assert.equal(line.exchange_rate_ppm, 14000500000);
});

test('balanced entry posts with a JE number; posted entry cannot be edited or deleted via API', async () => {
  const res = await post([
    { accountId: acc('1110'), debit: '250000' },
    { accountId: acc('4100'), credit: '250000' },
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'posted');
  assert.ok(res.body.entry_number);
  ctx.posted = res.body;

  const edit = await ctx.m.put(`/api/ledger/entries/${res.body.id}`, { description: 'x' });
  assert.equal(edit.status, 409);
  const del = await ctx.m.del(`/api/ledger/entries/${res.body.id}`);
  assert.equal(del.status, 409);
});

test('database triggers block UPDATE/DELETE on posted entries and lines (raw SQL)', () => {
  const raw = openLiveDb(server.dbPath);
  try {
    const id = ctx.posted.id;
    assert.throws(() => raw.prepare('UPDATE journal_entries SET description = ? WHERE id = ?').run('hack', id), /posted_entry_immutable/);
    assert.throws(() => raw.prepare("UPDATE journal_entries SET status = 'draft' WHERE id = ?").run(id), /posted_entry_immutable/);
    assert.throws(() => raw.prepare('DELETE FROM journal_entries WHERE id = ?').run(id), /posted_entry_immutable/);
    assert.throws(() => raw.prepare('UPDATE journal_lines SET debit_minor = debit_minor + 1 WHERE entry_id = ?').run(id), /posted_entry_immutable/);
    assert.throws(() => raw.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(id), /posted_entry_immutable/);
    const line = raw.prepare('SELECT * FROM journal_lines WHERE entry_id = ? LIMIT 1').get(id);
    assert.throws(
      () => raw.prepare('INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, debit_minor, credit_minor, currency_code, amount_original_minor) VALUES (?, ?, 99, ?, 1, 0, ?, 1)')
        .run(id, line.company_id, line.account_id, line.currency_code),
      /posted_entry_immutable/
    );
  } finally {
    raw.close();
  }
});

test('reversal swaps lines, links both entries, and is one-shot', async () => {
  const res = await ctx.m.post(`/api/ledger/entries/${ctx.posted.id}/reverse`, { date: `${YEAR}-03-15`, reason: 'خطأ إدخال' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { original, reversal } = res.body;
  assert.equal(original.status, 'reversed');
  assert.equal(original.reversed_by_entry_id, reversal.id);
  assert.equal(reversal.reverses_entry_id, original.id);
  assert.equal(reversal.status, 'posted');
  assert.equal(reversal.lines[0].credit_minor, original.lines[0].debit_minor);
  assert.equal(reversal.lines[1].debit_minor, original.lines[1].credit_minor);

  const again = await ctx.m.post(`/api/ledger/entries/${ctx.posted.id}/reverse`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_reversed');
  const ofReversal = await ctx.m.post(`/api/ledger/entries/${reversal.id}/reverse`, {});
  assert.equal(ofReversal.status, 409);

  const raw = openLiveDb(server.dbPath);
  try {
    assert.throws(() => raw.prepare("UPDATE journal_entries SET status = 'posted' WHERE id = ?").run(original.id), /posted_entry_immutable/);
  } finally {
    raw.close();
  }
});

test('drafts can be saved unbalanced, edited and deleted; posting still requires balance', async () => {
  const draft = await ctx.m.post('/api/ledger/entries', {
    date: `${YEAR}-04-05`,
    description: 'مسودة',
    lines: [{ accountId: acc('6200'), debit: '5000' }, { accountId: acc('1110'), credit: '4000' }],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.status, 'draft');
  assert.equal(draft.body.entry_number, null);

  const postUnbalanced = await ctx.m.post(`/api/ledger/entries/${draft.body.id}/post`, {});
  assert.equal(postUnbalanced.body.error, 'unbalanced');

  const fixed = await ctx.m.put(`/api/ledger/entries/${draft.body.id}`, {
    lines: [{ accountId: acc('6200'), debit: '5000' }, { accountId: acc('1110'), credit: '5000' }],
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const posted = await ctx.m.post(`/api/ledger/entries/${draft.body.id}/post`, {});
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.status, 'posted');

  const throwaway = await ctx.m.post('/api/ledger/entries', {
    date: `${YEAR}-04-06`,
    lines: [{ accountId: acc('6200'), debit: '1' }, { accountId: acc('1110'), credit: '1' }],
  });
  const del = await ctx.m.del(`/api/ledger/entries/${throwaway.body.id}`);
  assert.equal(del.status, 200);
  assert.equal((await ctx.m.get(`/api/ledger/entries/${throwaway.body.id}`)).status, 404);
});

test('closed and locked periods reject posting, reversing into them and draft edits', async () => {
  const may = ctx.period(5);
  const draft = await ctx.m.post('/api/ledger/entries', {
    date: `${YEAR}-05-10`,
    lines: [{ accountId: acc('6300'), debit: '700' }, { accountId: acc('1110'), credit: '700' }],
  });
  assert.equal(draft.status, 201);
  const toReverse = await post([{ accountId: acc('6400'), debit: '300' }, { accountId: acc('1110'), credit: '300' }], { date: `${YEAR}-06-02` });
  assert.equal(toReverse.status, 201);

  assert.equal((await ctx.m.post(`/api/ledger/periods/${may.id}/close`, {})).status, 200);
  const intoClosed = await post([{ accountId: acc('6300'), debit: '1' }, { accountId: acc('1110'), credit: '1' }], { date: `${YEAR}-05-20` });
  assert.equal(intoClosed.status, 409);
  assert.equal(intoClosed.body.error, 'period_closed');
  const editInClosed = await ctx.m.put(`/api/ledger/entries/${draft.body.id}`, { description: 'تعديل' });
  assert.equal(editInClosed.body.error, 'period_closed');
  const postInClosed = await ctx.m.post(`/api/ledger/entries/${draft.body.id}/post`, {});
  assert.equal(postInClosed.body.error, 'period_closed');
  const reverseInto = await ctx.m.post(`/api/ledger/entries/${toReverse.body.id}/reverse`, { date: `${YEAR}-05-25` });
  assert.equal(reverseInto.body.error, 'period_closed');

  assert.equal((await ctx.m.post(`/api/ledger/periods/${may.id}/reopen`, {})).status, 200);
  assert.equal((await ctx.m.post(`/api/ledger/entries/${draft.body.id}/post`, {})).status, 200);

  assert.equal((await ctx.m.post(`/api/ledger/periods/${may.id}/lock`, {})).status, 200);
  const reopenLocked = await ctx.m.post(`/api/ledger/periods/${may.id}/reopen`, {});
  assert.equal(reopenLocked.body.error, 'period_locked');
  const intoLocked = await post([{ accountId: acc('6300'), debit: '1' }, { accountId: acc('1110'), credit: '1' }], { date: `${YEAR}-05-21` });
  assert.equal(intoLocked.body.error, 'period_locked');

  const raw = openLiveDb(server.dbPath);
  try {
    assert.throws(() => raw.prepare("UPDATE fiscal_periods SET status = 'open' WHERE id = ?").run(may.id), /period_locked/);
  } finally {
    raw.close();
  }
});

test('opening balances: balance check, plug to opening equity, one per year, same source cannot post twice', async () => {
  const rows = [
    { accountCode: '1110', debit: '1000000' },
    { accountCode: '1150', debit: '500000' },
    { accountCode: '2110', credit: '300000' },
  ];
  const preview = await ctx.m.post('/api/ledger/opening-balances/preview', { rows });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.difference_minor, 1200000);

  const unbalanced = await ctx.m.post('/api/ledger/opening-balances', { fiscalYearId: ctx.fy.id, rows });
  assert.equal(unbalanced.body.error, 'opening_unbalanced');

  const ok = await ctx.m.post('/api/ledger/opening-balances', { fiscalYearId: ctx.fy.id, rows, plugToOpeningEquity: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.entry_date, `${YEAR}-01-01`);
  assert.equal(ok.body.source_type, 'opening_balance');
  const obeLine = ok.body.lines.find((l) => l.account_code === '3900');
  assert.equal(obeLine.credit_minor, 1200000);

  const twice = await ctx.m.post('/api/ledger/opening-balances', { fiscalYearId: ctx.fy.id, rows, plugToOpeningEquity: true });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, 'source_already_posted');

  // Once reversed, the same source may post again.
  // Not from the generic journal screen: only through the opening-balances action.
  const generic = await ctx.m.post(`/api/ledger/entries/${ok.body.id}/reverse`, { date: `${YEAR}-01-02` });
  assert.equal(generic.status, 409);
  assert.equal(generic.body.error, 'reverse_via_source');
  assert.match(generic.body.message, /الأرصدة الافتتاحية/);
  const rev = await ctx.m.post(`/api/ledger/opening-balances/${ok.body.id}/reverse`, { date: `${YEAR}-01-02` });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const again = await ctx.m.post('/api/ledger/opening-balances', { fiscalYearId: ctx.fy.id, rows, plugToOpeningEquity: true });
  assert.equal(again.status, 201, JSON.stringify(again.body));

  const raw = openLiveDb(server.dbPath);
  try {
    // The unique index is the last line of defence even outside lib/ledger.js.
    raw.exec('BEGIN');
    const info = raw.prepare("INSERT INTO journal_entries (company_id, entry_date, period_id, source_type, source_id, status) VALUES (?, ?, ?, 'opening_balance', ?, 'draft')")
      .run(ctx.company.companyId, `${YEAR}-01-01`, ctx.period(1).id, ctx.fy.id);
    assert.throws(() => raw.prepare("UPDATE journal_entries SET status = 'posted' WHERE id = ?").run(info.lastInsertRowid), /UNIQUE/);
    raw.exec('ROLLBACK');
  } finally {
    raw.close();
  }
});

test('opening balances: trial balance Excel upload returns a review preview', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TB');
  ws.addRow(['رمز الحساب', 'مدين', 'دائن']);
  ws.addRow(['1120', 2500, null]);
  ws.addRow(['2120', null, 2500]);
  ws.addRow(['9999', 10, null]);
  const buf = await wb.xlsx.writeBuffer();

  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact: ctx.company.managerContact, password: ctx.company.managerPassword }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([buf]), 'tb.xlsx');
  const res = await fetch(`${server.baseUrl}/api/ledger/opening-balances/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.rows.length, 3);
  assert.equal(body.error_count, 1, 'unknown account 9999 is flagged');
  assert.equal(body.difference_minor, 0);
});

test('idempotency key replays the same posted entry instead of posting twice', async () => {
  const lines = [{ accountId: acc('6500'), debit: '900' }, { accountId: acc('1110'), credit: '900' }];
  const a = await post(lines, { idempotencyKey: 'pay-123' });
  const b = await post(lines, { idempotencyKey: 'pay-123' });
  assert.equal(a.status, 201);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.idempotent_replay, true);
});

test('company currency cannot change once entries are posted (API and raw SQL)', async () => {
  const res = await ctx.m.put('/api/companies/me', { currency: 'USD' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'currency_locked');
  assert.match(res.body.message, /لا يمكن تغيير عملة الشركة/);
  const wizard = await ctx.m.put('/api/companies/setup', { stepData: { currency: 'EUR' } });
  assert.equal(wizard.status, 409);
  // Same currency or other fields still save.
  assert.equal((await ctx.m.put('/api/companies/me', { currency: 'SYP', address: 'دمشق' })).status, 200);
  assert.equal((await ctx.m.get('/api/companies/me')).body.currency, 'SYP');
  const raw = openLiveDb(server.dbPath);
  try {
    assert.throws(() => raw.prepare("UPDATE companies SET currency = 'USD' WHERE id = ?").run(ctx.company.companyId), /currency_locked/);
  } finally {
    raw.close();
  }
});

test('company currency can still change before anything is posted', async () => {
  const fresh = await createCompany(server.baseUrl);
  const res = await fresh.manager.put('/api/companies/me', { currency: 'USD' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.currency, 'USD');
});

test('chart-of-accounts template refuses to run once entries are posted', async () => {
  const res = await ctx.m.post('/api/ledger/coa-templates/food_manufacturing/apply', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'has_posted_entries');
});

test('account with entries cannot get children; parent becomes non-postable when it does', async () => {
  const res = await ctx.m.post('/api/ledger/accounts', { code: '1111', nameAr: 'صندوق فرعي', parentId: acc('1110') });
  assert.equal(res.body.error, 'parent_has_entries');
  const leaf = await ctx.m.post('/api/ledger/accounts', { code: '6210', nameAr: 'إيجار المستودع', parentId: acc('6900') });
  assert.equal(leaf.status, 201);
  const accounts = await ctx.m.get('/api/ledger/accounts');
  assert.equal(accounts.body.find((a) => a.code === '6900').is_postable, 0);
});

test('entry list filters by status and account', async () => {
  const reversed = await ctx.m.get('/api/ledger/entries?status=reversed');
  assert.ok(reversed.body.entries.length >= 2);
  assert.ok(reversed.body.entries.every((e) => e.status === 'reversed'));
  const byAccount = await ctx.m.get(`/api/ledger/entries?accountId=${acc('6200')}`);
  assert.ok(byAccount.body.entries.length >= 1);
});

test('integrity check is clean after all of the above', async () => {
  const res = await ctx.m.get('/api/ledger/integrity-check');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.violations, []);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.total_debit_minor, res.body.total_credit_minor);
});

test('integrity check reports a broken entry written behind the ledger', () => {
  // Simulate corruption that bypasses lib/ledger.js: a posted entry dated
  // outside its period. Triggers allow inserting a draft, so build one and
  // flip it to posted with a bogus period.
  const raw = openLiveDb(server.dbPath);
  try {
    const cid = ctx.company.companyId;
    const info = raw.prepare("INSERT INTO journal_entries (company_id, entry_date, period_id, status) VALUES (?, ?, ?, 'draft')").run(cid, `${YEAR}-08-01`, ctx.period(1).id);
    raw.prepare("UPDATE journal_entries SET status = 'posted', entry_number = 'BAD-1' WHERE id = ?").run(info.lastInsertRowid);
    ctx.badId = Number(info.lastInsertRowid);
  } finally {
    raw.close();
  }
});

test('integrity check lists the violations', async () => {
  const res = await ctx.m.get('/api/ledger/integrity-check');
  assert.equal(res.body.ok, false);
  const types = res.body.violations.filter((v) => v.entry_id === ctx.badId).map((v) => v.type).sort();
  assert.deepEqual(types, ['invalid_period', 'too_few_lines']);
});

test('every ledger action writes an audit row', async () => {
  // Actions not exercised by earlier tests: dimensions and attachments.
  const cc = await ctx.m.post('/api/ledger/cost-centers', { code: 'CC1', name: 'الإنتاج' });
  assert.equal(cc.status, 201);
  assert.equal((await ctx.m.put(`/api/ledger/cost-centers/${cc.body.id}`, { name: 'الإنتاج 2' })).status, 200);
  const pr = await ctx.m.post('/api/ledger/projects', { code: 'P1', name: 'مشروع' });
  assert.equal(pr.status, 201);
  assert.equal((await ctx.m.put(`/api/ledger/projects/${pr.body.id}`, { isActive: false })).status, 200);
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact: ctx.company.managerContact, password: ctx.company.managerPassword }),
  });
  const form = new FormData();
  form.append('file', new Blob(['receipt']), 'receipt.txt');
  const att = await fetch(`${server.baseUrl}/api/ledger/entries/${ctx.posted.id}/attachments`, {
    method: 'POST', headers: { Cookie: login.headers.get('set-cookie').split(';')[0] }, body: form,
  });
  assert.equal(att.status, 201);

  const res = await ctx.m.get('/api/audit-log?limit=500');
  assert.equal(res.status, 200);
  const actions = new Set(res.body.map((r) => r.action));
  for (const a of ['ledger.coa_template.apply', 'ledger.fiscal_year.create', 'ledger.entry.post', 'ledger.entry.reverse',
    'ledger.entry.create_draft', 'ledger.entry.update_draft', 'ledger.entry.delete_draft', 'ledger.period.close',
    'ledger.period.reopen', 'ledger.period.lock', 'ledger.account.create', 'ledger.account.update',
    'ledger.cost_center.create', 'ledger.cost_center.update', 'ledger.project.create', 'ledger.project.update', 'ledger.entry.attach']) {
    assert.ok(actions.has(a), `missing audit action ${a}`);
  }
  // Every row carries before/after snapshots where something existed before.
  const reverse = res.body.find((r) => r.action === 'ledger.entry.reverse');
  assert.ok(reverse.before_json && reverse.after_json);
  const update = res.body.find((r) => r.action === 'ledger.cost_center.update');
  assert.ok(update.before_json && update.after_json);
  // One audit row per posted entry (opening balances and reversals post too).
  const posted = (await ctx.m.get('/api/ledger/entries?limit=500')).body.entries.filter((e) => e.status !== 'draft' && e.entry_number !== 'BAD-1');
  const postedAudit = new Set(res.body.filter((r) => r.action === 'ledger.entry.post').map((r) => r.entity_id));
  for (const e of posted) assert.ok(postedAudit.has(e.id), `entry ${e.entry_number} has no ledger.entry.post audit row`);
});

test('permissions gate every ledger action', async () => {
  const outsider = await createRep(server.baseUrl, ctx.m, { permissions: ['view_app'] });
  assert.equal((await outsider.client.get('/api/ledger/entries')).status, 403);
  assert.equal((await outsider.client.get('/api/ledger/accounts')).status, 403);

  const viewer = await createRep(server.baseUrl, ctx.m, { permissions: ['view_ledger'] });
  assert.equal((await viewer.client.get('/api/ledger/entries')).status, 200);
  const viewerPost = await viewer.client.post('/api/ledger/entries', { date: `${YEAR}-07-01`, post: true, lines: [] });
  assert.equal(viewerPost.status, 403);
  assert.equal((await viewer.client.post(`/api/ledger/entries/${ctx.posted.id}/reverse`, {})).status, 403);
  assert.equal((await viewer.client.post('/api/ledger/accounts', { code: 'X1', nameAr: 'x', type: 'asset' })).status, 403);

  const closer = await createRep(server.baseUrl, ctx.m, { permissions: ['manage_fiscal_periods'] });
  const june = ctx.period(6);
  assert.equal((await closer.client.post(`/api/ledger/periods/${june.id}/lock`, {})).status, 403, 'lock needs lock_fiscal_periods');
  assert.equal((await closer.client.post(`/api/ledger/periods/${june.id}/close`, {})).status, 200);
  assert.equal((await closer.client.post(`/api/ledger/periods/${june.id}/reopen`, {})).status, 200);
});

test('another company cannot see or touch this company ledger', async () => {
  const other = await createCompany(server.baseUrl);
  const res = await other.manager.get(`/api/ledger/entries/${ctx.posted.id}`);
  assert.equal(res.status, 404);
  const rev = await other.manager.post(`/api/ledger/entries/${ctx.posted.id}/reverse`, {});
  assert.equal(rev.status, 404);
  const list = await other.manager.get('/api/ledger/entries');
  assert.equal(list.body.total, 0);
});
