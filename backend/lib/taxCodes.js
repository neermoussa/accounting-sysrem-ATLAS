// backend/lib/taxCodes.js
//
// Prompt 10 — configurable tax codes. Nothing is hardcoded: a company with
// no tax codes keeps today's behaviour (a free per-line rate posted to the
// output_tax / input_tax system accounts; golden test/taxGolden.test.js).
//
// A tax code has a type (sales / purchase), its tax account and rates with
// effective dates. A document line that names a code gets the rate in
// effect on the document date and posts its tax to the code's account.
// Price mode (sales lines with a code): companies.price_display_mode
// 'with_tax' = the price includes the tax (net = price / (1 + rate)),
// 'without_tax' = the tax is added on top. Purchase lines are always
// tax-exclusive (supplier prices).
//
// Tax report by period: from the ledger (journal lines on the tax accounts:
// every code's account plus output_tax / input_tax), with the taxable base
// and tax per code from the document lines that used it; the report's tax
// per account equals the ledger movement of that account in the period.

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const { logAudit } = require('./auditLog');

// A LedgerError subclass: every route that already maps ledger errors to
// 4xx (sales, payables, ledger) maps tax-code errors the same way.
class TaxError extends ledger.LedgerError {}
const fail = (code, message, status, extra) => {
  throw new TaxError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const parseBp = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) fail('invalid_tax_rate', 'النسبة يجب أن تكون بين 0 و100');
  return Math.round(n * 100);
};

function ownedCode(companyId, id) {
  const n = Number(id);
  const c = Number.isInteger(n) && n > 0 ? db.prepare('SELECT * FROM tax_codes WHERE id = ? AND company_id = ?').get(n, companyId) : null;
  if (!c) fail('invalid_tax_code', 'رمز الضريبة غير موجود أو لا يتبع لهذه الشركة', 400);
  return c;
}
const hasTaxCodes = (companyId) => Boolean(db.prepare('SELECT 1 FROM tax_codes WHERE company_id = ? LIMIT 1').get(companyId));

function rateOn(codeId, date) {
  return db.prepare('SELECT * FROM tax_code_rates WHERE tax_code_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1').get(codeId, date) || null;
}
function getCode(companyId, id) {
  const c = ownedCode(companyId, id);
  const acc = db.prepare('SELECT code, name_ar FROM accounts WHERE id = ?').get(c.account_id);
  return { ...c, account_code: acc.code, account_name: acc.name_ar, rates: db.prepare('SELECT id, rate_bp, effective_from FROM tax_code_rates WHERE tax_code_id = ? ORDER BY effective_from').all(c.id).map((r) => ({ ...r, rate: r.rate_bp / 100 })) };
}
const listCodes = (companyId) => db.prepare('SELECT id FROM tax_codes WHERE company_id = ? ORDER BY type, code').all(companyId).map((r) => getCode(companyId, r.id));

function requireTaxAccount(companyId, accountId) {
  let a;
  try {
    a = tenantRefs.requireOwned(companyId, 'account', accountId, { active: true });
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 400);
    throw err;
  }
  if (!a.is_postable) fail('account_not_postable', 'حساب الضريبة يجب أن يكون حسابًا فرعيًا قابلًا للترحيل');
  if (!['liability', 'asset'].includes(a.type)) fail('invalid_tax_account', 'حساب الضريبة يجب أن يكون من الخصوم (مخرجات) أو الأصول (مدخلات)');
  return a;
}

// { code, name, type, accountId, rate, effectiveFrom }
// Price mode (explicit choice, item 2 after Prompt 10).
const MODES = ['inclusive', 'exclusive'];
function getPriceMode(companyId) {
  const r = db.prepare('SELECT price_mode, chosen_by, chosen_at FROM company_tax_settings WHERE company_id = ?').get(companyId);
  return { mode: r?.price_mode ?? null, chosen_by: r?.chosen_by ?? null, chosen_at: r?.chosen_at ?? null, has_tax_codes: hasTaxCodes(companyId) };
}
function writePriceMode(companyId, mode, actor) {
  if (!MODES.includes(mode)) fail('price_mode_required', 'اختر وضع الأسعار: شاملة الضريبة (inclusive) أو غير شاملة (exclusive)');
  const before = getPriceMode(companyId);
  db.prepare("INSERT INTO company_tax_settings (company_id, price_mode, chosen_by) VALUES (?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET price_mode = excluded.price_mode, chosen_by = excluded.chosen_by, chosen_at = datetime('now')").run(companyId, mode, actor?.id ?? null);
  db.prepare('UPDATE companies SET price_display_mode = ? WHERE id = ?').run(mode === 'inclusive' ? 'with_tax' : 'without_tax', companyId);
  logAudit({ companyId, actor: actorOf(actor), action: 'tax.price_mode.set', entityType: 'company', entityId: companyId, before: { mode: before.mode }, after: { mode } });
}
function setPriceMode(companyId, { mode } = {}, actor) {
  return ledger.transaction(() => {
    writePriceMode(companyId, mode, actor);
    return getPriceMode(companyId);
  });
}
// A company that uses tax codes must have chosen the mode before any taxed
// document posts. Companies without tax codes: no check (unchanged).
function requirePriceModeChosen(companyId, taxMinor) {
  if (!taxMinor || !hasTaxCodes(companyId)) return;
  if (!getPriceMode(companyId).mode) fail('price_mode_not_chosen', 'اختر وضع الأسعار (شاملة / غير شاملة الضريبة) من شاشة الضريبة قبل ترحيل مستند عليه ضريبة', 409);
}

function createCode(companyId, input, actor) {
  const code = String(input.code || '').trim();
  const name = String(input.name || '').trim();
  if (!code || !name) fail('code_required', 'الرمز والاسم مطلوبان');
  if (!['sales', 'purchase'].includes(input.type)) fail('invalid_type', 'النوع: مبيعات أو مشتريات');
  const acc = requireTaxAccount(companyId, input.accountId);
  const bp = parseBp(input.rate);
  if (!isValidDate(input.effectiveFrom)) fail('invalid_date', 'تاريخ السريان مطلوب');
  return ledger.transaction(() => {
    if (db.prepare('SELECT 1 FROM tax_codes WHERE company_id = ? AND code = ?').get(companyId, code)) fail('code_exists', 'الرمز مستخدم', 409);
    // The first tax code requires the explicit price-mode choice.
    if (!getPriceMode(companyId).mode) writePriceMode(companyId, input.priceMode, actor);
    const id = Number(db.prepare('INSERT INTO tax_codes (company_id, code, name, type, account_id, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, code, name, input.type, acc.id, actor?.id ?? null).lastInsertRowid);
    db.prepare('INSERT INTO tax_code_rates (company_id, tax_code_id, rate_bp, effective_from, created_by) VALUES (?, ?, ?, ?, ?)').run(companyId, id, bp, input.effectiveFrom, actor?.id ?? null);
    const after = getCode(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'tax.code.create', entityType: 'tax_code', entityId: id, before: null, after });
    return after;
  });
}
// A rate change is a new rate row from a date (history is kept).
function addRate(companyId, id, { rate, effectiveFrom } = {}, actor) {
  const c = ownedCode(companyId, id);
  const bp = parseBp(rate);
  if (!isValidDate(effectiveFrom)) fail('invalid_date', 'تاريخ السريان مطلوب');
  return ledger.transaction(() => {
    if (db.prepare('SELECT 1 FROM tax_code_rates WHERE tax_code_id = ? AND effective_from = ?').get(c.id, effectiveFrom)) fail('rate_exists', 'يوجد سعر بهذا التاريخ', 409);
    db.prepare('INSERT INTO tax_code_rates (company_id, tax_code_id, rate_bp, effective_from, created_by) VALUES (?, ?, ?, ?, ?)').run(companyId, c.id, bp, effectiveFrom, actor?.id ?? null);
    const after = getCode(companyId, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'tax.code.rate', entityType: 'tax_code', entityId: c.id, before: null, after: { rate_bp: bp, effective_from: effectiveFrom } });
    return after;
  });
}
function updateCode(companyId, id, { name, accountId, active } = {}, actor) {
  const c = ownedCode(companyId, id);
  const acc = accountId !== undefined ? requireTaxAccount(companyId, accountId).id : c.account_id;
  return ledger.transaction(() => {
    db.prepare('UPDATE tax_codes SET name = ?, account_id = ?, active = ? WHERE id = ?').run(name !== undefined ? String(name).trim() || c.name : c.name, acc, active === undefined ? c.active : active ? 1 : 0, c.id);
    const after = getCode(companyId, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'tax.code.update', entityType: 'tax_code', entityId: c.id, before: { ...c }, after });
    return after;
  });
}

// Resolves a line's tax code for a document: rate on the date, account,
// inclusive flag. type: 'sales' | 'purchase'.
function resolve(companyId, taxCodeId, type, date, n) {
  const c = ownedCode(companyId, taxCodeId);
  if (!c.active) fail('tax_code_inactive', `السطر ${n}: رمز الضريبة ${c.code} غير مفعّل`);
  if (c.type !== type) fail('tax_code_type', `السطر ${n}: الرمز ${c.code} ليس رمز ${type === 'sales' ? 'مبيعات' : 'مشتريات'}`);
  const r = rateOn(c.id, date);
  if (!r) fail('tax_rate_not_effective', `السطر ${n}: لا يوجد سعر ساري للرمز ${c.code} في ${date}`);
  let inclusive = 0;
  if (type === 'sales') {
    const mode = getPriceMode(companyId).mode;
    if (!mode) fail('price_mode_not_chosen', 'اختر وضع الأسعار (شاملة / غير شاملة الضريبة) من شاشة الضريبة أولًا', 409);
    inclusive = mode === 'inclusive' ? 1 : 0;
  }
  return { tax_code_id: c.id, code: c.code, rate_bp: r.rate_bp, account_id: c.account_id, inclusive };
}
// Splits a line amount (minor, exact) into net + tax for a resolved code.
function split(amountExact, t) {
  if (t.inclusive) {
    // The net is rounded first and the tax is the remainder, so a line's
    // net + tax is exactly its (rounded) gross: rounding net and tax
    // separately could make them one minor unit more than the price.
    const raw = (amountExact * 10000) / (10000 + t.rate_bp);
    const net = Math.sign(raw) * Math.round(Math.abs(raw));
    return { exactNet: net, exactTax: amountExact - net };
  }
  return { exactNet: amountExact, exactTax: (amountExact * t.rate_bp) / 10000 };
}
function linkLine(companyId, lineType, lineId, t) {
  db.prepare('INSERT OR REPLACE INTO document_line_tax (company_id, line_type, line_id, tax_code_id, rate_bp, account_id, inclusive) VALUES (?, ?, ?, ?, ?, ?, ?)').run(companyId, lineType, lineId, t.tax_code_id, t.rate_bp, t.account_id, t.inclusive);
}
const lineTax = (lineType, lineId) => db.prepare('SELECT * FROM document_line_tax WHERE line_type = ? AND line_id = ?').get(lineType, lineId) || null;
function clearDocumentLines(lineType, lineIds) {
  if (!lineIds.length) return;
  db.prepare(`DELETE FROM document_line_tax WHERE line_type = ? AND line_id IN (${lineIds.map(() => '?').join(',')})`).run(lineType, ...lineIds);
}
// Tax amounts of a document's lines grouped by tax account; lines without
// a code go to `fallbackAccountId` (output_tax / input_tax as today).
function taxByAccount(lineType, lines, fallbackAccountId) {
  const map = new Map();
  for (const l of lines) {
    if (!l.tax_minor) continue;
    const link = lineTax(lineType, l.id);
    const acc = link ? link.account_id : fallbackAccountId;
    map.set(acc, (map.get(acc) || 0) + l.tax_minor);
  }
  return [...map.entries()].map(([accountId, amount]) => ({ accountId, amount }));
}

// ---------------------------------------------------------------------
// Tax report
// ---------------------------------------------------------------------

// Tax report by period, built FROM THE LEDGER (after Prompt 10, item 3).
// Every journal line on a tax account in the period (every code's account
// plus output_tax / input_tax) is classified, nothing is dropped:
//   coded     - a document line with a tax code: per code, rate and
//               document currency;
//   free_rate - a document line with a free per-line rate: per document
//               kind (sales invoice, credit note, supplier goods / landed
//               cost / expense invoice, debit note) and currency;
//   other     - anything else on a tax account (manual journals,
//               reversals ...): per source type.
// Amounts are the ledger's base amounts (foreign-currency documents are
// therefore at the document rate, exactly as posted); the document-currency
// tax is shown next to them. A document entry that touches a tax account
// with several codes / free lines is split by the lines' tax amounts.
// The rows add up to the ledger movement of every tax account
// (reconciliation per account and in total).
const DOC = {
  sales_invoice: { doc: 'sales_invoices', lines: 'sales_invoice_lines', fk: 'invoice_id', link: 'sales_invoice_line', linkCol: 'id', date: 'invoice_date', number: 'invoice_number', side: 'sales', sign: 1 },
  sales_credit_note: { doc: 'sales_credit_notes', lines: 'sales_credit_note_lines', fk: 'credit_note_id', link: 'sales_credit_note_line', linkCol: 'id', date: 'note_date', number: 'credit_note_number', side: 'sales', sign: -1 },
  supplier_invoice: { doc: 'supplier_invoices', lines: 'supplier_invoice_lines', fk: 'invoice_id', link: 'supplier_invoice_line', linkCol: 'id', date: 'invoice_date', number: 'invoice_number', side: 'purchase', sign: 1 },
  supplier_debit_note: { doc: 'supplier_debit_notes', lines: 'supplier_debit_note_lines', fk: 'debit_note_id', link: 'supplier_invoice_line', linkCol: 'invoice_line_id', date: 'note_date', number: 'debit_note_number', side: 'purchase', sign: -1 },
};
function splitSigned(total, weights) {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (!sum) return null;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * w) / sum);
  const out = raw.map(Math.floor);
  let rest = abs - out.reduce((t, x) => t + x, 0);
  raw.map((x, k) => [x - Math.floor(x), k]).sort((a, b) => b[0] - a[0]).forEach(([, k]) => { if (rest > 0) { out[k] += 1; rest -= 1; } });
  return out.map((x) => (total < 0 ? -x : x));
}
function taxReport(companyId, { from, to } = {}) {
  if (!isValidDate(from) || !isValidDate(to) || from > to) fail('invalid_period', 'الفترة غير صالحة');
  const fx = require('./fxRate');
  const baseCur = ledger.getBaseCurrency(companyId);
  const sysAcc = Object.fromEntries(['output_tax', 'input_tax'].map((k) => [k, db.prepare('SELECT id FROM accounts WHERE company_id = ? AND system_key = ?').get(companyId, k)?.id]).filter(([, v]) => v));
  const codeRows = db.prepare('SELECT id, code, type, account_id FROM tax_codes WHERE company_id = ?').all(companyId);
  const accIds = [...new Set([...Object.values(sysAcc), ...codeRows.map((r) => r.account_id)])];
  const accounts = accIds.map((aid) => {
    const a = db.prepare('SELECT id, code, name_ar, system_key, type FROM accounts WHERE id = ?').get(aid);
    const m = db.prepare(`SELECT COALESCE(SUM(l.debit_minor), 0) d, COALESCE(SUM(l.credit_minor), 0) c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND l.account_id = ? AND e.entry_date BETWEEN ? AND ?`).get(companyId, aid, from, to);
    return { account_id: a.id, code: a.code, name: a.name_ar, system_key: a.system_key, debit_minor: m.d, credit_minor: m.c, net_credit_minor: m.c - m.d };
  });
  const jls = accIds.length ? db.prepare(`SELECT l.account_id, l.debit_minor, l.credit_minor, l.currency_code, l.amount_original_minor, e.source_type, e.source_id
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND e.entry_date BETWEEN ? AND ? AND l.account_id IN (${accIds.map(() => '?').join(',')}) ORDER BY e.id, l.line_no`).all(companyId, from, to, ...accIds) : [];
  const codeById = new Map(codeRows.map((r) => [r.id, r]));
  const rows = new Map();
  const add = (key, init, net, orig, base) => {
    const r = rows.get(key) || { ...init, tax_base_minor: 0, tax_original_minor: 0, taxable_base_minor: 0, documents: new Set() };
    r.tax_base_minor += net;
    r.tax_original_minor += orig;
    r.taxable_base_minor += base;
    rows.set(key, r);
    return r;
  };
  const counted = new Set();
  for (const jl of jls) {
    const net = jl.credit_minor - jl.debit_minor;
    const orig = (jl.credit_minor ? 1 : -1) * (jl.amount_original_minor || Math.abs(net));
    const t = DOC[jl.source_type];
    const doc = t && db.prepare(`SELECT * FROM ${t.doc} WHERE id = ? AND company_id = ?`).get(jl.source_id, companyId);
    if (!doc) {
      add(`other|${jl.source_type}`, { section: 'other', source_type: jl.source_type }, net, net, 0).documents.add(jl.source_id);
      continue;
    }
    const fallback = sysAcc[t.side === 'sales' ? 'output_tax' : 'input_tax'];
    const kind = jl.source_type === 'supplier_invoice' ? `supplier_${doc.kind}` : jl.source_type;
    const foreign = doc.currency_code !== baseCur.code;
    const digits = foreign ? (ledger.getCurrency(companyId, doc.currency_code)?.minor_unit_digits ?? 2) : baseCur.minor_unit_digits;
    const toBase = (m) => (!foreign || !doc.rate_e8 ? m : fx.toBaseMinor(m, doc.rate_e8, doc.rate_quote, digits, baseCur.minor_unit_digits));
    const dls = db.prepare(`SELECT * FROM ${t.lines} WHERE ${t.fk} = ?`).all(doc.id);
    const parts = [];
    for (const dl of dls) {
      if (!dl.tax_minor) continue;
      const link = lineTax(t.link, dl[t.linkCol]);
      if (link && link.account_id === jl.account_id) parts.push({ key: `coded|${link.tax_code_id}|${link.rate_bp}|${doc.currency_code}`, init: { section: 'coded', tax_code_id: link.tax_code_id, code: codeById.get(link.tax_code_id)?.code, type: codeById.get(link.tax_code_id)?.type, rate: link.rate_bp / 100, currency: doc.currency_code }, w: dl.tax_minor, net: dl.net_minor });
      else if (!link && jl.account_id === fallback) parts.push({ key: `free|${kind}|${doc.currency_code}`, init: { section: 'free_rate', kind, currency: doc.currency_code }, w: dl.tax_minor, net: dl.net_minor });
    }
    const shares = parts.length ? splitSigned(net, parts.map((p) => p.w)) : null;
    if (!shares) {
      add(`other|${jl.source_type}`, { section: 'other', source_type: jl.source_type }, net, orig, 0).documents.add(jl.source_id);
      continue;
    }
    const origShares = splitSigned(orig, parts.map((p) => p.w));
    parts.forEach((p, k) => {
      // The taxable base of a document is counted once per row.
      const once = `${p.key}|${jl.source_type}|${doc.id}|${k}`;
      const baseAmt = counted.has(once) ? 0 : t.sign * toBase(p.net);
      counted.add(once);
      add(p.key, { ...p.init }, shares[k], origShares[k], baseAmt).documents.add(`${jl.source_type}:${doc.id}`);
    });
  }
  const out = [...rows.values()].map((r) => ({ ...r, documents: r.documents.size }));
  const order = { coded: 0, free_rate: 1, other: 2 };
  out.sort((a, b) => order[a.section] - order[b.section] || String(a.code || a.kind || a.source_type).localeCompare(String(b.code || b.kind || b.source_type)) || (a.rate || 0) - (b.rate || 0) || String(a.currency).localeCompare(String(b.currency)));
  const codes = out.filter((r) => r.section === 'coded').map((r) => ({ ...r, base_minor: r.taxable_base_minor, tax_minor: r.tax_base_minor * (r.type === 'sales' ? 1 : -1) }));
  const sectionTotal = (s) => out.filter((r) => r.section === s).reduce((t, r) => t + r.tax_base_minor, 0);
  const ledgerTotal = accounts.reduce((t, a) => t + a.net_credit_minor, 0);
  const typeOf = new Map(codeRows.map((r) => [r.account_id, r.type]));
  const isSales = (a) => a.system_key === 'output_tax' || typeOf.get(a.account_id) === 'sales';
  const output = accounts.filter(isSales).reduce((t, a) => t + a.net_credit_minor, 0);
  const input = accounts.filter((a) => !isSales(a)).reduce((t, a) => t - a.net_credit_minor, 0);
  // Per account: ledger = documents + other (always explained) — the
  // documents-only column shows what manual postings changed.
  const reconciliation = accounts.map((a) => {
    const docs = jls.filter((l) => l.account_id === a.account_id && DOC[l.source_type]).reduce((t, l) => t + l.credit_minor - l.debit_minor, 0);
    const other = jls.filter((l) => l.account_id === a.account_id && !DOC[l.source_type]).reduce((t, l) => t + l.credit_minor - l.debit_minor, 0);
    return { account_id: a.account_id, code: a.code, ledger_net_credit_minor: a.net_credit_minor, documents_net_credit_minor: docs, other_net_credit_minor: other, difference_minor: a.net_credit_minor - docs, unexplained_minor: a.net_credit_minor - docs - other };
  });
  const totals = { ledger_net_credit_minor: ledgerTotal, coded_minor: sectionTotal('coded'), free_rate_minor: sectionTotal('free_rate'), other_minor: sectionTotal('other') };
  totals.unexplained_minor = ledgerTotal - totals.coded_minor - totals.free_rate_minor - totals.other_minor;
  return {
    from, to, base_currency: baseCur.code, accounts, rows: out, codes, totals, reconciliation,
    reconciled: totals.unexplained_minor === 0 && reconciliation.every((r) => r.unexplained_minor === 0),
    foreign_currency_rows: out.filter((r) => r.currency && r.currency !== baseCur.code).length,
    output_tax_minor: output, input_tax_minor: input, net_payable_minor: output - input, digits: baseCur.minor_unit_digits,
  };
}

module.exports = { MODES, getPriceMode, setPriceMode, requirePriceModeChosen, TaxError, hasTaxCodes, rateOn, getCode, listCodes, createCode, addRate, updateCode, resolve, split, linkLine, lineTax, clearDocumentLines, taxByAccount, taxReport };
