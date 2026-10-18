// backend/test/fixtures/reportsScenario.js
//
// One company that exercises the money paths the analytics layer reads:
// stock ledger, purchases (goods with tax, expense with a cost center,
// payment), sales with cost of goods (USD and SYP, two customers in two
// regions with a rep), a credit note, a receipt, a treasury expense with a
// cost center, a stock adjustment, payroll. buildReportsScenario() returns
// the context; captureExistingReports() snapshots the EXISTING report
// endpoints (recorded before Prompt 12a: test/reportsGolden.test.js).

const { openLiveDb } = require('../liveDb');
const { normalize: baseNormalize } = require('./legacyScenario');

const Y = '2026';
const normalize = (v) => JSON.parse(JSON.stringify(baseNormalize(v)), (k, x) => (['public_token', 'backup_path', 'generated_at'].includes(k) ? `<${k}>` : typeof x === 'string' ? x.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TS>') : x));
function ok(r, status) {
  if (status ? r.status !== status : r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function buildReportsScenario({ manager: m, dbPath, companyId, h, createRep, baseUrl }) {
  const { accounts } = await h.setupLedger(m, 'trading');
  const acc = (code) => accounts.find((a) => a.code === code)?.id;
  ok(await (await h.goLive(m, `${Y}-01-01`)).res);
  ok(await m.post('/api/currency/rates', { currencyCode: 'SYP', rate: '13500', rateQuote: 'foreign_per_base', effectiveAt: `${Y}-01-01` }), 201);
  const ccSales = ok(await m.post('/api/ledger/cost-centers', { code: 'S', name: 'مركز المبيعات' }), 201).id;
  const ccAdmin = ok(await m.post('/api/ledger/cost-centers', { code: 'A', name: 'الإدارة' }), 201).id;
  const rep = await createRep(baseUrl, m, { name: 'مندوب الشمال', permissions: ['view_app'] });
  const nuts = await h.mkProduct(m, { name: 'لوز', category: 'مكسرات' });
  const drink = await h.mkProduct(m, { name: 'عصير', category: 'مشروبات' });
  const dry = ok(await m.post('/api/stock/activation/dry-run', { date: `${Y}-01-01` }));
  ok(await m.post('/api/stock/activation', { dryRunId: dry.dry_run_id }));
  // Purchases.
  const supplier = ok(await m.post('/api/purchasing/suppliers', { name: 'مورد التصنيف', currencyCode: 'USD' }), 201);
  const po = ok(await m.post('/api/purchasing/orders', { supplierId: supplier.id, orderDate: `${Y}-01-10`, lines: [{ productId: nuts, qty: 100, unitPrice: '5.00' }, { productId: drink, qty: 50, unitPrice: '2.00' }] }), 201);
  const sub = ok(await m.post(`/api/purchasing/orders/${po.id}/submit`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/approve`, {}));
  ok(await m.post(`/api/purchasing/orders/${po.id}/receive`, { receiptDate: `${Y}-01-12`, lines: sub.lines.map((l) => ({ poLineId: l.id, qty: l.qty })) }), 201);
  const gi = ok(await m.post('/api/purchasing/invoices', { kind: 'goods', supplierId: supplier.id, poId: po.id, invoiceDate: `${Y}-01-15`, lines: sub.lines.map((l) => ({ poLineId: l.id, qty: l.qty, taxRate: '5' })) }), 201);
  ok(await m.post(`/api/purchasing/invoices/${gi.id}/post`, {}));
  const ex = ok(await m.post('/api/purchasing/invoices', { kind: 'expense', supplierId: supplier.id, invoiceDate: `${Y}-02-01`, lines: [{ description: 'إيجار', qty: 1, unitPrice: '400', expenseAccountId: acc('6200') }] }), 201);
  ok(await m.post(`/api/purchasing/invoices/${ex.id}/post`, {}));
  ok(await m.post('/api/purchasing/payments', { supplierId: supplier.id, amount: '300', paymentDate: `${Y}-02-20`, method: 'cash' }), 201);
  // Sales.
  const s1 = await h.mkShop(m, 'سوبرماركت دمشق');
  const s2 = await h.mkShop(m, 'بقالة حلب');
  const db = openLiveDb(dbPath);
  db.prepare("UPDATE shops SET region = 'دمشق', assigned_rep_id = ? WHERE id = ?").run(rep.userId, s1);
  db.prepare("UPDATE shops SET region = 'حلب' WHERE id = ?").run(s2);
  db.close();
  const sell = async (shopId, date, lines, extra = {}) => {
    const inv = ok(await m.post('/api/sales/invoices', { shopId, invoiceDate: date, lines, ...extra }), 201);
    return ok(await m.post(`/api/sales/invoices/${inv.id}/post`, {}));
  };
  const i1 = await sell(s1, `${Y}-02-10`, [{ productId: nuts, description: 'لوز', qty: 10, unitPrice: '9.00', taxRate: '10' }]);
  await sell(s2, `${Y}-03-05`, [{ productId: drink, description: 'عصير', qty: 20, unitPrice: '4.00' }]);
  await sell(s1, `${Y}-03-10`, [{ productId: nuts, description: 'لوز', qty: 2, unitPrice: '135000' }], { currencyCode: 'SYP' });
  ok(await m.post('/api/sales/credit-notes', { invoiceId: i1.id, date: `${Y}-02-12`, lines: [{ invoiceLineId: i1.lines[0].id, qty: 1 }] }), 201);
  ok(await m.post('/api/receivables/receipts', { shopId: s1, method: 'cash', amount: '50', date: `${Y}-03-15` }), 201);
  // Treasury expense with a cost center; stock adjustment (count variance).
  const box = ok(await m.get('/api/treasury/boxes'))[0];
  const v = ok(await m.post('/api/treasury/vouchers', { type: 'expense', cashBoxId: box.id, amount: '30', counterAccountId: acc('6500'), date: `${Y}-03-20` }), 201);
  ok(await m.post(`/api/treasury/vouchers/${v.id}/approve`, {}));
  void ccAdmin;
  const holder = ok(await m.get('/api/stock/meta')).holders.find((x) => x.kind === 'warehouse');
  ok(await m.post('/api/stock/adjustments', { productId: drink, holderId: holder.id, newQty: 28, reasonCode: 'count', date: `${Y}-03-25` }));
  // Payroll (March).
  ok(await m.put('/api/payroll/settings', { expenseAccountId: acc('6100'), employerExpenseAccountId: acc('6500'), salariesPayableAccountId: acc('2130'), deductionsPayableAccountId: acc('2120'), advancesAccountId: acc('1160') }));
  const pp = ok(await m.post('/api/payroll/periods/import', { period: `${Y}-03`, externalId: 'R-03', lines: [{ department: 'المبيعات', costCenterId: ccSales, currencyCode: 'USD', gross: '1200', deductions: '100', employerContributions: '50', net: '1100' }] }), 201);
  ok(await m.post(`/api/payroll/periods/${pp.id}/post`, {}));
  return { acc, nuts, drink, s1, s2, supplier, rep, ccSales, ccAdmin, box };
}

async function captureExistingReports(m) {
  const g = async (url) => { const r = await m.get(url); return { status: r.status, body: r.body }; };
  const q = `from=${Y}-01-01&to=${Y}-12-31`;
  return normalize({
    trial_balance: await g(`/api/financial-reports/trial-balance?${q}`),
    income_statement: await g(`/api/financial-reports/income-statement?${q}`),
    balance_sheet: await g(`/api/financial-reports/balance-sheet?asOf=${Y}-12-31`),
    cash_flow: await g(`/api/financial-reports/cash-flow?${q}`),
    expense_analysis: await g(`/api/financial-reports/expense-analysis?${q}`),
    ar_aging: await g(`/api/receivables/aging?asOf=${Y}-12-31`),
    ap_aging: await g(`/api/purchasing/reports/aging?asOf=${Y}-12-31`),
    purchases_by_supplier: await g(`/api/purchasing/reports/purchases?${q}&by=supplier`),
    stock_item_balance: await g('/api/stock/reports/item-balance'),
    stock_inventory_cost: await g('/api/stock/reports/inventory-cost'),
    stock_profitability: await g(`/api/stock/reports/profitability?${q}`),
    stock_count_variances: await g(`/api/stock/reports/count-variances?${q}`),
    payroll_cost: await g(`/api/payroll/reports/cost?from=${Y}-01&to=${Y}-12`),
  });
}

module.exports = { buildReportsScenario, captureExistingReports, Y };
