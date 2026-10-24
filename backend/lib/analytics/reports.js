// backend/lib/analytics/reports.js
//
// Prompt 12a — the ready reports (Prompt 12 list), computed from the fact
// tables. Every function is pure: (dbh, companyId, params) -> { columns,
// rows, totals }, where dbh is a database handle — in production the
// worker's READ-ONLY second connection (lib/analytics/runner.js), in tests
// any connection. Nothing here writes.
//
// Drill-down (Prompt 4 convention, extended):
//   financial amounts carry drill = { kind: 'gl', accountId | type, from, to,
//     excludeClosing? } — exactly the general-ledger query of Prompt 4;
//   operational amounts carry drill = { kind: 'facts', fact, filters } —
//     GET /api/analytics/drill returns the fact rows with their document,
//     journal entry and stock moves (GET /api/analytics/document).
// Two reports need graph traversal over live tables (lot trace, recall):
// they are marked live: true and run on the main connection.

class ReportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status) => { throw new ReportError(code, message, status); };
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const col = (key, ar, en, type = 'text') => ({ key, label_ar: ar, label_en: en, type });
const money = (key, ar, en) => col(key, ar, en, 'money');
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
const NOT_CLOSING = 'AND is_closing = 0';

const DIM_LABEL = { account: ['الحساب', 'Account'], cost_center: ['مركز الكلفة', 'Cost center'], project: ['المشروع', 'Project'], supplier: ['المورد', 'Supplier'], employee: ['الموظف', 'Employee'], month: ['الشهر', 'Month'], item: ['المادة', 'Item'], customer: ['الزبون', 'Customer'], branch: ['الفرع', 'Branch'], rep: ['المندوب', 'Rep'], region: ['المنطقة', 'Region'], category: ['الفئة', 'Category'], channel: ['القناة', 'Channel'], warehouse: ['المستودع', 'Warehouse'], method: ['طريقة الدفع', 'Method'], kind: ['النوع', 'Kind'] };
function range(p, { needFrom = true } = {}) {
  const to = p.to || p.asOf || p.now?.slice(0, 10);
  const from = p.from || (needFrom ? `${String(to).slice(0, 4)}-01-01` : '1900-01-01');
  if (!isDate(from) || !isDate(to) || from > to) fail('invalid_dates', 'الفترة غير صالحة');
  return { from, to };
}
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ---------------------------------------------------------------------
// Financial (fact_journal_lines)
// ---------------------------------------------------------------------

// Optional branchId: only lines of entries posted for that branch (the
// Prompt 4 trial balance filter); the drill carries it.
function trialBalance(dbh, cid, p) {
  const { from, to } = range(p);
  const branchId = num(p.branchId);
  const rows = dbh.prepare(`SELECT a.id account_id, a.code, a.name_ar, a.type,
      COALESCE(SUM(CASE WHEN f.entry_date < ? THEN f.debit_minor - f.credit_minor END), 0) opening,
      COALESCE(SUM(CASE WHEN f.entry_date >= ? THEN f.debit_minor END), 0) period_debit,
      COALESCE(SUM(CASE WHEN f.entry_date >= ? THEN f.credit_minor END), 0) period_credit
    FROM fact_journal_lines f JOIN accounts a ON a.id = f.account_id
    WHERE f.company_id = ? AND f.entry_date <= ? ${branchId ? 'AND f.branch_id = ?' : ''} GROUP BY a.id ORDER BY a.code`).all(from, from, from, cid, to, ...(branchId ? [branchId] : [])).map((r) => {
    const closing = r.opening + r.period_debit - r.period_credit;
    return { ...r, opening_debit: Math.max(r.opening, 0), opening_credit: Math.max(-r.opening, 0), closing_debit: Math.max(closing, 0), closing_credit: Math.max(-closing, 0), drill: { kind: 'gl', accountId: r.account_id, from, to, ...(branchId ? { branchId } : {}) } };
  }).filter((r) => r.opening || r.period_debit || r.period_credit);
  return {
    columns: [col('code', 'الرمز', 'Code'), col('name_ar', 'الحساب', 'Account'), money('opening_debit', 'افتتاحي مدين', 'Opening Dr'), money('opening_credit', 'افتتاحي دائن', 'Opening Cr'), money('period_debit', 'حركة مدين', 'Period Dr'), money('period_credit', 'حركة دائن', 'Period Cr'), money('closing_debit', 'ختامي مدين', 'Closing Dr'), money('closing_credit', 'ختامي دائن', 'Closing Cr')],
    rows,
    totals: Object.fromEntries(['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'closing_debit', 'closing_credit'].map((k) => [k, sum(rows, k)])),
  };
}

function generalLedger(dbh, cid, p) {
  const { from, to } = range(p);
  const accountId = num(p.accountId);
  if (!accountId) fail('account_required', 'اختر الحساب');
  const opening = dbh.prepare('SELECT COALESCE(SUM(debit_minor - credit_minor), 0) s FROM fact_journal_lines WHERE company_id = ? AND account_id = ? AND entry_date < ?').get(cid, accountId, from).s;
  let run = opening;
  const rows = dbh.prepare(`SELECT line_id, entry_id, entry_number, entry_date, debit_minor, credit_minor, source_type, source_id, cost_center_id, party_type, party_id
    FROM fact_journal_lines WHERE company_id = ? AND account_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date, entry_id, line_id`).all(cid, accountId, from, to).map((r) => {
    run += r.debit_minor - r.credit_minor;
    return { ...r, balance: run, document: { source_type: r.source_type, source_id: r.source_id, entry_id: r.entry_id } };
  });
  return { columns: [col('entry_date', 'التاريخ', 'Date'), col('entry_number', 'القيد', 'Entry'), col('source_type', 'المستند', 'Document'), money('debit_minor', 'مدين', 'Debit'), money('credit_minor', 'دائن', 'Credit'), money('balance', 'الرصيد', 'Balance')], rows, totals: { opening, debit_minor: sum(rows, 'debit_minor'), credit_minor: sum(rows, 'credit_minor'), closing: run } };
}

const PL_CLASSES = ['revenue', 'cogs', 'opex', 'other'];
function plByAccount(dbh, cid, from, to) {
  return dbh.prepare(`SELECT a.id account_id, a.code, a.name_ar, a.type, f.report_class, COALESCE(SUM(f.credit_minor - f.debit_minor), 0) net_credit
    FROM fact_journal_lines f JOIN accounts a ON a.id = f.account_id
    WHERE f.company_id = ? AND f.entry_date BETWEEN ? AND ? AND f.account_type IN ('revenue', 'expense') ${NOT_CLOSING} GROUP BY a.id ORDER BY a.code`).all(cid, from, to);
}
function incomeStatement(dbh, cid, p) {
  const { from, to } = range(p);
  const rows = plByAccount(dbh, cid, from, to).filter((r) => r.net_credit).map((r) => ({ ...r, amount: r.type === 'revenue' ? r.net_credit : -r.net_credit, drill: { kind: 'gl', accountId: r.account_id, from, to, excludeClosing: 1 } }));
  const by = (cls) => rows.filter((r) => (r.report_class || (r.type === 'revenue' ? 'revenue' : 'opex')) === cls);
  const revenue = sum(by('revenue'), 'amount');
  const cogs = sum(by('cogs'), 'amount');
  const opex = sum(by('opex'), 'amount');
  const other = rows.filter((r) => !['revenue', 'cogs', 'opex'].includes(r.report_class)).reduce((t, r) => t + r.net_credit, 0);
  const net = rows.reduce((t, r) => t + r.net_credit, 0);
  return { columns: [col('code', 'الرمز', 'Code'), col('name_ar', 'الحساب', 'Account'), col('report_class', 'التصنيف', 'Class'), money('amount', 'المبلغ', 'Amount')], rows, totals: { revenue, cogs, gross_profit: revenue - cogs, opex, other_net: other, net_income: net } };
}

function balanceSheet(dbh, cid, p) {
  const { to } = range(p, { needFrom: false });
  const rows = dbh.prepare(`SELECT a.id account_id, a.code, a.name_ar, a.type, f.report_class, COALESCE(SUM(f.debit_minor - f.credit_minor), 0) net_debit
    FROM fact_journal_lines f JOIN accounts a ON a.id = f.account_id WHERE f.company_id = ? AND f.entry_date <= ? GROUP BY a.id ORDER BY a.code`).all(cid, to)
    .filter((r) => r.net_debit).map((r) => ({ ...r, amount: r.type === 'asset' ? r.net_debit : -r.net_debit, drill: { kind: 'gl', accountId: r.account_id, from: '1900-01-01', to } }));
  const assets = rows.filter((r) => r.type === 'asset').reduce((t, r) => t + r.net_debit, 0);
  const liabilities = -rows.filter((r) => r.type === 'liability').reduce((t, r) => t + r.net_debit, 0);
  const equity = -rows.filter((r) => r.type === 'equity').reduce((t, r) => t + r.net_debit, 0);
  const unclosed = -rows.filter((r) => ['revenue', 'expense'].includes(r.type)).reduce((t, r) => t + r.net_debit, 0);
  return { columns: [col('code', 'الرمز', 'Code'), col('name_ar', 'الحساب', 'Account'), col('type', 'النوع', 'Type'), money('amount', 'الرصيد', 'Balance')], rows: rows.filter((r) => ['asset', 'liability', 'equity'].includes(r.type)), totals: { assets, liabilities, equity, current_result: unclosed, liabilities_and_equity: liabilities + equity + unclosed } };
}

// Direct method: each entry's cash movement is spread over the classes of
// its other lines (in proportion), so the classes add up to the change in
// cash exactly.
function cashFlow(dbh, cid, p) {
  const { from, to } = range(p);
  const { allocate } = require('./alloc');
  const lines = dbh.prepare(`SELECT entry_id, report_class, account_type, debit_minor - credit_minor net FROM fact_journal_lines
    WHERE company_id = ? AND entry_date BETWEEN ? AND ? ${NOT_CLOSING} ORDER BY entry_id, line_id`).all(cid, from, to);
  const byClass = new Map();
  let i = 0;
  while (i < lines.length) {
    const e = lines[i].entry_id;
    const group = [];
    while (i < lines.length && lines[i].entry_id === e) group.push(lines[i++]);
    const cash = group.filter((l) => l.report_class === 'cash');
    const other = group.filter((l) => l.report_class !== 'cash');
    const cashNet = cash.reduce((t, l) => t + l.net, 0);
    if (!cashNet) continue;
    const classes = new Map();
    for (const l of other) classes.set(l.report_class || l.account_type, (classes.get(l.report_class || l.account_type) || 0) + l.net);
    const keys = [...classes.keys()];
    const parts = keys.length ? allocate(cashNet, keys.map((k) => classes.get(k))) : [cashNet];
    (keys.length ? keys : ['unclassified']).forEach((k, j) => byClass.set(k, (byClass.get(k) || 0) + parts[j]));
  }
  const rows = [...byClass.entries()].map(([report_class, amount]) => ({ report_class, amount })).sort((a, b) => a.report_class.localeCompare(b.report_class));
  const opening = dbh.prepare("SELECT COALESCE(SUM(debit_minor - credit_minor), 0) s FROM fact_journal_lines WHERE company_id = ? AND report_class = 'cash' AND entry_date < ?").get(cid, from).s;
  const net = sum(rows, 'amount');
  return { columns: [col('report_class', 'مصدر / استخدام النقد (حسب تصنيف الطرف المقابل)', 'Source / use of cash (counterpart class)'), money('amount', 'المبلغ', 'Amount')], rows, totals: { opening_cash: opening, net_change: net, closing_cash: opening + net } };
}

function periodComparison(dbh, cid, p, unit) {
  const { from, to } = range(p);
  const keyExpr = unit === 'month' ? 'ym' : 'substr(entry_date, 1, 4)';
  const data = dbh.prepare(`SELECT ${keyExpr} k, COALESCE(report_class, CASE WHEN account_type = 'revenue' THEN 'revenue' ELSE 'opex' END) cls, COALESCE(SUM(credit_minor - debit_minor), 0) net
    FROM fact_journal_lines WHERE company_id = ? AND entry_date BETWEEN ? AND ? AND account_type IN ('revenue', 'expense') ${NOT_CLOSING} GROUP BY k, cls`).all(cid, from, to);
  const keys = [...new Set(data.map((d) => d.k))].sort();
  const rows = keys.map((k) => {
    const g = (cls) => data.filter((d) => d.k === k && d.cls === cls).reduce((t, d) => t + d.net, 0);
    const net = data.filter((d) => d.k === k).reduce((t, d) => t + d.net, 0);
    const revenue = g('revenue');
    const cogs = -g('cogs');
    return { [unit]: k, revenue, cogs, gross_profit: revenue - cogs, opex: -g('opex'), net_income: net, margin_bp: revenue ? Math.round(((revenue - cogs) * 10000) / revenue) : null };
  });
  rows.forEach((r, i) => { r.change_net_income = i ? r.net_income - rows[i - 1].net_income : null; });
  return { columns: [col(unit, unit === 'month' ? 'الشهر' : 'السنة', unit), money('revenue', 'الإيرادات', 'Revenue'), money('cogs', 'تكلفة المبيعات', 'COGS'), money('gross_profit', 'مجمل الربح', 'Gross profit'), money('opex', 'المصاريف', 'Opex'), money('net_income', 'صافي الربح', 'Net income'), money('change_net_income', 'التغير', 'Change')], rows, totals: { net_income: sum(rows, 'net_income'), revenue: sum(rows, 'revenue') } };
}

function budgetVsActual(dbh, cid, p) {
  const budgetId = num(p.budgetId);
  const b = budgetId ? dbh.prepare('SELECT * FROM budgets WHERE id = ? AND company_id = ?').get(budgetId, cid) : null;
  if (!b) fail('invalid_budget', 'اختر الموازنة');
  const lines = dbh.prepare(`SELECT bl.account_id, a.code, a.name_ar, a.type, SUM(bl.amount_minor) budget, MIN(fp.start_date) from_d, MAX(fp.end_date) to_d
    FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id JOIN fiscal_periods fp ON fp.id = bl.period_id WHERE bl.budget_id = ? GROUP BY bl.account_id ORDER BY a.code`).all(b.id);
  const rows = lines.map((l) => {
    const net = dbh.prepare(`SELECT COALESCE(SUM(debit_minor - credit_minor), 0) s FROM fact_journal_lines WHERE company_id = ? AND account_id = ? AND entry_date BETWEEN ? AND ? ${NOT_CLOSING}`).get(cid, l.account_id, l.from_d, l.to_d).s;
    const actual = l.type === 'revenue' ? -net : net;
    return { ...l, actual, variance: actual - l.budget, drill: { kind: 'gl', accountId: l.account_id, from: l.from_d, to: l.to_d, excludeClosing: 1 } };
  });
  return { columns: [col('code', 'الرمز', 'Code'), col('name_ar', 'الحساب', 'Account'), money('budget', 'الموازنة', 'Budget'), money('actual', 'الفعلي', 'Actual'), money('variance', 'الفرق', 'Variance')], rows, totals: { budget: sum(rows, 'budget'), actual: sum(rows, 'actual'), variance: sum(rows, 'variance') } };
}

const EXP_BY = { account: 'account_id', cost_center: 'cost_center_id', project: 'project_id', supplier: 'supplier_id', employee: 'employee_id', month: 'ym', branch: 'branch_id' };
function expenseAnalysis(dbh, cid, p) {
  const { from, to } = range(p);
  const by = EXP_BY[p.by || 'account'] ? (p.by || 'account') : fail('invalid_dimension', 'بُعد غير مدعوم');
  const k = EXP_BY[by];
  const rows = dbh.prepare(`SELECT ${k} k, COALESCE(SUM(amount_minor), 0) amount, COUNT(*) lines FROM fact_expenses WHERE company_id = ? AND entry_date BETWEEN ? AND ? GROUP BY ${k} ORDER BY amount DESC`).all(cid, from, to)
    .map((r) => ({ [by]: r.k, label: label(dbh, by, r.k), amount: r.amount, lines: r.lines, drill: by === 'account' ? { kind: 'gl', accountId: r.k, from, to, excludeClosing: 1 } : { kind: 'facts', fact: 'expenses', filters: { [k]: r.k, from, to } } }));
  return { columns: [col('label', ...(DIM_LABEL[by] || [by, by])), money('amount', 'المبلغ', 'Amount'), col('lines', 'السطور', 'Lines', 'number')], rows, totals: { amount: sum(rows, 'amount') } };
}

function fxGainLoss(dbh, cid, p) {
  const { from, to } = range(p);
  const rows = dbh.prepare(`SELECT f.ym, a.code, a.name_ar, f.account_id, f.source_type, COALESCE(SUM(f.credit_minor - f.debit_minor), 0) gain
    FROM fact_journal_lines f JOIN accounts a ON a.id = f.account_id WHERE f.company_id = ? AND f.entry_date BETWEEN ? AND ? AND a.system_key IN ('fx_realized', 'fx_unrealized') ${NOT_CLOSING}
    GROUP BY f.ym, f.account_id, f.source_type ORDER BY f.ym, a.code`).all(cid, from, to).map((r) => ({ ...r, drill: { kind: 'gl', accountId: r.account_id, from, to, excludeClosing: 1 } }));
  return { columns: [col('ym', 'الشهر', 'Month'), col('name_ar', 'الحساب', 'Account'), col('source_type', 'المصدر', 'Source'), money('gain', 'ربح (+) / خسارة (-)', 'Gain (+) / loss (-)')], rows, totals: { gain: sum(rows, 'gain') } };
}

// ---------------------------------------------------------------------
// Labels for dimensions
// ---------------------------------------------------------------------

function label(dbh, dim, id) {
  if (id === null || id === undefined) return '—';
  const one = (sql) => dbh.prepare(sql).get(id);
  switch (dim) {
    case 'account': { const a = one('SELECT code, name_ar FROM accounts WHERE id = ?'); return a ? `${a.code} ${a.name_ar}` : String(id); }
    case 'cost_center': return one('SELECT code || \' \' || name n FROM cost_centers WHERE id = ?')?.n ?? String(id);
    case 'project': return one('SELECT code || \' \' || name n FROM projects WHERE id = ?')?.n ?? String(id);
    case 'supplier': return one('SELECT name n FROM suppliers WHERE id = ?')?.n ?? String(id);
    case 'customer': return one('SELECT name n FROM shops WHERE id = ?')?.n ?? String(id);
    case 'employee': case 'rep': return one('SELECT name n FROM users WHERE id = ?')?.n ?? String(id);
    case 'item': return one('SELECT name n FROM products WHERE id = ?')?.n ?? String(id);
    case 'branch': return one('SELECT name n FROM branches_ref WHERE id = ?')?.n ?? String(id);
    case 'warehouse': return one('SELECT name n FROM warehouses WHERE id = ?')?.n ?? String(id);
    case 'holder': return one('SELECT name n FROM stock_holders WHERE id = ?')?.n ?? String(id);
    default: return String(id);
  }
}

// ---------------------------------------------------------------------
// Operational
// ---------------------------------------------------------------------

const SALES_BY = { item: 'product_id', customer: 'customer_id', branch: 'branch_id', rep: 'rep_id', region: 'region', category: 'category', channel: 'channel', month: 'ym', warehouse: 'warehouse_id' };
function salesBy(dbh, cid, p) {
  const { from, to } = range(p);
  const by = p.by || 'item';
  const k = SALES_BY[by] || fail('invalid_dimension', 'بُعد غير مدعوم');
  const rows = dbh.prepare(`SELECT ${k} k, COALESCE(SUM(qty), 0) qty, COALESCE(SUM(net_base_minor), 0) net, COALESCE(SUM(cost_base_minor), 0) cost, COUNT(DISTINCT doc_type || doc_id) docs
    FROM fact_sales_lines WHERE company_id = ? AND doc_date BETWEEN ? AND ? GROUP BY ${k} ORDER BY net DESC`).all(cid, from, to)
    .map((r) => ({ [by]: r.k, label: ['region', 'category', 'channel', 'month'].includes(by) ? (r.k ?? '—') : label(dbh, by, r.k), qty: r.qty, net: r.net, cost: r.cost, margin: r.net - r.cost, documents: r.docs, drill: { kind: 'facts', fact: 'sales', filters: { [k]: r.k, from, to } } }));
  return { columns: [col('label', ...(DIM_LABEL[by] || [by, by])), col('qty', 'الكمية', 'Qty', 'number'), money('net', 'صافي المبيعات', 'Net sales'), money('cost', 'التكلفة', 'Cost'), money('margin', 'الهامش', 'Margin'), col('documents', 'المستندات', 'Docs', 'number')], rows, totals: { qty: sum(rows, 'qty'), net: sum(rows, 'net'), cost: sum(rows, 'cost'), margin: sum(rows, 'margin') } };
}

const PURCH_BY = { supplier: 'supplier_id', item: 'product_id', category: 'category', kind: 'kind', month: 'ym', account: 'expense_account_id' };
function purchasesBy(dbh, cid, p) {
  const { from, to } = range(p);
  const by = p.by || 'supplier';
  const k = PURCH_BY[by] || fail('invalid_dimension', 'بُعد غير مدعوم');
  const rows = dbh.prepare(`SELECT ${k} k, COALESCE(SUM(qty), 0) qty, COALESCE(SUM(net_base_minor), 0) net, COUNT(DISTINCT doc_type || doc_id) docs
    FROM fact_purchase_lines WHERE company_id = ? AND doc_date BETWEEN ? AND ? GROUP BY ${k} ORDER BY net DESC`).all(cid, from, to)
    .map((r) => ({ [by]: r.k, label: ['category', 'kind', 'month'].includes(by) ? (r.k ?? '—') : label(dbh, by === 'account' ? 'account' : by, r.k), qty: r.qty, net: r.net, documents: r.docs, drill: { kind: 'facts', fact: 'purchases', filters: { [k]: r.k, from, to } } }));
  return { columns: [col('label', ...(DIM_LABEL[by] || [by, by])), col('qty', 'الكمية', 'Qty', 'number'), money('net', 'صافي المشتريات', 'Net purchases'), col('documents', 'المستندات', 'Docs', 'number')], rows, totals: { qty: sum(rows, 'qty'), net: sum(rows, 'net') } };
}

function stockMovement(dbh, cid, p) {
  const { from, to } = range(p);
  const rows = dbh.prepare(`SELECT product_id, move_type, COALESCE(SUM(qty), 0) qty, COALESCE(SUM(value_minor), 0) value FROM fact_inventory_moves
    WHERE company_id = ? AND move_date BETWEEN ? AND ? GROUP BY product_id, move_type ORDER BY product_id, move_type`).all(cid, from, to)
    .map((r) => ({ ...r, item: label(dbh, 'item', r.product_id), drill: { kind: 'facts', fact: 'inventory', filters: { product_id: r.product_id, move_type: r.move_type, from, to } } }));
  return { columns: [col('item', 'المادة', 'Item'), col('move_type', 'نوع الحركة', 'Move type'), col('qty', 'الكمية', 'Qty', 'number'), money('value', 'القيمة', 'Value')], rows, totals: { value: sum(rows, 'value') } };
}

function stockOnHand(dbh, cid, p) {
  const { to } = range(p, { needFrom: false });
  const by = p.by === 'holder' ? 'holder' : 'item';
  const rows = dbh.prepare(`SELECT product_id, ${by === 'holder' ? 'holder_id,' : ''} COALESCE(SUM(qty), 0) qty, COALESCE(SUM(value_minor), 0) value FROM fact_inventory_moves
    WHERE company_id = ? AND move_date <= ? GROUP BY product_id ${by === 'holder' ? ', holder_id' : ''} ORDER BY product_id`).all(cid, to)
    .filter((r) => Math.abs(r.qty) > 1e-9 || r.value).map((r) => ({ ...r, item: label(dbh, 'item', r.product_id), holder: r.holder_id ? label(dbh, 'holder', r.holder_id) : undefined, unit_cost: Math.abs(r.qty) > 1e-9 ? Math.round(r.value / r.qty) : null, drill: { kind: 'facts', fact: 'inventory', filters: { product_id: r.product_id, ...(r.holder_id ? { holder_id: r.holder_id } : {}), to } } }));
  return { columns: [col('item', 'المادة', 'Item'), ...(by === 'holder' ? [col('holder', 'المكان', 'Holder')] : []), col('qty', 'الكمية', 'Qty', 'number'), money('unit_cost', 'تكلفة الوحدة', 'Unit cost'), money('value', 'القيمة', 'Value')], rows, totals: { value: sum(rows, 'value') } };
}

function countVariances(dbh, cid, p) {
  const { from, to } = range(p);
  const rows = dbh.prepare(`SELECT product_id, move_type, COALESCE(SUM(qty), 0) qty, COALESCE(SUM(value_minor), 0) value, COUNT(*) moves FROM fact_inventory_moves
    WHERE company_id = ? AND move_date BETWEEN ? AND ? AND move_type IN ('count', 'adjustment') GROUP BY product_id, move_type ORDER BY value`).all(cid, from, to)
    .map((r) => ({ ...r, item: label(dbh, 'item', r.product_id), drill: { kind: 'facts', fact: 'inventory', filters: { product_id: r.product_id, move_type: r.move_type, from, to } } }));
  return { columns: [col('item', 'المادة', 'Item'), col('move_type', 'النوع', 'Type'), col('qty', 'فرق الكمية', 'Qty variance', 'number'), money('value', 'فرق القيمة', 'Value variance')], rows, totals: { value: sum(rows, 'value') } };
}

// Customer-level FIFO aging: credits settle the oldest debits first; the
// open debits are bucketed by due date (or date). Total = AR control.
const BUCKETS = [['current', -Infinity, 0], ['d1_30', 1, 30], ['d31_60', 31, 60], ['d61_90', 61, 90], ['d90_plus', 91, Infinity]];
function receivableAging(dbh, cid, p) {
  const { to } = range(p, { needFrom: false });
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const custs = dbh.prepare('SELECT DISTINCT customer_id FROM fact_receivables WHERE company_id = ? AND entry_date <= ? ORDER BY customer_id').all(cid, to).map((r) => r.customer_id);
  const rows = [];
  for (const c of custs) {
    const ls = dbh.prepare('SELECT entry_date, due_date, debit_minor, credit_minor FROM fact_receivables WHERE company_id = ? AND customer_id IS ? AND entry_date <= ? ORDER BY entry_date, line_id').all(cid, c, to);
    const open = [];
    let credit = 0;
    for (const l of ls) {
      if (l.debit_minor) open.push({ amount: l.debit_minor, date: l.due_date || l.entry_date });
      credit += l.credit_minor;
    }
    for (const o of open) { const take = Math.min(o.amount, credit); o.amount -= take; credit -= take; }
    const r = { customer_id: c, customer: label(dbh, 'customer', c), current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied_credit: -credit };
    for (const o of open.filter((x) => x.amount)) {
      const d = days(o.date, to);
      const b = BUCKETS.find(([, lo, hi]) => d >= lo && d <= hi) || BUCKETS[0];
      r[b[0]] += o.amount;
    }
    r.total = r.current + r.d1_30 + r.d31_60 + r.d61_90 + r.d90_plus + r.unapplied_credit;
    r.drill = { kind: 'facts', fact: 'receivables', filters: { customer_id: c, to } };
    if (r.total || r.unapplied_credit) rows.push(r);
  }
  return { columns: [col('customer', 'الزبون', 'Customer'), money('current', 'غير مستحق', 'Current'), money('d1_30', '1-30', '1-30'), money('d31_60', '31-60', '31-60'), money('d61_90', '61-90', '61-90'), money('d90_plus', '+90', '90+'), money('unapplied_credit', 'دفعات غير مخصصة', 'Unapplied'), money('total', 'الإجمالي', 'Total')], rows, totals: Object.fromEntries(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unapplied_credit', 'total'].map((k) => [k, sum(rows, k)])) };
}

function collections(dbh, cid, p) {
  const { from, to } = range(p);
  const by = ['customer', 'rep', 'method', 'month', 'region'].includes(p.by) ? p.by : 'customer';
  const k = { customer: 'customer_id', rep: 'rep_id', method: 'method', month: 'ym', region: 'region' }[by];
  const rows = dbh.prepare(`SELECT ${k} k, COALESCE(SUM(credit_minor - debit_minor), 0) amount, COUNT(DISTINCT source_id) receipts FROM fact_receivables
    WHERE company_id = ? AND entry_date BETWEEN ? AND ? AND source_type IN ('customer_receipt', 'collection') GROUP BY ${k} ORDER BY amount DESC`).all(cid, from, to)
    .map((r) => ({ [by]: r.k, label: ['method', 'month', 'region'].includes(by) ? (r.k ?? '—') : label(dbh, by, r.k), amount: r.amount, receipts: r.receipts, drill: { kind: 'facts', fact: 'receivables', filters: { [k]: r.k, from, to, source_type: 'customer_receipt' } } }));
  return { columns: [col('label', ...(DIM_LABEL[by] || [by, by])), money('amount', 'المحصّل', 'Collected'), col('receipts', 'السندات', 'Receipts', 'number')], rows, totals: { amount: sum(rows, 'amount') } };
}

function repExpenses(dbh, cid, p) {
  const { from, to } = range(p);
  const rows = dbh.prepare(`SELECT employee_id, account_id, COALESCE(SUM(amount_minor), 0) amount FROM fact_expenses WHERE company_id = ? AND entry_date BETWEEN ? AND ? AND employee_id IS NOT NULL GROUP BY employee_id, account_id ORDER BY employee_id`).all(cid, from, to)
    .map((r) => ({ ...r, rep: label(dbh, 'rep', r.employee_id), account: label(dbh, 'account', r.account_id), drill: { kind: 'facts', fact: 'expenses', filters: { employee_id: r.employee_id, account_id: r.account_id, from, to } } }));
  return { columns: [col('rep', 'المندوب', 'Rep'), col('account', 'الحساب', 'Account'), money('amount', 'المبلغ', 'Amount')], rows, totals: { amount: sum(rows, 'amount') } };
}

function repPerformance(dbh, cid, p) {
  const { from, to } = range(p);
  const sales = dbh.prepare('SELECT rep_id, COALESCE(SUM(net_base_minor), 0) net, COUNT(DISTINCT customer_id) customers FROM fact_sales_lines WHERE company_id = ? AND doc_date BETWEEN ? AND ? GROUP BY rep_id').all(cid, from, to);
  const coll = dbh.prepare("SELECT rep_id, COALESCE(SUM(credit_minor - debit_minor), 0) amount FROM fact_receivables WHERE company_id = ? AND entry_date BETWEEN ? AND ? AND source_type IN ('customer_receipt', 'collection') GROUP BY rep_id").all(cid, from, to);
  const reps = [...new Set([...sales.map((s) => s.rep_id), ...coll.map((x) => x.rep_id)])];
  const rows = reps.map((r) => ({ rep_id: r, rep: label(dbh, 'rep', r), sales: sales.find((s) => s.rep_id === r)?.net ?? 0, customers: sales.find((s) => s.rep_id === r)?.customers ?? 0, collected: coll.find((x) => x.rep_id === r)?.amount ?? 0, drill: { kind: 'facts', fact: 'sales', filters: { rep_id: r, from, to } } })).sort((a, b) => b.sales - a.sales);
  return { columns: [col('rep', 'المندوب', 'Rep'), money('sales', 'المبيعات', 'Sales'), money('collected', 'التحصيل', 'Collected'), col('customers', 'الزبائن', 'Customers', 'number')], rows, totals: { sales: sum(rows, 'sales'), collected: sum(rows, 'collected') } };
}

// ---------------------------------------------------------------------
// Manufacturing
// ---------------------------------------------------------------------

function batches(dbh, cid, p) {
  const { from, to } = range(p);
  return dbh.prepare('SELECT * FROM fact_production_batches WHERE company_id = ? AND production_date BETWEEN ? AND ? ORDER BY production_date, order_id').all(cid, from, to);
}
const batchTotal = (b) => b.materials_minor + b.labour_minor + b.energy_minor + b.overhead_minor - b.byproduct_credit_minor;
function batchCost(dbh, cid, p) {
  const rows = batches(dbh, cid, p).map((b) => ({ ...b, item: label(dbh, 'item', b.product_id), total: batchTotal(b), cost_per_unit: b.actual_units ? Math.round(b.fg_value_minor / b.actual_units) : null, drill: { kind: 'facts', fact: 'inventory', filters: { source_type: 'mfg_order', source_id: b.order_id } } }));
  return { columns: [col('order_number', 'الأمر', 'Order'), col('item', 'المنتج', 'Product'), money('materials_minor', 'المواد', 'Materials'), money('labour_minor', 'العمل', 'Labour'), money('energy_minor', 'الطاقة', 'Energy'), money('overhead_minor', 'غير مباشرة', 'Overhead'), money('byproduct_credit_minor', 'منتج ثانوي', 'By-product'), money('abnormal_loss_minor', 'هدر غير طبيعي', 'Abnormal loss'), money('fg_value_minor', 'قيمة الإنتاج', 'FG value'), money('cost_per_unit', 'تكلفة الوحدة', 'Unit cost')], rows, totals: { fg_value_minor: sum(rows, 'fg_value_minor'), total: sum(rows, 'total') } };
}
function mixCost(dbh, cid, p) {
  const bs = batches(dbh, cid, p).filter((b) => b.status === 'closed');
  const prods = [...new Set(bs.map((b) => b.product_id))];
  const rows = prods.map((pid) => {
    const g = bs.filter((b) => b.product_id === pid);
    const fg = sum(g, 'fg_value_minor');
    const units = g.reduce((t, b) => t + (b.actual_units || 0), 0);
    const kg = g.reduce((t, b) => t + (b.actual_kg || 0), 0);
    return { product_id: pid, item: label(dbh, 'item', pid), batches: g.length, units, fg_value: fg, cost_per_unit: units ? Math.round(fg / units) : null, cost_per_kg: kg ? Math.round(fg / kg) : null, drill: { kind: 'facts', fact: 'production', filters: { product_id: pid } } };
  });
  return { columns: [col('item', 'الخلطة', 'Mix'), col('batches', 'الدفعات', 'Batches', 'number'), col('units', 'الوحدات', 'Units', 'number'), money('fg_value', 'التكلفة', 'Cost'), money('cost_per_unit', 'للوحدة', 'Per unit'), money('cost_per_kg', 'للكيلو', 'Per kg')], rows, totals: { fg_value: sum(rows, 'fg_value') } };
}
function yieldReport(dbh, cid, p) {
  const rows = batches(dbh, cid, p).filter((b) => b.status === 'closed').map((b) => ({ order_number: b.order_number, item: label(dbh, 'item', b.product_id), expected_units: b.expected_units, actual_units: b.actual_units, yield_bp: b.expected_units ? Math.round((b.actual_units * 10000) / b.expected_units) : null, drill: { kind: 'facts', fact: 'production', filters: { order_id: b.order_id } } }));
  return { columns: [col('order_number', 'الأمر', 'Order'), col('item', 'المنتج', 'Product'), col('expected_units', 'المتوقع', 'Expected', 'number'), col('actual_units', 'الفعلي', 'Actual', 'number'), col('yield_bp', 'المردود (نقطة أساس)', 'Yield (bp)', 'number')], rows, totals: {} };
}
function lossReport(dbh, cid, p) {
  const rows = batches(dbh, cid, p).filter((b) => b.abnormal_loss_minor || b.written_off_minor).map((b) => ({ order_number: b.order_number, item: label(dbh, 'item', b.product_id), status: b.status, abnormal_loss: b.abnormal_loss_minor, written_off: b.written_off_minor, drill: { kind: 'facts', fact: 'production', filters: { order_id: b.order_id } } }));
  return { columns: [col('order_number', 'الأمر', 'Order'), col('item', 'المنتج', 'Product'), col('status', 'الحالة', 'Status'), money('abnormal_loss', 'هدر غير طبيعي', 'Abnormal loss'), money('written_off', 'دفعة مرفوضة', 'Rejected batch')], rows, totals: { abnormal_loss: sum(rows, 'abnormal_loss'), written_off: sum(rows, 'written_off') } };
}
function consumption(dbh, cid, p) {
  const { from, to } = range(p);
  const rows = dbh.prepare(`SELECT product_id, COALESCE(SUM(-qty), 0) qty, COALESCE(SUM(-value_minor), 0) value FROM fact_inventory_moves
    WHERE company_id = ? AND move_date BETWEEN ? AND ? AND move_type IN ('production_issue', 'production_return') GROUP BY product_id ORDER BY value DESC`).all(cid, from, to)
    .map((r) => ({ ...r, item: label(dbh, 'item', r.product_id), drill: { kind: 'facts', fact: 'inventory', filters: { product_id: r.product_id, move_type: 'production_issue', from, to } } }));
  return { columns: [col('item', 'المادة', 'Material'), col('qty', 'المستهلك', 'Consumed', 'number'), money('value', 'القيمة', 'Value')], rows, totals: { value: sum(rows, 'value') } };
}
function profitability(dbh, cid, p, by) {
  return salesBy(dbh, cid, { ...p, by });
}

// ---------------------------------------------------------------------
// Payroll (aggregate cost; detail stays in payroll)
// ---------------------------------------------------------------------

function payrollCost(dbh, cid, p) {
  const rows = dbh.prepare('SELECT period, department, COALESCE(SUM(gross_base_minor), 0) gross, COALESCE(SUM(employer_base_minor), 0) employer FROM fact_payroll WHERE company_id = ? GROUP BY period, department ORDER BY period, department').all(cid)
    .filter((r) => (!p.from || r.period >= p.from.slice(0, 7)) && (!p.to || r.period <= p.to.slice(0, 7))).map((r) => ({ ...r, cost: r.gross + r.employer }));
  return { columns: [col('period', 'الفترة', 'Period'), col('department', 'القسم', 'Department'), money('gross', 'الإجمالي', 'Gross'), money('employer', 'مساهمات صاحب العمل', 'Employer'), money('cost', 'التكلفة', 'Cost')], rows, totals: { cost: sum(rows, 'cost') } };
}

// ---------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------

const R = (key, family, ar, en, run, extra = {}) => ({ key, family, name_ar: ar, name_en: en, run, ...extra });
const CATALOG = [
  R('trial_balance', 'financial', 'ميزان المراجعة', 'Trial balance', trialBalance),
  R('general_ledger', 'financial', 'دفتر الأستاذ', 'General ledger', generalLedger, { params: ['accountId'] }),
  R('income_statement', 'financial', 'قائمة الدخل', 'Income statement', incomeStatement),
  R('balance_sheet', 'financial', 'الميزانية العمومية', 'Balance sheet', balanceSheet, { asOf: true }),
  R('cash_flow', 'financial', 'التدفقات النقدية', 'Cash flow', cashFlow),
  R('monthly_comparison', 'financial', 'مقارنة شهرية', 'Monthly comparison', (d, c, p) => periodComparison(d, c, p, 'month')),
  R('yearly_comparison', 'financial', 'مقارنة سنوية', 'Yearly comparison', (d, c, p) => periodComparison(d, c, p, 'year')),
  R('budget_vs_actual', 'financial', 'الموازنة مقابل الفعلي', 'Budget vs actual', budgetVsActual, { params: ['budgetId'] }),
  R('expense_analysis', 'financial', 'تحليل المصاريف', 'Expense analysis', expenseAnalysis, { dims: Object.keys(EXP_BY) }),
  R('fx_gain_loss', 'financial', 'أرباح وخسائر فروقات الصرف', 'FX gain / loss', fxGainLoss),
  R('sales_by_item', 'sales', 'المبيعات حسب المادة', 'Sales by item', (d, c, p) => salesBy(d, c, { ...p, by: 'item' })),
  R('sales_by_customer', 'sales', 'المبيعات حسب الزبون', 'Sales by customer', (d, c, p) => salesBy(d, c, { ...p, by: 'customer' })),
  R('sales_by_branch', 'sales', 'المبيعات حسب الفرع', 'Sales by branch', (d, c, p) => salesBy(d, c, { ...p, by: 'branch' })),
  R('sales_by_rep', 'sales', 'المبيعات حسب المندوب', 'Sales by rep', (d, c, p) => salesBy(d, c, { ...p, by: 'rep' })),
  R('sales_by', 'sales', 'المبيعات حسب بُعد', 'Sales by dimension', salesBy, { dims: Object.keys(SALES_BY) }),
  R('purchases_by_supplier', 'purchases', 'المشتريات حسب المورد', 'Purchases by supplier', (d, c, p) => purchasesBy(d, c, { ...p, by: 'supplier' })),
  R('purchases_by_item', 'purchases', 'المشتريات حسب المادة', 'Purchases by item', (d, c, p) => purchasesBy(d, c, { ...p, by: 'item' })),
  R('stock_on_hand', 'inventory', 'المخزون وقيمته', 'Stock on hand', stockOnHand, { asOf: true }),
  R('stock_movement', 'inventory', 'حركة المخزون', 'Stock movement', stockMovement),
  R('count_variances', 'inventory', 'فروقات الجرد والتسويات', 'Count variances', countVariances),
  R('receivable_aging', 'receivables', 'أعمار الذمم المدينة', 'Receivable aging', receivableAging, { asOf: true }),
  R('collections', 'receivables', 'التحصيلات', 'Collections', collections, { dims: ['customer', 'rep', 'method', 'month', 'region'] }),
  R('rep_expenses', 'operations', 'مصاريف المندوبين', 'Rep expenses', repExpenses),
  R('rep_performance', 'operations', 'أداء المندوبين', 'Rep performance', repPerformance),
  R('mix_cost', 'manufacturing', 'تكلفة الخلطة', 'Mix cost', mixCost),
  R('batch_cost', 'manufacturing', 'تكلفة الدفعة', 'Batch cost', batchCost),
  R('yield', 'manufacturing', 'المردود', 'Yield', yieldReport),
  R('loss', 'manufacturing', 'الهدر والفاقد', 'Loss', lossReport),
  R('consumption', 'manufacturing', 'استهلاك المواد', 'Consumption', consumption),
  R('cost_variances', 'manufacturing', 'انحرافات التكلفة', 'Cost variances', null, { live: true }),
  R('product_profitability', 'manufacturing', 'ربحية المنتجات', 'Product profitability', (d, c, p) => profitability(d, c, p, 'item')),
  R('customer_profitability', 'manufacturing', 'ربحية الزبائن', 'Customer profitability', (d, c, p) => profitability(d, c, p, 'customer')),
  R('lot_trace', 'manufacturing', 'تتبع الدفعة', 'Lot trace', null, { live: true, params: ['lotId'] }),
  R('recall', 'manufacturing', 'السحب من السوق', 'Recall', null, { live: true, params: ['lotId'] }),
  R('payroll_cost', 'payroll', 'تكلفة الرواتب حسب القسم', 'Payroll cost by department', payrollCost, { permission: 'payroll' }),
];
const BY_KEY = Object.fromEntries(CATALOG.map((r) => [r.key, r]));

function run(dbh, companyId, key, params = {}) {
  const def = BY_KEY[key];
  if (!def || def.live) fail('unknown_report', 'تقرير غير معروف', 404);
  return def.run(dbh, companyId, params);
}

module.exports = { ReportError, CATALOG, BY_KEY, run, label };
