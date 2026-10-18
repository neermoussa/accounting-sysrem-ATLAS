// backend/lib/salesPosting.js
//
// Sales documents and the automatic postings of existing events (Prompt 2).
// Every journal entry goes through lib/ledger.js postEntry(); this file only
// decides WHICH accounts. docs/posting-map.md documents each event.
//
// Rounding policy (owner decision): every line is rounded to the currency's
// minor unit; the document total is the rounded exact total; any residue
// between the two goes to the `rounding_difference` system account so the
// entry balances exactly.
//
// Currency (Prompt 5): documents may be in any active currency; the rate is
// locked at posting and every line is converted exactly — see
// documentCurrency() / fxEntryLines().

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const documentNumbering = require('./documentNumbering');
const pricingEngine = require('./pricingEngine');
const { logAudit } = require('./auditLog');
const { checkpoint } = require('./faultInjection');
const fx = require('./fxRate');
const { toMinor, fromMinor, roundToMinor } = require('./ledgerCurrencies');

class SalesError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new SalesError(code, message, status, extra);
};

function owned(companyId, kind, id, opts) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
    throw err;
  }
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
const today = () => new Date().toISOString().slice(0, 10);
const actorOf = (a) => (a ? { id: a.id, name: a.name } : null);
const roundMinor = (x) => roundToMinor(x, 0);

function base(companyId) {
  return ledger.getBaseCurrency(companyId);
}

function systemAccount(companyId, key) {
  const a = ledger.getAccountBySystemKey(companyId, key);
  if (!a || !a.is_active) fail('missing_system_account', `الحساب النظامي ${key} غير معرّف — طبّق قالب دليل الحسابات`, 409);
  return a.id;
}

// Document currency (Prompt 5): base or any active currency. The rate is
// fixed when the document is POSTED (lib/currency.js documentRate).
function documentCurrency(companyId, code) {
  const b = base(companyId);
  const c = String(code || b.code).toUpperCase();
  if (c === b.code) return b;
  const cur = ledger.getCurrency(companyId, c);
  if (!cur || !cur.is_active) fail('invalid_currency', 'العملة غير معرّفة');
  return cur;
}

// Ledger lines for a document in currency `cur` at `rate`: parts in the
// document currency are converted line by line (BigInt, one rounding);
// parts marked base:true (COGS) are already base. `baseOverride` fixes the
// base amount of chosen parts (closing an invoice exactly); the residue of
// all roundings goes to rounding_difference so the entry balances exactly.
function fxEntryLines(companyId, parts, cur, rate, { baseOverride } = {}) {
  const b = base(companyId);
  const grouped = entryLines(parts);
  if (cur.code === b.code) return { lines: grouped, baseOf: (pred) => grouped.filter(pred).reduce((s, l) => s + l.debitMinor + l.creditMinor, 0) };
  const out = grouped.map((l) => {
    if (l.base) return l;
    const orig = l.debitMinor || l.creditMinor;
    const override = baseOverride ? baseOverride(l) : null;
    const baseMinor = override ?? fx.toBaseMinor(orig, rate.rateE8, rate.quote, cur.minor_unit_digits, b.minor_unit_digits);
    return {
      ...l, currencyCode: cur.code, amountOriginalMinor: orig, rateE8: rate.rateE8, rateQuote: rate.quote,
      debitMinor: l.debitMinor ? baseMinor : 0, creditMinor: l.creditMinor ? baseMinor : 0,
    };
  }).filter((l) => l.debitMinor || l.creditMinor);
  const diff = out.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
  if (diff) {
    out.push({ accountId: systemAccount(companyId, 'rounding_difference'), debitMinor: diff < 0 ? -diff : 0, creditMinor: diff > 0 ? diff : 0, memo: 'فرق تقريب تحويل العملات', partyType: null, partyId: null });
  }
  return { lines: out, baseOf: (pred) => out.filter(pred).reduce((s, l) => s + l.debitMinor + l.creditMinor, 0) };
}

function currencyRate(companyId, code, date, { exchangeRate, rateQuote } = {}, actor) {
  const currency = require('./currency');
  try {
    return currency.documentRate(companyId, code, date, { override: { rate: exchangeRate, rateQuote }, actor });
  } catch (err) {
    if (err instanceof currency.CurrencyError) {
      const { code: c, status, message, ...extra } = err;
      fail(c, message, status, extra);
    }
    throw err;
  }
}

function issueNumber(companyId, type, prefix) {
  if (!db.prepare('SELECT 1 FROM document_number_sequences WHERE company_id = ? AND document_type = ?').get(companyId, type)) {
    documentNumbering.setConfig(companyId, type, { prefix });
  }
  return documentNumbering.issueNext(companyId, type);
}

// Cost of one unit (in the sold unit) at this moment, minor units of base.
// Basic products.cost_price for now; Prompt 8 replaces this with real
// inventory valuation.
function unitCostMinor(product, unitKey, digits) {
  if (!product || product.cost_price == null) return null;
  let cost = product.cost_price;
  const baseUnit = db.prepare('SELECT * FROM product_units WHERE product_id = ? AND is_base = 1').get(product.id);
  if (baseUnit && unitKey) {
    const f = db.prepare('SELECT factor FROM product_units WHERE product_id = ? AND unit_key = ?').get(product.id, unitKey)?.factor;
    if (f) cost = product.cost_price * (f / baseUnit.factor);
  }
  return roundToMinor(cost, digits);
}

function revenueAccountFor(companyId, product) {
  if (product?.category) {
    const row = db
      .prepare(
        `SELECT pca.revenue_account_id FROM product_category_accounts pca JOIN accounts a ON a.id = pca.revenue_account_id
         WHERE pca.company_id = ? AND pca.category = ? AND a.is_active = 1 AND a.is_postable = 1`
      )
      .get(companyId, product.category);
    if (row) return row.revenue_account_id;
  }
  return systemAccount(companyId, 'sales_revenue');
}

function parseQty(v, n) {
  const q = Number(v);
  if (!Number.isFinite(q) || q <= 0) fail('invalid_qty', `السطر ${n}: الكمية يجب أن تكون أكبر من صفر`);
  return Math.round(q * 1000) / 1000;
}

function parseTaxBp(v, n) {
  if (v === undefined || v === null || v === '') return 0;
  const bp = toMinor(v, 2); // "5" -> 500 basis points, "12.5" -> 1250
  if (bp < 0 || bp > 10000) fail('invalid_tax_rate', `السطر ${n}: نسبة الضريبة غير صالحة`);
  return bp;
}

// Applies the rounding policy to a set of { exactNet, exactTax } values.
function roundDocument(lines) {
  let exact = 0;
  let sumNet = 0;
  let sumTax = 0;
  for (const l of lines) {
    l.net_minor = roundMinor(l.exactNet);
    l.tax_minor = roundMinor(l.exactTax);
    exact += l.exactNet + l.exactTax;
    sumNet += l.net_minor;
    sumTax += l.tax_minor;
  }
  const total = roundMinor(exact);
  return { subtotal: sumNet, tax: sumTax, total, rounding: total - sumNet - sumTax };
}

// ---------------------------------------------------------------------
// Sales invoices
// ---------------------------------------------------------------------

function buildInvoiceLines(companyId, shop, rawLines, digits, currencyCode, date) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) fail('lines_required', 'الفاتورة تحتاج سطرًا واحدًا على الأقل');
  return rawLines.map((raw, i) => {
    const n = i + 1;
    const product = raw.productId ? owned(companyId, 'product', raw.productId, { active: true }) : null;
    const description = String(raw.description || product?.name || '').trim();
    if (!description) fail('description_required', `السطر ${n}: اختر مادة أو اكتب وصفًا`);
    const qty = parseQty(raw.qty, n);
    const unitKey = raw.unitKey || null;
    let unitPrice;
    let priceSource = 'manual';
    if (raw.unitPrice !== undefined && raw.unitPrice !== null && raw.unitPrice !== '') {
      unitPrice = toMinor(raw.unitPrice, digits);
    } else if (product) {
      // Reuse the existing pricing engine (customer/qty/region prices,
      // campaigns). It returns major units in the requested currency.
      const priced = pricingEngine.priceLine(companyId, { productId: product.id, unitKey, qty, shopId: shop.id, region: shop.region, currency: currencyCode });
      if (priced.blocked) fail('pricing_blocked', `السطر ${n}: لا يمكن تسعير المادة (${priced.reason})`, 400, { line: n, reason: priced.reason });
      unitPrice = roundToMinor(priced.discountedUnitPrice, digits);
      priceSource = priced.priceSource || 'pricing_engine';
    } else {
      fail('price_required', `السطر ${n}: السعر مطلوب`);
    }
    if (unitPrice < 0) fail('invalid_price', `السطر ${n}: السعر غير صالح`);
    const discount = raw.discount ? toMinor(raw.discount, digits) : 0;
    const gross = unitPrice * qty;
    if (discount < 0 || discount > gross) fail('invalid_discount', `السطر ${n}: الخصم غير صالح`);
    // Prompt 10: a tax code gives the rate on the invoice date, its account
    // and (company price mode) whether the price includes the tax. Without
    // a code: the free per-line rate added on top, exactly as before.
    const taxCode = raw.taxCodeId ? require('./taxCodes').resolve(companyId, raw.taxCodeId, 'sales', date || today(), n) : null;
    const taxBp = taxCode ? taxCode.rate_bp : parseTaxBp(raw.taxRate, n);
    const amounts = taxCode ? require('./taxCodes').split(gross - discount, taxCode) : { exactNet: gross - discount, exactTax: ((gross - discount) * taxBp) / 10000 };
    const exactNet = amounts.exactNet;
    return {
      line_no: n,
      product_id: product?.id ?? null,
      description,
      qty,
      unit_key: unitKey,
      unit_price_minor: unitPrice,
      discount_minor: discount,
      tax_rate_bp: taxBp,
      exactNet,
      exactTax: amounts.exactTax,
      _tax: taxCode,
      revenue_account_id: revenueAccountFor(companyId, product),
      unit_cost_minor: unitCostMinor(product, unitKey, base(companyId).minor_unit_digits), // cost is base money
      price_source: priceSource,
    };
  });
}

function getInvoice(companyId, id) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE company_id = ? AND id = ?').get(companyId, id);
  if (!inv) return null;
  // Amounts are in the document currency (Prompt 5).
  const digits = documentCurrency(companyId, inv.currency_code).minor_unit_digits;
  const f = (m) => fromMinor(m, digits);
  const lines = db
    .prepare(
      `SELECT l.*, a.code AS revenue_account_code, a.name_ar AS revenue_account_name,
         COALESCE((SELECT SUM(cl.qty) FROM sales_credit_note_lines cl WHERE cl.invoice_line_id = l.id), 0) AS credited_qty
       FROM sales_invoice_lines l LEFT JOIN accounts a ON a.id = l.revenue_account_id WHERE l.invoice_id = ? ORDER BY l.line_no`
    )
    .all(id)
    .map((l) => {
      const out = { ...l, unit_price: f(l.unit_price_minor), discount: f(l.discount_minor), net: f(l.net_minor), tax: f(l.tax_minor), tax_rate: fromMinor(l.tax_rate_bp, 2) };
      // Prompt 10: only coded lines carry these keys (uncoded responses unchanged).
      const tx = require('./taxCodes').lineTax('sales_invoice_line', l.id);
      if (tx) Object.assign(out, { tax_code_id: tx.tax_code_id, tax_inclusive: tx.inclusive });
      return out;
    });
  const shop = db.prepare('SELECT id, name, phone, address FROM shops WHERE id = ?').get(inv.shop_id);
  const credits = db.prepare('SELECT id, credit_note_number, note_date, total_minor FROM sales_credit_notes WHERE invoice_id = ? ORDER BY id').all(id);
  const entry = inv.journal_entry_id ? db.prepare('SELECT id, entry_number, status FROM journal_entries WHERE id = ?').get(inv.journal_entry_id) : null;
  return {
    ...inv,
    shop,
    lines,
    credit_notes: credits.map((c) => ({ ...c, total: f(c.total_minor) })),
    journal_entry: entry,
    subtotal: f(inv.subtotal_minor),
    discount: f(inv.discount_minor),
    tax: f(inv.tax_minor),
    rounding: f(inv.rounding_minor),
    total: f(inv.total_minor),
    credited: f(inv.credited_minor),
    open: f(inv.total_minor - inv.credited_minor),
    base_currency: base(companyId).code,
    exchange_rate: inv.rate_e8 ? fx.formatRate(inv.rate_e8) : null,
    total_base: inv.total_base_minor !== null && inv.total_base_minor !== undefined ? fromMinor(inv.total_base_minor, base(companyId).minor_unit_digits) : null,
  };
}

function listInvoices(companyId, { status, shopId, from, to, q, limit } = {}) {
  const where = ['i.company_id = ?'];
  const p = [companyId];
  if (status) { where.push('i.status = ?'); p.push(String(status)); }
  if (shopId) { where.push('i.shop_id = ?'); p.push(Number(shopId)); }
  if (from) { where.push('i.invoice_date >= ?'); p.push(String(from)); }
  if (to) { where.push('i.invoice_date <= ?'); p.push(String(to)); }
  if (q) { where.push('(i.invoice_number LIKE ? OR s.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  const digits = base(companyId).minor_unit_digits;
  return db
    .prepare(
      `SELECT i.*, s.name AS shop_name FROM sales_invoices i JOIN shops s ON s.id = i.shop_id
       WHERE ${where.join(' AND ')} ORDER BY i.invoice_date DESC, i.id DESC LIMIT ?`
    )
    .all(...p, Math.min(Number(limit) || 200, 500))
    .map((i) => {
      const dd = i.currency_code === base(companyId).code ? digits : documentCurrency(companyId, i.currency_code).minor_unit_digits;
      return { ...i, total: fromMinor(i.total_minor, dd), open: fromMinor(i.total_minor - i.credited_minor, dd) };
    });
}

function writeInvoiceLines(companyId, invoiceId, lines) {
  require('./taxCodes').clearDocumentLines('sales_invoice_line', db.prepare('SELECT id FROM sales_invoice_lines WHERE invoice_id = ?').all(invoiceId).map((r) => r.id));
  db.prepare('DELETE FROM sales_invoice_lines WHERE invoice_id = ?').run(invoiceId);
  const ins = db.prepare(
    `INSERT INTO sales_invoice_lines (company_id, invoice_id, line_no, product_id, description, qty, unit_key, unit_price_minor,
       discount_minor, tax_rate_bp, net_minor, tax_minor, revenue_account_id, unit_cost_minor, price_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const l of lines) {
    const r = ins.run(companyId, invoiceId, l.line_no, l.product_id, l.description, l.qty, l.unit_key, l.unit_price_minor, l.discount_minor,
      l.tax_rate_bp, l.net_minor, l.tax_minor, l.revenue_account_id, l.unit_cost_minor, l.price_source);
    if (l._tax) require('./taxCodes').linkLine(companyId, 'sales_invoice_line', Number(r.lastInsertRowid), l._tax);
  }
}

function invoiceHeader(companyId, input, existing) {
  const shop = owned(companyId, 'shop', input.shopId ?? existing?.shop_id, { active: !existing });
  const date = input.invoiceDate ?? existing?.invoice_date ?? today();
  if (!isValidDate(date)) fail('invalid_date', 'تاريخ الفاتورة غير صالح');
  const due = input.dueDate !== undefined ? input.dueDate || null : existing?.due_date ?? null;
  if (due && (!isValidDate(due) || due < date)) fail('invalid_due_date', 'تاريخ الاستحقاق غير صالح');
  const cur = documentCurrency(companyId, input.currencyCode ?? existing?.currency_code);
  const branchId = input.branchId !== undefined ? (input.branchId ? owned(companyId, 'branch', input.branchId, { active: true }).id : null) : existing?.branch_id ?? null;
  const warehouseId = input.warehouseId !== undefined ? (input.warehouseId ? owned(companyId, 'warehouse', input.warehouseId).id : null) : existing?.warehouse_id ?? null;
  let orderId = existing?.order_id ?? null;
  if (input.orderId !== undefined) {
    orderId = null;
    if (input.orderId) {
      const order = owned(companyId, 'order', input.orderId, { active: true });
      if (order.shop_id !== shop.id) fail('order_shop_mismatch', 'الطلب لا يخص هذا الزبون');
      const clash = db
        .prepare("SELECT invoice_number FROM sales_invoices WHERE company_id = ? AND order_id = ? AND status <> 'cancelled' AND id <> ?")
        .get(companyId, order.id, existing?.id ?? 0);
      if (clash) fail('order_already_invoiced', `هذا الطلب مفوتر مسبقًا ${clash.invoice_number || '(مسودة)'}`, 409);
      orderId = order.id;
    }
  }
  return { shop, date, due, cur, branchId, warehouseId, orderId, notes: input.notes !== undefined ? input.notes || null : existing?.notes ?? null };
}

function createInvoice(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const h = invoiceHeader(companyId, input, null);
    const lines = buildInvoiceLines(companyId, h.shop, input.lines, h.cur.minor_unit_digits, h.cur.code, h.date);
    const t = roundDocument(lines);
    const disc = lines.reduce((s, l) => s + l.discount_minor, 0);
    const id = Number(
      db
        .prepare(
          `INSERT INTO sales_invoices (company_id, shop_id, branch_id, warehouse_id, order_id, invoice_date, due_date, currency_code,
             subtotal_minor, discount_minor, tax_minor, rounding_minor, total_minor, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, h.shop.id, h.branchId, h.warehouseId, h.orderId, h.date, h.due, h.cur.code, t.subtotal + disc, disc, t.tax, t.rounding, t.total, h.notes, actor?.id ?? null)
        .lastInsertRowid
    );
    writeInvoiceLines(companyId, id, lines);
    const after = getInvoice(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'sales.invoice.create', entityType: 'sales_invoice', entityId: id, shopId: h.shop.id, before: null, after });
    return after;
  });
}

function requireDraftInvoice(companyId, id) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE company_id = ? AND id = ?').get(companyId, id);
  if (!inv) fail('not_found', 'الفاتورة غير موجودة', 404);
  if (inv.status !== 'draft') fail('invoice_not_draft', 'الفاتورة المرحّلة لا تُعدّل — استخدم إشعار دائن', 409);
  return inv;
}

function updateInvoice(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const existing = requireDraftInvoice(companyId, id);
    const before = getInvoice(companyId, id);
    const h = invoiceHeader(companyId, input, existing);
    let t = { subtotal: existing.subtotal_minor - existing.discount_minor, tax: existing.tax_minor, rounding: existing.rounding_minor, total: existing.total_minor };
    let disc = existing.discount_minor;
    if (input.lines !== undefined) {
      const lines = buildInvoiceLines(companyId, h.shop, input.lines, h.cur.minor_unit_digits, h.cur.code, h.date);
      t = roundDocument(lines);
      disc = lines.reduce((s, l) => s + l.discount_minor, 0);
      writeInvoiceLines(companyId, id, lines);
    }
    db.prepare(
      `UPDATE sales_invoices SET shop_id = ?, branch_id = ?, warehouse_id = ?, order_id = ?, invoice_date = ?, due_date = ?, notes = ?,
         subtotal_minor = ?, discount_minor = ?, tax_minor = ?, rounding_minor = ?, total_minor = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(h.shop.id, h.branchId, h.warehouseId, h.orderId, h.date, h.due, h.notes, t.subtotal + disc, disc, t.tax, t.rounding, t.total, id);
    const after = getInvoice(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'sales.invoice.update', entityType: 'sales_invoice', entityId: id, shopId: h.shop.id, before, after });
    return after;
  });
}

function deleteInvoice(companyId, id, actor) {
  return ledger.transaction(() => {
    requireDraftInvoice(companyId, id);
    const before = getInvoice(companyId, id);
    db.prepare('DELETE FROM sales_invoice_lines WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM sales_invoices WHERE id = ?').run(id);
    logAudit({ companyId, actor: actorOf(actor), action: 'sales.invoice.delete', entityType: 'sales_invoice', entityId: id, shopId: before.shop_id, before, after: null });
    return { ok: true };
  });
}

// Groups { accountId, side, amount } into ledger lines, skipping zeros.
function entryLines(parts) {
  const map = new Map();
  for (const p of parts) {
    if (!p.amount) continue;
    const key = `${p.accountId}|${p.side}|${p.partyType || ''}|${p.partyId || ''}|${p.base ? 'b' : ''}`;
    const cur = map.get(key) || { ...p, amount: 0 };
    cur.amount += p.amount;
    map.set(key, cur);
  }
  return [...map.values()]
    .filter((p) => p.amount !== 0)
    .map((p) => {
      // A negative amount on one side is the same amount on the other.
      const side = p.amount < 0 ? (p.side === 'debit' ? 'credit' : 'debit') : p.side;
      const amt = Math.abs(p.amount);
      return {
        accountId: p.accountId,
        debitMinor: side === 'debit' ? amt : 0,
        creditMinor: side === 'credit' ? amt : 0,
        partyType: p.partyType || null,
        partyId: p.partyId || null,
        memo: p.memo || null,
        ...(p.base ? { base: true } : {}),
      };
    });
}

function cogsParts(companyId, lines, { reverse }) {
  const cost = lines.reduce((s, l) => s + (l.unit_cost_minor ? roundMinor(l.unit_cost_minor * l.qty) : 0), 0);
  if (!cost) return [];
  const cogs = systemAccount(companyId, 'cogs');
  const inv = systemAccount(companyId, 'inventory');
  return reverse
    ? [{ accountId: inv, side: 'debit', amount: cost, memo: 'إعادة البضاعة إلى المخزون', base: true }, { accountId: cogs, side: 'credit', amount: cost, base: true }]
    : [{ accountId: cogs, side: 'debit', amount: cost, memo: 'تكلفة البضاعة المباعة', base: true }, { accountId: inv, side: 'credit', amount: cost, base: true }];
}

function postInvoice(companyId, id, actor, { overrideReason, exchangeRate, rateQuote } = {}) {
  return ledger.transaction(() => {
    const inv = requireDraftInvoice(companyId, id);
    if (inv.total_minor <= 0) fail('zero_total', 'لا يمكن ترحيل فاتورة بقيمة صفر');
    require('./taxCodes').requirePriceModeChosen(companyId, inv.tax_minor);
    const cur = documentCurrency(companyId, inv.currency_code);
    // Prompt 5: the rate is locked here (history rate for the invoice date,
    // or a typed override with override_exchange_rate).
    const rate = currencyRate(companyId, cur.code, inv.invoice_date, { exchangeRate, rateQuote }, actor);
    const totalBase = cur.code === base(companyId).code ? inv.total_minor : fx.toBaseMinor(inv.total_minor, rate.rateE8, rate.quote, cur.minor_unit_digits, base(companyId).minor_unit_digits);
    const shop = owned(companyId, 'shop', inv.shop_id);
    // Credit control (Prompt 3): warn or block per company setting; a block
    // can be overridden only with override_credit_limit and a reason.
    const credit = require('./receivables').invoiceCreditCheck(companyId, shop, totalBase, { user: actor, overrideReason });
    const lines = db.prepare('SELECT * FROM sales_invoice_lines WHERE invoice_id = ? ORDER BY line_no').all(id);
    const ar = systemAccount(companyId, 'ar_control');
    const number = issueNumber(companyId, 'SI', 'SI-');
    const parts = [{ accountId: ar, side: 'debit', amount: inv.total_minor, partyType: 'customer', partyId: inv.shop_id }];
    for (const l of lines) parts.push({ accountId: l.revenue_account_id || systemAccount(companyId, 'sales_revenue'), side: 'credit', amount: l.net_minor });
    // Tax per account: coded lines to their tax code's account, the rest to
    // output_tax (a company without tax codes: one output_tax line, as before).
    if (inv.tax_minor) for (const t of require('./taxCodes').taxByAccount('sales_invoice_line', lines, systemAccount(companyId, 'output_tax'))) parts.push({ accountId: t.accountId, side: 'credit', amount: t.amount });
    if (inv.rounding_minor) parts.push({ accountId: systemAccount(companyId, 'rounding_difference'), side: 'credit', amount: inv.rounding_minor, memo: 'فرق التقريب' });
    // Prompt 8: with the stock ledger, COGS = the 'sale' moves' valuation
    // cost out of the selling holder; without it, products.cost_price.
    const si = require('./stockLedger').isActive(companyId) ? require('./stockDocs').salesIssue(companyId, inv, lines, actor) : null;
    parts.push(...(si ? si.parts : cogsParts(companyId, lines, { reverse: false })));
    const built = fxEntryLines(companyId, parts, cur, rate);
    const entry = ledger.postEntry(
      companyId,
      { date: inv.invoice_date, description: `فاتورة مبيعات ${number}`, sourceType: 'sales_invoice', sourceId: id, branchId: inv.branch_id, lines: built.lines },
      actor
    );
    if (si) {
      if (si.moveIds.length) db.prepare(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${si.moveIds.map(() => '?').join(',')})`).run(entry.id, ...si.moveIds);
      for (const [lineId, uc] of si.unitCosts) db.prepare('UPDATE sales_invoice_lines SET unit_cost_minor = ? WHERE id = ?').run(uc, lineId);
    }
    checkpoint('sales.invoice.post.after_entry');
    const arBase = built.baseOf((l) => l.accountId === ar && l.partyType === 'customer');
    db.prepare(
      `UPDATE sales_invoices SET status = 'posted', invoice_number = ?, journal_entry_id = ?, posted_by = ?, posted_at = datetime('now'), updated_at = datetime('now'),
         rate_e8 = ?, rate_quote = ?, total_base_minor = ?
       WHERE id = ? AND status = 'draft'`
    ).run(number, entry.id, actor?.id ?? null, rate.rateE8, rate.quote, arBase, id);
    const after = getInvoice(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'sales.invoice.post', entityType: 'sales_invoice', entityId: id, shopId: inv.shop_id, before: { status: 'draft' }, after: { ...after, credit_check: credit.exceeded ? credit : undefined } });
    return credit.exceeded ? { ...after, credit_check: credit } : after;
  });
}

// ---------------------------------------------------------------------
// Draft invoice from a delivered order (Prompt 3, item 1)
// ---------------------------------------------------------------------

const INVOICEABLE_ORDER_STATUSES = ['delivered', 'paid'];

function orderInvoiceLines(order) {
  const ordered = JSON.parse(order.items_json || '[]');
  const delivery = db.prepare('SELECT delivered_items_json FROM order_deliveries WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(order.id);
  const delivered = delivery ? JSON.parse(delivery.delivered_items_json || '[]') : null;
  const lines = [];
  for (const it of ordered) {
    let qty = Number(it.qty);
    if (delivered) {
      const d = delivered.find((x) => (x.product_id && x.product_id === it.product_id) || x.product_name === it.product_name);
      // Free (promotion) lines follow the paid line they belong to; a paid
      // line that was not delivered at all is left off the invoice.
      if (!it.is_free) qty = Number(d?.qty ?? 0);
      else if (d) qty = Number(d.qty);
    }
    if (!(qty > 0)) continue;
    lines.push({
      productId: it.product_id || null,
      description: it.product_name || '',
      qty,
      unitKey: it.unit_key || null,
      unitPrice: it.is_free ? '0' : String(it.unit_price ?? (it.qty ? Number(it.line_total || 0) / Number(it.qty) : 0)),
      isFree: !!it.is_free,
    });
  }
  return lines;
}

function listInvoiceableOrders(companyId, { shopId } = {}) {
  const p = [companyId, ...INVOICEABLE_ORDER_STATUSES];
  let extra = '';
  if (shopId) { extra = ' AND o.shop_id = ?'; p.push(Number(shopId)); }
  return db
    .prepare(
      `SELECT o.id, o.shop_id, s.name AS shop_name, o.order_date, o.status, o.total_value, o.delivered_at FROM orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.company_id = ? AND o.status IN (?, ?) AND o.deleted_at IS NULL${extra}
         AND NOT EXISTS (SELECT 1 FROM sales_invoices i WHERE i.order_id = o.id AND i.status <> 'cancelled')
       ORDER BY o.delivered_at DESC, o.id DESC LIMIT 300`
    )
    .all(...p);
}

function createInvoiceFromOrder(companyId, orderId, actor) {
  const order = owned(companyId, 'order', orderId, { active: true });
  if (!INVOICEABLE_ORDER_STATUSES.includes(order.status)) fail('order_not_delivered', 'يمكن الفوترة من طلب مُسلَّم فقط', 409, { order_status: order.status });
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(order.shop_id);
  const lines = orderInvoiceLines(order).map(({ isFree, unitPrice, ...l }) => ({
    ...l,
    // Prices come from the order as agreed with the customer (not re-priced).
    unitPrice: String(roundToMinor(Number(unitPrice), base(companyId).minor_unit_digits) / 10 ** base(companyId).minor_unit_digits),
    description: isFree ? `${l.description} (مجاني)` : l.description,
  }));
  if (!lines.length) fail('nothing_delivered', 'لا توجد كميات مسلّمة في هذا الطلب');
  const inv = createInvoice(
    companyId,
    { shopId: shop.id, orderId: order.id, invoiceDate: today(), notes: `من الطلب رقم ${order.id} بتاريخ ${order.order_date}`, lines },
    actor
  );
  logAudit({ companyId, actor: actorOf(actor), action: 'sales.invoice.from_order', entityType: 'sales_invoice', entityId: inv.id, shopId: shop.id, before: null, after: { order_id: order.id } });
  return inv;
}

// ---------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------

function getCreditNote(companyId, id) {
  const cn = db.prepare('SELECT * FROM sales_credit_notes WHERE company_id = ? AND id = ?').get(companyId, id);
  if (!cn) return null;
  const digits = documentCurrency(companyId, cn.currency_code).minor_unit_digits;
  const f = (m) => fromMinor(m, digits);
  const lines = db
    .prepare('SELECT * FROM sales_credit_note_lines WHERE credit_note_id = ? ORDER BY line_no')
    .all(id)
    .map((l) => ({ ...l, unit_price: f(l.unit_price_minor), net: f(l.net_minor), tax: f(l.tax_minor) }));
  return {
    ...cn,
    shop: db.prepare('SELECT id, name FROM shops WHERE id = ?').get(cn.shop_id),
    invoice: cn.invoice_id ? db.prepare('SELECT id, invoice_number FROM sales_invoices WHERE id = ?').get(cn.invoice_id) : null,
    journal_entry: cn.journal_entry_id ? db.prepare('SELECT id, entry_number FROM journal_entries WHERE id = ?').get(cn.journal_entry_id) : null,
    lines,
    subtotal: f(cn.subtotal_minor),
    tax: f(cn.tax_minor),
    rounding: f(cn.rounding_minor),
    total: f(cn.total_minor),
  };
}

function listCreditNotes(companyId, { shopId } = {}) {
  const digits = base(companyId).minor_unit_digits;
  const p = [companyId];
  let where = 'c.company_id = ?';
  if (shopId) { where += ' AND c.shop_id = ?'; p.push(Number(shopId)); }
  return db
    .prepare(
      `SELECT c.*, s.name AS shop_name, i.invoice_number FROM sales_credit_notes c JOIN shops s ON s.id = c.shop_id
       LEFT JOIN sales_invoices i ON i.id = c.invoice_id WHERE ${where} ORDER BY c.note_date DESC, c.id DESC LIMIT 500`
    )
    .all(...p)
    .map((c) => ({ ...c, total: fromMinor(c.total_minor, digits) }));
}

// input: { invoiceId?, shopId, date, reason, restock, returnRequestId?,
//   lines: [{ invoiceLineId, qty }] (against an invoice) or
//          [{ productId?, description, qty, unitPrice, taxRate }] (free) }
function createCreditNote(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const b = base(companyId);
    const date = input.date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    let invoice = null;
    if (input.invoiceId) {
      invoice = owned(companyId, 'sales_invoice', input.invoiceId);
      if (invoice.status !== 'posted') fail('invoice_not_posted', 'لا يمكن إصدار إشعار دائن إلا لفاتورة مرحّلة', 409);
    }
    // Prompt 5: a credit note against an invoice is in the invoice's
    // currency at the invoice's locked rate (no FX on a credit). Standalone
    // credit notes are base currency.
    const cur = invoice ? documentCurrency(companyId, invoice.currency_code) : b;
    const rate = invoice && invoice.rate_e8 ? { rateE8: invoice.rate_e8, quote: invoice.rate_quote } : { rateE8: Number(fx.SCALE), quote: 'base_per_foreign' };
    const digits = cur.minor_unit_digits;
    const shopId = invoice ? invoice.shop_id : owned(companyId, 'shop', input.shopId).id;
    if (invoice && input.shopId && Number(input.shopId) !== invoice.shop_id) fail('invoice_shop_mismatch', 'الفاتورة لا تخص هذا الزبون');
    const rawLines = Array.isArray(input.lines) ? input.lines : [];
    if (!rawLines.length) fail('lines_required', 'إشعار الدائن يحتاج سطرًا واحدًا على الأقل');

    const lines = rawLines.map((raw, i) => {
      const n = i + 1;
      const qty = parseQty(raw.qty, n);
      if (invoice) {
        const il = db.prepare('SELECT * FROM sales_invoice_lines WHERE id = ? AND invoice_id = ?').get(Number(raw.invoiceLineId), invoice.id);
        if (!il) fail('invalid_invoice_line', `السطر ${n}: سطر الفاتورة غير موجود`);
        const credited = db.prepare('SELECT COALESCE(SUM(qty), 0) q FROM sales_credit_note_lines WHERE invoice_line_id = ?').get(il.id).q;
        if (qty > il.qty - credited + 1e-9) fail('qty_exceeds_invoice', `السطر ${n}: الكمية أكبر من المتبقي في الفاتورة (${il.qty - credited})`);
        // A tax-inclusive coded line credits its own net and tax pro rata.
        const ilTax = require('./taxCodes').lineTax('sales_invoice_line', il.id);
        const exactNet = ilTax?.inclusive ? (il.net_minor * qty) / il.qty : il.unit_price_minor * qty - (il.discount_minor * qty) / il.qty;
        return {
          line_no: n, invoice_line_id: il.id, product_id: il.product_id, description: il.description, qty,
          unit_price_minor: il.unit_price_minor, tax_rate_bp: il.tax_rate_bp, exactNet, exactTax: ilTax?.inclusive ? (il.tax_minor * qty) / il.qty : (exactNet * il.tax_rate_bp) / 10000,
          unit_cost_minor: il.unit_cost_minor, _tax: ilTax,
        };
      }
      const product = raw.productId ? owned(companyId, 'product', raw.productId) : null;
      const description = String(raw.description || product?.name || '').trim();
      if (!description) fail('description_required', `السطر ${n}: الوصف مطلوب`);
      const unitPrice = raw.unitPriceMinor !== undefined ? Number(raw.unitPriceMinor) : toMinor(raw.unitPrice, digits);
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) fail('invalid_price', `السطر ${n}: السعر غير صالح`);
      const taxBp = parseTaxBp(raw.taxRate, n);
      const exactNet = raw.exactNet !== undefined ? raw.exactNet : unitPrice * qty;
      return {
        line_no: n, invoice_line_id: null, product_id: product?.id ?? null, description, qty, unit_price_minor: unitPrice,
        tax_rate_bp: taxBp, exactNet, exactTax: (exactNet * taxBp) / 10000, unit_cost_minor: unitCostMinor(product, null, b.minor_unit_digits),
      };
    });
    const t = roundDocument(lines);
    require('./taxCodes').requirePriceModeChosen(companyId, t.tax);
    if (t.total <= 0) fail('zero_total', 'قيمة إشعار الدائن صفر');
    if (invoice) {
      // A credit note can't credit more than is still open on the invoice;
      // money already received against it must be un-allocated first (it
      // then stays on the customer's account as an unallocated credit).
      const open = require('./receivables').invoiceOpenMinor(invoice);
      if (t.total > open) fail('exceeds_invoice_open', `إشعار الدائن (${fromMinor(t.total, digits)}) أكبر من المتبقي على الفاتورة (${fromMinor(open, digits)}) — ألغِ تخصيص المقبوضات أولًا`, 409, { open_minor: open });
    }
    // Closing the invoice's last open amount relieves exactly the base it
    // still carries, so no base dust stays on a settled foreign invoice.
    // (Computed before this credit note row exists.)
    const closeBase = invoice && t.total === require('./receivables').invoiceOpenMinor(invoice) ? require('./currency').invoiceBaseOpen(invoice) : null;
    const restock = !!input.restock;
    const number = issueNumber(companyId, 'CN', 'CN-');
    const id = Number(
      db
        .prepare(
          `INSERT INTO sales_credit_notes (company_id, credit_note_number, shop_id, invoice_id, return_request_id, note_date, currency_code, reason,
             restock, subtotal_minor, tax_minor, rounding_minor, total_minor, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, number, shopId, invoice?.id ?? null, input.returnRequestId ?? null, date, cur.code, input.reason || null, restock ? 1 : 0,
          t.subtotal, t.tax, t.rounding, t.total, actor?.id ?? null)
        .lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO sales_credit_note_lines (company_id, credit_note_id, line_no, invoice_line_id, product_id, description, qty, unit_price_minor,
         tax_rate_bp, net_minor, tax_minor, unit_cost_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      const r = ins.run(companyId, id, l.line_no, l.invoice_line_id, l.product_id, l.description, l.qty, l.unit_price_minor, l.tax_rate_bp, l.net_minor, l.tax_minor, l.unit_cost_minor);
      l.id = Number(r.lastInsertRowid);
      if (l._tax) require('./taxCodes').linkLine(companyId, 'sales_credit_note_line', l.id, l._tax);
    }

    const parts = [
      { accountId: systemAccount(companyId, 'sales_returns'), side: 'debit', amount: t.subtotal },
      ...(t.tax ? require('./taxCodes').taxByAccount('sales_credit_note_line', lines, systemAccount(companyId, 'output_tax')).map((x) => ({ accountId: x.accountId, side: 'debit', amount: x.amount })) : [{ accountId: systemAccount(companyId, 'output_tax'), side: 'debit', amount: 0 }]),
      { accountId: systemAccount(companyId, 'rounding_difference'), side: 'debit', amount: t.rounding, memo: 'فرق التقريب' },
      { accountId: systemAccount(companyId, 'ar_control'), side: 'credit', amount: t.total, partyType: 'customer', partyId: shopId },
    ];
    // Prompt 8: with the stock ledger a restock goes back into the holder
    // the sale left from, at the sale's cost; a return request's credit note
    // carries no inventory leg (its restock move posts it — stockDocs.returnRestock).
    const stockOn = require('./stockLedger').isActive(companyId);
    let sr = null;
    if (restock && stockOn) {
      if (!input.returnRequestId) {
        const withUnits = lines.map((l) => ({ ...l, unit_key: l.unit_key ?? (l.invoice_line_id ? db.prepare('SELECT unit_key FROM sales_invoice_lines WHERE id = ?').get(l.invoice_line_id)?.unit_key : null) }));
        sr = require('./stockDocs').salesReturn(companyId, { date, lines: withUnits, sourceId: id }, actor);
        parts.push(...sr.parts);
      }
    } else if (restock) parts.push(...cogsParts(companyId, lines, { reverse: true }));
    const arId = systemAccount(companyId, 'ar_control');
    const built = fxEntryLines(companyId, parts, cur, rate, {
      baseOverride: closeBase !== null ? (l) => (l.accountId === arId && l.partyType === 'customer' ? closeBase : null) : null,
    });
    const entry = ledger.postEntry(
      companyId,
      { date, description: `إشعار دائن ${number}${invoice ? ` للفاتورة ${invoice.invoice_number}` : ''}`, sourceType: 'sales_credit_note', sourceId: id, lines: built.lines },
      actor
    );
    const arBase = built.baseOf((l) => l.accountId === arId && l.partyType === 'customer');
    db.prepare('UPDATE sales_credit_notes SET journal_entry_id = ?, rate_e8 = ?, rate_quote = ?, total_base_minor = ? WHERE id = ?').run(entry.id, rate.rateE8, rate.quote, arBase, id);
    if (sr?.moveIds.length) db.prepare(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${sr.moveIds.map(() => '?').join(',')})`).run(entry.id, ...sr.moveIds);
    checkpoint('sales.credit_note.after_entry');

    if (invoice) {
      const credited = invoice.credited_minor + t.total;
      const remaining = db
        .prepare(
          `SELECT COALESCE(SUM(l.qty - COALESCE((SELECT SUM(c.qty) FROM sales_credit_note_lines c WHERE c.invoice_line_id = l.id), 0)), 0) r
           FROM sales_invoice_lines l WHERE l.invoice_id = ?`
        )
        .get(invoice.id).r;
      const status = remaining <= 1e-9 ? 'cancelled' : 'posted';
      db.prepare("UPDATE sales_invoices SET credited_minor = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(credited, status, invoice.id);
    }
    const after = getCreditNote(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'sales.credit_note.create', entityType: 'sales_credit_note', entityId: id, shopId, before: null, after });
    return after;
  });
}

// Cancels a posted invoice by crediting everything still open on it.
function cancelInvoice(companyId, id, { reason, restock } = {}, actor) {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE company_id = ? AND id = ?').get(companyId, id);
  if (!inv) fail('not_found', 'الفاتورة غير موجودة', 404);
  if (inv.status === 'draft') fail('invoice_not_posted', 'احذف المسودة بدل إلغائها', 409);
  if (inv.status === 'cancelled') fail('already_cancelled', 'الفاتورة ملغاة مسبقًا', 409);
  const lines = db
    .prepare(
      `SELECT l.id, l.qty - COALESCE((SELECT SUM(c.qty) FROM sales_credit_note_lines c WHERE c.invoice_line_id = l.id), 0) AS open_qty
       FROM sales_invoice_lines l WHERE l.invoice_id = ?`
    )
    .all(id)
    .filter((l) => l.open_qty > 1e-9);
  return createCreditNote(companyId, { invoiceId: id, reason: reason || 'إلغاء الفاتورة', restock, lines: lines.map((l) => ({ invoiceLineId: l.id, qty: l.open_qty })) }, actor);
}

// ---------------------------------------------------------------------
// Existing events (only called when the company is ledger_live)
// ---------------------------------------------------------------------

// Confirmed collection: Dr cash (cash) / bank-in-transit (transfer),
// Cr receivable for the customer. Runs inside confirmCollection's
// transaction; the source idempotency index makes a replay impossible.
function postCollection(companyId, collection, actor) {
  const digits = base(companyId).minor_unit_digits;
  // Prompt 7: a foreign-currency collection carries its rate locked at
  // confirmation (collection_fx); base collections are unchanged.
  const fxRow = db.prepare('SELECT * FROM collection_fx WHERE collection_id = ?').get(collection.id);
  const amount = fxRow ? fxRow.base_minor : roundToMinor(collection.amount, digits);
  if (amount <= 0) fail('zero_amount', 'مبلغ القبض صفر');
  // Rep cash custody (company setting rep_cash_handover = 1): confirmed
  // rep cash stays on rep_cash_custody (per rep) until a handover moves it
  // into a cash box. Off (default): cash_default, as before.
  const custody = collection.method === 'cash' && collection.rep_id && db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'rep_cash_handover'").get(companyId)?.value === '1';
  const debitKey = collection.method === 'transfer' ? 'bank_in_transit' : custody ? 'rep_cash_custody' : 'cash_default';
  const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(collection.shop_id);
  const fxLine = fxRow ? { currencyCode: fxRow.currency_code, amountOriginalMinor: fxRow.amount_original_minor, rateE8: fxRow.rate_e8, rateQuote: fxRow.rate_quote } : {};
  const lines = entryLines([
    { accountId: systemAccount(companyId, debitKey), side: 'debit', amount, ...(custody ? { partyType: 'employee', partyId: collection.rep_id } : {}) },
    { accountId: systemAccount(companyId, 'ar_control'), side: 'credit', amount, partyType: 'customer', partyId: collection.shop_id },
  ]).map((l) => ({ ...l, ...fxLine }));
  const entry = ledger.postEntry(
    companyId,
    {
      date: today(),
      description: `قبض ${collection.method === 'transfer' ? 'حوالة' : 'نقدي'} من ${shop?.name || ''}${fxRow ? ` (${fxRow.currency_code})` : ''}${collection.transfer_reference ? ` — ${collection.transfer_reference}` : ''}`,
      sourceType: 'collection',
      sourceId: collection.id,
      lines,
    },
    actor
  );
  // Prompt 3: the confirmed collection becomes a receipt the accountant can
  // allocate (auto-allocated oldest-first unless the company turned it off).
  require('./receivables').createReceipt(
    companyId,
    {
      shopId: collection.shop_id, date: today(), method: collection.method === 'transfer' ? 'transfer' : 'cash',
      ...(fxRow ? { currencyCode: fxRow.currency_code, amountMinor: fxRow.amount_original_minor } : { amountMinor: amount }),
      collectionId: collection.id, entryId: entry.id, notes: collection.transfer_reference || null,
    },
    actor,
    fxRow ? { foreignSource: true, lockedRate: { rateE8: fxRow.rate_e8, quote: fxRow.rate_quote } } : {}
  );
  return entry;
}

// Approved return financial adjustment: a credit note (linked to the return
// and, when the return names an order with a posted invoice, to that
// invoice for reference) — Dr sales returns / Cr receivable, plus
// Dr inventory / Cr COGS at current cost for items that went back to stock.
// Returns the credited amount in major units (same shape the route always
// returned), or null when nothing is creditable.
function postReturnCredit(companyId, request, items, actor) {
  const digits = base(companyId).minor_unit_digits;
  const valid = items.filter((it) => it.inspection_status === 'valid' && it.unit_value);
  if (!valid.length) return null;
  const lines = valid.map((it) => {
    const qty = it.inspected_qty ?? it.requested_qty;
    const product = it.product_id ? db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(it.product_id, companyId) : null;
    return {
      productId: product?.id,
      description: it.product_name,
      qty,
      unitPriceMinor: roundToMinor(it.unit_value, digits),
      // Exact value as the old flow computed it (unit_value * qty), so the
      // credited total matches it to the minor unit.
      exactNet: roundToMinor(it.unit_value, digits + 6) / 10 ** 6 * qty,
      taxRate: 0,
    };
  });
  const cn = createCreditNote(
    companyId,
    {
      shopId: request.shop_id,
      returnRequestId: request.id,
      reason: `مرتجع رقم ${request.id}${request.reason ? ` — ${request.reason}` : ''}`,
      restock: valid.some((it) => it.product_id),
      lines,
    },
    actor
  );
  const credit = Number(fromMinor(cn.total_minor, digits));
  db.prepare('UPDATE return_requests SET financial_adjustment_applied = 1, financial_adjustment_amount = ? WHERE id = ?').run(credit, request.id);
  checkpoint('returns.credit.after_applied');
  return credit;
}

// ---------------------------------------------------------------------
// Stubs for later prompts — deliberately not implemented here.
// ---------------------------------------------------------------------

// Rep cash handover (rep custody -> cash box): Prompt 7 (Cash & bank).
function postRepCashHandover() {
  fail('not_implemented', 'تسليم نقدية المندوب يُرحَّل في مرحلة النقدية والبنوك', 501);
}
// Operating expenses: Prompt 7.
function postExpense() {
  fail('not_implemented', 'المصاريف تُرحَّل في مرحلة النقدية والبنوك', 501);
}
// Rep commissions (lib/commissions.js): Prompt 11 (HR & payroll).
function postCommission() {
  fail('not_implemented', 'العمولات تُرحَّل في مرحلة الرواتب', 501);
}

module.exports = {
  SalesError,
  getInvoice,
  listInvoices,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  postInvoice,
  cancelInvoice,
  listInvoiceableOrders,
  createInvoiceFromOrder,
  getCreditNote,
  listCreditNotes,
  createCreditNote,
  postCollection,
  postReturnCredit,
  postRepCashHandover,
  postExpense,
  postCommission,
};
