// backend/lib/financialReports.js
//
// Financial statements computed from the ledger (Prompt 4): trial balance,
// general ledger / account statement, income statement, balance sheet, cash
// flow (direct + indirect), budget vs actual, expense analysis, year-end
// close and the month-end checklist.
//
// One aggregation (accountTotals) feeds every report, so they can't drift
// apart. Amounts are integer minor units of the base currency. Posted and
// reversed entries both count (a reversal is its own posted entry).
//
// Drill-down convention: every amount row carries `drill` =
// { accountId?, from, to, branchId?, costCenterId?, projectId?, excludeClosing? }
// — the same query parameters GET /api/reports/general-ledger accepts, so the
// frontend opens the ledger lines behind any number with one component.

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const { logAudit } = require('./auditLog');
const { fromMinor } = require('./ledgerCurrencies');
const reportClasses = require('./reportClass');

class ReportError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new ReportError(code, message, status, extra);
};
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const CLOSING_SOURCE = 'year_end_close';

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function daysInclusive(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function digits(companyId) {
  return ledger.getBaseCurrency(companyId).minor_unit_digits;
}

// ---------------------------------------------------------------------
// Parameters & accounts
// ---------------------------------------------------------------------

// Validates the shared report parameters; dimension ids go through the
// one tenant-ownership helper.
function params(companyId, q = {}, { needFrom = true } = {}) {
  const to = q.to || today();
  const from = q.from || (needFrom ? `${to.slice(0, 4)}-01-01` : null);
  if (!isDate(to) || (from && !isDate(from)) || (from && from > to)) fail('invalid_dates', 'الفترة غير صالحة');
  const own = (kind, v) => {
    if (v === undefined || v === null || v === '') return null;
    try {
      return tenantRefs.requireOwned(companyId, kind, v).id;
    } catch (err) {
      if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
      throw err;
    }
  };
  return {
    from,
    to,
    branchId: own('branch', q.branchId),
    costCenterId: own('cost_center', q.costCenterId),
    projectId: own('project', q.projectId),
  };
}

// Statement class from accounts.report_class only (never the code). NULL
// falls back to the type default. contra_asset (accumulated depreciation)
// is shown with fixed assets; a current-asset allowance (doubtful debts) is
// simply classed current_asset — signs follow the account type anyway.
function effectiveClass(a) {
  const own = a.report_class || reportClasses.DEFAULT_BY_TYPE[a.type];
  return own === 'contra_asset' ? 'fixed_asset' : own;
}

function loadAccounts(companyId) {
  const rows = db.prepare('SELECT id, code, name_ar, name_en, type, normal_balance, parent_id, is_postable, is_active, system_key, report_class FROM accounts WHERE company_id = ? ORDER BY code').all(companyId);
  const byId = new Map(rows.map((a) => [a.id, { ...a, children: [] }]));
  for (const a of byId.values()) if (a.parent_id && byId.has(a.parent_id)) byId.get(a.parent_id).children.push(a.id);
  for (const a of byId.values()) {
    a.cls = effectiveClass(a);
    a.depth = 0;
    let p = a.parent_id;
    const seen = new Set();
    while (p && byId.has(p) && !seen.has(p)) {
      seen.add(p);
      a.depth += 1;
      p = byId.get(p).parent_id;
    }
  }
  return byId;
}

function descendantsOf(byId, id) {
  const out = [];
  const walk = (x) => {
    const a = byId.get(x);
    if (!a) return;
    if (a.is_postable || !a.children.length) out.push(a.id);
    for (const c of a.children) walk(c);
  };
  walk(id);
  return out;
}

// ---------------------------------------------------------------------
// The one aggregation
// ---------------------------------------------------------------------

// Per account: debit/credit before `from` (opening) and within [from, to].
// Filters: branch (entry), cost center / project (line), excludeClosing
// (year-end closing entries, for P&L views).
function accountTotals(companyId, { from, to, branchId, costCenterId, projectId, excludeClosing = false, accountIds = null }) {
  const where = ['e.company_id = ?', "e.status IN ('posted','reversed')", 'e.entry_date <= ?'];
  const p = [from || '0000-01-01', from || '0000-01-01', from || '0000-01-01', from || '0000-01-01', companyId, to];
  if (branchId) { where.push('e.branch_id = ?'); p.push(branchId); }
  if (costCenterId) { where.push('l.cost_center_id = ?'); p.push(costCenterId); }
  if (projectId) { where.push('l.project_id = ?'); p.push(projectId); }
  if (excludeClosing) where.push(`e.source_type <> '${CLOSING_SOURCE}'`);
  if (accountIds) where.push(`l.account_id IN (${accountIds.map(() => '?').join(',') || 'NULL'})`), p.push(...accountIds);
  const rows = db
    .prepare(
      `SELECT l.account_id,
         SUM(CASE WHEN e.entry_date < ? THEN l.debit_minor ELSE 0 END) AS od,
         SUM(CASE WHEN e.entry_date < ? THEN l.credit_minor ELSE 0 END) AS oc,
         SUM(CASE WHEN e.entry_date >= ? THEN l.debit_minor ELSE 0 END) AS pd,
         SUM(CASE WHEN e.entry_date >= ? THEN l.credit_minor ELSE 0 END) AS pc
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE ${where.join(' AND ')}
       GROUP BY l.account_id`
    )
    .all(...p);
  return new Map(rows.map((r) => [r.account_id, { od: r.od, oc: r.oc, pd: r.pd, pc: r.pc }]));
}

const ZERO = { od: 0, oc: 0, pd: 0, pc: 0 };
function sumTotals(list) {
  return list.reduce((t, x) => ({ od: t.od + x.od, oc: t.oc + x.oc, pd: t.pd + x.pd, pc: t.pc + x.pc }), { ...ZERO });
}

// Statement sign by account TYPE (not normal_balance), so contra accounts
// (sales returns, accumulated depreciation) reduce their section:
// assets/expenses debit-positive, liabilities/equity/revenue credit-positive.
function natural(a, debitMinusCredit) {
  return ['liability', 'equity', 'revenue'].includes(a.type) ? -debitMinusCredit : debitMinusCredit;
}

function trialBalance(companyId, q = {}) {
  const pr = params(companyId, q);
  const byId = loadAccounts(companyId);
  const totals = accountTotals(companyId, pr);
  const t = (id) => totals.get(id) || ZERO;
  const rollup = new Map();
  const roll = (id) => {
    if (rollup.has(id)) return rollup.get(id);
    const a = byId.get(id);
    const v = sumTotals([t(id), ...a.children.map(roll)]);
    rollup.set(id, v);
    return v;
  };
  for (const id of byId.keys()) roll(id);
  const split = (net) => ({ debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  const rows = [];
  const grand = { opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 0, closing_debit: 0, closing_credit: 0 };
  for (const a of byId.values()) {
    const v = rollup.get(a.id);
    const opening = v.od - v.oc;
    const closing = opening + v.pd - v.pc;
    if (q.hideZero !== '0' && !v.od && !v.oc && !v.pd && !v.pc) continue;
    const o = split(opening);
    const c = split(closing);
    const row = {
      account_id: a.id, code: a.code, name_ar: a.name_ar, name_en: a.name_en, type: a.type, depth: a.depth, is_header: !a.is_postable && a.children.length > 0,
      opening_debit: o.debit, opening_credit: o.credit, period_debit: v.pd, period_credit: v.pc, closing_debit: c.debit, closing_credit: c.credit,
      drill: { accountId: a.id, from: pr.from, to: pr.to, branchId: pr.branchId, costCenterId: pr.costCenterId, projectId: pr.projectId },
    };
    rows.push(row);
    if (!row.is_header) {
      // Grand totals from leaves only (headers are roll-ups).
      const lo = split((t(a.id).od - t(a.id).oc));
      const lc = split(t(a.id).od - t(a.id).oc + t(a.id).pd - t(a.id).pc);
      grand.opening_debit += lo.debit;
      grand.opening_credit += lo.credit;
      grand.period_debit += t(a.id).pd;
      grand.period_credit += t(a.id).pc;
      grand.closing_debit += lc.debit;
      grand.closing_credit += lc.credit;
    }
  }
  rows.sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  const lineFiltered = !!(pr.costCenterId || pr.projectId);
  return {
    ...pr,
    rows,
    totals: grand,
    balanced: grand.period_debit === grand.period_credit && grand.opening_debit === grand.opening_credit && grand.closing_debit === grand.closing_credit,
    // A cost-center/project filter selects LINES, so it need not balance.
    line_filtered: lineFiltered,
    digits: digits(companyId),
  };
}

// ---------------------------------------------------------------------
// General ledger / account statement
// ---------------------------------------------------------------------

const SOURCE_DOC_SQL = {
  sales_invoice: 'SELECT invoice_number AS n FROM sales_invoices WHERE id = ?',
  sales_credit_note: 'SELECT credit_note_number AS n FROM sales_credit_notes WHERE id = ?',
  customer_receipt: 'SELECT receipt_number AS n FROM customer_receipts WHERE id = ?',
  collection: "SELECT '#' || id AS n FROM collections WHERE id = ?",
  customer_open_item: 'SELECT invoice_number AS n FROM open_items WHERE id = ?',
};

function generalLedger(companyId, q = {}) {
  const pr = params(companyId, q);
  const byId = loadAccounts(companyId);
  let accountIds = null;
  let account = null;
  if (q.accountId) {
    try {
      account = tenantRefs.requireOwned(companyId, 'account', q.accountId);
    } catch (err) {
      if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
      throw err;
    }
    accountIds = descendantsOf(byId, account.id);
  } else if (q.type) {
    accountIds = [...byId.values()].filter((a) => a.type === q.type).map((a) => a.id);
  } else {
    fail('account_required', 'اختر حسابًا');
  }
  const excludeClosing = q.excludeClosing === '1';
  const opening = sumTotals([...accountTotals(companyId, { ...pr, excludeClosing, accountIds }).values()]);
  const where = ['e.company_id = ?', "e.status IN ('posted','reversed')", 'e.entry_date BETWEEN ? AND ?', `l.account_id IN (${accountIds.map(() => '?').join(',') || 'NULL'})`];
  const p = [companyId, pr.from, pr.to, ...accountIds];
  if (pr.branchId) { where.push('e.branch_id = ?'); p.push(pr.branchId); }
  if (pr.costCenterId) { where.push('l.cost_center_id = ?'); p.push(pr.costCenterId); }
  if (pr.projectId) { where.push('l.project_id = ?'); p.push(pr.projectId); }
  if (excludeClosing) where.push(`e.source_type <> '${CLOSING_SOURCE}'`);
  const limit = Math.min(Number(q.limit) || 1000, 5000);
  const lines = db
    .prepare(
      `SELECT l.id, l.entry_id, l.line_no, l.account_id, l.debit_minor, l.credit_minor, l.memo, l.party_type, l.party_id,
              e.entry_number, e.entry_date, e.description, e.source_type, e.source_id, e.status, e.branch_id,
              cc.name AS cost_center_name, pj.name AS project_name,
              (SELECT COUNT(*) FROM journal_attachments ja WHERE ja.entry_id = e.id) AS attachments
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
       LEFT JOIN projects pj ON pj.id = l.project_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.entry_date, e.id, l.line_no LIMIT ?`
    )
    .all(...p, limit + 1);
  const truncated = lines.length > limit;
  if (truncated) lines.pop();
  let running = opening.od - opening.oc + opening.pd - opening.pc; // pd/pc are 0 here (from..to excluded)
  running = opening.od - opening.oc;
  const out = lines.map((l) => {
    running += l.debit_minor - l.credit_minor;
    const docSql = SOURCE_DOC_SQL[l.source_type];
    const a = byId.get(l.account_id);
    return {
      ...l,
      account_code: a?.code,
      account_name_ar: a?.name_ar,
      running_minor: running,
      source_number: docSql ? db.prepare(docSql).get(l.source_id)?.n ?? null : null,
      party_name: l.party_type === 'customer' && l.party_id ? db.prepare('SELECT name FROM shops WHERE id = ?').get(l.party_id)?.name : null,
    };
  });
  const periodDebit = out.reduce((s, l) => s + l.debit_minor, 0);
  const periodCredit = out.reduce((s, l) => s + l.credit_minor, 0);
  return {
    ...pr,
    account: account ? { id: account.id, code: account.code, name_ar: account.name_ar, type: account.type, normal_balance: account.normal_balance } : null,
    type: q.type || null,
    opening_minor: opening.od - opening.oc,
    period_debit_minor: periodDebit,
    period_credit_minor: periodCredit,
    closing_minor: opening.od - opening.oc + periodDebit - periodCredit,
    lines: out,
    truncated,
    digits: digits(companyId),
  };
}

// ---------------------------------------------------------------------
// Income statement
// ---------------------------------------------------------------------

// True while the inventory system account has never received an opening
// value (an opening-balances entry, or Prompt 8's 'inventory_opening'
// valuation). IS and BS then carry a "figures not final" banner.
function inventoryOpeningMissing(companyId) {
  const inv = ledger.getAccountBySystemKey(companyId, 'inventory');
  if (!inv) return false;
  // Stock ledger activated = the opening stock was valued (its entry may
  // be a credit or nothing when the ledger already carried that value).
  if (require('./stockLedger').isActive(companyId)) return false;
  return !db
    .prepare(
      `SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status = 'posted' AND l.account_id = ? AND l.debit_minor > 0
         AND e.source_type IN ('opening_balance', 'inventory_opening') LIMIT 1`
    )
    .get(companyId, inv.id);
}

function isSection(a) {
  if (a.type !== 'revenue' && a.type !== 'expense') return null;
  if (a.cls === 'other') return 'other';
  if (a.type === 'revenue') return 'revenue';
  return a.cls === 'cogs' ? 'cost_of_sales' : 'expenses';
}

function columnsFor(pr, q) {
  const cols = [];
  if (q.monthly === '1') {
    let start = pr.from;
    let i = 0;
    while (start <= pr.to && i < 24) {
      const monthEnd = addDays(addMonths(`${start.slice(0, 7)}-01`, 1), -1);
      const end = monthEnd < pr.to ? monthEnd : pr.to;
      cols.push({ key: `m${i}`, label: start.slice(0, 7), from: start, to: end });
      start = addDays(end, 1);
      i += 1;
    }
    return cols;
  }
  cols.push({ key: 'current', label: `${pr.from} → ${pr.to}`, from: pr.from, to: pr.to });
  if (q.compare === 'prev_year') {
    cols.push({ key: 'compare', label: `${addMonths(pr.from, -12)} → ${addMonths(pr.to, -12)}`, from: addMonths(pr.from, -12), to: addMonths(pr.to, -12) });
  } else if (q.compare === 'prev_period') {
    const len = daysInclusive(pr.from, pr.to);
    const to = addDays(pr.from, -1);
    cols.push({ key: 'compare', label: `${addDays(to, -(len - 1))} → ${to}`, from: addDays(to, -(len - 1)), to });
  }
  return cols;
}

// Period movement per account per calendar month in [from, to] (excluding
// year-end closing entries), shaped like accountTotals' pd/pc per column.
function monthlyTotals(companyId, pr, cols) {
  const where = ['e.company_id = ?', "e.status IN ('posted','reversed')", 'e.entry_date BETWEEN ? AND ?', `e.source_type <> '${CLOSING_SOURCE}'`];
  const p = [companyId, pr.from, pr.to];
  if (pr.branchId) { where.push('e.branch_id = ?'); p.push(pr.branchId); }
  if (pr.costCenterId) { where.push('l.cost_center_id = ?'); p.push(pr.costCenterId); }
  if (pr.projectId) { where.push('l.project_id = ?'); p.push(pr.projectId); }
  const rows = db
    .prepare(
      `SELECT l.account_id, substr(e.entry_date, 1, 7) AS ym, SUM(l.debit_minor) AS pd, SUM(l.credit_minor) AS pc
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE ${where.join(' AND ')} GROUP BY l.account_id, ym`
    )
    .all(...p);
  const idx = new Map(cols.map((c, i) => [c.label, i]));
  const out = cols.map(() => new Map());
  for (const r of rows) {
    const i = idx.get(r.ym);
    if (i !== undefined) out[i].set(r.account_id, { od: 0, oc: 0, pd: r.pd, pc: r.pc });
  }
  return out;
}

function incomeStatement(companyId, q = {}) {
  const pr = params(companyId, q);
  const byId = loadAccounts(companyId);
  const cols = columnsFor(pr, q);
  // Monthly: one grouped scan instead of one scan per column.
  const data = q.monthly === '1' ? monthlyTotals(companyId, pr, cols) : cols.map((c) => accountTotals(companyId, { ...pr, from: c.from, to: c.to, excludeClosing: true }));
  const sections = { revenue: [], cost_of_sales: [], expenses: [], other: [] };
  for (const a of byId.values()) {
    const sec = isSection(a);
    if (!sec || !(a.is_postable || !a.children.length)) continue;
    const amounts = data.map((m) => {
      const v = m.get(a.id) || ZERO;
      // 'other' (non-operating) is income-positive whatever the type.
      return sec === 'other' ? -(v.pd - v.pc) : natural(a, v.pd - v.pc);
    });
    if (amounts.every((x) => x === 0)) continue;
    sections[sec].push({
      account_id: a.id, code: a.code, name_ar: a.name_ar, name_en: a.name_en, amounts,
      drill: cols.map((c) => ({ accountId: a.id, from: c.from, to: c.to, branchId: pr.branchId, costCenterId: pr.costCenterId, projectId: pr.projectId, excludeClosing: true })),
    });
  }
  for (const k of Object.keys(sections)) sections[k].sort((x, y) => (x.code < y.code ? -1 : 1));
  const sum = (rows) => cols.map((_, i) => rows.reduce((s, r) => s + r.amounts[i], 0));
  const revenue = sum(sections.revenue);
  const cogs = sum(sections.cost_of_sales);
  const expenses = sum(sections.expenses);
  const gross = revenue.map((r, i) => r - cogs[i]);
  const other = sum(sections.other);
  const operating = gross.map((g, i) => g - expenses[i]);
  const net = operating.map((o, i) => o + other[i]);
  const typeDrill = (type) => cols.map((c) => ({ type, from: c.from, to: c.to, branchId: pr.branchId, costCenterId: pr.costCenterId, projectId: pr.projectId, excludeClosing: true }));
  return {
    ...pr,
    columns: cols,
    sections,
    totals: { revenue, cost_of_sales: cogs, gross_profit: gross, expenses, operating_income: operating, other, net_income: net },
    total_drill: { revenue: typeDrill('revenue'), expenses: typeDrill('expense') },
    inventory_opening_missing: inventoryOpeningMissing(companyId),
    digits: digits(companyId),
  };
}

// ---------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------

function bsSection(a) {
  if (a.type === 'asset') return a.cls === 'fixed_asset' ? 'fixed_assets' : 'current_assets';
  if (a.type === 'liability') return a.cls === 'long_term_liability' ? 'long_term_liabilities' : 'current_liabilities';
  if (a.type === 'equity') return 'equity';
  return null;
}

function balanceSheet(companyId, q = {}) {
  const asOf = q.asOf || q.to || today();
  if (!isDate(asOf)) fail('invalid_dates', 'التاريخ غير صالح');
  const pr = params(companyId, { ...q, to: asOf, from: undefined }, { needFrom: false });
  const byId = loadAccounts(companyId);
  const cols = [{ key: 'current', label: asOf, asOf }];
  if (q.compare === 'prev_year') cols.push({ key: 'compare', label: addMonths(asOf, -12), asOf: addMonths(asOf, -12) });
  else if (q.compare === 'prev_period') {
    const prevEnd = addDays(`${asOf.slice(0, 7)}-01`, -1);
    cols.push({ key: 'compare', label: prevEnd, asOf: prevEnd });
  }
  const data = cols.map((c) => accountTotals(companyId, { ...pr, from: null, to: c.asOf }));
  const sections = { current_assets: [], fixed_assets: [], current_liabilities: [], long_term_liabilities: [], equity: [] };
  const earnings = cols.map(() => 0);
  for (const a of byId.values()) {
    if (!(a.is_postable || !a.children.length)) continue;
    const nets = data.map((m) => {
      const v = m.get(a.id) || ZERO;
      return v.pd - v.pc; // from = null -> everything is "period"
    });
    if (a.type === 'revenue' || a.type === 'expense') {
      // Not-yet-closed P&L (all years) shown as "current earnings" in equity.
      nets.forEach((n, i) => { earnings[i] += -n; });
      continue;
    }
    const sec = bsSection(a);
    if (!sec) continue;
    const amounts = nets.map((n) => natural(a, n));
    if (amounts.every((x) => x === 0)) continue;
    sections[sec].push({ account_id: a.id, code: a.code, name_ar: a.name_ar, name_en: a.name_en, amounts, drill: cols.map((c) => ({ accountId: a.id, from: '1900-01-01', to: c.asOf, branchId: pr.branchId })) });
  }
  for (const k of Object.keys(sections)) sections[k].sort((x, y) => (x.code < y.code ? -1 : 1));
  const sum = (rows) => cols.map((_, i) => rows.reduce((s, r) => s + r.amounts[i], 0));
  const t = Object.fromEntries(Object.keys(sections).map((k) => [k, sum(sections[k])]));
  const assets = cols.map((_, i) => t.current_assets[i] + t.fixed_assets[i]);
  const liabilities = cols.map((_, i) => t.current_liabilities[i] + t.long_term_liabilities[i]);
  const equity = cols.map((_, i) => t.equity[i] + earnings[i]);
  const liabEq = cols.map((_, i) => liabilities[i] + equity[i]);
  return {
    as_of: asOf,
    branchId: pr.branchId,
    columns: cols,
    sections,
    current_earnings: earnings,
    current_earnings_drill: cols.map((c) => ({ type: 'revenue', from: '1900-01-01', to: c.asOf, branchId: pr.branchId })),
    totals: { ...t, assets, liabilities, equity, liabilities_and_equity: liabEq },
    balanced: cols.map((_, i) => assets[i] === liabEq[i]),
    inventory_opening_missing: inventoryOpeningMissing(companyId),
    digits: digits(companyId),
  };
}

// ---------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------

// Cash & bank accounts: settings.cash_account_ids (JSON array) if set, else
// every account with report_class 'cash' (and the postable accounts under
// them).
function cashAccountIds(companyId, byId = loadAccounts(companyId)) {
  const raw = db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'cash_account_ids'").get(companyId)?.value;
  let ids = [];
  try {
    ids = raw ? JSON.parse(raw).map(Number).filter((id) => byId.has(id)) : [];
  } catch {
    ids = [];
  }
  if (!ids.length) {
    for (const a of byId.values()) if (a.report_class === 'cash') ids.push(a.id);
  }
  return [...new Set(ids.flatMap((id) => descendantsOf(byId, id)))];
}

function cfCategory(a) {
  // Accumulated depreciation moves with the (non-cash) depreciation expense:
  // operating add-back, not investing.
  if (a.report_class === 'contra_asset') return 'operating';
  if (a.type === 'asset' && a.cls === 'fixed_asset') return 'investing';
  if (a.type === 'liability' && a.cls === 'long_term_liability') return 'financing';
  if (a.type === 'equity' && a.system_key !== 'retained_earnings') return 'financing';
  return 'operating';
}

function cashFlow(companyId, q = {}) {
  const pr = params(companyId, q);
  const byId = loadAccounts(companyId);
  const cash = cashAccountIds(companyId, byId);
  const cashSet = new Set(cash);
  const totals = accountTotals(companyId, { ...pr, excludeClosing: true });
  const t = (id) => totals.get(id) || ZERO;
  const openingCash = cash.reduce((s, id) => s + t(id).od - t(id).oc, 0);
  const closingCash = cash.reduce((s, id) => s + t(id).od - t(id).oc + t(id).pd - t(id).pc, 0);

  // Direct: in every entry that moves cash, each non-cash line's (credit -
  // debit) is exactly the cash it brought in/out (entries balance).
  const ph = cash.map(() => '?').join(',') || 'NULL';
  const where = ['e.company_id = ?', "e.status IN ('posted','reversed')", 'e.entry_date BETWEEN ? AND ?', `e.source_type <> '${CLOSING_SOURCE}'`];
  const p = [companyId, pr.from, pr.to];
  if (pr.branchId) { where.push('e.branch_id = ?'); p.push(pr.branchId); }
  const direct = db
    .prepare(
      `SELECT l.account_id, SUM(l.credit_minor - l.debit_minor) AS cash_minor
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       WHERE ${where.join(' AND ')} AND l.account_id NOT IN (${ph})
         AND EXISTS (SELECT 1 FROM journal_lines c WHERE c.entry_id = e.id AND c.account_id IN (${ph}))
       GROUP BY l.account_id`
    )
    .all(...p, ...cash, ...cash);
  const directSections = { operating: [], investing: [], financing: [] };
  for (const r of direct) {
    if (!r.cash_minor) continue;
    const a = byId.get(r.account_id);
    directSections[cfCategory(a)].push({ account_id: a.id, code: a.code, name_ar: a.name_ar, amount: r.cash_minor, drill: { accountId: a.id, from: pr.from, to: pr.to, branchId: pr.branchId } });
  }
  const sumRows = (rows) => rows.reduce((s, r) => s + r.amount, 0);
  const directTotals = Object.fromEntries(Object.entries(directSections).map(([k, v]) => [k, sumRows(v)]));

  // Indirect: net income + changes in non-cash balance-sheet accounts.
  let netIncome = 0;
  const indirect = { operating: [], investing: [], financing: [] };
  for (const a of byId.values()) {
    if (!(a.is_postable || !a.children.length)) continue;
    const v = t(a.id);
    const delta = v.pd - v.pc; // debit-positive change in the period
    if (a.type === 'revenue' || a.type === 'expense') {
      netIncome += -delta;
      continue;
    }
    if (cashSet.has(a.id) || !delta) continue;
    indirect[cfCategory(a)].push({ account_id: a.id, code: a.code, name_ar: a.name_ar, amount: -delta, drill: { accountId: a.id, from: pr.from, to: pr.to, branchId: pr.branchId } });
  }
  const indirectTotals = {
    operating: netIncome + sumRows(indirect.operating),
    investing: sumRows(indirect.investing),
    financing: sumRows(indirect.financing),
  };
  const net = closingCash - openingCash;
  return {
    ...pr,
    cash_accounts: cash.map((id) => ({ id, code: byId.get(id).code, name_ar: byId.get(id).name_ar })),
    opening_cash: openingCash,
    closing_cash: closingCash,
    net_change: net,
    direct: { sections: directSections, totals: directTotals, net: directTotals.operating + directTotals.investing + directTotals.financing },
    indirect: { net_income: netIncome, sections: indirect, totals: indirectTotals, net: indirectTotals.operating + indirectTotals.investing + indirectTotals.financing },
    // Both methods must explain the actual change in cash.
    reconciles: directTotals.operating + directTotals.investing + directTotals.financing === net && indirectTotals.operating + indirectTotals.investing + indirectTotals.financing === net,
    digits: digits(companyId),
  };
}

// ---------------------------------------------------------------------
// Expense analysis
// ---------------------------------------------------------------------

function expenseAnalysis(companyId, q = {}) {
  const pr = params(companyId, q);
  const by = ['account', 'cost_center', 'project', 'branch'].includes(q.by) ? q.by : 'account';
  const byId = loadAccounts(companyId);
  const expenseIds = [...byId.values()].filter((a) => a.type === 'expense' && (a.is_postable || !a.children.length)).map((a) => a.id);
  if (!expenseIds.length) return { ...pr, by, rows: [], total: 0, digits: digits(companyId) };
  const keySql = { account: 'l.account_id', cost_center: 'l.cost_center_id', project: 'l.project_id', branch: 'e.branch_id' }[by];
  const where = ['e.company_id = ?', "e.status IN ('posted','reversed')", 'e.entry_date BETWEEN ? AND ?', `e.source_type <> '${CLOSING_SOURCE}'`, `l.account_id IN (${expenseIds.map(() => '?').join(',')})`];
  const p = [companyId, pr.from, pr.to, ...expenseIds];
  if (pr.branchId) { where.push('e.branch_id = ?'); p.push(pr.branchId); }
  if (pr.costCenterId) { where.push('l.cost_center_id = ?'); p.push(pr.costCenterId); }
  if (pr.projectId) { where.push('l.project_id = ?'); p.push(pr.projectId); }
  const rows = db
    .prepare(`SELECT ${keySql} AS k, SUM(l.debit_minor - l.credit_minor) AS amount FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE ${where.join(' AND ')} GROUP BY ${keySql}`)
    .all(...p);
  const label = (k) => {
    if (k === null || k === undefined) return null;
    if (by === 'account') return `${byId.get(k)?.code} — ${byId.get(k)?.name_ar}`;
    if (by === 'cost_center') return db.prepare('SELECT name FROM cost_centers WHERE id = ?').get(k)?.name;
    if (by === 'project') return db.prepare('SELECT name FROM projects WHERE id = ?').get(k)?.name;
    return db.prepare('SELECT name FROM branches_ref WHERE id = ?').get(k)?.name;
  };
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const out = rows
    .filter((r) => r.amount)
    .map((r) => {
      const drill = { type: 'expense', from: pr.from, to: pr.to, branchId: pr.branchId, costCenterId: pr.costCenterId, projectId: pr.projectId, excludeClosing: true };
      if (by === 'account') { delete drill.type; drill.accountId = r.k; }
      if (by === 'cost_center' && r.k) drill.costCenterId = r.k;
      if (by === 'project' && r.k) drill.projectId = r.k;
      if (by === 'branch' && r.k) drill.branchId = r.k;
      return { key: r.k, label: label(r.k), amount: r.amount, pct: total ? Math.round((r.amount / total) * 10000) / 100 : 0, drill };
    })
    .sort((x, y) => y.amount - x.amount);
  return { ...pr, by, rows: out, total, digits: digits(companyId) };
}

// ---------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------

function getBudget(companyId, id) {
  const b = db.prepare('SELECT * FROM budgets WHERE company_id = ? AND id = ?').get(companyId, Number(id));
  if (!b) fail('not_found', 'الموازنة غير موجودة', 404);
  return b;
}

function listBudgets(companyId) {
  return db
    .prepare(
      `SELECT b.*, fy.year, (SELECT COALESCE(SUM(amount_minor), 0) FROM budget_lines bl WHERE bl.budget_id = b.id) AS total_minor,
         (SELECT COUNT(*) FROM budget_lines bl WHERE bl.budget_id = b.id) AS line_count
       FROM budgets b JOIN fiscal_years fy ON fy.id = b.fiscal_year_id WHERE b.company_id = ? ORDER BY fy.year DESC, b.name`
    )
    .all(companyId);
}

function budgetDetail(companyId, id) {
  const b = getBudget(companyId, id);
  return {
    ...b,
    periods: db.prepare('SELECT id, number, start_date, end_date FROM fiscal_periods WHERE fiscal_year_id = ? ORDER BY number').all(b.fiscal_year_id),
    lines: db
      .prepare(
        `SELECT bl.*, a.code, a.name_ar, cc.name AS cost_center_name FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id
         LEFT JOIN cost_centers cc ON cc.id = bl.cost_center_id WHERE bl.budget_id = ? ORDER BY a.code, bl.period_id`
      )
      .all(b.id),
  };
}

function createBudget(companyId, { fiscalYearId, name, notes }, actor) {
  let fy;
  try {
    fy = tenantRefs.requireOwned(companyId, 'fiscal_year', fiscalYearId);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
    throw err;
  }
  const n = String(name || '').trim();
  if (!n) fail('name_required', 'اسم الموازنة مطلوب');
  if (db.prepare('SELECT 1 FROM budgets WHERE company_id = ? AND fiscal_year_id = ? AND name = ?').get(companyId, fy.id, n)) fail('duplicate_budget', 'يوجد موازنة بهذا الاسم لهذه السنة', 409);
  const id = Number(db.prepare('INSERT INTO budgets (company_id, fiscal_year_id, name, notes, created_by) VALUES (?, ?, ?, ?, ?)').run(companyId, fy.id, n, notes || null, actor?.id ?? null).lastInsertRowid);
  logAudit({ companyId, actor, action: 'reports.budget.create', entityType: 'budget', entityId: id, before: null, after: { fiscal_year_id: fy.id, name: n } });
  return budgetDetail(companyId, id);
}

// lines: [{ accountId, costCenterId?, periodId, amount (decimal) }] — upsert;
// amount '' / null deletes the cell.
function setBudgetLines(companyId, id, lines, actor) {
  const { toMinor } = require('./ledgerCurrencies');
  const d = digits(companyId);
  return ledger.transaction(() => {
    const b = getBudget(companyId, id);
    if (b.status === 'approved') fail('budget_approved', 'الموازنة معتمدة — أعدها إلى مسودة للتعديل', 409);
    const own = (kind, v) => {
      try {
        return tenantRefs.requireOwned(companyId, kind, v);
      } catch (err) {
        if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
        throw err;
      }
    };
    let changed = 0;
    for (const [i, l] of (lines || []).entries()) {
      const acc = own('account', l.accountId);
      if (!['revenue', 'expense'].includes(acc.type) && !l.allowBalanceSheet) fail('invalid_account', `السطر ${i + 1}: الموازنة لحسابات الإيرادات والمصاريف`);
      if (!acc.is_postable) fail('non_postable_account', `السطر ${i + 1}: اختر حسابًا فرعيًا`);
      const cc = l.costCenterId ? own('cost_center', l.costCenterId).id : null;
      const period = own('fiscal_period', l.periodId);
      if (period.fiscal_year_id !== b.fiscal_year_id) fail('invalid_period', `السطر ${i + 1}: الفترة ليست من سنة الموازنة`);
      db.prepare('DELETE FROM budget_lines WHERE budget_id = ? AND account_id = ? AND COALESCE(cost_center_id, 0) = ? AND period_id = ?').run(b.id, acc.id, cc || 0, period.id);
      if (l.amount !== '' && l.amount !== null && l.amount !== undefined) {
        const amt = toMinor(l.amount, d);
        db.prepare('INSERT INTO budget_lines (company_id, budget_id, account_id, cost_center_id, period_id, amount_minor) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, b.id, acc.id, cc, period.id, amt);
      }
      changed += 1;
    }
    db.prepare("UPDATE budgets SET updated_at = datetime('now') WHERE id = ?").run(b.id);
    logAudit({ companyId, actor, action: 'reports.budget.lines', entityType: 'budget', entityId: b.id, before: null, after: { cells: changed } });
    return budgetDetail(companyId, b.id);
  });
}

function setBudgetStatus(companyId, id, status, actor) {
  const b = getBudget(companyId, id);
  if (!['draft', 'approved'].includes(status)) fail('invalid_status', 'حالة غير صالحة');
  db.prepare("UPDATE budgets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, b.id);
  logAudit({ companyId, actor, action: 'reports.budget.status', entityType: 'budget', entityId: b.id, before: { status: b.status }, after: { status } });
  return budgetDetail(companyId, b.id);
}

// Budget vs actual over the budget's periods that fall inside [from, to]
// (default: the whole fiscal year). Variance = actual - budget; % of budget.
function budgetVsActual(companyId, id, q = {}) {
  const b = getBudget(companyId, id);
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(b.fiscal_year_id);
  const pr = params(companyId, { from: q.from || fy.start_date, to: q.to || fy.end_date, costCenterId: q.costCenterId });
  const byId = loadAccounts(companyId);
  const periods = db.prepare('SELECT id FROM fiscal_periods WHERE fiscal_year_id = ? AND start_date >= ? AND end_date <= ?').all(fy.id, pr.from, pr.to).map((p) => p.id);
  const lineWhere = pr.costCenterId ? 'AND bl.cost_center_id = ?' : '';
  const budgetRows = periods.length
    ? db
        .prepare(
          `SELECT bl.account_id, bl.cost_center_id, SUM(bl.amount_minor) AS budget FROM budget_lines bl
           WHERE bl.budget_id = ? AND bl.period_id IN (${periods.map(() => '?').join(',')}) ${lineWhere} GROUP BY bl.account_id, bl.cost_center_id`
        )
        .all(b.id, ...periods, ...(pr.costCenterId ? [pr.costCenterId] : []))
    : [];
  const actualFor = (accountId, costCenterId) => {
    const v = accountTotals(companyId, { from: pr.from, to: pr.to, costCenterId: costCenterId || pr.costCenterId || null, excludeClosing: true, accountIds: [accountId] }).get(accountId) || ZERO;
    return natural(byId.get(accountId), v.pd - v.pc);
  };
  const rows = budgetRows.map((r) => {
    const a = byId.get(r.account_id);
    const actual = actualFor(r.account_id, r.cost_center_id);
    const variance = actual - r.budget;
    return {
      account_id: a.id, code: a.code, name_ar: a.name_ar, type: a.type,
      cost_center_id: r.cost_center_id, cost_center_name: r.cost_center_id ? db.prepare('SELECT name FROM cost_centers WHERE id = ?').get(r.cost_center_id)?.name : null,
      budget: r.budget, actual, variance,
      variance_pct: r.budget ? Math.round((variance / r.budget) * 10000) / 100 : null,
      // Expense over budget / revenue under budget = unfavourable.
      favourable: a.type === 'expense' ? variance <= 0 : variance >= 0,
      drill: { accountId: a.id, from: pr.from, to: pr.to, costCenterId: r.cost_center_id || pr.costCenterId, excludeClosing: true },
    };
  });
  rows.sort((x, y) => (x.code < y.code ? -1 : 1));
  const tot = (type, k) => rows.filter((r) => r.type === type).reduce((s, r) => s + r[k], 0);
  return {
    budget: { id: b.id, name: b.name, status: b.status, fiscal_year: fy.year },
    ...pr,
    rows,
    totals: {
      revenue: { budget: tot('revenue', 'budget'), actual: tot('revenue', 'actual') },
      expense: { budget: tot('expense', 'budget'), actual: tot('expense', 'actual') },
    },
    digits: digits(companyId),
  };
}

// ---------------------------------------------------------------------
// Year-end close
// ---------------------------------------------------------------------

function closingEntry(companyId, fyId) {
  return db.prepare(`SELECT * FROM journal_entries WHERE company_id = ? AND source_type = '${CLOSING_SOURCE}' AND source_id = ? AND status = 'posted'`).get(companyId, fyId);
}

// Moves every revenue/expense balance (cumulative to the year end, so prior
// unclosed years are swept too) to retained_earnings in ONE posted entry
// dated the fiscal year's last day.
function closeYear(companyId, fyId, actor) {
  return ledger.transaction(() => {
    let fy;
    try {
      fy = tenantRefs.requireOwned(companyId, 'fiscal_year', fyId);
    } catch (err) {
      if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 404);
      throw err;
    }
    if (closingEntry(companyId, fy.id)) fail('already_closed', 'السنة مقفلة مسبقًا', 409);
    const re = ledger.getAccountBySystemKey(companyId, 'retained_earnings');
    if (!re) fail('missing_system_account', 'حساب الأرباح المحتجزة غير معرّف', 409);
    const byId = loadAccounts(companyId);
    const totals = accountTotals(companyId, { from: null, to: fy.end_date });
    const lines = [];
    let net = 0; // credit-positive (profit)
    for (const a of byId.values()) {
      if (a.type !== 'revenue' && a.type !== 'expense') continue;
      const v = totals.get(a.id);
      if (!v) continue;
      const bal = v.pd - v.pc; // debit-positive
      if (!bal) continue;
      lines.push({ accountId: a.id, debitMinor: bal < 0 ? -bal : 0, creditMinor: bal > 0 ? bal : 0, memo: 'إقفال' });
      net += -bal;
    }
    if (!lines.length) fail('nothing_to_close', 'لا توجد أرصدة إيرادات أو مصاريف لإقفالها', 409);
    if (net) lines.push({ accountId: re.id, debitMinor: net < 0 ? -net : 0, creditMinor: net > 0 ? net : 0, memo: net > 0 ? 'صافي ربح السنة' : 'صافي خسارة السنة' });
    const entry = ledger.postEntry(
      companyId,
      { date: fy.end_date, description: `إقفال السنة المالية ${fy.year} — نقل النتيجة إلى الأرباح المحتجزة`, sourceType: CLOSING_SOURCE, sourceId: fy.id, lines },
      actor
    );
    db.prepare("UPDATE fiscal_years SET status = 'closed' WHERE id = ?").run(fy.id);
    logAudit({ companyId, actor, action: 'reports.year_end.close', entityType: 'fiscal_year', entityId: fy.id, before: { status: fy.status }, after: { status: 'closed', entry_id: entry.id, net_income_minor: net } });
    return { fiscal_year: { ...fy, status: 'closed' }, entry_id: entry.id, entry_number: entry.entry_number, net_income_minor: net };
  });
}

// Reversible only until the next year's first posting.
function reopenYear(companyId, fyId, { reason } = {}, actor) {
  return ledger.transaction(() => {
    let fy;
    try {
      fy = tenantRefs.requireOwned(companyId, 'fiscal_year', fyId);
    } catch (err) {
      if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 404);
      throw err;
    }
    const entry = closingEntry(companyId, fy.id);
    if (!entry) fail('not_closed', 'السنة غير مقفلة', 409);
    const later = db
      .prepare("SELECT entry_number FROM journal_entries WHERE company_id = ? AND status IN ('posted','reversed') AND entry_date > ? AND source_type <> 'reversal' LIMIT 1")
      .get(companyId, fy.end_date);
    if (later) fail('next_year_posted', `لا يمكن إلغاء الإقفال: رُحّلت قيود في السنة التالية (${later.entry_number})`, 409);
    ledger.reverseEntry(companyId, entry.id, { date: fy.end_date, reason: reason || 'إلغاء إقفال السنة', fromSource: true }, actor);
    db.prepare("UPDATE fiscal_years SET status = 'open' WHERE id = ?").run(fy.id);
    logAudit({ companyId, actor, action: 'reports.year_end.reopen', entityType: 'fiscal_year', entityId: fy.id, before: { status: 'closed' }, after: { status: 'open', reason: reason || null } });
    return { fiscal_year: { ...fy, status: 'open' } };
  });
}

function yearEndStatus(companyId) {
  return db
    .prepare('SELECT * FROM fiscal_years WHERE company_id = ? ORDER BY start_date DESC')
    .all(companyId)
    .map((fy) => {
      const e = closingEntry(companyId, fy.id);
      return { ...fy, closing_entry: e ? { id: e.id, entry_number: e.entry_number } : null };
    });
}

// ---------------------------------------------------------------------
// Month-end checklist
// ---------------------------------------------------------------------

function monthEndChecklist(companyId, periodId) {
  let period;
  try {
    period = tenantRefs.requireOwned(companyId, 'fiscal_period', periodId);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 404);
    throw err;
  }
  const { start_date: from, end_date: to } = period;
  const n = (sql, ...p) => db.prepare(sql).get(...p).c;
  const items = [];
  const add = (key, severity, count, link, detail) => items.push({ key, severity, count, ok: count === 0, link, detail: detail ?? null });
  add('draft_entries', 'blocker', n("SELECT COUNT(*) c FROM journal_entries WHERE company_id = ? AND status = 'draft' AND entry_date BETWEEN ? AND ?", companyId, from, to), `/ledger/entries?status=draft&from=${from}&to=${to}`);
  add('draft_invoices', 'blocker', n("SELECT COUNT(*) c FROM sales_invoices WHERE company_id = ? AND status = 'draft' AND invoice_date BETWEEN ? AND ?", companyId, from, to), '/sales/invoices?status=draft');
  add('pending_collections', 'blocker', n("SELECT COUNT(*) c FROM collections WHERE company_id = ? AND status IN ('pending_accountant_confirmation','pending_verification') AND date(collected_at) <= ?", companyId, to), '/collections');
  add('pending_returns', 'blocker', n("SELECT COUNT(*) c FROM return_requests WHERE company_id = ? AND status = 'pending_review' AND date(created_at) <= ?", companyId, to), '/returns');
  add('uninvoiced_deliveries', 'warning', n("SELECT COUNT(*) c FROM orders o WHERE o.company_id = ? AND o.status IN ('delivered','paid') AND o.deleted_at IS NULL AND date(COALESCE(o.delivered_at, o.order_date)) <= ? AND NOT EXISTS (SELECT 1 FROM sales_invoices i WHERE i.order_id = o.id AND i.status <> 'cancelled')", companyId, to), '/sales/invoices?fromOrder=1');
  add('cheques_due_not_deposited', 'warning', n("SELECT COUNT(*) c FROM cheques_received WHERE company_id = ? AND status = 'in_portfolio' AND due_date <= ?", companyId, to), '/receivables/cheques');
  add('unallocated_receipts', 'warning', n(`SELECT COUNT(*) c FROM customer_receipts r WHERE r.company_id = ? AND r.status = 'posted' AND r.receipt_date <= ?
    AND r.amount_minor > COALESCE((SELECT SUM(a.amount_minor) FROM receipt_allocations a WHERE a.receipt_id = r.id), 0)`, companyId, to), '/receivables/receipts');
  const recon = require('./receivables').reconciliationCheck(companyId, { asOf: to });
  add('ar_reconciliation', 'blocker', recon.differences.length + (recon.difference_minor ? 1 : 0), '/receivables/reports?tab=reconciliation');
  add('ap_reconciliation', 'blocker', require('./payables').apReconciliation(companyId, { asOf: to }).difference_minor ? 1 : 0, '/purchasing/reports?tab=aging');
  add('mismatched_supplier_invoices', 'warning', n("SELECT COUNT(*) c FROM supplier_invoices WHERE company_id = ? AND status = 'draft' AND match_status = 'mismatch' AND invoice_date <= ?", companyId, to), '/purchasing?tab=invoices');
  add('uninvoiced_receipts', 'warning', n("SELECT COUNT(*) c FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.receipt_id WHERE g.company_id = ? AND g.receipt_date <= ? AND l.invoiced_qty < l.qty - l.rejected_qty - 0.0005", companyId, to), '/purchasing?tab=receipts');
  // Prompt 10 closing adjustments — only for a company that uses them, so
  // the checklist of every other company is unchanged.
  if (require('./fixedAssets').usesFixedAssets(companyId)) {
    add('depreciation_not_posted', 'blocker', require('./fixedAssets').missingDepreciation(companyId, to.slice(0, 7)), '/accounting/adjustments?tab=depreciation');
  }
  if (require('./recurringEntries').usesRecurring(companyId)) {
    add('recurring_entries_due', 'blocker', require('./recurringEntries').dueCount(companyId, to), '/accounting/adjustments?tab=recurring');
  }
  const integrity = ledger.ledgerIntegrityCheck(companyId);
  add('ledger_integrity', 'blocker', integrity.violations.length, '/ledger/entries');
  const blockers = items.filter((i) => i.severity === 'blocker' && !i.ok).length;
  return { period: { id: period.id, year: period.year, number: period.number, start_date: from, end_date: to, status: period.status }, items, blockers, ready_to_close: blockers === 0 };
}

// ---------------------------------------------------------------------
// Export helper: report -> flat { title, columns, rows } for Excel / PDF
// ---------------------------------------------------------------------

function fmt(companyId, minor) {
  return minor === null || minor === undefined ? '' : fromMinor(minor, digits(companyId));
}

module.exports = {
  ReportError,
  CLOSING_SOURCE,
  accountTotals,
  trialBalance,
  generalLedger,
  incomeStatement,
  balanceSheet,
  cashFlow,
  cashAccountIds,
  expenseAnalysis,
  listBudgets,
  budgetDetail,
  createBudget,
  setBudgetLines,
  setBudgetStatus,
  budgetVsActual,
  closeYear,
  reopenYear,
  yearEndStatus,
  monthEndChecklist,
  inventoryOpeningMissing,
  fmt,
};
