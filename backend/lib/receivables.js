// backend/lib/receivables.js
//
// Receivables (Prompt 3) on top of the ledger:
//  - customer receipts (from confirmed collections, manual, or cheques) and
//    their allocation to invoices (oldest-first by default, manual override);
//  - post-dated cheques received (portfolio -> deposited -> cleared/bounced;
//    a bounce reverses the receipt entry and frees its allocations);
//  - aging as of any date, built from the receivable ledger lines so the
//    total always equals the control account;
//  - collection forecast, customer statements, the daily control-vs-
//    sub-ledger reconciliation, and ledger-based dashboard figures.
// All journal entries go through lib/ledger.js postEntry/reverseEntry.

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const documentNumbering = require('./documentNumbering');
const { logAudit } = require('./auditLog');
const { createNotification } = require('./notify');
const { toMinor, fromMinor } = require('./ledgerCurrencies');
const { checkpoint } = require('./faultInjection');

class ReceivablesError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new ReceivablesError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id, name: a.name } : null);
const today = () => new Date().toISOString().slice(0, 10);
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function owned(companyId, kind, id, opts) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
    throw err;
  }
}

function digits(companyId) {
  return ledger.getBaseCurrency(companyId).minor_unit_digits;
}

function systemAccount(companyId, key) {
  const a = ledger.getAccountBySystemKey(companyId, key);
  if (!a || !a.is_active) fail('missing_system_account', `الحساب النظامي ${key} غير معرّف — طبّق قالب دليل الحسابات`, 409);
  return a.id;
}

function getSetting(companyId, key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

function issueNumber(companyId, type, prefix) {
  if (!db.prepare('SELECT 1 FROM document_number_sequences WHERE company_id = ? AND document_type = ?').get(companyId, type)) {
    documentNumbering.setConfig(companyId, type, { prefix });
  }
  return documentNumbering.issueNext(companyId, type);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// ---------------------------------------------------------------------
// Invoices: open amounts
// ---------------------------------------------------------------------

function allocatedMinor(invoiceId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(a.amount_minor), 0) s FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id
       WHERE a.invoice_id = ? AND r.status = 'posted'`
    )
    .get(invoiceId).s;
}

function invoiceOpenMinor(invoice) {
  return invoice.total_minor - invoice.credited_minor - allocatedMinor(invoice.id);
}

function openInvoices(companyId, shopId) {
  return db
    .prepare("SELECT * FROM sales_invoices WHERE company_id = ? AND shop_id = ? AND status = 'posted' ORDER BY COALESCE(due_date, invoice_date), invoice_date, id")
    .all(companyId, shopId)
    .map((i) => ({ ...i, open_minor: invoiceOpenMinor(i) }))
    .filter((i) => i.open_minor > 0);
}

// ---------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------

const DEBIT_KEY = { cash: 'cash_default', transfer: 'bank_in_transit', cheque: 'cheques_in_portfolio', other: 'cash_default' };

// ---- currency helpers (Prompt 5) -----------------------------------
// Receipts and invoices each carry their own currency and locked rate;
// rows from before Prompt 5 are base currency at rate 1.
const ONE_E8 = 100000000;
const cur = () => require('./currency');
function currencyCall(fn) {
  try {
    return fn();
  } catch (err) {
    const C = cur().CurrencyError;
    if (err instanceof C) {
      const { code, status, message, ...extra } = err;
      fail(code, message, status, extra);
    }
    throw err;
  }
}
function baseCode(companyId) {
  return ledger.getBaseCurrency(companyId).code;
}
function rCur(companyId, r) {
  return r.currency_code || baseCode(companyId);
}
function rOriginal(r) {
  return r.amount_original_minor ?? r.amount_minor;
}
function rRate(r) {
  return r.rate_e8 ? { rateE8: r.rate_e8, quote: r.rate_quote } : { rateE8: ONE_E8, quote: 'base_per_foreign' };
}
function iRate(inv) {
  return inv.rate_e8 ? { rateE8: inv.rate_e8, quote: inv.rate_quote } : { rateE8: ONE_E8, quote: 'base_per_foreign' };
}
function currencyDigits(companyId, code) {
  return ledger.getCurrency(companyId, code)?.minor_unit_digits ?? digits(companyId);
}
// Receipt-currency amount already allocated / its base.
function receiptUsed(receiptId) {
  return db
    .prepare('SELECT COALESCE(SUM(COALESCE(receipt_amount_minor, amount_minor)), 0) o, COALESCE(SUM(COALESCE(base_paid_minor, amount_minor)), 0) b FROM receipt_allocations WHERE receipt_id = ?')
    .get(receiptId);
}

function receiptAllocations(receiptId) {
  return db
    .prepare(
      `SELECT a.*, i.invoice_number, i.currency_code AS invoice_currency FROM receipt_allocations a JOIN sales_invoices i ON i.id = a.invoice_id
       WHERE a.receipt_id = ? ORDER BY a.id`
    )
    .all(receiptId);
}

function getReceipt(companyId, id) {
  const r = db.prepare('SELECT * FROM customer_receipts WHERE company_id = ? AND id = ?').get(companyId, id);
  if (!r) return null;
  const d = digits(companyId);
  const code = rCur(companyId, r);
  const rd = currencyDigits(companyId, code);
  const allocations = receiptAllocations(id).map((a) => ({
    ...a,
    amount: fromMinor(a.amount_minor, currencyDigits(companyId, a.invoice_currency)),
    receipt_amount: fromMinor(a.receipt_amount_minor ?? a.amount_minor, rd),
    fx_minor: (a.base_paid_minor ?? a.amount_minor) - (a.base_relieved_minor ?? a.amount_minor),
  }));
  const used = receiptUsed(id);
  const unallocated = r.status === 'posted' ? rOriginal(r) - used.o : 0;
  return {
    ...r,
    currency_code: code,
    amount_original_minor: rOriginal(r),
    amount_original: fromMinor(rOriginal(r), rd),
    exchange_rate: r.rate_e8 ? require('./fxRate').formatRate(r.rate_e8) : null,
    shop: db.prepare('SELECT id, name FROM shops WHERE id = ?').get(r.shop_id),
    amount: fromMinor(r.amount_minor, d),
    allocations,
    allocated_minor: used.o,
    unallocated_minor: unallocated,
    unallocated: fromMinor(unallocated, rd),
    fx_settlements: db.prepare("SELECT s.*, e.entry_number FROM fx_settlements s LEFT JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.receipt_id = ? AND s.status = 'posted'").all(id),
    journal_entry: r.journal_entry_id ? db.prepare('SELECT id, entry_number FROM journal_entries WHERE id = ?').get(r.journal_entry_id) : null,
    cheque: r.cheque_id ? db.prepare('SELECT * FROM cheques_received WHERE id = ?').get(r.cheque_id) : null,
  };
}

function listReceipts(companyId, { shopId, status, unallocated } = {}) {
  const where = ['r.company_id = ?'];
  const p = [companyId];
  if (shopId) { where.push('r.shop_id = ?'); p.push(Number(shopId)); }
  if (status) { where.push('r.status = ?'); p.push(String(status)); }
  const d = digits(companyId);
  const rows = db
    .prepare(
      `SELECT r.*, s.name AS shop_name,
         COALESCE((SELECT SUM(COALESCE(a.receipt_amount_minor, a.amount_minor)) FROM receipt_allocations a WHERE a.receipt_id = r.id), 0) AS allocated_minor
       FROM customer_receipts r JOIN shops s ON s.id = r.shop_id WHERE ${where.join(' AND ')}
       ORDER BY r.receipt_date DESC, r.id DESC LIMIT 500`
    )
    .all(...p)
    .map((r) => ({
      ...r,
      currency_code: rCur(companyId, r),
      amount_original_minor: rOriginal(r),
      amount: fromMinor(r.amount_minor, d),
      unallocated_minor: r.status === 'posted' ? rOriginal(r) - r.allocated_minor : 0,
    }));
  return unallocated ? rows.filter((r) => r.unallocated_minor > 0) : rows;
}

// Creates a receipt. Either it already has its journal entry (a confirmed
// collection posts through lib/salesPosting.js postCollection and passes
// entryId), or this posts Dr cash/bank-in-transit/cheques / Cr AR(customer).
// Prompt 5: currencyCode + amount in that currency; the rate is the
// history rate of the receipt date (or a typed override with
// override_exchange_rate) and is locked on the receipt.
// opts (internal only): foreignSource lets a collection / cheque receipt be
// in a foreign currency (Prompt 7); lockedRate = the rate locked when the
// collection or cheque was confirmed.
function createReceipt(companyId, input, actor, opts = {}) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const shop = owned(companyId, 'shop', input.shopId);
    const method = input.method || 'cash';
    if (!DEBIT_KEY[method]) fail('invalid_method', 'طريقة القبض غير صالحة');
    const date = input.date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const base = ledger.getBaseCurrency(companyId);
    const code = String(input.currencyCode || base.code).toUpperCase();
    if (code !== base.code && (input.entryId || input.collectionId || input.chequeId) && !opts.foreignSource) fail('foreign_currency_not_supported', 'التحصيلات والشيكات بالعملة الأساسية فقط حاليًا');
    const currency = code === base.code ? base : ledger.getCurrency(companyId, code);
    if (!currency || !currency.is_active) fail('invalid_currency', 'العملة غير معرّفة');
    const originalMinor = input.amountMinor !== undefined ? Number(input.amountMinor) : toMinor(input.amount, currency.minor_unit_digits);
    if (!Number.isSafeInteger(originalMinor) || originalMinor <= 0) fail('invalid_amount', 'المبلغ يجب أن يكون أكبر من صفر');
    const rate = opts.lockedRate || currencyCall(() => cur().documentRate(companyId, code, date, { override: { rate: input.exchangeRate, rateQuote: input.rateQuote }, actor }));
    const amountMinor = code === base.code ? originalMinor : currencyCall(() => cur().toBase(companyId, code, originalMinor, rate));
    if (amountMinor <= 0) fail('invalid_amount', 'المبلغ بعد التحويل يساوي صفرًا');
    const number = issueNumber(companyId, 'RC', 'RC-');
    const id = Number(
      db
        .prepare(
          `INSERT INTO customer_receipts (company_id, receipt_number, shop_id, receipt_date, method, amount_minor, collection_id, cheque_id, journal_entry_id, notes, created_by,
             currency_code, amount_original_minor, rate_e8, rate_quote)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, number, shop.id, date, method, amountMinor, input.collectionId ?? null, input.chequeId ?? null, input.entryId ?? null, input.notes || null, actor?.id ?? null,
          code, originalMinor, rate.rateE8, rate.quote)
        .lastInsertRowid
    );
    if (!input.entryId) {
      const fxLine = code === base.code ? {} : { currencyCode: code, amountOriginalMinor: originalMinor, rateE8: rate.rateE8, rateQuote: rate.quote };
      const entry = ledger.postEntry(
        companyId,
        {
          date,
          description: `سند قبض ${number} — ${shop.name}`,
          sourceType: 'customer_receipt',
          sourceId: id,
          lines: [
            { accountId: systemAccount(companyId, DEBIT_KEY[method]), debitMinor: amountMinor, creditMinor: 0, ...fxLine },
            { accountId: systemAccount(companyId, 'ar_control'), debitMinor: 0, creditMinor: amountMinor, partyType: 'customer', partyId: shop.id, ...fxLine },
          ],
        },
        actor
      );
      db.prepare('UPDATE customer_receipts SET journal_entry_id = ? WHERE id = ?').run(entry.id, id);
    }
    checkpoint('receivables.receipt.after_entry');
    logAudit({ companyId, actor: actorOf(actor), action: 'receivables.receipt.create', entityType: 'customer_receipt', entityId: id, shopId: shop.id, before: null, after: { number, method, amount_minor: amountMinor, currency_code: code, amount_original_minor: originalMinor, rate_e8: rate.rateE8, rate_quote: rate.quote, rate_overridden: !!rate.overridden } });

    if (Array.isArray(input.allocations) && input.allocations.length) setAllocations(companyId, id, input.allocations, actor);
    else if (input.autoAllocate ?? getSetting(companyId, 'receipt_auto_allocate', '1') === '1') autoAllocate(companyId, id, actor);
    return getReceipt(companyId, id);
  });
}

function requirePostedReceipt(companyId, id) {
  const r = db.prepare('SELECT * FROM customer_receipts WHERE company_id = ? AND id = ?').get(companyId, Number(id));
  if (!r) fail('not_found', 'سند القبض غير موجود', 404);
  if (r.status !== 'posted') fail('receipt_reversed', 'سند القبض معكوس ولا يمكن تخصيصه', 409);
  return r;
}

// ---- allocation maths (Prompt 5) ------------------------------------
// The invoice-currency rate at the receipt date converts between the
// receipt's money and the invoice's (receiving SYP against a USD invoice).
function settlementRate(companyId, receipt, invoice, override, actor) {
  const ic = invoice.currency_code;
  if (ic === rCur(companyId, receipt) || ic === baseCode(companyId)) return null;
  return currencyCall(() => cur().documentRate(companyId, ic, receipt.receipt_date, { override, actor }));
}
// receipt-currency amount -> invoice-currency amount settled.
function receiptToInvoice(companyId, receipt, invoice, rAmt, sRate) {
  const rc = rCur(companyId, receipt);
  const ic = invoice.currency_code;
  if (rc === ic) return rAmt;
  const b = currencyCall(() => cur().toBase(companyId, rc, rAmt, rRate(receipt)));
  return ic === baseCode(companyId) ? b : currencyCall(() => cur().fromBase(companyId, ic, b, sRate));
}
// invoice-currency amount -> receipt-currency amount needed (rounded up so
// converting back covers it).
function invoiceToReceipt(companyId, receipt, invoice, iAmt, sRate) {
  const rc = rCur(companyId, receipt);
  const ic = invoice.currency_code;
  if (rc === ic) return iAmt;
  const b = ic === baseCode(companyId) ? iAmt : currencyCall(() => cur().toBase(companyId, ic, iAmt, sRate));
  let need = rc === baseCode(companyId) ? b : currencyCall(() => cur().fromBase(companyId, rc, b, rRate(receipt)));
  while (receiptToInvoice(companyId, receipt, invoice, need, sRate) < iAmt) need += 1;
  return need;
}

// Removes one allocation, reversing its realized-FX entry (same tx).
function removeAllocation(companyId, a, actor) {
  const s = db.prepare("SELECT * FROM fx_settlements WHERE company_id = ? AND receipt_id = ? AND invoice_id = ? AND status = 'posted'").all(companyId, a.receipt_id, a.invoice_id);
  for (const x of s) {
    if (x.journal_entry_id) ledger.reverseEntry(companyId, x.journal_entry_id, { reason: 'إلغاء تخصيص سند القبض', fromSource: true }, actor);
    db.prepare("UPDATE fx_settlements SET status = 'reversed' WHERE id = ?").run(x.id);
  }
  db.prepare('DELETE FROM receipt_allocations WHERE id = ?').run(a.id);
}

// Allocates `rAmt` (receipt currency) of the receipt to the invoice:
// settled invoice amount, base paid, base relieved, and the realized FX
// entry for their difference (fx_realized).
function addAllocation(companyId, receipt, invoice, rAmt, method, actor, { override } = {}) {
  const existing = db.prepare('SELECT * FROM receipt_allocations WHERE receipt_id = ? AND invoice_id = ?').get(receipt.id, invoice.id);
  if (existing) {
    rAmt += existing.receipt_amount_minor ?? existing.amount_minor;
    removeAllocation(companyId, existing, actor);
  }
  const sRate = settlementRate(companyId, receipt, invoice, override, actor);
  const open = invoiceOpenMinor(invoice);
  let settled = receiptToInvoice(companyId, receipt, invoice, rAmt, sRate);
  if (settled > open) settled = open;
  if (settled <= 0) fail('allocation_too_small', 'المبلغ المخصص أصغر من أصغر وحدة في عملة الفاتورة', 409);
  const used = receiptUsed(receipt.id);
  const remainingOriginal = rOriginal(receipt) - used.o;
  const basePaid = rAmt === remainingOriginal
    ? receipt.amount_minor - used.b // receipt fully used: exactly its base, no dust
    : currencyCall(() => cur().toBase(companyId, rCur(companyId, receipt), rAmt, rRate(receipt)));
  const baseRelieved = settled === open
    ? cur().invoiceBaseOpen(invoice) // invoice closed: exactly the base it carries
    : currencyCall(() => cur().toBase(companyId, invoice.currency_code, settled, iRate(invoice)));
  const date = today() < receipt.receipt_date ? receipt.receipt_date : today();
  db.prepare(
    `INSERT INTO receipt_allocations (company_id, receipt_id, invoice_id, amount_minor, allocation_date, method, created_by,
       receipt_amount_minor, base_paid_minor, base_relieved_minor, settlement_rate_e8, settlement_rate_quote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, receipt.id, invoice.id, settled, date, method, actor?.id ?? null, rAmt, basePaid, baseRelieved, sRate?.rateE8 ?? null, sRate?.quote ?? null);
  const fxMinor = basePaid - baseRelieved;
  if (fxMinor) {
    const sid = Number(
      db.prepare('INSERT INTO fx_settlements (company_id, receipt_id, invoice_id, shop_id, fx_minor) VALUES (?, ?, ?, ?, ?)')
        .run(companyId, receipt.id, invoice.id, receipt.shop_id, fxMinor).lastInsertRowid
    );
    const ar = systemAccount(companyId, 'ar_control');
    const fxAcc = systemAccount(companyId, 'fx_realized');
    const amt = Math.abs(fxMinor);
    // Paid more base than the invoice carried: gain (AR back up to zero).
    const lines = fxMinor > 0
      ? [{ accountId: ar, debitMinor: amt, partyType: 'customer', partyId: receipt.shop_id, memo: `فرق صرف محقق — ${invoice.invoice_number}` }, { accountId: fxAcc, creditMinor: amt, memo: 'أرباح فروقات صرف محققة' }]
      : [{ accountId: fxAcc, debitMinor: amt, memo: 'خسائر فروقات صرف محققة' }, { accountId: ar, creditMinor: amt, partyType: 'customer', partyId: receipt.shop_id, memo: `فرق صرف محقق — ${invoice.invoice_number}` }];
    // Dated at the receipt (the settlement rate is the receipt-date rate);
    // if that period is closed, on the allocation date instead.
    const fxEntry = (d) => ledger.postEntry(companyId, { date: d, description: `فرق صرف محقق: ${receipt.receipt_number} ← ${invoice.invoice_number}`, sourceType: 'fx_realized', sourceId: sid, lines }, actor);
    let entry;
    try {
      entry = fxEntry(receipt.receipt_date);
    } catch (err) {
      if (!(err instanceof ledger.LedgerError) || !['period_closed', 'period_locked', 'no_period'].includes(err.code) || receipt.receipt_date === date) throw err;
      entry = fxEntry(date);
    }
    db.prepare('UPDATE fx_settlements SET journal_entry_id = ? WHERE id = ?').run(entry.id, sid);
    checkpoint('receivables.allocation.after_fx');
  }
  return { invoice_id: invoice.id, amount_minor: settled, receipt_amount_minor: rAmt, base_paid_minor: basePaid, base_relieved_minor: baseRelieved, fx_minor: fxMinor };
}

// Oldest due first; never more than the receipt's unallocated amount or an
// invoice's open amount (converted when the currencies differ).
function autoAllocate(companyId, receiptId, actor) {
  return ledger.transaction(() => {
    const r = requirePostedReceipt(companyId, receiptId);
    let remaining = rOriginal(r) - receiptUsed(r.id).o;
    const made = [];
    for (const inv of openInvoices(companyId, r.shop_id)) {
      if (remaining <= 0) break;
      const sRate = settlementRate(companyId, r, inv, null, actor);
      const need = invoiceToReceipt(companyId, r, inv, inv.open_minor, sRate);
      const amt = Math.min(remaining, need);
      if (receiptToInvoice(companyId, r, inv, amt, sRate) <= 0) continue;
      made.push(addAllocation(companyId, r, inv, amt, 'auto', actor));
      remaining -= amt;
    }
    if (made.length) logAudit({ companyId, actor: actorOf(actor), action: 'receivables.allocation.auto', entityType: 'customer_receipt', entityId: r.id, shopId: r.shop_id, before: null, after: made });
    return getReceipt(companyId, r.id);
  });
}

// Manual override: replaces the receipt's whole allocation set.
// allocations: [{ invoiceId, amount (decimal, RECEIPT currency) | amountMinor,
//   settlementRate?, settlementRateQuote? (override_exchange_rate) }]
function setAllocations(companyId, receiptId, allocations, actor) {
  return ledger.transaction(() => {
    const r = requirePostedReceipt(companyId, receiptId);
    const before = receiptAllocations(r.id);
    for (const a of before) removeAllocation(companyId, a, actor);
    const rd = currencyDigits(companyId, rCur(companyId, r));
    let total = 0;
    const seen = new Set();
    for (const [i, a] of (allocations || []).entries()) {
      const inv = owned(companyId, 'sales_invoice', a.invoiceId);
      if (seen.has(inv.id)) fail('duplicate_invoice', `السطر ${i + 1}: الفاتورة مكررة`);
      seen.add(inv.id);
      if (inv.shop_id !== r.shop_id) fail('invoice_shop_mismatch', `الفاتورة ${inv.invoice_number} لا تخص زبون السند`);
      if (inv.status !== 'posted') fail('invoice_not_open', `الفاتورة ${inv.invoice_number || inv.id} غير مفتوحة`, 409);
      const amt = a.amountMinor !== undefined ? Number(a.amountMinor) : toMinor(a.amount, rd);
      if (!Number.isSafeInteger(amt) || amt <= 0) fail('invalid_amount', `السطر ${i + 1}: المبلغ غير صالح`);
      const override = a.settlementRate ? { rate: a.settlementRate, rateQuote: a.settlementRateQuote } : null;
      const sRate = settlementRate(companyId, r, inv, override, actor);
      const open = invoiceOpenMinor(inv);
      const need = invoiceToReceipt(companyId, r, inv, open, sRate);
      if (amt > need) {
        const id = currencyDigits(companyId, inv.currency_code);
        fail('exceeds_invoice_open', `المبلغ أكبر من المتبقي على الفاتورة ${inv.invoice_number} (${fromMinor(open, id)} ${inv.currency_code})`, 409, { invoice_id: inv.id, open_minor: open, receipt_amount_needed_minor: need });
      }
      total += amt;
      if (total > rOriginal(r)) fail('exceeds_receipt', `مجموع التخصيص أكبر من مبلغ السند (${fromMinor(rOriginal(r), rd)})`, 409);
      addAllocation(companyId, r, inv, amt, 'manual', actor, { override });
    }
    const after = receiptAllocations(r.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'receivables.allocation.set', entityType: 'customer_receipt', entityId: r.id, shopId: r.shop_id, before, after });
    return getReceipt(companyId, r.id);
  });
}

// Reversing a receipt = reversing its journal entry; onEntryReversed (called
// by lib/ledger.js reverseEntry) marks the receipt and frees allocations.
function reverseReceipt(companyId, receiptId, { reason, date } = {}, actor) {
  return ledger.transaction(() => {
    const r = requirePostedReceipt(companyId, receiptId);
    if (r.cheque_id) fail('use_cheque_bounce', 'هذا السند لشيك — استخدم "ارتداد الشيك"', 409);
    // A receipt created by a confirmed collection is reversed through the
    // collection, so the collection's status follows.
    if (r.collection_id) {
      try {
        require('./collections').reverseCollection(companyId, r.collection_id, { reason, date }, actor);
      } catch (err) {
        if (err instanceof ReceivablesError) throw err;
        fail(err.message === 'reason_required' ? 'reason_required' : err.message, err.message === 'reason_required' ? 'سبب العكس مطلوب' : err.detail || 'تعذّر عكس التحصيل', err.status || 400);
      }
      return getReceipt(companyId, r.id);
    }
    ledger.reverseEntry(companyId, r.journal_entry_id, { reason: reason || `عكس سند القبض ${r.receipt_number}`, date, fromSource: true }, actor);
    return getReceipt(companyId, r.id);
  });
}

// Hook from lib/ledger.js reverseEntry (same transaction). Keeps receipts
// consistent however the entry was reversed (receipt screen, cheque bounce,
// or the generic journal-entry reverse button).
function onEntryReversed(companyId, original, reversal, actor) {
  let receipt = null;
  if (original.source_type === 'customer_receipt') {
    receipt = db.prepare('SELECT * FROM customer_receipts WHERE company_id = ? AND id = ?').get(companyId, original.source_id);
  } else if (original.source_type === 'collection') {
    receipt = db.prepare('SELECT * FROM customer_receipts WHERE company_id = ? AND collection_id = ?').get(companyId, original.source_id);
  }
  if (!receipt || receipt.status !== 'posted') return;
  const before = receiptAllocations(receipt.id);
  for (const a of before) removeAllocation(companyId, a, actor);
  db.prepare("UPDATE customer_receipts SET status = 'reversed', reversal_entry_id = ?, reversal_reason = ? WHERE id = ?").run(reversal.id, reversal.reversal_reason || null, receipt.id);
  logAudit({ companyId, actor: actorOf(actor), action: 'receivables.receipt.reverse', entityType: 'customer_receipt', entityId: receipt.id, shopId: receipt.shop_id, before: { status: 'posted', allocations: before }, after: { status: 'reversed', reversal_entry_id: reversal.id } });
}

// Backfill (after Prompt 3): confirmed collections of a ledger-live company
// that have a posted journal entry but no receipt (confirmed between Prompt
// 2 and Prompt 3) get one, so they can be allocated. Idempotent: a
// collection that already has a receipt is never touched again (unique
// index on customer_receipts.collection_id).
function backfillCollectionReceipts(companyId, { dryRun = true, autoAllocate } = {}, actor) {
  if (!require('./customerLedger').isLedgerLive(companyId)) fail('not_ledger_live', 'الشركة لم تتحول إلى دفتر الأستاذ', 409);
  const candidates = db
    .prepare(
      `SELECT c.id, c.shop_id, c.method, c.amount, e.id AS entry_id, e.entry_date, e.status AS entry_status
       FROM collections c JOIN journal_entries e ON e.company_id = c.company_id AND e.source_type = 'collection' AND e.source_id = c.id
       WHERE c.company_id = ? AND c.status = 'confirmed'
         AND NOT EXISTS (SELECT 1 FROM customer_receipts r WHERE r.collection_id = c.id)
       ORDER BY e.entry_date, c.id`
    )
    .all(companyId);
  const ar = arId(companyId);
  const plan = [];
  const skipped = [];
  for (const c of candidates) {
    if (c.entry_status !== 'posted') {
      skipped.push({ collection_id: c.id, reason: 'entry_reversed' });
      continue;
    }
    const amount = db.prepare("SELECT SUM(credit_minor) s FROM journal_lines WHERE entry_id = ? AND account_id = ? AND party_type = 'customer'").get(c.entry_id, ar).s || 0;
    if (amount <= 0) {
      skipped.push({ collection_id: c.id, reason: 'no_receivable_line' });
      continue;
    }
    plan.push({ collection_id: c.id, shop_id: c.shop_id, method: c.method === 'transfer' ? 'transfer' : 'cash', amount_minor: amount, entry_id: c.entry_id, date: c.entry_date });
  }
  if (dryRun) return { dry_run: true, to_create: plan.length, plan, skipped };
  const created = ledger.transaction(() =>
    plan.map((p) =>
      createReceipt(
        companyId,
        { shopId: p.shop_id, date: p.date, method: p.method, amountMinor: p.amount_minor, collectionId: p.collection_id, entryId: p.entry_id, notes: 'إنشاء لاحق لتحصيل مؤكد قبل وجود سندات القبض', autoAllocate },
        actor
      ).id
    )
  );
  logAudit({ companyId, actor: actorOf(actor), action: 'receivables.receipt.backfill', entityType: 'company', entityId: companyId, before: null, after: { created: created.length, skipped: skipped.length } });
  return { dry_run: false, created: created.length, receipt_ids: created, skipped };
}

// ---------------------------------------------------------------------
// Cheques received
// ---------------------------------------------------------------------

function getCheque(companyId, id) {
  const c = db.prepare('SELECT * FROM cheques_received WHERE company_id = ? AND id = ?').get(companyId, Number(id));
  if (!c) fail('not_found', 'الشيك غير موجود', 404);
  return c;
}

function listCheques(companyId, { status } = {}) {
  const d = digits(companyId);
  const p = [companyId];
  let where = 'c.company_id = ?';
  if (status) { where += ' AND c.status = ?'; p.push(String(status)); }
  return db
    .prepare(`SELECT c.*, s.name AS shop_name, r.receipt_number FROM cheques_received c JOIN shops s ON s.id = c.shop_id LEFT JOIN customer_receipts r ON r.id = c.receipt_id WHERE ${where} ORDER BY c.due_date, c.id`)
    .all(...p)
    .map((c) => ({ ...c, amount: fromMinor(c.amount_minor, d) }));
}

// A received post-dated cheque settles the customer at once (Dr cheques in
// portfolio / Cr AR) through a cheque receipt, auto-allocated like any other.
function receiveCheque(companyId, input, actor) {
  return ledger.transaction(() => {
    const shop = owned(companyId, 'shop', input.shopId);
    const number = String(input.chequeNumber || '').trim();
    if (!number) fail('cheque_number_required', 'رقم الشيك مطلوب');
    const received = input.receivedDate || today();
    if (!isValidDate(received) || !isValidDate(input.dueDate)) fail('invalid_date', 'تاريخ الاستلام أو الاستحقاق غير صالح');
    // Prompt 7: a cheque may be in a foreign currency; its rate is locked
    // now (recording = the accountant's confirmation) and carried until it
    // clears.
    const base = ledger.getBaseCurrency(companyId);
    const code = String(input.currencyCode || base.code).toUpperCase();
    const currency = code === base.code ? base : ledger.getCurrency(companyId, code);
    if (!currency || !currency.is_active) fail('invalid_currency', 'العملة غير معرّفة');
    const originalMinor = toMinor(input.amount, currency.minor_unit_digits);
    if (originalMinor <= 0) fail('invalid_amount', 'مبلغ الشيك يجب أن يكون أكبر من صفر');
    const rate = code === base.code ? null : currencyCall(() => cur().documentRate(companyId, code, received, { override: { rate: input.exchangeRate, rateQuote: input.rateQuote }, actor }));
    const amountMinor = rate ? currencyCall(() => cur().toBase(companyId, code, originalMinor, rate)) : originalMinor;
    if (amountMinor <= 0) fail('invalid_amount', 'المبلغ بعد التحويل يساوي صفرًا');
    let chequeId;
    try {
      chequeId = Number(
        db
          .prepare('INSERT INTO cheques_received (company_id, shop_id, cheque_number, bank_name, received_date, due_date, amount_minor, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(companyId, shop.id, number, input.bankName || '', received, input.dueDate, amountMinor, actor?.id ?? null).lastInsertRowid
      );
    } catch (err) {
      if (/UNIQUE/.test(err.message)) fail('duplicate_cheque', 'هذا الشيك مسجّل مسبقًا', 409);
      throw err;
    }
    if (rate) db.prepare('UPDATE cheques_received SET currency_code = ?, amount_original_minor = ?, rate_e8 = ?, rate_quote = ? WHERE id = ?').run(code, originalMinor, rate.rateE8, rate.quote, chequeId);
    const receipt = createReceipt(
      companyId,
      { shopId: shop.id, date: received, method: 'cheque', ...(rate ? { currencyCode: code, amountMinor: originalMinor } : { amountMinor }), chequeId, notes: `شيك رقم ${number}${input.bankName ? ` — ${input.bankName}` : ''} يستحق ${input.dueDate}`, allocations: input.allocations },
      actor,
      rate ? { foreignSource: true, lockedRate: rate } : {}
    );
    db.prepare('UPDATE cheques_received SET receipt_id = ? WHERE id = ?').run(receipt.id, chequeId);
    logAudit({ companyId, actor: actorOf(actor), action: 'receivables.cheque.receive', entityType: 'cheque_received', entityId: chequeId, shopId: shop.id, before: null, after: { number, due_date: input.dueDate, amount_minor: amountMinor, receipt_id: receipt.id, ...(rate ? { currency_code: code, amount_original_minor: originalMinor, rate_e8: rate.rateE8, rate_quote: rate.quote } : {}) } });
    return { ...getCheque(companyId, chequeId), receipt };
  });
}

function depositCheque(companyId, id, actor) {
  return ledger.transaction(() => {
    const c = getCheque(companyId, id);
    if (c.status !== 'in_portfolio') fail('invalid_transition', 'الشيك ليس في المحفظة', 409);
    db.prepare("UPDATE cheques_received SET status = 'deposited', deposited_at = datetime('now') WHERE id = ?").run(c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'receivables.cheque.deposit', entityType: 'cheque_received', entityId: c.id, shopId: c.shop_id, before: { status: c.status }, after: { status: 'deposited' } });
    return getCheque(companyId, c.id);
  });
}

// Cleared: the money is in the bank. Without a bank box (as before Prompt
// 7): Dr bank-in-transit / Cr cheques in portfolio. With a bank box
// (Prompt 7): Dr that box at the clearing-date rate / Cr cheques in
// portfolio at the carried base; the difference -> fx_realized.
function clearCheque(companyId, id, { date, cashBoxId, exchangeRate, rateQuote } = {}, actor) {
  return ledger.transaction(() => {
    const c = getCheque(companyId, id);
    if (!['in_portfolio', 'deposited'].includes(c.status)) fail('invalid_transition', 'لا يمكن تحصيل هذا الشيك', 409);
    const d = date || today();
    const code = c.currency_code || baseCode(companyId);
    let entry;
    let box = null;
    let fxMinor = 0;
    if (cashBoxId) {
      const T = require('./treasury');
      try {
        box = T.usableBox(companyId, cashBoxId, actor, { kind: 'bank' });
      } catch (err) {
        if (err.code && err.status) fail(err.code, err.message, err.status);
        throw err;
      }
      if (box.currency_code !== code) fail('currency_mismatch', `الشيك بعملة ${code} والحساب البنكي ${box.name} بعملة ${box.currency_code}`);
      const isBase = code === baseCode(companyId);
      const rate = isBase ? null : currencyCall(() => cur().documentRate(companyId, code, d, { override: { rate: exchangeRate, rateQuote }, actor }));
      const original = c.amount_original_minor ?? c.amount_minor;
      const bankBase = isBase ? c.amount_minor : currencyCall(() => cur().toBase(companyId, code, original, rate));
      fxMinor = bankBase - c.amount_minor; // > 0 gain
      const f = (r) => (isBase ? {} : { currencyCode: code, amountOriginalMinor: original, rateE8: r.rateE8, rateQuote: r.quote });
      const lines = [
        { accountId: box.account_id, debitMinor: bankBase, creditMinor: 0, ...f(rate || {}) },
        { accountId: systemAccount(companyId, 'cheques_in_portfolio'), debitMinor: 0, creditMinor: c.amount_minor, ...f(rRate(c)) },
      ];
      if (fxMinor) lines.push({ accountId: systemAccount(companyId, 'fx_realized'), debitMinor: fxMinor < 0 ? -fxMinor : 0, creditMinor: fxMinor > 0 ? fxMinor : 0, memo: 'فرق صرف بين استلام الشيك وتحصيله' });
      entry = ledger.postEntry(companyId, { date: d, description: `تحصيل الشيك رقم ${c.cheque_number} في ${box.name}`, sourceType: 'cheque_clear', sourceId: c.id, lines }, actor);
    } else {
      if (code !== baseCode(companyId)) fail('cash_box_required', 'شيك بعملة أجنبية — اختر الحساب البنكي بالعملة نفسها');
      entry = ledger.postEntry(
        companyId,
        {
          date: d,
          description: `تحصيل الشيك رقم ${c.cheque_number}`,
          sourceType: 'cheque_clear',
          sourceId: c.id,
          lines: [
            { accountId: systemAccount(companyId, 'bank_in_transit'), debitMinor: c.amount_minor, creditMinor: 0 },
            { accountId: systemAccount(companyId, 'cheques_in_portfolio'), debitMinor: 0, creditMinor: c.amount_minor },
          ],
        },
        actor
      );
    }
    checkpoint('receivables.cheque_clear.after_entry');
    db.prepare("UPDATE cheques_received SET status = 'cleared', cleared_at = datetime('now'), clear_entry_id = ? WHERE id = ?").run(entry.id, c.id);
    if (box) db.prepare('UPDATE cheques_received SET cash_box_id = ?, clear_fx_minor = ? WHERE id = ?').run(box.id, fxMinor, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'receivables.cheque.clear', entityType: 'cheque_received', entityId: c.id, shopId: c.shop_id, before: { status: c.status }, after: { status: 'cleared', entry_id: entry.id, ...(box ? { cash_box_id: box.id, fx_minor: fxMinor } : {}) } });
    return getCheque(companyId, c.id);
  });
}

// Bounced: reverse the receipt entry (Dr AR / Cr cheques in portfolio) —
// the customer owes again and the invoices it paid are open again.
function bounceCheque(companyId, id, { reason, date } = {}, actor) {
  return ledger.transaction(() => {
    const c = getCheque(companyId, id);
    if (c.status === 'cleared') fail('cheque_already_cleared', 'الشيك محصّل — لا يمكن تسجيل ارتداده هنا', 409);
    if (c.status === 'bounced') fail('already_bounced', 'الشيك مرتد مسبقًا', 409);
    const r = db.prepare('SELECT * FROM customer_receipts WHERE id = ?').get(c.receipt_id);
    ledger.reverseEntry(companyId, r.journal_entry_id, { reason: `ارتداد الشيك رقم ${c.cheque_number}${reason ? ` — ${reason}` : ''}`, date, fromSource: true }, actor);
    db.prepare("UPDATE cheques_received SET status = 'bounced', bounced_at = datetime('now'), bounce_reason = ? WHERE id = ?").run(reason || null, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'receivables.cheque.bounce', entityType: 'cheque_received', entityId: c.id, shopId: c.shop_id, before: { status: c.status }, after: { status: 'bounced', reason: reason || null } });
    const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(c.shop_id);
    createNotification({
      companyId,
      type: 'cheque_bounced',
      message_ar: `ارتد الشيك رقم ${c.cheque_number} للزبون ${shop?.name || ''} — أُعيد المبلغ إلى ذمته.`,
      message_en: `Cheque ${c.cheque_number} from ${shop?.name || ''} bounced — the amount is owed again.`,
      link_path: '/receivables/cheques',
      entity_type: 'cheque_received',
      entity_id: c.id,
    });
    return getCheque(companyId, c.id);
  });
}

// ---------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------

const BUCKETS = ['b0_30', 'b31_60', 'b61_90', 'b90_plus', 'legacy'];

function bucketOf(days) {
  if (days <= 30) return 'b0_30';
  if (days <= 60) return 'b31_60';
  if (days <= 90) return 'b61_90';
  return 'b90_plus';
}

function arId(companyId) {
  return ledger.getAccountBySystemKey(companyId, 'ar_control')?.id ?? null;
}

// Open items of one customer as of a date. Every receivable line is put in
// a group (invoice, receipt, credit note, other entry); credits that are
// tied to an invoice (its credit notes, receipt allocations dated <= asOf,
// reversals of its entry) land on that invoice. Positive groups are open
// debit items aged by due date; negative groups are unallocated credits.
// The sum of all groups is exactly the customer's AR balance as of the date.
function customerOpenItems(companyId, shopId, asOf) {
  const ar = arId(companyId);
  if (!ar) return [];
  const lines = db
    .prepare(
      `SELECT l.debit_minor, l.credit_minor, e.id AS entry_id, e.entry_number, e.entry_date, e.source_type, e.source_id, e.description
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'customer' AND l.party_id = ? AND e.entry_date <= ?
       ORDER BY e.entry_date, e.id`
    )
    .all(companyId, ar, shopId, asOf);
  const entryKey = new Map();
  const keyOf = (e) => {
    if (entryKey.has(e.entry_id)) return entryKey.get(e.entry_id);
    let key;
    if (e.source_type === 'sales_invoice') key = `inv:${e.source_id}`;
    else if (e.source_type === 'sales_credit_note') {
      const cn = db.prepare('SELECT invoice_id FROM sales_credit_notes WHERE id = ?').get(e.source_id);
      key = cn?.invoice_id ? `inv:${cn.invoice_id}` : `cn:${e.source_id}`;
    } else if (e.source_type === 'customer_receipt') key = `rcpt:${e.source_id}`;
    else if (e.source_type === 'fx_realized') {
      const fxs = db.prepare('SELECT invoice_id FROM fx_settlements WHERE id = ?').get(e.source_id);
      key = fxs ? `inv:${fxs.invoice_id}` : `entry:${e.entry_id}`;
    }
    else if (e.source_type === 'customer_open_item') key = `oi:${e.source_id}`;
    else if (e.source_type === 'customer_opening') key = `legacy:${e.entry_id}`;
    else if (e.source_type === 'collection') {
      const r = db.prepare('SELECT id FROM customer_receipts WHERE collection_id = ?').get(e.source_id);
      key = r ? `rcpt:${r.id}` : `entry:${e.entry_id}`;
    } else if (e.source_type === 'reversal') {
      const orig = db.prepare('SELECT id AS entry_id, entry_number, entry_date, source_type, source_id FROM journal_entries WHERE id = ?').get(e.source_id);
      key = orig ? keyOf(orig) : `entry:${e.entry_id}`;
    } else key = `entry:${e.entry_id}`;
    entryKey.set(e.entry_id, key);
    return key;
  };
  const groups = new Map();
  const group = (key, seed) => {
    if (!groups.has(key)) groups.set(key, { key, amount_minor: 0, ...seed });
    return groups.get(key);
  };
  for (const l of lines) {
    const key = keyOf(l);
    const g = group(key, { entry_id: l.entry_id, entry_number: l.entry_number, date: l.entry_date, source_type: l.source_type, description: l.description });
    g.amount_minor += l.debit_minor - l.credit_minor;
  }
  // Allocations move credit (the BASE paid) from the receipt group onto the
  // invoice group; realized-FX entries land on the invoice too, so a fully
  // settled foreign invoice nets to exactly zero.
  const allocs = db
    .prepare(
      `SELECT a.receipt_id, a.invoice_id, COALESCE(a.base_paid_minor, a.amount_minor) AS amount_minor FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id
       WHERE a.company_id = ? AND r.shop_id = ? AND r.status = 'posted' AND a.allocation_date <= ?`
    )
    .all(companyId, shopId, asOf);
  for (const a of allocs) {
    if (!groups.has(`rcpt:${a.receipt_id}`)) continue; // receipt dated after asOf
    groups.get(`rcpt:${a.receipt_id}`).amount_minor += a.amount_minor;
    group(`inv:${a.invoice_id}`, {}).amount_minor -= a.amount_minor;
  }
  const items = [];
  for (const g of groups.values()) {
    if (g.amount_minor === 0) continue;
    let due = g.date;
    let number = g.entry_number;
    let docLink = null;
    if (g.key.startsWith('inv:')) {
      const inv = db.prepare('SELECT id, invoice_number, invoice_date, due_date FROM sales_invoices WHERE id = ?').get(Number(g.key.slice(4)));
      if (inv) {
        due = inv.due_date || inv.invoice_date;
        number = inv.invoice_number;
        docLink = { type: 'sales_invoice', id: inv.id };
        g.date = inv.invoice_date;
      }
    } else if (g.key.startsWith('rcpt:')) {
      const r = db.prepare('SELECT id, receipt_number FROM customer_receipts WHERE id = ?').get(Number(g.key.slice(5)));
      if (r) { number = r.receipt_number; docLink = { type: 'customer_receipt', id: r.id }; }
    } else if (g.key.startsWith('oi:')) {
      const oi = db.prepare('SELECT * FROM open_items WHERE id = ?').get(Number(g.key.slice(3)));
      if (oi) {
        due = oi.due_date;
        number = oi.invoice_number;
        g.date = oi.invoice_date;
        docLink = { type: 'open_item', id: oi.id };
      }
    } else if (g.key.startsWith('cn:')) {
      const c = db.prepare('SELECT id, credit_note_number FROM sales_credit_notes WHERE id = ?').get(Number(g.key.slice(3)));
      if (c) { number = c.credit_note_number; docLink = { type: 'sales_credit_note', id: c.id }; }
    }
    const daysOverdue = daysBetween(due, asOf);
    items.push({
      ...g,
      number,
      due_date: due,
      days_overdue: daysOverdue,
      // Migrated debt with no known invoice age (go-live residual) is its own
      // 'legacy' bucket, never 0-30.
      legacy: g.key.startsWith('legacy:'),
      bucket: g.amount_minor <= 0 ? 'credits' : g.key.startsWith('legacy:') ? 'legacy' : bucketOf(daysOverdue),
      document: docLink,
    });
  }
  return items.sort((x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : 0));
}

function emptyBuckets() {
  return { b0_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0, legacy: 0, credits: 0, total: 0 };
}

// Company setting legacy_debt_policy: 'overdue' (default) treats legacy /
// undated debt as overdue for reminders, credit control and the overdue
// dashboard count; 'current' does not.
function legacyIsOverdue(companyId) {
  return getSetting(companyId, 'legacy_debt_policy', 'overdue') !== 'current';
}

// Open debit items past due (days > minDays), legacy per the policy.
function overdueItems(companyId, shopId, { minDays = 0, asOf } = {}) {
  const legacyOverdue = legacyIsOverdue(companyId);
  return customerOpenItems(companyId, shopId, asOf || today()).filter(
    (it) => it.amount_minor > 0 && (it.bucket === 'legacy' ? legacyOverdue : it.days_overdue > minDays)
  );
}

// groupBy: customer | rep | region | branch
function agingReport(companyId, { asOf, groupBy = 'customer', repId, region, branch } = {}) {
  const date = asOf || today();
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  if (!['customer', 'rep', 'region', 'branch'].includes(groupBy)) fail('invalid_group', 'تجميع غير صالح');
  const d = digits(companyId);
  const where = ['s.company_id = ?'];
  const p = [companyId];
  if (repId) { where.push('s.assigned_rep_id = ?'); p.push(Number(repId)); }
  if (region) { where.push('s.region = ?'); p.push(String(region)); }
  if (branch) { where.push('s.branch = ?'); p.push(String(branch)); }
  const shops = db
    .prepare(`SELECT s.id, s.name, s.region, s.branch, s.assigned_rep_id, u.name AS rep_name FROM shops s LEFT JOIN users u ON u.id = s.assigned_rep_id WHERE ${where.join(' AND ')}`)
    .all(...p);
  const groups = new Map();
  const totals = emptyBuckets();
  for (const s of shops) {
    const items = customerOpenItems(companyId, s.id, date);
    if (!items.length) continue;
    const b = emptyBuckets();
    for (const it of items) {
      b[it.bucket] += it.amount_minor;
      b.total += it.amount_minor;
    }
    const key = groupBy === 'customer' ? s.id : groupBy === 'rep' ? s.assigned_rep_id ?? 0 : groupBy === 'region' ? s.region || '' : s.branch || '';
    const label = groupBy === 'customer' ? s.name : groupBy === 'rep' ? s.rep_name || '—' : (groupBy === 'region' ? s.region : s.branch) || '—';
    if (!groups.has(key)) groups.set(key, { key, label, customers: 0, ...emptyBuckets() });
    const g = groups.get(key);
    g.customers += 1;
    for (const k of Object.keys(b)) {
      g[k] += b[k];
      totals[k] += b[k];
    }
  }
  const ar = arId(companyId);
  const control = ar
    ? db
        .prepare(
          `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND e.entry_date <= ?`
        )
        .get(companyId, ar, date).s
    : 0;
  const filtered = !!(repId || region || branch);
  return {
    as_of: date,
    group_by: groupBy,
    buckets: [...BUCKETS, 'credits'],
    rows: [...groups.values()].sort((x, y) => y.total - x.total).map((r) => ({ ...r, total_fmt: fromMinor(r.total, d) })),
    totals,
    control_minor: control,
    // Lines on the AR account without a customer cannot be aged; they show
    // up here and on the reconciliation screen.
    unassigned_minor: filtered ? null : control - totals.total,
    digits: d,
  };
}

function customerAging(companyId, shopId, asOf) {
  const shop = owned(companyId, 'shop', shopId);
  const date = asOf || today();
  const d = digits(companyId);
  const items = customerOpenItems(companyId, shop.id, date).map((it) => ({ ...it, amount: fromMinor(it.amount_minor, d) }));
  const b = emptyBuckets();
  for (const it of items) {
    b[it.bucket] += it.amount_minor;
    b.total += it.amount_minor;
  }
  return { shop: { id: shop.id, name: shop.name }, as_of: date, items, totals: b, digits: d };
}

// ---------------------------------------------------------------------
// Collection forecast
// ---------------------------------------------------------------------

// Average days a customer pays after the due date, from its allocation
// history (amount-weighted). No history: company average, else 0.
function paymentDelayDays(companyId, shopId) {
  const rows = db
    .prepare(
      `SELECT COALESCE(a.base_paid_minor, a.amount_minor) AS amount_minor, a.allocation_date, COALESCE(i.due_date, i.invoice_date) AS due FROM receipt_allocations a
       JOIN sales_invoices i ON i.id = a.invoice_id JOIN customer_receipts r ON r.id = a.receipt_id
       WHERE a.company_id = ? AND r.status = 'posted' ${shopId ? 'AND i.shop_id = ?' : ''}`
    )
    .all(...(shopId ? [companyId, shopId] : [companyId]));
  let w = 0;
  let sum = 0;
  for (const r of rows) {
    w += r.amount_minor;
    sum += r.amount_minor * Math.max(0, daysBetween(r.due, r.allocation_date));
  }
  return w ? Math.round(sum / w) : null;
}

function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function collectionForecast(companyId, { weeks = 12 } = {}) {
  const asOf = today();
  const d = digits(companyId);
  const companyDelay = paymentDelayDays(companyId, null) ?? 0;
  const thisWeek = weekStart(asOf);
  const buckets = new Map();
  for (let i = 0; i < weeks; i++) {
    const dt = new Date(`${thisWeek}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + i * 7);
    const key = dt.toISOString().slice(0, 10);
    buckets.set(key, { week_start: key, amount_minor: 0, items: 0 });
  }
  const later = { week_start: 'later', amount_minor: 0, items: 0 };
  const customers = [];
  for (const s of db.prepare('SELECT id, name FROM shops WHERE company_id = ?').all(companyId)) {
    const items = customerOpenItems(companyId, s.id, asOf).filter((it) => it.amount_minor > 0);
    if (!items.length) continue;
    const delay = paymentDelayDays(companyId, s.id) ?? companyDelay;
    let expectedTotal = 0;
    for (const it of items) {
      const exp = new Date(`${it.due_date}T00:00:00Z`);
      exp.setUTCDate(exp.getUTCDate() + delay);
      let wk = weekStart(exp.toISOString().slice(0, 10));
      if (wk < thisWeek) wk = thisWeek; // overdue: expected now
      const b = buckets.get(wk) || later;
      b.amount_minor += it.amount_minor;
      b.items += 1;
      expectedTotal += it.amount_minor;
    }
    customers.push({ shop_id: s.id, shop_name: s.name, delay_days: delay, open_minor: expectedTotal });
  }
  const rows = [...buckets.values(), later].map((b) => ({ ...b, amount: fromMinor(b.amount_minor, d) }));
  return { as_of: asOf, company_delay_days: companyDelay, weeks: rows, customers: customers.sort((a, b) => b.open_minor - a.open_minor), digits: d };
}

// ---------------------------------------------------------------------
// Control account vs customer sub-ledger
// ---------------------------------------------------------------------

// asOf (default today): only entries dated <= asOf. The displayed-balance
// comparison is a "now" check, so it runs only for today's date.
function reconciliationCheck(companyId, { store = false, asOf } = {}) {
  const ar = arId(companyId);
  const d = digits(companyId);
  const date = asOf || today();
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  const isToday = date === today();
  if (!ar) return { check_date: date, control_minor: 0, subledger_minor: 0, difference_minor: 0, differences: [], digits: d };
  const control = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND e.entry_date <= ?`
    )
    .get(companyId, ar, date).s;
  const perParty = db
    .prepare(
      `SELECT l.party_type, l.party_id, s.id AS shop_id, s.name AS shop_name, SUM(l.debit_minor - l.credit_minor) AS ledger_minor
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN shops s ON s.id = l.party_id AND s.company_id = e.company_id AND l.party_type = 'customer'
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND e.entry_date <= ?
       GROUP BY l.party_type, l.party_id`
    )
    .all(companyId, ar, date);
  const live = require('./customerLedger').isLedgerLive(companyId);
  let subledger = 0;
  const differences = [];
  for (const r of perParty) {
    if (r.party_type === 'customer' && r.shop_id) {
      subledger += r.ledger_minor;
      // Live companies: the balance shown everywhere must equal the ledger.
      if (live && isToday) {
        const shown = db.prepare('SELECT balance FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(r.shop_id);
        const shownMinor = shown ? Math.round(shown.balance * 10 ** d) : 0;
        if (shownMinor !== r.ledger_minor) {
          differences.push({ type: 'displayed_balance', shop_id: r.shop_id, shop_name: r.shop_name, ledger_minor: r.ledger_minor, displayed_minor: shownMinor, difference_minor: shownMinor - r.ledger_minor });
        }
      }
    } else if (r.ledger_minor !== 0) {
      differences.push({
        type: r.party_type ? 'unknown_party' : 'no_customer',
        shop_id: null,
        shop_name: r.party_type ? `${r.party_type} #${r.party_id}` : null,
        ledger_minor: r.ledger_minor,
        difference_minor: r.ledger_minor,
      });
    }
  }
  const result = {
    check_date: date,
    live,
    control_minor: control,
    subledger_minor: subledger,
    difference_minor: control - subledger,
    differences,
    digits: d,
  };
  if (store && isToday) {
    db.prepare(
      `INSERT INTO ar_reconciliation_checks (company_id, check_date, control_minor, subledger_minor, difference_minor, difference_count, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, check_date) DO UPDATE SET control_minor = excluded.control_minor, subledger_minor = excluded.subledger_minor,
         difference_minor = excluded.difference_minor, difference_count = excluded.difference_count, details_json = excluded.details_json, created_at = datetime('now')`
    ).run(companyId, date, control, subledger, control - subledger, differences.length, JSON.stringify(differences));
  }
  return result;
}

function reconciliationHistory(companyId) {
  return db.prepare('SELECT * FROM ar_reconciliation_checks WHERE company_id = ? ORDER BY check_date DESC LIMIT 60').all(companyId);
}

// Daily sweep (server.js): one stored check per company per day; notifies
// when something does not reconcile.
function runDailyReconciliation() {
  for (const { id } of db.prepare("SELECT DISTINCT company_id AS id FROM accounts WHERE system_key = 'ar_control'").all()) {
    try {
      const r = reconciliationCheck(id, { store: true });
      if (r.difference_minor !== 0 || r.differences.length) {
        createNotification({
          companyId: id,
          type: 'ar_reconciliation_difference',
          message_ar: `مطابقة الذمم المدينة: ${r.differences.length} فرق بين حساب المراقبة ودفاتر الزبائن.`,
          message_en: `AR reconciliation: ${r.differences.length} difference(s) between the control account and customer ledgers.`,
          link_path: '/receivables/reconciliation',
          entity_type: 'company',
          entity_id: id,
        });
      }
    } catch (err) {
      console.error(`[receivables] daily reconciliation failed for company ${id}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------

function customerStatement(companyId, shopId, { from, to } = {}) {
  const shop = owned(companyId, 'shop', shopId);
  const end = to || today();
  const start = from || `${end.slice(0, 4)}-01-01`;
  if (!isValidDate(start) || !isValidDate(end) || start > end) fail('invalid_date', 'الفترة غير صالحة');
  const ar = arId(companyId);
  const d = digits(companyId);
  const before = (dt) =>
    ar
      ? db
          .prepare(
            `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
             WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'customer' AND l.party_id = ? AND e.entry_date < ?`
          )
          .get(companyId, ar, shop.id, dt).s
      : 0;
  const opening = before(start);
  const rows = ar
    ? db
        .prepare(
          `SELECT e.entry_date, e.entry_number, e.description, e.source_type, e.source_id, e.id AS entry_id, l.debit_minor, l.credit_minor
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'customer' AND l.party_id = ?
             AND e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date, e.id, l.line_no`
        )
        .all(companyId, ar, shop.id, start, end)
    : [];
  let running = opening;
  const lines = rows.map((r) => {
    running += r.debit_minor - r.credit_minor;
    return { ...r, debit: fromMinor(r.debit_minor, d), credit: fromMinor(r.credit_minor, d), running_minor: running, running: fromMinor(running, d) };
  });
  const totalDebit = rows.reduce((s, r) => s + r.debit_minor, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit_minor, 0);
  return {
    shop: { id: shop.id, name: shop.name, phone: shop.phone },
    company: db.prepare('SELECT name, currency FROM companies WHERE id = ?').get(companyId),
    from: start,
    to: end,
    opening_minor: opening,
    opening: fromMinor(opening, d),
    lines,
    total_debit: fromMinor(totalDebit, d),
    total_credit: fromMinor(totalCredit, d),
    closing_minor: running,
    closing: fromMinor(running, d),
    open_invoices: openInvoices(companyId, shop.id).map((i) => ({ invoice_number: i.invoice_number, invoice_date: i.invoice_date, due_date: i.due_date, open: fromMinor(i.open_minor, d) })),
  };
}

function statementWhatsappText(st) {
  const cur = st.company?.currency || '';
  const lines = [
    `مرحبًا ${st.shop.name}،`,
    `كشف حسابكم من ${st.from} إلى ${st.to}:`,
    `الرصيد الافتتاحي: ${st.opening} ${cur}`,
    `مجموع المدين: ${st.total_debit} — مجموع الدائن: ${st.total_credit}`,
    `الرصيد الختامي: ${st.closing} ${cur}`,
  ];
  if (st.open_invoices.length) {
    lines.push('الفواتير غير المسددة:');
    for (const i of st.open_invoices.slice(0, 10)) lines.push(`• ${i.invoice_number} (${i.invoice_date}) — ${i.open}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Dashboard figures (live companies) and credit check for invoices
// ---------------------------------------------------------------------

function dashboardFigures(companyId) {
  const ar = arId(companyId);
  if (!ar) return { receivables: 0, receivableShops: 0, overdueShops: 0 };
  const per = db
    .prepare(
      `SELECT l.party_id AS shop_id, SUM(l.debit_minor - l.credit_minor) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'customer' GROUP BY l.party_id`
    )
    .all(companyId, ar);
  const d = digits(companyId);
  const positive = per.filter((r) => r.b > 0);
  const asOf = today();
  let overdue = 0;
  for (const r of positive) {
    if (overdueItems(companyId, r.shop_id, { asOf }).length) overdue += 1;
  }
  return { receivables: Number(fromMinor(positive.reduce((s, r) => s + r.b, 0), d)), receivableShops: positive.length, overdueShops: overdue };
}

// Invoice credit check (company setting invoice_credit_policy: warn|block,
// default warn). Reuses lib/orderLifecycle.js limits (shop override, else
// company default) and the displayed balance (ledger-derived once live).
function invoiceCreditCheck(companyId, shop, totalMinor, { user, overrideReason } = {}) {
  const { checkCreditLimit } = require('./orderLifecycle');
  const total = Number(fromMinor(totalMinor, digits(companyId)));
  const check = checkCreditLimit(companyId, shop, total);
  // Overdue debt (legacy included per legacy_debt_policy) triggers the same
  // warn/block as a limit breach.
  const overdue = overdueItems(companyId, shop.id);
  const overdueMinor = overdue.reduce((t, it) => t + it.amount_minor, 0);
  if (!check.exceeded && !overdueMinor) return { exceeded: false };
  const policy = getSetting(companyId, 'invoice_credit_policy', 'warn') === 'block' ? 'block' : 'warn';
  const info = {
    exceeded: true, policy, limit: check.limit ?? null, projected_balance: check.projectedBalance ?? null,
    reasons: [...(check.exceeded ? ['credit_limit'] : []), ...(overdueMinor ? ['overdue_debt'] : [])],
    overdue_minor: overdueMinor, overdue_legacy: overdue.some((it) => it.bucket === 'legacy'),
  };
  if (policy === 'warn') return { ...info, warning: true };
  const canOverride = user?.permissions?.includes('override_credit_limit');
  if (canOverride && String(overrideReason || '').trim()) return { ...info, overridden: true, override_reason: String(overrideReason).trim() };
  const why = check.exceeded ? 'تتجاوز الفاتورة الحد الائتماني للزبون' : 'على الزبون ديون متأخرة السداد';
  fail(canOverride ? 'credit_override_reason_required' : 'credit_limit_blocked', canOverride ? `${why} — اذكر سبب التجاوز` : why, 403, info);
}

module.exports = {
  ReceivablesError,
  invoiceOpenMinor,
  openInvoices,
  getReceipt,
  listReceipts,
  createReceipt,
  autoAllocate,
  setAllocations,
  reverseReceipt,
  onEntryReversed,
  backfillCollectionReceipts,
  listCheques,
  receiveCheque,
  depositCheque,
  clearCheque,
  bounceCheque,
  customerOpenItems,
  overdueItems,
  legacyIsOverdue,
  agingReport,
  customerAging,
  collectionForecast,
  reconciliationCheck,
  reconciliationHistory,
  runDailyReconciliation,
  customerStatement,
  statementWhatsappText,
  dashboardFigures,
  invoiceCreditCheck,
};
