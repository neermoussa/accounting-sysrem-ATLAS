// backend/lib/analytics/facts.js
//
// Prompt 12a — fact tables (db/factSchema.js). One builder per source
// document writes that document's fact rows (after deleting the old ones);
// refresh() runs the builders for the documents the triggers queued
// (incremental), rebuild() runs them for every document of the company
// (from scratch). Both use the same builders, so they give identical rows.
//
// Base-currency amounts follow the ledger exactly: a document's revenue
// (sales) or net purchase value is taken from ITS journal entry and
// allocated over its lines by their original net (largest remainder), so a
// report's total equals what the ledger booked.

const db = require('../../db/init');
const ledger = require('../ledger');
const clock = require('../clock');

const ym = (d) => String(d).slice(0, 7);
const POSTED = "('posted', 'reversed')";

const { allocate } = require('./alloc');

const sysAccount = (cid, key) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND system_key = ?').get(cid, key)?.id ?? null;
const taxAccounts = (cid) => new Set([sysAccount(cid, 'input_tax'), sysAccount(cid, 'output_tax'), ...db.prepare('SELECT account_id FROM tax_codes WHERE company_id = ?').all(cid).map((r) => r.account_id)].filter(Boolean));
const repOfShop = (shopId) => db.prepare('SELECT assigned_rep_id r FROM shops WHERE id = ?').get(shopId)?.r ?? null;

// ---------------------------------------------------------------------
// Journal-derived facts (journal lines, expenses, receivables, payables)
// ---------------------------------------------------------------------

function buildJournal(cid, entryId) {
  for (const t of ['fact_journal_lines', 'fact_expenses', 'fact_receivables', 'fact_payables']) db.prepare(`DELETE FROM ${t} WHERE entry_id = ?`).run(entryId);
  const e = db.prepare(`SELECT * FROM journal_entries WHERE id = ? AND company_id = ? AND status IN ${POSTED}`).get(entryId, cid);
  if (!e) return;
  const ar = sysAccount(cid, 'ar_control');
  const ap = sysAccount(cid, 'ap_control');
  const lines = db.prepare('SELECT l.*, a.code, a.type, a.report_class FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no').all(e.id);
  const insJ = db.prepare(`INSERT INTO fact_journal_lines (line_id, company_id, entry_id, entry_number, entry_date, ym, account_id, account_code, account_type, report_class, debit_minor, credit_minor, branch_id, cost_center_id, project_id, party_type, party_id, currency_code, amount_original_minor, source_type, source_id, is_closing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Document context for the dimensions.
  let supplierId = null;
  let dueDate = null;
  let method = null;
  let repId = null;
  if (e.source_type === 'supplier_invoice') {
    const d = db.prepare('SELECT supplier_id, due_date FROM supplier_invoices WHERE id = ?').get(e.source_id);
    supplierId = d?.supplier_id ?? null;
    dueDate = d?.due_date ?? null;
  } else if (e.source_type === 'sales_invoice') {
    dueDate = db.prepare('SELECT due_date FROM sales_invoices WHERE id = ?').get(e.source_id)?.due_date ?? null;
  } else if (e.source_type === 'customer_receipt') {
    const r = db.prepare('SELECT r.method, c.rep_id FROM customer_receipts r LEFT JOIN collections c ON c.id = r.collection_id WHERE r.id = ?').get(e.source_id);
    method = r?.method ?? null;
    repId = r?.rep_id ?? null;
  }
  for (const l of lines) {
    insJ.run(l.id, cid, e.id, e.entry_number, e.entry_date, ym(e.entry_date), l.account_id, l.code, l.type, l.report_class, l.debit_minor, l.credit_minor, e.branch_id ?? null, l.cost_center_id ?? null, l.project_id ?? null, l.party_type ?? null, l.party_id ?? null, l.currency_code ?? null, l.amount_original_minor ?? null, e.source_type, e.source_id ?? null, e.source_type === 'year_end_close' ? 1 : 0);
    if (l.type === 'expense' && e.source_type !== 'year_end_close') {
      db.prepare(`INSERT INTO fact_expenses (line_id, company_id, entry_id, entry_date, ym, account_id, account_code, report_class, amount_minor, branch_id, cost_center_id, project_id, supplier_id, employee_id, source_type, source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(l.id, cid, e.id, e.entry_date, ym(e.entry_date), l.account_id, l.code, l.report_class, l.debit_minor - l.credit_minor, e.branch_id ?? null, l.cost_center_id ?? null, l.project_id ?? null, supplierId, l.party_type === 'employee' ? l.party_id : null, e.source_type, e.source_id ?? null);
    }
    if (l.account_id === ar) {
      const cust = l.party_type === 'customer' ? l.party_id : null;
      const shop = cust ? db.prepare('SELECT region, assigned_rep_id FROM shops WHERE id = ?').get(cust) : null;
      db.prepare(`INSERT INTO fact_receivables (line_id, company_id, entry_id, entry_date, ym, customer_id, region, rep_id, debit_minor, credit_minor, due_date, method, source_type, source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(l.id, cid, e.id, e.entry_date, ym(e.entry_date), cust, shop?.region ?? null, repId ?? shop?.assigned_rep_id ?? null, l.debit_minor, l.credit_minor, dueDate, method, e.source_type, e.source_id ?? null);
    }
    if (l.account_id === ap) {
      db.prepare(`INSERT INTO fact_payables (line_id, company_id, entry_id, entry_date, ym, supplier_id, debit_minor, credit_minor, due_date, source_type, source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(l.id, cid, e.id, e.entry_date, ym(e.entry_date), l.party_type === 'supplier' ? l.party_id : null, l.debit_minor, l.credit_minor, dueDate, e.source_type, e.source_id ?? null);
    }
  }
}

// ---------------------------------------------------------------------
// Sales lines
// ---------------------------------------------------------------------

function revenueOfEntry(entryId) {
  return db.prepare("SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.type = 'revenue'").get(entryId).s;
}
// Cost of goods follows the stock ledger: an invoice line's cost is what
// its sale moves took out; a credit note's restock value (moves keyed by
// the note) is split over its lines of that product by qty. No move = no
// cost (a credit note that did not restock leaves the cost booked).
function invCost(l) {
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(-SUM(value_minor), 0) v FROM stock_moves WHERE source_type = 'sales_invoice_line' AND source_id = ?").get(l.id);
  return r.n ? r.v : null;
}
function creditNoteCosts(cnId, lines) {
  const out = lines.map(() => null);
  const byProduct = new Map();
  lines.forEach((l, k) => { if (l.product_id) byProduct.set(l.product_id, [...(byProduct.get(l.product_id) || []), k]); });
  for (const [pid, idx] of byProduct) {
    const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE source_type = 'sales_credit_note' AND source_id = ? AND product_id = ?").get(cnId, pid);
    if (!r.n) continue;
    allocate(-r.v, idx.map((k) => lines[k].qty)).forEach((c, j) => { out[idx[j]] = c; });
  }
  return out;
}
function buildSales(cid, key) {
  db.prepare('DELETE FROM fact_sales_lines WHERE company_id = ? AND fact_key LIKE ?').run(cid, `${key}:%`);
  const [kind, idStr] = key.split(':');
  const id = Number(idStr);
  const ins = db.prepare(`INSERT INTO fact_sales_lines (fact_key, company_id, doc_type, doc_id, doc_number, line_id, doc_date, ym, customer_id, region, rep_id, branch_id, warehouse_id, product_id, category, channel, currency_code, qty, net_original_minor, net_base_minor, cost_base_minor, entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (kind === 'inv') {
    const inv = db.prepare("SELECT * FROM sales_invoices WHERE id = ? AND company_id = ? AND status IN ('posted', 'cancelled') AND journal_entry_id IS NOT NULL").get(id, cid);
    if (!inv) return;
    const order = inv.order_id ? db.prepare('SELECT rep_id, source FROM orders WHERE id = ?').get(inv.order_id) : null;
    const shop = db.prepare('SELECT region, assigned_rep_id FROM shops WHERE id = ?').get(inv.shop_id);
    const lines = db.prepare('SELECT l.*, p.category FROM sales_invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.invoice_id = ? ORDER BY l.line_no').all(inv.id);
    const base = allocate(revenueOfEntry(inv.journal_entry_id), lines.map((l) => l.net_minor));
    lines.forEach((l, k) => ins.run(`${key}:${l.id}`, cid, 'sales_invoice', inv.id, inv.invoice_number, l.id, inv.invoice_date, ym(inv.invoice_date), inv.shop_id, shop?.region ?? null, order?.rep_id ?? shop?.assigned_rep_id ?? null, inv.branch_id ?? null, inv.warehouse_id ?? null, l.product_id ?? null, l.category ?? null, order?.source ?? 'direct', inv.currency_code, l.qty, l.net_minor, base[k], invCost(l), inv.journal_entry_id));
  } else {
    const cn = db.prepare('SELECT * FROM sales_credit_notes WHERE id = ? AND company_id = ? AND journal_entry_id IS NOT NULL').get(id, cid);
    if (!cn) return;
    const inv = cn.invoice_id ? db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(cn.invoice_id) : null;
    const order = inv?.order_id ? db.prepare('SELECT rep_id, source FROM orders WHERE id = ?').get(inv.order_id) : null;
    const shopId = cn.shop_id ?? inv?.shop_id;
    const shop = db.prepare('SELECT region, assigned_rep_id FROM shops WHERE id = ?').get(shopId);
    const lines = db.prepare('SELECT l.*, p.category FROM sales_credit_note_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.credit_note_id = ? ORDER BY l.line_no').all(cn.id);
    const base = allocate(revenueOfEntry(cn.journal_entry_id), lines.map((l) => l.net_minor));
    const cnCost = creditNoteCosts(cn.id, lines);
    lines.forEach((l, k) => ins.run(`${key}:${l.id}`, cid, 'sales_credit_note', cn.id, cn.credit_note_number, l.id, cn.note_date, ym(cn.note_date), shopId, shop?.region ?? null, order?.rep_id ?? shop?.assigned_rep_id ?? null, inv?.branch_id ?? null, inv?.warehouse_id ?? null, l.product_id ?? null, l.category ?? null, order?.source ?? 'direct', cn.currency_code, -l.qty, -l.net_minor, base[k], cnCost[k], cn.journal_entry_id));
  }
}

// ---------------------------------------------------------------------
// Purchase lines
// ---------------------------------------------------------------------

function buildPurchase(cid, key) {
  db.prepare('DELETE FROM fact_purchase_lines WHERE company_id = ? AND fact_key LIKE ?').run(cid, `${key}:%`);
  const [kind, idStr] = key.split(':');
  const id = Number(idStr);
  const ap = sysAccount(cid, 'ap_control');
  const tax = taxAccounts(cid);
  // Net posted value of a supplier document = AP movement - tax movement.
  const netOf = (entryId, sign) => {
    const ls = db.prepare('SELECT account_id, debit_minor, credit_minor FROM journal_lines WHERE entry_id = ?').all(entryId);
    const apAmt = ls.filter((l) => l.account_id === ap).reduce((t, l) => t + l.credit_minor - l.debit_minor, 0);
    const taxAmt = ls.filter((l) => tax.has(l.account_id)).reduce((t, l) => t + l.debit_minor - l.credit_minor, 0);
    return sign * (sign > 0 ? apAmt - taxAmt : -(apAmt - taxAmt));
  };
  const ins = db.prepare(`INSERT INTO fact_purchase_lines (fact_key, company_id, doc_type, doc_id, doc_number, line_id, doc_date, ym, kind, supplier_id, product_id, category, expense_account_id, currency_code, qty, net_original_minor, net_base_minor, entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (kind === 'inv') {
    const inv = db.prepare("SELECT * FROM supplier_invoices WHERE id = ? AND company_id = ? AND status = 'posted' AND kind <> 'opening' AND journal_entry_id IS NOT NULL").get(id, cid);
    if (!inv) return;
    const lines = db.prepare('SELECT l.*, p.category FROM supplier_invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.invoice_id = ? ORDER BY l.line_no').all(inv.id);
    const base = allocate(netOf(inv.journal_entry_id, 1), lines.map((l) => l.net_minor));
    lines.forEach((l, k) => ins.run(`${key}:${l.id}`, cid, 'supplier_invoice', inv.id, inv.invoice_number, l.id, inv.invoice_date, ym(inv.invoice_date), inv.kind, inv.supplier_id, l.product_id ?? null, l.category ?? null, l.expense_account_id ?? null, inv.currency_code, l.qty, l.net_minor, base[k], inv.journal_entry_id));
  } else {
    const dn = db.prepare('SELECT * FROM supplier_debit_notes WHERE id = ? AND company_id = ? AND journal_entry_id IS NOT NULL').get(id, cid);
    if (!dn) return;
    const inv = db.prepare('SELECT kind FROM supplier_invoices WHERE id = ?').get(dn.invoice_id);
    const lines = db.prepare('SELECT l.*, p.category, il.expense_account_id FROM supplier_debit_note_lines l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN supplier_invoice_lines il ON il.id = l.invoice_line_id WHERE l.debit_note_id = ? ORDER BY l.line_no').all(dn.id);
    const base = allocate(netOf(dn.journal_entry_id, -1), lines.map((l) => l.net_minor));
    lines.forEach((l, k) => ins.run(`${key}:${l.id}`, cid, 'supplier_debit_note', dn.id, dn.debit_note_number, l.id, dn.note_date, ym(dn.note_date), inv?.kind ?? 'goods', dn.supplier_id, l.product_id ?? null, l.category ?? null, l.expense_account_id ?? null, dn.currency_code, -l.qty, -l.net_minor, base[k], dn.journal_entry_id));
  }
}

// ---------------------------------------------------------------------
// Stock moves, production, payroll
// ---------------------------------------------------------------------

function buildStock(cid, moveId) {
  db.prepare('DELETE FROM fact_inventory_moves WHERE move_id = ?').run(Number(moveId));
  const m = db.prepare('SELECT m.*, p.category, h.kind holder_kind, h.ref_id FROM stock_moves m JOIN products p ON p.id = m.product_id JOIN stock_holders h ON h.id = m.holder_id WHERE m.id = ? AND m.company_id = ?').get(Number(moveId), cid);
  if (!m) return;
  db.prepare(`INSERT INTO fact_inventory_moves (move_id, company_id, move_date, ym, product_id, category, holder_id, holder_kind, warehouse_id, lot_id, move_type, qty, value_minor, source_type, source_id, entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, cid, m.move_date, ym(m.move_date), m.product_id, m.category ?? null, m.holder_id, m.holder_kind, m.holder_kind === 'warehouse' ? m.ref_id : null, m.lot_id ?? null, m.move_type, m.qty, m.value_minor, m.source_type ?? null, m.source_id ?? null, m.journal_entry_id ?? null);
}

function buildProduction(cid, orderId) {
  db.prepare('DELETE FROM fact_production_batches WHERE order_id = ?').run(Number(orderId));
  const o = db.prepare("SELECT o.*, p.category FROM mfg_orders o JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.company_id = ? AND o.status IN ('closed', 'rejected')").get(Number(orderId), cid);
  if (!o || !o.cost_json) return;
  const c = JSON.parse(o.cost_json);
  const amt = (x) => (typeof x === 'number' ? x : x?.amount_minor ?? 0);
  // Theoretical cost moves with the latest purchase prices, so it is not a
  // fact (a rebuild would differ): cost variances run live.
  const theoretical = null;
  db.prepare(`INSERT INTO fact_production_batches (order_id, company_id, order_number, production_date, ym, status, product_id, category, version_id, batches, expected_units, actual_units, actual_kg, materials_minor, labour_minor, energy_minor, overhead_minor, byproduct_credit_minor, abnormal_loss_minor, written_off_minor, fg_value_minor, theoretical_minor, lot_id, entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(o.id, cid, o.order_number, o.production_date, ym(o.production_date), o.status, o.product_id, o.category ?? null, o.version_id ?? null, o.batches ?? null, c.expected_units ?? null, c.actual_units ?? null, c.actual_kg ?? null,
    c.materials_minor ?? 0, amt(c.labour), amt(c.energy), amt(c.overhead), c.byproduct_credit_minor ?? 0, c.abnormal_loss_minor ?? 0, c.written_off_minor ?? 0, c.fg_value_minor ?? 0, theoretical, o.output_lot_id ?? null, o.journal_entry_id ?? null);
}

function buildPayroll(cid, periodId) {
  db.prepare('DELETE FROM fact_payroll WHERE period_id = ?').run(Number(periodId));
  const p = db.prepare("SELECT * FROM payroll_periods WHERE id = ? AND company_id = ? AND status = 'posted'").get(Number(periodId), cid);
  if (!p) return;
  const P = require('../purchasing');
  const baseCode = ledger.getBaseCurrency(cid).code;
  const rates = p.rates_json ? JSON.parse(p.rates_json) : {};
  const toBase = (cur, m) => (cur === baseCode || !m ? m : P.toBase(cid, cur, m, { rateE8: rates[cur].rate_e8, quote: rates[cur].quote }));
  for (const l of db.prepare('SELECT * FROM payroll_lines WHERE period_id = ? ORDER BY line_no').all(p.id)) {
    db.prepare(`INSERT INTO fact_payroll (line_id, company_id, period_id, period, department, cost_center_id, currency_code, gross_base_minor, employer_base_minor, deductions_base_minor, net_base_minor, headcount, entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(l.id, cid, p.id, p.period, l.department, l.cost_center_id ?? null, l.currency_code, toBase(l.currency_code, l.gross_minor), toBase(l.currency_code, l.employer_contrib_minor), toBase(l.currency_code, l.deductions_minor), toBase(l.currency_code, l.net_minor), l.headcount ?? null, p.journal_entry_id);
  }
}

const BUILDERS = { journal: buildJournal, sales: buildSales, purchase: buildPurchase, stock: buildStock, production: buildProduction, payroll: buildPayroll };
const FACT_TABLES = ['fact_journal_lines', 'fact_expenses', 'fact_receivables', 'fact_payables', 'fact_sales_lines', 'fact_purchase_lines', 'fact_inventory_moves', 'fact_production_batches', 'fact_payroll'];

// Every source document of a company, per group (for the full rebuild).
function allSources(cid) {
  return {
    journal: db.prepare(`SELECT id k FROM journal_entries WHERE company_id = ? AND status IN ${POSTED} ORDER BY id`).all(cid).map((r) => r.k),
    sales: [...db.prepare("SELECT 'inv:' || id k FROM sales_invoices WHERE company_id = ? AND status IN ('posted', 'cancelled') ORDER BY id").all(cid), ...db.prepare("SELECT 'cn:' || id k FROM sales_credit_notes WHERE company_id = ? ORDER BY id").all(cid)].map((r) => r.k),
    purchase: [...db.prepare("SELECT 'inv:' || id k FROM supplier_invoices WHERE company_id = ? AND status = 'posted' ORDER BY id").all(cid), ...db.prepare("SELECT 'dn:' || id k FROM supplier_debit_notes WHERE company_id = ? ORDER BY id").all(cid)].map((r) => r.k),
    stock: db.prepare('SELECT id k FROM stock_moves WHERE company_id = ? ORDER BY id').all(cid).map((r) => r.k),
    production: db.prepare("SELECT id k FROM mfg_orders WHERE company_id = ? AND status IN ('closed', 'rejected') ORDER BY id").all(cid).map((r) => r.k),
    payroll: db.prepare("SELECT id k FROM payroll_periods WHERE company_id = ? AND status = 'posted' ORDER BY id").all(cid).map((r) => r.k),
  };
}

function stamp(cid, lastQueueId, full) {
  const now = clock.nowSql();
  db.prepare(`INSERT INTO fact_state (company_id, refreshed_at, last_queue_id, full_rebuild_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET refreshed_at = excluded.refreshed_at, last_queue_id = MAX(fact_state.last_queue_id, excluded.last_queue_id), full_rebuild_at = COALESCE(excluded.full_rebuild_at, fact_state.full_rebuild_at)`).run(cid, now, lastQueueId, full ? now : null);
}

// From scratch: every fact row of the company is deleted and rebuilt.
function rebuild(cid) {
  return ledger.transaction(() => {
    const maxQ = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM fact_queue WHERE company_id = ?').get(cid).m;
    for (const t of FACT_TABLES) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(cid);
    const src = allSources(cid);
    let n = 0;
    for (const [group, keys] of Object.entries(src)) for (const k of keys) { BUILDERS[group](cid, String(k)); n += 1; }
    db.prepare('DELETE FROM fact_queue WHERE company_id = ? AND id <= ?').run(cid, maxQ);
    stamp(cid, maxQ, true);
    return { company_id: cid, documents: n, mode: 'rebuild' };
  });
}

// Incremental: rebuild only the queued documents (deduplicated).
function refresh(cid, { limit = 5000 } = {}) {
  return ledger.transaction(() => {
    const items = db.prepare('SELECT id, fact_group, source_key FROM fact_queue WHERE company_id = ? ORDER BY id LIMIT ?').all(cid, limit);
    if (!items.length) { stamp(cid, 0, false); return { company_id: cid, documents: 0, mode: 'incremental' }; }
    if (items.some((i) => i.fact_group === 'rebuild')) return rebuild(cid);
    const seen = new Set();
    for (const i of items) {
      const k = `${i.fact_group}|${i.source_key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      BUILDERS[i.fact_group](cid, String(i.source_key));
    }
    const maxId = items[items.length - 1].id;
    db.prepare('DELETE FROM fact_queue WHERE company_id = ? AND id <= ?').run(cid, maxId);
    stamp(cid, maxId, false);
    return { company_id: cid, documents: seen.size, mode: 'incremental' };
  });
}

function freshness(cid) {
  const s = db.prepare('SELECT * FROM fact_state WHERE company_id = ?').get(cid);
  const pending = db.prepare('SELECT COUNT(*) n FROM fact_queue WHERE company_id = ?').get(cid).n;
  return { refreshed_at: s?.refreshed_at ?? null, full_rebuild_at: s?.full_rebuild_at ?? null, pending_changes: pending, up_to_date: Boolean(s) && pending === 0 };
}

// Background: refresh every company with queued changes.
function sweep() {
  const out = [];
  for (const { company_id: cid } of db.prepare('SELECT DISTINCT company_id FROM fact_queue').all()) {
    try { out.push(refresh(cid)); } catch (err) { out.push({ company_id: cid, error: err.message }); }
  }
  return out;
}

module.exports = { FACT_TABLES, allocate, rebuild, refresh, freshness, sweep, BUILDERS };
