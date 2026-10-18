// backend/lib/currency.js
//
// Multi-currency (Prompt 5): the exchange_rates history, the rate a document
// uses (locked at posting), conversions, balances by currency, the FX
// gain/loss report and the period-end unrealized revaluation.
//
// Rates are rate_e8 + rate_quote (lib/fxRate.js). A document dated D uses
// the latest rate effective on or before the END of D, unless a user with
// override_exchange_rate types one.

const db = require('../db/init');
const ledger = require('./ledger');
const fx = require('./fxRate');
const { logAudit } = require('./auditLog');
const { fromMinor } = require('./ledgerCurrencies');

class CurrencyError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new CurrencyError(code, message, status, extra);
};
const SOURCES = ['manual', 'api', 'central_bank'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const ONE = Number(fx.SCALE);

function base(companyId) {
  return ledger.getBaseCurrency(companyId);
}
function currency(companyId, code) {
  const c = ledger.getCurrency(companyId, String(code || '').toUpperCase());
  if (!c || !c.is_active) fail('invalid_currency', 'العملة غير معرّفة');
  return c;
}
function withFx(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof fx.FxError) fail(err.code, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------
// Rate history
// ---------------------------------------------------------------------

function normalizeEffectiveAt(v) {
  if (!v) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const s = String(v).trim().replace('T', ' ');
  if (isDate(s)) return `${s} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) && !Number.isNaN(Date.parse(s.replace(' ', 'T')))) return s.length === 16 ? `${s}:00` : s;
  fail('invalid_date', 'تاريخ السعر غير صالح');
}

function addRate(companyId, { currencyCode, rate, rateQuote, effectiveAt, source = 'manual', notes }, actor) {
  const b = base(companyId);
  const cur = currency(companyId, currencyCode);
  if (cur.code === b.code) fail('base_currency_rate', 'العملة الأساسية سعرها 1 دائمًا');
  if (!SOURCES.includes(source)) fail('invalid_source', 'مصدر السعر غير صالح');
  const { rateE8, quote } = withFx(() => fx.parseRate(rate, rateQuote || 'base_per_foreign', { foreign: cur.code, base: b.code }));
  const at = normalizeEffectiveAt(effectiveAt);
  const id = Number(
    db
      .prepare('INSERT INTO exchange_rates (company_id, currency_code, rate_e8, rate_quote, effective_at, source, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, cur.code, rateE8, quote, at, source, notes || null, actor?.id ?? null).lastInsertRowid
  );
  const row = getRate(companyId, id);
  logAudit({ companyId, actor: actorOf(actor), action: 'currency.rate.add', entityType: 'exchange_rate', entityId: id, before: null, after: row });
  return row;
}

function decorate(r) {
  return r ? { ...r, rate: fx.formatRate(r.rate_e8) } : null;
}
function getRate(companyId, id) {
  return decorate(db.prepare('SELECT * FROM exchange_rates WHERE company_id = ? AND id = ?').get(companyId, id));
}

function listRates(companyId, { currencyCode, from, to, limit } = {}) {
  const where = ['company_id = ?'];
  const p = [companyId];
  if (currencyCode) { where.push('currency_code = ?'); p.push(String(currencyCode).toUpperCase()); }
  if (from) { where.push('effective_at >= ?'); p.push(`${from} 00:00:00`); }
  if (to) { where.push('effective_at <= ?'); p.push(`${to} 23:59:59`); }
  return db
    .prepare(`SELECT * FROM exchange_rates WHERE ${where.join(' AND ')} ORDER BY effective_at DESC, id DESC LIMIT ?`)
    .all(...p, Math.min(Number(limit) || 500, 5000))
    .map(decorate);
}

// Latest rate effective on or before `at` (a date = end of that day).
function rateFor(companyId, code, at) {
  const b = base(companyId);
  const c = String(code || b.code).toUpperCase();
  if (c === b.code) return { rate_e8: ONE, rate_quote: 'base_per_foreign', id: null, base: true };
  const when = isDate(at) ? `${at} 23:59:59` : normalizeEffectiveAt(at);
  return db
    .prepare('SELECT * FROM exchange_rates WHERE company_id = ? AND currency_code = ? AND effective_at <= ? ORDER BY effective_at DESC, id DESC LIMIT 1')
    .get(companyId, c, when) || null;
}

// The rate a document uses. override = { rate, rateQuote } needs
// override_exchange_rate; otherwise the history rate for the date, which
// must exist.
function documentRate(companyId, code, date, { override, actor } = {}) {
  const b = base(companyId);
  const c = String(code || b.code).toUpperCase();
  if (c === b.code) return { rateE8: ONE, quote: 'base_per_foreign', overridden: false };
  if (override && override.rate !== undefined && override.rate !== null && override.rate !== '') {
    if (!actor?.permissions?.includes('override_exchange_rate')) fail('rate_override_forbidden', 'تجاوز سعر الصرف يحتاج صلاحية override_exchange_rate', 403);
    const r = withFx(() => fx.parseRate(override.rate, override.rateQuote || 'base_per_foreign', { foreign: c, base: b.code }));
    return { ...r, overridden: true };
  }
  const r = rateFor(companyId, c, date);
  if (!r) fail('rate_missing', `لا يوجد سعر صرف لـ ${c} بتاريخ ${date} أو قبله — أدخل سعر اليوم أولًا`, 409, { currency: c, date });
  return { rateE8: r.rate_e8, quote: r.rate_quote, overridden: false, rate_id: r.id };
}

function toBase(companyId, code, minor, rate) {
  const b = base(companyId);
  const c = currency(companyId, code);
  if (c.code === b.code) return minor;
  return withFx(() => fx.toBaseMinor(minor, rate.rateE8, rate.quote, c.minor_unit_digits, b.minor_unit_digits));
}
function fromBase(companyId, code, baseMinor, rate) {
  const b = base(companyId);
  const c = currency(companyId, code);
  if (c.code === b.code) return baseMinor;
  return withFx(() => fx.fromBaseMinor(baseMinor, rate.rateE8, rate.quote, c.minor_unit_digits, b.minor_unit_digits));
}

// lib/exchangeRate.js fetches "SYP per 1 USD" daily; record it here too.
function recordApiUsdSyp(companyId, sypPerUsd, source = 'api') {
  const b = base(companyId);
  const rate = Number(sypPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const str = rate.toFixed(8).replace(/\.?0+$/, '');
  if (b.code === 'SYP') return addRate(companyId, { currencyCode: 'USD', rate: str, rateQuote: 'base_per_foreign', source }, null);
  if (b.code === 'USD') return addRate(companyId, { currencyCode: 'SYP', rate: str, rateQuote: 'foreign_per_base', source }, null);
  return null; // other bases: the USD/SYP pair is not a base rate
}

// ---------------------------------------------------------------------
// Open foreign-currency items (receivables + cash/bank accounts)
// ---------------------------------------------------------------------

function invoiceBaseTotal(inv) {
  return inv.total_base_minor ?? inv.total_minor;
}

// Base still carried for an invoice = its base total - base of its credit
// notes - base relieved by receipt allocations (each allocation relieves
// base_relieved_minor, or amount_minor for base-currency rows).
function invoiceBaseOpen(inv) {
  const credited = db.prepare('SELECT COALESCE(SUM(COALESCE(total_base_minor, total_minor)), 0) s FROM sales_credit_notes WHERE invoice_id = ?').get(inv.id).s;
  const relieved = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(a.base_relieved_minor, a.amount_minor)), 0) s FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id
       WHERE a.invoice_id = ? AND r.status = 'posted'`
    )
    .get(inv.id).s;
  return invoiceBaseTotal(inv) - credited - relieved;
}

function receiptCurrency(r, baseCode) {
  return r.currency_code || baseCode;
}
function receiptOriginal(r) {
  return r.amount_original_minor ?? r.amount_minor;
}
function receiptRate(r) {
  return r.rate_e8 ? { rateE8: r.rate_e8, quote: r.rate_quote } : { rateE8: ONE, quote: 'base_per_foreign' };
}

// Open documents per customer in their own currency AND in base.
function openReceivables(companyId, { asOf } = {}) {
  const b = base(companyId);
  const rec = require('./receivables');
  const out = [];
  const invoices = db.prepare("SELECT i.*, s.name AS shop_name FROM sales_invoices i JOIN shops s ON s.id = i.shop_id WHERE i.company_id = ? AND i.status = 'posted'" + (asOf ? ' AND i.invoice_date <= ?' : '')).all(...[companyId, ...(asOf ? [asOf] : [])]);
  for (const inv of invoices) {
    const open = rec.invoiceOpenMinor(inv);
    if (open <= 0) continue;
    out.push({ kind: 'invoice', id: inv.id, number: inv.invoice_number, shop_id: inv.shop_id, shop_name: inv.shop_name, currency_code: inv.currency_code, open_minor: open, base_minor: invoiceBaseOpen(inv) });
  }
  const receipts = db.prepare("SELECT r.*, s.name AS shop_name FROM customer_receipts r JOIN shops s ON s.id = r.shop_id WHERE r.company_id = ? AND r.status = 'posted'" + (asOf ? ' AND r.receipt_date <= ?' : '')).all(...[companyId, ...(asOf ? [asOf] : [])]);
  for (const r of receipts) {
    const used = db.prepare('SELECT COALESCE(SUM(COALESCE(receipt_amount_minor, amount_minor)), 0) o, COALESCE(SUM(COALESCE(base_paid_minor, amount_minor)), 0) b FROM receipt_allocations WHERE receipt_id = ?').get(r.id);
    const remaining = receiptOriginal(r) - used.o;
    if (remaining <= 0) continue;
    out.push({ kind: 'receipt', id: r.id, number: r.receipt_number, shop_id: r.shop_id, shop_name: r.shop_name, currency_code: receiptCurrency(r, b.code), open_minor: -remaining, base_minor: -(r.amount_minor - used.b) });
  }
  return out;
}

// Open supplier documents (Prompt 6) in their own currency AND in base;
// positive = owed to the supplier, negative = unallocated payments.
function openPayables(companyId, { asOf } = {}) {
  const b = base(companyId);
  const pay = require('./payables');
  const out = [];
  const where = asOf ? ' AND i.invoice_date <= ?' : '';
  for (const inv of db.prepare(`SELECT i.*, s.name AS supplier_name FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.company_id = ? AND i.status = 'posted'${where}`).all(...[companyId, ...(asOf ? [asOf] : [])])) {
    const open = pay.invoiceOpenMinor(inv);
    if (open <= 0) continue;
    out.push({ kind: 'supplier_invoice', id: inv.id, number: inv.invoice_number, supplier_id: inv.supplier_id, supplier_name: inv.supplier_name, currency_code: inv.currency_code, open_minor: open, base_minor: pay.invoiceBaseOpen(inv) });
  }
  const pw = asOf ? ' AND p.payment_date <= ?' : '';
  for (const p of db.prepare(`SELECT p.*, s.name AS supplier_name FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.company_id = ? AND p.status = 'posted'${pw}`).all(...[companyId, ...(asOf ? [asOf] : [])])) {
    const used = db.prepare('SELECT COALESCE(SUM(payment_amount_minor), 0) o, COALESCE(SUM(base_paid_minor), 0) b FROM supplier_payment_allocations WHERE payment_id = ?').get(p.id);
    const remaining = p.amount_original_minor - used.o;
    if (remaining <= 0) continue;
    out.push({ kind: 'supplier_payment', id: p.id, number: p.payment_number, supplier_id: p.supplier_id, supplier_name: p.supplier_name, currency_code: p.currency_code || b.code, open_minor: -remaining, base_minor: -(p.amount_minor - used.b) });
  }
  return out;
}

// Asset/liability accounts (except AR / AP control, handled per document) that
// hold foreign-currency lines: balance per currency and its carrying base.
function foreignAccountBalances(companyId, asOf) {
  const b = base(companyId);
  const ar = ledger.getAccountBySystemKey(companyId, 'ar_control')?.id ?? 0;
  const ap = ledger.getAccountBySystemKey(companyId, 'ap_control')?.id ?? 0;
  return db
    .prepare(
      `SELECT a.id AS account_id, a.code, a.name_ar, a.type, l.currency_code,
         SUM(CASE WHEN l.debit_minor > 0 THEN l.amount_original_minor ELSE -l.amount_original_minor END) AS original_minor,
         SUM(l.debit_minor - l.credit_minor) AS base_minor
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND e.entry_date <= ? AND l.currency_code <> ?
         AND a.type IN ('asset','liability') AND a.id NOT IN (?, ?)
       GROUP BY a.id, l.currency_code HAVING original_minor <> 0 OR base_minor <> 0`
    )
    .all(companyId, asOf, b.code, ar, ap);
}

function balancesByCurrency(companyId, { asOf } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const b = base(companyId);
  const items = openReceivables(companyId, { asOf: date });
  const customers = new Map();
  for (const it of items) {
    const k = `${it.shop_id}|${it.currency_code}`;
    const row = customers.get(k) || { shop_id: it.shop_id, shop_name: it.shop_name, currency_code: it.currency_code, balance_minor: 0, base_minor: 0, documents: 0 };
    row.balance_minor += it.open_minor;
    row.base_minor += it.base_minor;
    row.documents += 1;
    customers.set(k, row);
  }
  const totals = {};
  for (const r of customers.values()) {
    totals[r.currency_code] ??= { currency_code: r.currency_code, balance_minor: 0, base_minor: 0 };
    totals[r.currency_code].balance_minor += r.balance_minor;
    totals[r.currency_code].base_minor += r.base_minor;
  }
  const suppliers = new Map();
  const supplierTotals = {};
  for (const it of openPayables(companyId, { asOf: date })) {
    const k = `${it.supplier_id}|${it.currency_code}`;
    const row = suppliers.get(k) || { supplier_id: it.supplier_id, supplier_name: it.supplier_name, currency_code: it.currency_code, balance_minor: 0, base_minor: 0, documents: 0 };
    row.balance_minor += it.open_minor;
    row.base_minor += it.base_minor;
    row.documents += 1;
    suppliers.set(k, row);
    supplierTotals[it.currency_code] ??= { currency_code: it.currency_code, balance_minor: 0, base_minor: 0 };
    supplierTotals[it.currency_code].balance_minor += it.open_minor;
    supplierTotals[it.currency_code].base_minor += it.base_minor;
  }
  return {
    as_of: date,
    base_currency: b.code,
    suppliers: [...suppliers.values()].sort((x, y) => (x.supplier_name < y.supplier_name ? -1 : 1)),
    payable_totals: Object.values(supplierTotals),
    customers: [...customers.values()].sort((x, y) => (x.shop_name < y.shop_name ? -1 : 1)),
    receivable_totals: Object.values(totals),
    accounts: foreignAccountBalances(companyId, date),
    digits: Object.fromEntries(db.prepare('SELECT code, minor_unit_digits FROM currencies WHERE company_id = ?').all(companyId).map((c) => [c.code, c.minor_unit_digits])),
  };
}

// ---------------------------------------------------------------------
// Unrealized revaluation
// ---------------------------------------------------------------------

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Preview: every open foreign-currency balance at asOf revalued at the
// closing rate (latest rate on or before the end of asOf).
function revaluationPreview(companyId, { asOf } = {}) {
  if (!isDate(asOf)) fail('invalid_date', 'تاريخ إعادة التقييم غير صالح');
  const b = base(companyId);
  const lines = [];
  const missing = new Set();
  const closing = (code) => {
    const r = rateFor(companyId, code, asOf);
    if (!r) missing.add(code);
    return r ? { rateE8: r.rate_e8, quote: r.rate_quote, rate: fx.formatRate(r.rate_e8) } : null;
  };
  for (const it of openReceivables(companyId, { asOf })) {
    if (it.currency_code === b.code) continue;
    const rate = closing(it.currency_code);
    if (!rate) continue;
    const revalued = toBase(companyId, it.currency_code, it.open_minor, rate);
    const diff = revalued - it.base_minor;
    if (!diff) continue;
    lines.push({ kind: it.kind, document_id: it.id, number: it.number, shop_id: it.shop_id, shop_name: it.shop_name, currency_code: it.currency_code, open_minor: it.open_minor, carrying_base_minor: it.base_minor, closing_rate: rate.rate, closing_rate_quote: rate.quote, revalued_base_minor: revalued, difference_minor: diff });
  }
  // Payables (Prompt 6): same tool. difference = change of the LIABILITY
  // (positive = we owe more base = loss).
  for (const it of openPayables(companyId, { asOf })) {
    if (it.currency_code === b.code) continue;
    const rate = closing(it.currency_code);
    if (!rate) continue;
    const revalued = toBase(companyId, it.currency_code, it.open_minor, rate);
    const diff = revalued - it.base_minor;
    if (!diff) continue;
    lines.push({ kind: it.kind, side: 'payable', document_id: it.id, number: it.number, supplier_id: it.supplier_id, shop_name: it.supplier_name, currency_code: it.currency_code, open_minor: it.open_minor, carrying_base_minor: it.base_minor, closing_rate: rate.rate, closing_rate_quote: rate.quote, revalued_base_minor: revalued, difference_minor: diff });
  }
  for (const a of foreignAccountBalances(companyId, asOf)) {
    const rate = closing(a.currency_code);
    if (!rate) continue;
    const revalued = toBase(companyId, a.currency_code, a.original_minor, rate);
    const diff = revalued - a.base_minor;
    if (!diff) continue;
    lines.push({ kind: 'account', account_id: a.account_id, number: a.code, name: a.name_ar, currency_code: a.currency_code, open_minor: a.original_minor, carrying_base_minor: a.base_minor, closing_rate: rate.rate, closing_rate_quote: rate.quote, revalued_base_minor: revalued, difference_minor: diff });
  }
  // Gain (+) for the company: receivable/asset increases minus payable increases.
  const total = lines.reduce((s, l) => s + (l.side === 'payable' ? -l.difference_minor : l.difference_minor), 0);
  const already = db.prepare('SELECT id, journal_entry_id FROM fx_revaluations WHERE company_id = ? AND as_of = ?').get(companyId, asOf);
  return { as_of: asOf, reversal_date: addDays(asOf, 1), base_currency: b.code, lines, total_minor: total, missing_rates: [...missing], already_posted: already || null };
}

// Posts the revaluation dated asOf and its automatic reversal dated the
// next day (day one of the next period). Gain/loss -> fx_unrealized.
function postRevaluation(companyId, { asOf } = {}, actor) {
  return ledger.transaction(() => {
    const p = revaluationPreview(companyId, { asOf });
    if (p.already_posted) fail('already_revalued', 'تمت إعادة التقييم لهذا التاريخ مسبقًا', 409);
    if (p.missing_rates.length) fail('rate_missing', `لا يوجد سعر إقفال لـ ${p.missing_rates.join('، ')} — أدخل الأسعار أولًا`, 409, { currencies: p.missing_rates });
    if (!p.lines.length) fail('nothing_to_revalue', 'لا توجد أرصدة بعملات أجنبية تحتاج إعادة تقييم', 409);
    const ar = ledger.getAccountBySystemKey(companyId, 'ar_control');
    const ap = ledger.getAccountBySystemKey(companyId, 'ap_control');
    const fxAcc = ledger.getAccountBySystemKey(companyId, 'fx_unrealized');
    if (!ar || !fxAcc || (!ap && p.lines.some((l) => l.side === 'payable'))) fail('missing_system_account', 'حسابات النظام غير مكتملة', 409);
    const jl = [];
    for (const l of p.lines) {
      const d = l.difference_minor;
      const memo = `إعادة تقييم ${l.number} (${l.currency_code})`;
      if (l.side === 'payable') {
        // The liability grows by d: credit AP (d > 0) or debit it (d < 0).
        jl.push({ accountId: ap.id, debitMinor: d < 0 ? -d : 0, creditMinor: d > 0 ? d : 0, memo, partyType: 'supplier', partyId: l.supplier_id });
        continue;
      }
      const accountId = l.kind === 'account' ? l.account_id : ar.id;
      const party = l.kind === 'account' ? {} : { partyType: 'customer', partyId: l.shop_id };
      jl.push({ accountId, debitMinor: d > 0 ? d : 0, creditMinor: d < 0 ? -d : 0, memo, ...party });
    }
    const total = p.total_minor;
    if (total) jl.push({ accountId: fxAcc.id, debitMinor: total < 0 ? -total : 0, creditMinor: total > 0 ? total : 0, memo: total > 0 ? 'أرباح فروقات صرف غير محققة' : 'خسائر فروقات صرف غير محققة' });
    const id = Number(
      db.prepare('INSERT INTO fx_revaluations (company_id, as_of, reversal_date, total_minor, details_json, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(companyId, asOf, p.reversal_date, total, JSON.stringify(p.lines), actor?.id ?? null).lastInsertRowid
    );
    const entry = ledger.postEntry(companyId, { date: asOf, description: `إعادة تقييم العملات الأجنبية في ${asOf}`, sourceType: 'fx_revaluation', sourceId: id, lines: jl }, actor);
    const rev = ledger.reverseEntry(companyId, entry.id, { date: p.reversal_date, reason: 'عكس تلقائي لإعادة التقييم في أول يوم من الفترة التالية', fromSource: true }, actor);
    db.prepare('UPDATE fx_revaluations SET journal_entry_id = ?, reversal_entry_id = ? WHERE id = ?').run(entry.id, rev.reversal.id, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'currency.revaluation.post', entityType: 'fx_revaluation', entityId: id, before: null, after: { as_of: asOf, total_minor: total, entry_id: entry.id, reversal_entry_id: rev.reversal.id, lines: p.lines.length } });
    return { ...p, id, journal_entry: { id: entry.id, entry_number: entry.entry_number }, reversal_entry: { id: rev.reversal.id, entry_number: rev.reversal.entry_number } };
  });
}

function listRevaluations(companyId) {
  return db
    .prepare(
      `SELECT v.*, e.entry_number, r.entry_number AS reversal_entry_number FROM fx_revaluations v
       LEFT JOIN journal_entries e ON e.id = v.journal_entry_id LEFT JOIN journal_entries r ON r.id = v.reversal_entry_id
       WHERE v.company_id = ? ORDER BY v.as_of DESC`
    )
    .all(companyId)
    .map((v) => ({ ...v, details: JSON.parse(v.details_json), details_json: undefined }));
}

// ---------------------------------------------------------------------
// FX gain/loss report
// ---------------------------------------------------------------------

const FX_KINDS = { fx_realized: 'realized', fx_realized_ap: 'realized', fx_revaluation: 'unrealized', reversal: 'unrealized_reversal',
  // receipt-vs-invoice exchange difference on a goods invoice (post-Prompt 6)
  supplier_invoice: 'realized',
};

// Every line on the two FX accounts in [from, to]: fx_realized (receipt
// settlements) and fx_unrealized (revaluation and its automatic reversal).
// Rounding of FX conversions is on rounding_difference and not included.
// Entries posted before the split (both on the old fx_gain_loss account,
// now fx_realized) are classified by their source.
function fxGainLossReport(companyId, { from, to } = {}) {
  const t = to || new Date().toISOString().slice(0, 10);
  const f = from || `${t.slice(0, 4)}-01-01`;
  if (!isDate(f) || !isDate(t) || f > t) fail('invalid_dates', 'الفترة غير صالحة');
  const realizedAcc = ledger.getAccountBySystemKey(companyId, 'fx_realized');
  const unrealizedAcc = ledger.getAccountBySystemKey(companyId, 'fx_unrealized');
  const ids = [realizedAcc?.id, unrealizedAcc?.id].filter(Boolean);
  const accounts = { realized: realizedAcc ? { id: realizedAcc.id, code: realizedAcc.code, name_ar: realizedAcc.name_ar } : null, unrealized: unrealizedAcc ? { id: unrealizedAcc.id, code: unrealizedAcc.code, name_ar: unrealizedAcc.name_ar } : null };
  if (!ids.length) return { from: f, to: t, rows: [], totals: { realized: 0, unrealized: 0, other: 0, net: 0 }, accounts };
  const rows = db
    .prepare(
      `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.source_type, e.source_id, e.description, l.account_id, l.credit_minor - l.debit_minor AS gain_minor,
         (SELECT o.source_type FROM journal_entries o WHERE o.id = e.source_id) AS reversed_source
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id IN (${ids.map(() => '?').join(',')}) AND e.entry_date BETWEEN ? AND ?
       ORDER BY e.entry_date, e.id`
    )
    .all(companyId, ...ids, f, t)
    .map((r) => {
      let kind = FX_KINDS[r.source_type] || 'other';
      if (r.source_type === 'reversal') kind = r.reversed_source === 'fx_revaluation' ? 'unrealized_reversal' : ['fx_realized', 'fx_realized_ap', 'supplier_invoice'].includes(r.reversed_source) ? 'realized' : 'other';
      let document = null;
      if (r.source_type === 'fx_realized_ap') {
        const s = db.prepare('SELECT s.*, i.invoice_number, p.payment_number FROM ap_fx_settlements s JOIN supplier_invoices i ON i.id = s.invoice_id JOIN supplier_payments p ON p.id = s.payment_id WHERE s.id = ?').get(r.source_id);
        if (s) document = { supplier_invoice_id: s.invoice_id, invoice_number: s.invoice_number, payment_id: s.payment_id, payment_number: s.payment_number };
      }
      if (r.source_type === 'supplier_invoice') {
        const i = db.prepare('SELECT invoice_number FROM supplier_invoices WHERE id = ?').get(r.source_id);
        if (i) document = { supplier_invoice_id: r.source_id, invoice_number: i.invoice_number };
      }
      if (r.source_type === 'fx_realized') {
        const s = db.prepare('SELECT s.*, i.invoice_number, rc.receipt_number FROM fx_settlements s JOIN sales_invoices i ON i.id = s.invoice_id JOIN customer_receipts rc ON rc.id = s.receipt_id WHERE s.id = ?').get(r.source_id);
        if (s) document = { invoice_id: s.invoice_id, invoice_number: s.invoice_number, receipt_id: s.receipt_id, receipt_number: s.receipt_number };
      }
      return { ...r, kind, account: r.account_id === unrealizedAcc?.id ? 'fx_unrealized' : 'fx_realized', document };
    });
  const sum = (k) => rows.filter((r) => (Array.isArray(k) ? k.includes(r.kind) : r.kind === k)).reduce((s, r) => s + r.gain_minor, 0);
  return {
    from: f, to: t, rows,
    totals: { realized: sum('realized'), unrealized: sum(['unrealized', 'unrealized_reversal']), other: sum('other'), net: rows.reduce((s, r) => s + r.gain_minor, 0) },
    accounts,
    account_id: realizedAcc?.id ?? null,
  };
}

module.exports = {
  CurrencyError,
  addRate,
  listRates,
  getRate,
  rateFor,
  documentRate,
  toBase,
  fromBase,
  recordApiUsdSyp,
  invoiceBaseOpen,
  invoiceBaseTotal,
  receiptOriginal,
  receiptRate,
  openReceivables,
  openPayables,
  balancesByCurrency,
  revaluationPreview,
  postRevaluation,
  listRevaluations,
  fxGainLossReport,
  fmt: (minor, digits) => fromMinor(minor, digits),
};
