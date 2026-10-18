// backend/lib/payables.js
//
// Payables (Prompt 6): supplier invoices with three-way match (PO vs goods
// receipt vs invoice, tolerance settings, approve_purchase_mismatch),
// landed cost allocated to receipt lines (value / weight / quantity) and
// added to item cost, supplier payments with allocation and realized FX,
// debit notes (purchase returns), payables aging, supplier statement, the
// AP control vs sub-ledger reconciliation and the purchasing reports.
//
// Postings (all through lib/ledger.js):
//   goods invoice   Dr GRNI (cleared at the receipt value) / Dr|Cr PPV /
//                   Dr input tax / Cr AP (supplier, invoice currency)
//   landed cost     Dr inventory (allocated) / Dr input tax / Cr AP
//   expense invoice Dr expense accounts / Dr input tax / Cr AP
//   payment         Dr AP (supplier) / Cr cash | bank-in-transit
//   payment vs invoice in another rate: realized FX -> fx_realized
//   debit note      Dr AP / Cr inventory / Cr input tax (invoice rate)

const db = require('../db/init');
const ledger = require('./ledger');
const fx = require('./fxRate');
const P = require('./purchasing');
const { logAudit } = require('./auditLog');
const { toMinor, fromMinor } = require('./ledgerCurrencies');
const { checkpoint } = require('./faultInjection');
const TC = require('./taxCodes');

const { fail, owned, optionalOwned } = P;
const today = () => new Date().toISOString().slice(0, 10);
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const ONE_E8 = 100000000;
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------
// Supplier invoices
// ---------------------------------------------------------------------

function invoiceOpenMinor(inv) {
  const paid = db
    .prepare(`SELECT COALESCE(SUM(a.amount_minor), 0) s FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? AND p.status = 'posted'`)
    .get(inv.id).s;
  return inv.total_minor - inv.debited_minor - paid;
}
// Base the invoice still carries on AP: its base total - debit notes' base
// - base relieved by payments.
function invoiceBaseOpen(inv) {
  const debited = db.prepare('SELECT COALESCE(SUM(total_base_minor), 0) s FROM supplier_debit_notes WHERE invoice_id = ?').get(inv.id).s;
  const relieved = db
    .prepare(`SELECT COALESCE(SUM(a.base_relieved_minor), 0) s FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? AND p.status = 'posted'`)
    .get(inv.id).s;
  return (inv.total_base_minor ?? 0) - debited - relieved;
}

function getInvoice(companyId, id) {
  const inv = owned(companyId, 'supplier_invoice', id);
  const cur = P.currencyOf(companyId, inv.currency_code);
  return {
    ...inv,
    digits: cur.minor_unit_digits,
    supplier: db.prepare('SELECT id, name, payment_terms_days FROM suppliers WHERE id = ?').get(inv.supplier_id),
    purchase_order: inv.po_id ? db.prepare('SELECT id, po_number FROM purchase_orders WHERE id = ?').get(inv.po_id) : null,
    receipt: inv.receipt_id ? db.prepare('SELECT id, receipt_number FROM goods_receipts WHERE id = ?').get(inv.receipt_id) : null,
    lines: db.prepare('SELECT l.*, p.name AS product_name, a.code AS expense_account_code FROM supplier_invoice_lines l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN accounts a ON a.id = l.expense_account_id WHERE l.invoice_id = ? ORDER BY l.line_no').all(inv.id),
    match: inv.match_details_json ? JSON.parse(inv.match_details_json) : null,
    open_minor: inv.status === 'posted' ? invoiceOpenMinor(inv) : null,
    base_open_minor: inv.status === 'posted' ? invoiceBaseOpen(inv) : null,
    exchange_rate: inv.rate_e8 ? fx.formatRate(inv.rate_e8) : null,
    landed_allocations: inv.kind === 'landed_cost' ? db.prepare('SELECT a.*, l.description FROM landed_cost_allocations a JOIN goods_receipt_lines l ON l.id = a.receipt_line_id WHERE a.invoice_id = ?').all(inv.id) : [],
    payments: db.prepare('SELECT a.*, p.payment_number, p.payment_date FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? AND p.status = ?').all(inv.id, 'posted'),
    debit_notes: db.prepare('SELECT id, debit_note_number, note_date, total_minor FROM supplier_debit_notes WHERE invoice_id = ?').all(inv.id),
    journal_entry: inv.journal_entry_id ? db.prepare('SELECT id, entry_number FROM journal_entries WHERE id = ?').get(inv.journal_entry_id) : null,
  };
}

function listInvoices(companyId, { status, supplierId, kind, match } = {}) {
  const where = ['i.company_id = ?'];
  const p = [companyId];
  if (status) { where.push('i.status = ?'); p.push(String(status)); }
  if (kind) { where.push('i.kind = ?'); p.push(String(kind)); }
  if (match) { where.push('i.match_status = ?'); p.push(String(match)); }
  if (supplierId) { where.push('i.supplier_id = ?'); p.push(owned(companyId, 'supplier', supplierId).id); }
  return db
    .prepare(`SELECT i.*, s.name AS supplier_name FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE ${where.join(' AND ')} ORDER BY i.invoice_date DESC, i.id DESC LIMIT 500`)
    .all(...p)
    .map((i) => ({ ...i, open_minor: i.status === 'posted' ? invoiceOpenMinor(i) : null }));
}

// input: { supplierId, kind, poId?, receiptId?, landedMethod?, invoiceDate,
//   dueDate?, supplierInvoiceRef, currencyCode?, notes,
//   lines: goods [{ poLineId, qty, unitPrice, taxRate? }]
//          expense [{ description, qty, unitPrice, taxRate?, expenseAccountId }]
//          landed_cost [{ description, landedKind, qty: 1, unitPrice, taxRate? }] }
function saveInvoice(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const existing = id ? owned(companyId, 'supplier_invoice', id) : null;
    if (existing && existing.status !== 'draft') fail('invoice_not_draft', 'الفاتورة المرحّلة لا تُعدّل — استخدم إشعار مدين', 409);
    const kind = input.kind || existing?.kind || 'goods';
    if (!['goods', 'landed_cost', 'expense'].includes(kind)) fail('invalid_kind', 'نوع الفاتورة غير صالح');
    const supplier = owned(companyId, 'supplier', input.supplierId ?? existing?.supplier_id, { active: !existing });
    const date = input.invoiceDate || existing?.invoice_date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const due = input.dueDate !== undefined ? input.dueDate || null : existing?.due_date ?? null;
    const dueDate = due || addDays(date, supplier.payment_terms_days ?? 30);
    if (!isValidDate(dueDate) || dueDate < date) fail('invalid_due_date', 'تاريخ الاستحقاق غير صالح');
    let po = null;
    let receipt = null;
    let method = null;
    if (kind === 'goods') {
      po = owned(companyId, 'purchase_order', input.poId ?? existing?.po_id);
      if (po.supplier_id !== supplier.id) fail('po_supplier_mismatch', 'أمر الشراء لا يخص هذا المورد');
      if (!['approved', 'partially_received', 'received', 'closed'].includes(po.status)) fail('po_not_approved', 'أمر الشراء غير معتمد', 409);
    } else if (kind === 'landed_cost') {
      receipt = owned(companyId, 'goods_receipt', input.receiptId ?? existing?.receipt_id);
      method = input.landedMethod || existing?.landed_method || 'value';
      if (!['value', 'weight', 'quantity'].includes(method)) fail('invalid_landed_method', 'طريقة توزيع التكاليف غير صالحة');
    }
    const cur = P.currencyOf(companyId, kind === 'goods' ? po.currency_code : input.currencyCode || existing?.currency_code || supplier.currency_code);
    if (kind === 'goods' && input.currencyCode && String(input.currencyCode).toUpperCase() !== po.currency_code) fail('currency_mismatch', 'عملة الفاتورة يجب أن تطابق أمر الشراء');
    let lines = null;
    if (input.lines !== undefined || !existing) {
      const raw = (input.lines || []).map((l) => ({ ...l, productId: undefined }));
      lines = P.priceLines(companyId, raw.map((l, i) => {
        if (kind === 'expense' && l.taxCodeId) {
          // Prompt 10: a purchase tax code sets the rate on the invoice date.
          const t = TC.resolve(companyId, l.taxCodeId, 'purchase', date, i + 1);
          return { ...l, taxRate: t.rate_bp / 100, _tax: t };
        }
        if (kind !== 'goods') return l;
        const pl = db.prepare('SELECT * FROM purchase_order_lines WHERE id = ? AND company_id = ? AND po_id = ?').get(Number(l.poLineId), companyId, po.id);
        if (!pl) fail('invalid_po_line', `السطر ${i + 1}: سطر أمر الشراء غير موجود`);
        // A purchase tax code on a goods line: base-currency invoices only (a
        // foreign-currency goods invoice posts its tax as one converted
        // amount, so it keeps the free rate).
        if (l.taxCodeId) {
          if (cur.code !== P.base(companyId).code) fail('tax_code_foreign_goods', `السطر ${i + 1}: رمز الضريبة لفواتير البضاعة بالعملة الأساسية فقط — استخدم النسبة الحرة`);
          const t = TC.resolve(companyId, l.taxCodeId, 'purchase', date, i + 1);
          return { ...l, description: l.description || pl.description, unitPrice: l.unitPrice ?? undefined, unitPriceMinor: l.unitPrice === undefined || l.unitPrice === '' ? pl.unit_price_minor : undefined, taxRate: t.rate_bp / 100, _tax: t, _pl: pl };
        }
        return { ...l, description: l.description || pl.description, unitPrice: l.unitPrice ?? undefined, unitPriceMinor: l.unitPrice === undefined || l.unitPrice === '' ? pl.unit_price_minor : undefined, taxRate: l.taxRate ?? fromMinor(pl.tax_rate_bp, 2), _pl: pl };
      }), cur.minor_unit_digits, { withProductCheck: false });
      for (const [i, l] of lines.entries()) {
        const n = i + 1;
        l.po_line_id = l.raw._pl?.id ?? null;
        l.product_id = l.raw._pl?.product_id ?? null;
        l.expense_account_id = null;
        l.landed_kind = null;
        l._tax = l.raw._tax || null;
        l._asset = null;
        if (kind === 'expense' && l.raw.asset) {
          // Prompt 10: the line becomes a fixed asset when the invoice posts;
          // it is debited to the category's asset account.
          const sp = l.raw.asset;
          const cat = db.prepare('SELECT * FROM fa_categories WHERE id = ? AND company_id = ? AND active = 1').get(Number(sp.categoryId), companyId);
          if (!cat) fail('invalid_category', `السطر ${n}: فئة الأصل غير موجودة أو لا تتبع لهذه الشركة`);
          const life = sp.usefulLifeMonths ?? cat.default_life_months;
          if (!(Number.isInteger(Number(life)) && Number(life) > 0)) fail('invalid_life', `السطر ${n}: العمر الإنتاجي مطلوب`);
          if (sp.method && !['straight_line', 'declining_balance'].includes(sp.method)) fail('invalid_method', `السطر ${n}: طريقة الإهلاك غير صالحة`);
          l.expense_account_id = cat.asset_account_id;
          l._asset = { category_id: cat.id, name: sp.name ? String(sp.name).trim() : null, useful_life_months: Number(life), salvage_minor: sp.salvage !== undefined && sp.salvage !== '' ? toMinor(sp.salvage, cur.minor_unit_digits) : Number(sp.salvageMinor || 0), method: sp.method || null };
          continue;
        }
        if (kind === 'expense') {
          const acc = owned(companyId, 'account', l.raw.expenseAccountId, { active: true });
          if (!acc.is_postable || !['expense', 'asset'].includes(acc.type)) fail('invalid_expense_account', `السطر ${n}: اختر حساب مصروف أو أصل فرعي`);
          l.expense_account_id = acc.id;
        }
        if (kind === 'landed_cost') {
          l.landed_kind = l.raw.landedKind || 'other';
          if (!['shipping', 'customs', 'transport', 'insurance', 'other'].includes(l.landed_kind)) fail('invalid_landed_kind', `السطر ${n}: نوع التكلفة غير صالح`);
        }
      }
    }
    const ref = input.supplierInvoiceRef !== undefined ? String(input.supplierInvoiceRef || '').trim() || null : existing?.supplier_invoice_ref ?? null;
    if (ref && db.prepare("SELECT 1 FROM supplier_invoices WHERE company_id = ? AND supplier_id = ? AND supplier_invoice_ref = ? AND status <> 'cancelled' AND id <> ?").get(companyId, supplier.id, ref, existing?.id ?? 0)) {
      fail('duplicate_supplier_invoice', `فاتورة المورد رقم ${ref} مسجلة مسبقًا`, 409);
    }
    const header = [supplier.id, kind, po?.id ?? null, receipt?.id ?? null, method, date, dueDate, cur.code, ref, input.notes !== undefined ? input.notes || null : existing?.notes ?? null];
    let iid = existing?.id;
    if (existing) {
      db.prepare("UPDATE supplier_invoices SET supplier_id = ?, kind = ?, po_id = ?, receipt_id = ?, landed_method = ?, invoice_date = ?, due_date = ?, currency_code = ?, supplier_invoice_ref = ?, notes = ?, match_status = 'not_checked', match_details_json = NULL, mismatch_approved_by = NULL, mismatch_approved_at = NULL, updated_at = datetime('now') WHERE id = ?").run(...header, iid);
    } else {
      iid = Number(db.prepare('INSERT INTO supplier_invoices (company_id, supplier_id, kind, po_id, receipt_id, landed_method, invoice_date, due_date, currency_code, supplier_invoice_ref, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, ...header, actor?.id ?? null).lastInsertRowid);
    }
    if (lines) {
      const oldIds = db.prepare('SELECT id FROM supplier_invoice_lines WHERE invoice_id = ?').all(iid).map((r) => r.id);
      TC.clearDocumentLines('supplier_invoice_line', oldIds);
      for (const lid of oldIds) db.prepare('DELETE FROM supplier_invoice_line_assets WHERE invoice_line_id = ?').run(lid);
      db.prepare('DELETE FROM supplier_invoice_lines WHERE invoice_id = ?').run(iid);
      const ins = db.prepare('INSERT INTO supplier_invoice_lines (company_id, invoice_id, line_no, po_line_id, product_id, description, qty, unit_price_minor, tax_rate_bp, net_minor, tax_minor, expense_account_id, landed_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const l of lines) {
        const lid = Number(ins.run(companyId, iid, l.line_no, l.po_line_id, l.product_id, l.description, l.qty, l.unit_price_minor, l.tax_rate_bp, l.net_minor, l.tax_minor, l.expense_account_id, l.landed_kind).lastInsertRowid);
        if (l._tax) TC.linkLine(companyId, 'supplier_invoice_line', lid, l._tax);
        if (l._asset) db.prepare('INSERT INTO supplier_invoice_line_assets (company_id, invoice_line_id, category_id, name, useful_life_months, salvage_minor, method) VALUES (?, ?, ?, ?, ?, ?, ?)').run(companyId, lid, l._asset.category_id, l._asset.name, l._asset.useful_life_months, l._asset.salvage_minor, l._asset.method);
      }
      const sub = lines.reduce((s, l) => s + l.net_minor, 0);
      const tax = lines.reduce((s, l) => s + l.tax_minor, 0);
      db.prepare('UPDATE supplier_invoices SET subtotal_minor = ?, tax_minor = ?, total_minor = ? WHERE id = ?').run(sub, tax, sub + tax, iid);
    }
    if (kind !== 'goods') db.prepare("UPDATE supplier_invoices SET match_status = 'not_required' WHERE id = ?").run(iid);
    else threeWayMatch(companyId, iid, { store: true });
    const after = getInvoice(companyId, iid);
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'payables.invoice.update' : 'payables.invoice.create', entityType: 'supplier_invoice', entityId: iid, before: existing, after });
    return after;
  });
}

function deleteInvoice(companyId, id, actor) {
  return ledger.transaction(() => {
    const inv = owned(companyId, 'supplier_invoice', id);
    if (inv.status !== 'draft') fail('invoice_not_draft', 'لا تُحذف إلا المسودة', 409);
    db.prepare('DELETE FROM supplier_invoice_lines WHERE invoice_id = ?').run(inv.id);
    db.prepare('DELETE FROM supplier_invoices WHERE id = ?').run(inv.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.invoice.delete', entityType: 'supplier_invoice', entityId: inv.id, before: inv, after: null });
    return { ok: true };
  });
}

// Three-way match per goods line: quantity invoiced vs quantity received
// and not yet invoiced (accepted qty), price vs PO price. Tolerances:
// settings purchase_qty_tolerance_bp, purchase_price_tolerance_bp (basis
// points; default 0 qty / 200 = 2% price).
function threeWayMatch(companyId, invoiceId, { store = false } = {}) {
  const inv = db.prepare('SELECT * FROM supplier_invoices WHERE id = ? AND company_id = ?').get(invoiceId, companyId);
  if (inv.kind !== 'goods') return { status: 'not_required', lines: [] };
  const qtyTol = Number(P.getSetting(companyId, 'purchase_qty_tolerance_bp', '0'));
  const priceTol = Number(P.getSetting(companyId, 'purchase_price_tolerance_bp', '200'));
  const lines = db.prepare('SELECT * FROM supplier_invoice_lines WHERE invoice_id = ? ORDER BY line_no').all(invoiceId);
  // Draft invoices on the same PO line compete for the same received qty.
  const results = lines.map((l) => {
    const pl = db.prepare('SELECT * FROM purchase_order_lines WHERE id = ?').get(l.po_line_id);
    const available = Math.round((pl.received_qty - pl.invoiced_qty) * 1000) / 1000;
    const issues = [];
    if (l.qty > available * (1 + qtyTol / 10000) + 1e-9) issues.push({ type: 'qty', invoiced: l.qty, received_not_invoiced: available, ordered: pl.qty });
    const diff = Math.abs(l.unit_price_minor - pl.unit_price_minor);
    if (diff * 10000 > pl.unit_price_minor * priceTol) issues.push({ type: 'price', invoiced: l.unit_price_minor, ordered: pl.unit_price_minor, diff_bp: pl.unit_price_minor ? Math.round((diff * 10000) / pl.unit_price_minor) : null });
    return { line_no: l.line_no, po_line_id: pl.id, description: l.description, ok: !issues.length, issues };
  });
  const ok = results.every((r) => r.ok);
  const details = { checked_at: new Date().toISOString(), qty_tolerance_bp: qtyTol, price_tolerance_bp: priceTol, lines: results };
  if (store) {
    const keepApproved = inv.match_status === 'approved' && !ok;
    db.prepare('UPDATE supplier_invoices SET match_status = ?, match_details_json = ? WHERE id = ?').run(keepApproved ? 'approved' : ok ? 'matched' : 'mismatch', JSON.stringify(details), invoiceId);
  }
  return { status: ok ? 'matched' : 'mismatch', ...details };
}

function approveMismatch(companyId, id, { reason } = {}, actor) {
  return ledger.transaction(() => {
    const inv = owned(companyId, 'supplier_invoice', id);
    if (inv.status !== 'draft') fail('invoice_not_draft', 'الفاتورة ليست مسودة', 409);
    const m = threeWayMatch(companyId, inv.id, { store: true });
    if (m.status !== 'mismatch') fail('no_mismatch', 'لا توجد فروقات تحتاج موافقة', 409);
    if (!String(reason || '').trim()) fail('reason_required', 'سبب الموافقة مطلوب');
    db.prepare("UPDATE supplier_invoices SET match_status = 'approved', mismatch_approved_by = ?, mismatch_approved_at = datetime('now'), mismatch_reason = ? WHERE id = ?").run(actor?.id ?? null, String(reason).trim(), inv.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.invoice.approve_mismatch', entityType: 'supplier_invoice', entityId: inv.id, before: { match_status: 'mismatch' }, after: { match_status: 'approved', reason, details: m.lines } });
    return getInvoice(companyId, inv.id);
  });
}

// Largest-remainder split of `total` over weights (exact sum).
function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) return null;
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((x) => Math.floor(x));
  let rest = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < order.length && rest > 0; k += 1, rest -= 1) out[order[k][1]] += 1;
  return out;
}

// Converts doc-currency parts to ledger lines; base-only parts pass
// through; rounding residue -> rounding_difference (balances exactly).
function fxLines(companyId, parts, cur, rate) {
  const b = P.base(companyId);
  const out = parts.filter((p) => p.amount).map((p) => {
    if (p.base || cur.code === b.code) return { accountId: p.accountId, debitMinor: p.side === 'debit' ? p.amount : 0, creditMinor: p.side === 'credit' ? p.amount : 0, partyType: p.partyType || null, partyId: p.partyId || null, memo: p.memo || null };
    const baseMinor = p.baseOverride ?? P.toBase(companyId, cur.code, p.amount, rate);
    return { accountId: p.accountId, currencyCode: cur.code, amountOriginalMinor: p.amount, rateE8: rate.rateE8, rateQuote: rate.quote, debitMinor: p.side === 'debit' ? baseMinor : 0, creditMinor: p.side === 'credit' ? baseMinor : 0, partyType: p.partyType || null, partyId: p.partyId || null, memo: p.memo || null };
  }).filter((l) => l.debitMinor || l.creditMinor);
  const diff = out.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
  if (diff) out.push({ accountId: P.systemAccount(companyId, 'rounding_difference'), debitMinor: diff < 0 ? -diff : 0, creditMinor: diff > 0 ? diff : 0, memo: 'فرق تقريب تحويل العملات' });
  return out;
}

function postInvoice(companyId, id, { exchangeRate, rateQuote } = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const inv = owned(companyId, 'supplier_invoice', id);
    if (inv.status !== 'draft') fail('invoice_not_draft', 'الفاتورة ليست مسودة', 409);
    if (inv.total_minor <= 0) fail('zero_total', 'فاتورة بقيمة صفر');
    TC.requirePriceModeChosen(companyId, inv.tax_minor);
    const lines = db.prepare('SELECT * FROM supplier_invoice_lines WHERE invoice_id = ? ORDER BY line_no').all(inv.id);
    if (inv.kind === 'goods') {
      const m = threeWayMatch(companyId, inv.id, { store: true });
      const status = db.prepare('SELECT match_status FROM supplier_invoices WHERE id = ?').get(inv.id).match_status;
      if (m.status === 'mismatch' && status !== 'approved') {
        fail('three_way_mismatch', 'الفاتورة لا تطابق أمر الشراء والاستلام — تحتاج موافقة approve_purchase_mismatch قبل الترحيل', 409, { match: m.lines.filter((l) => !l.ok) });
      }
    }
    const cur = P.currencyOf(companyId, inv.currency_code);
    const rate = P.docRate(companyId, cur.code, inv.invoice_date, { exchangeRate, rateQuote }, actor);
    const ap = P.systemAccount(companyId, 'ap_control');
    const number = P.issueNumber(companyId, 'PI', 'PI-');
    const totalBase = P.toBase(companyId, cur.code, inv.total_minor, rate);
    const taxBase = inv.tax_minor ? P.toBase(companyId, cur.code, inv.tax_minor, rate) : 0;
    const supplierParty = { partyType: 'supplier', partyId: inv.supplier_id };
    let jl;
    let landedMovesAll = [];
    const lineUpdates = [];
    if (inv.kind === 'goods') {
      // Clear GRNI at the receipt value, FIFO over the PO line's receipts.
      // Each cleared portion is also valued at ITS receipt's rate, which
      // splits the line's difference in two:
      //   price: invoice amount @ receipt rate - GRNI cleared -> PPV
      //   rate:  invoice amount @ invoice rate - same @ receipt rate -> fx_realized
      // (same quantity, so the rate part is purely exchange-rate movement).
      let grniTotal = 0;
      let ppvTotal = 0;
      let fxTotal = 0;
      for (const l of lines) {
        let need = l.qty;
        let cleared = 0;
        let atReceiptRate = 0;
        let docLeft = l.net_minor;
        const rls = db
          .prepare('SELECT gl.*, g.rate_e8 AS g_rate_e8, g.rate_quote AS g_rate_quote FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id WHERE gl.po_line_id = ? ORDER BY g.receipt_date, gl.id')
          .all(l.po_line_id);
        for (const rl of rls) {
          if (need <= 1e-9) break;
          const accepted = Math.round((rl.qty - rl.rejected_qty) * 1000) / 1000;
          const avail = Math.round((accepted - rl.invoiced_qty) * 1000) / 1000;
          if (avail <= 1e-9) continue;
          const take = Math.min(avail, need);
          const last = Math.abs(take - avail) < 1e-9;
          const part = last ? rl.value_base_minor - rl.grni_cleared_base_minor : Math.round((rl.value_base_minor * take) / accepted);
          db.prepare('UPDATE goods_receipt_lines SET invoiced_qty = invoiced_qty + ?, grni_cleared_base_minor = grni_cleared_base_minor + ? WHERE id = ?').run(take, part, rl.id);
          cleared += part;
          need = Math.round((need - take) * 1000) / 1000;
          const lastPortion = need <= 1e-9;
          const docPart = lastPortion ? docLeft : Math.round((l.net_minor * take) / l.qty);
          docLeft -= docPart;
          atReceiptRate += P.toBase(companyId, cur.code, docPart, P.rateOf({ rate_e8: rl.g_rate_e8, rate_quote: rl.g_rate_quote }));
        }
        if (docLeft) atReceiptRate += P.toBase(companyId, cur.code, docLeft, rate);
        const lineBase = P.toBase(companyId, cur.code, l.net_minor, rate);
        const ppv = atReceiptRate - cleared;
        const fx = lineBase - atReceiptRate;
        grniTotal += cleared;
        ppvTotal += ppv;
        fxTotal += fx;
        lineUpdates.push({ id: l.id, lineBase, cleared, ppv, fx });
        db.prepare('UPDATE purchase_order_lines SET invoiced_qty = invoiced_qty + ? WHERE id = ?').run(l.qty, l.po_line_id);
        P.recordPrice(companyId, { supplierId: inv.supplier_id, productId: l.product_id, description: l.description, date: inv.invoice_date, currencyCode: cur.code, unitMinor: l.unit_price_minor, unitBaseMinor: P.toBase(companyId, cur.code, l.unit_price_minor, rate), sourceType: 'supplier_invoice', sourceId: inv.id });
      }
      // Per-line rounding vs the header total goes to rounding_difference.
      const dust = totalBase - taxBase - grniTotal - ppvTotal - fxTotal;
      jl = [
        { accountId: ap, creditMinor: totalBase, currencyCode: cur.code, amountOriginalMinor: inv.total_minor, rateE8: rate.rateE8, rateQuote: rate.quote, ...supplierParty, memo: `فاتورة مورد ${inv.supplier_invoice_ref || number}` },
        ...(grniTotal ? [{ accountId: P.systemAccount(companyId, 'grni'), debitMinor: grniTotal, memo: 'تسوية بضاعة مستلمة' }] : []),
        // Coded goods lines (base currency only): tax per code account; else
        // the single input_tax line exactly as before.
        ...(taxBase && lines.some((l) => TC.lineTax('supplier_invoice_line', l.id))
          ? TC.taxByAccount('supplier_invoice_line', lines, P.systemAccount(companyId, 'input_tax')).map((t) => ({ accountId: t.accountId, debitMinor: t.amount }))
          : taxBase ? [{ accountId: P.systemAccount(companyId, 'input_tax'), debitMinor: taxBase, currencyCode: cur.code, amountOriginalMinor: inv.tax_minor, rateE8: rate.rateE8, rateQuote: rate.quote }] : []),
        ...(ppvTotal ? [{ accountId: P.systemAccount(companyId, 'purchase_price_variance'), debitMinor: ppvTotal > 0 ? ppvTotal : 0, creditMinor: ppvTotal < 0 ? -ppvTotal : 0, memo: 'فرق سعر الشراء' }] : []),
        ...(fxTotal ? [{ accountId: P.systemAccount(companyId, 'fx_realized'), debitMinor: fxTotal > 0 ? fxTotal : 0, creditMinor: fxTotal < 0 ? -fxTotal : 0, memo: 'فرق سعر الصرف بين الاستلام والفاتورة' }] : []),
        ...(dust ? [{ accountId: P.systemAccount(companyId, 'rounding_difference'), debitMinor: dust > 0 ? dust : 0, creditMinor: dust < 0 ? -dust : 0, memo: 'فرق تقريب تحويل العملات' }] : []),
      ];
      if (cur.code === P.base(companyId).code) for (const l of jl) { delete l.currencyCode; delete l.amountOriginalMinor; delete l.rateE8; delete l.rateQuote; }
    } else if (inv.kind === 'expense') {
      const parts = [
        ...lines.map((l) => ({ accountId: l.expense_account_id, side: 'debit', amount: l.net_minor, memo: l.description })),
        ...TC.taxByAccount('supplier_invoice_line', lines, P.systemAccount(companyId, 'input_tax')).map((t) => ({ accountId: t.accountId, side: 'debit', amount: t.amount })),
        { accountId: ap, side: 'credit', amount: inv.total_minor, ...supplierParty, memo: `فاتورة مورد ${inv.supplier_invoice_ref || number}` },
      ];
      jl = fxLines(companyId, parts, cur, rate);
    } else {
      // Landed cost: net (no tax) in base, allocated to the receipt's lines.
      const receipt = db.prepare('SELECT * FROM goods_receipts WHERE id = ?').get(inv.receipt_id);
      const rls = db.prepare('SELECT gl.*, p.box_weight_grams FROM goods_receipt_lines gl LEFT JOIN products p ON p.id = gl.product_id WHERE gl.receipt_id = ? ORDER BY gl.line_no').all(receipt.id);
      const netBase = totalBase - taxBase;
      const basisOf = (rl) => {
        const accepted = rl.qty - rl.rejected_qty;
        if (inv.landed_method === 'value') return rl.value_base_minor;
        if (inv.landed_method === 'quantity') return accepted;
        if (rl.weight_kg !== null && rl.weight_kg !== undefined) return rl.weight_kg;
        return rl.box_weight_grams ? (rl.box_weight_grams * accepted) / 1000 : 0;
      };
      const weights = rls.map(basisOf);
      const shares = allocate(netBase, weights);
      if (!shares) fail('landed_basis_zero', inv.landed_method === 'weight' ? 'لا يوجد وزن لسطور الاستلام — أدخل الوزن أو اختر طريقة أخرى' : 'لا يوجد أساس لتوزيع التكلفة', 409);
      const stockOn = require('./stockLedger').isActive(companyId);
      const landedLines = [];
      const landedMoves = [];
      for (const [k, rl] of rls.entries()) {
        if (!shares[k]) continue;
        const accepted = rl.qty - rl.rejected_qty;
        if (stockOn && rl.product_id) {
          // Prompt 8: to the stock still on hand from this receipt line; the
          // share of quantity already gone -> COGS (standard: PPV).
          const r = require('./stockDocs').landedCost(companyId, { receipt, receiptLine: rl, share: shares[k], invoiceId: inv.id, date: inv.invoice_date }, actor);
          landedLines.push(...r.lines);
          landedMoves.push(...r.moveIds);
          db.prepare('INSERT INTO landed_cost_allocations (company_id, invoice_id, receipt_line_id, method, basis, amount_base_minor, product_cost_before, product_cost_after) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)').run(companyId, inv.id, rl.id, inv.landed_method, weights[k], shares[k]);
          db.prepare('UPDATE goods_receipt_lines SET landed_base_minor = landed_base_minor + ? WHERE id = ?').run(shares[k], rl.id);
          continue;
        }
        const change = P.addCostOnly(companyId, rl.product_id, shares[k], accepted);
        db.prepare('INSERT INTO landed_cost_allocations (company_id, invoice_id, receipt_line_id, method, basis, amount_base_minor, product_cost_before, product_cost_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(companyId, inv.id, rl.id, inv.landed_method, weights[k], shares[k], change?.before ?? null, change?.after ?? null);
        db.prepare('UPDATE goods_receipt_lines SET landed_base_minor = landed_base_minor + ? WHERE id = ?').run(shares[k], rl.id);
      }
      db.prepare('UPDATE goods_receipts SET landed_base_minor = landed_base_minor + ? WHERE id = ?').run(netBase, receipt.id);
      landedMovesAll = landedMoves;
      jl = [
        { accountId: ap, creditMinor: totalBase, currencyCode: cur.code, amountOriginalMinor: inv.total_minor, rateE8: rate.rateE8, rateQuote: rate.quote, ...supplierParty, memo: `تكاليف شحن/جمارك — ${receipt.receipt_number}` },
        ...(stockOn
          ? [...landedLines, ...(netBase - landedLines.reduce((t, x) => t + x.debitMinor, 0) ? [{ accountId: P.systemAccount(companyId, 'inventory'), debitMinor: netBase - landedLines.reduce((t, x) => t + x.debitMinor, 0), memo: `تكاليف إضافية على ${receipt.receipt_number}` }] : [])]
          : [{ accountId: P.systemAccount(companyId, 'inventory'), debitMinor: netBase, memo: `تكاليف إضافية على ${receipt.receipt_number}` }]),
        ...(taxBase ? [{ accountId: P.systemAccount(companyId, 'input_tax'), debitMinor: taxBase, currencyCode: cur.code, amountOriginalMinor: inv.tax_minor, rateE8: rate.rateE8, rateQuote: rate.quote }] : []),
      ];
      if (cur.code === P.base(companyId).code) for (const l of jl) { delete l.currencyCode; delete l.amountOriginalMinor; delete l.rateE8; delete l.rateQuote; }
    }
    const entry = ledger.postEntry(companyId, { date: inv.invoice_date, description: `فاتورة مورد ${number}${inv.supplier_invoice_ref ? ` (${inv.supplier_invoice_ref})` : ''}`, sourceType: 'supplier_invoice', sourceId: inv.id, lines: jl }, actor);
    if (landedMovesAll.length) db.prepare(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${landedMovesAll.map(() => '?').join(',')})`).run(entry.id, ...landedMovesAll);
    if (inv.kind === 'expense') {
      // Prompt 10: asset lines -> the register (cost = the line's base amount).
      for (const l of lines) {
        const spec = db.prepare('SELECT * FROM supplier_invoice_line_assets WHERE invoice_line_id = ?').get(l.id);
        if (!spec) continue;
        const costBase = cur.code === P.base(companyId).code ? l.net_minor : P.toBase(companyId, cur.code, l.net_minor, rate);
        require('./fixedAssets').createFromInvoiceLine(companyId, { invoice: { ...inv, invoice_number: number }, line: l, spec, costBaseMinor: costBase }, actor);
      }
    }
    checkpoint('payables.invoice.after_entry');
    for (const u of lineUpdates) db.prepare('UPDATE supplier_invoice_lines SET line_base_minor = ?, grni_cleared_base_minor = ?, ppv_base_minor = ?, fx_base_minor = ? WHERE id = ?').run(u.lineBase, u.cleared, u.ppv, u.fx, u.id);
    db.prepare("UPDATE supplier_invoices SET status = 'posted', invoice_number = ?, rate_e8 = ?, rate_quote = ?, total_base_minor = ?, journal_entry_id = ?, posted_by = ?, posted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(number, rate.rateE8, rate.quote, totalBase, entry.id, actor?.id ?? null, inv.id);
    if (inv.po_id) P.refreshPoStatus(inv.po_id);
    const after = getInvoice(companyId, inv.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.invoice.post', entityType: 'supplier_invoice', entityId: inv.id, before: { status: 'draft' }, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Supplier opening balances
// ---------------------------------------------------------------------

// AP balance carried with no supplier (e.g. a lump opening balance).
function unassignedAp(companyId) {
  const ap = apId(companyId);
  if (!ap) return 0;
  return db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type IS NULL`).get(companyId, ap).s;
}

// rows: [{ supplierId, amount, currencyCode?, exchangeRate?, rateQuote?,
//   billDate?, dueDate?, ref? }]. A row with neither billDate nor dueDate is
//   an undated legacy balance: due_date stays NULL and it ages in the
//   'legacy' bucket (same rule as customer_opening on receivables), never
//   in 'current'. Each row becomes a posted 'opening' supplier invoice
// (so it ages and can be paid) with its entry:
//   mode 'reclass' (default): Dr AP (no supplier) / Cr AP (supplier) — moves
//     an existing lump AP balance onto suppliers; total <= unassigned AP.
//   mode 'opening': Dr opening_balance_equity / Cr AP (supplier).
function createOpeningBalances(companyId, { date, mode = 'reclass', rows } = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    if (!['reclass', 'opening'].includes(mode)) fail('invalid_mode', 'نوع الرصيد الافتتاحي غير صالح');
    const d = date || today();
    if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
    if (!Array.isArray(rows) || !rows.length) fail('lines_required', 'أدخل رصيد مورد واحد على الأقل');
    const ap = P.systemAccount(companyId, 'ap_control');
    const contra = mode === 'reclass' ? ap : P.systemAccount(companyId, 'opening_balance_equity');
    const prepared = rows.map((r, i) => {
      const supplier = owned(companyId, 'supplier', r.supplierId);
      const cur = P.currencyOf(companyId, r.currencyCode || supplier.currency_code);
      const amount = r.amountMinor !== undefined ? Number(r.amountMinor) : toMinor(r.amount, cur.minor_unit_digits);
      if (!Number.isSafeInteger(amount) || amount <= 0) fail('invalid_amount', `السطر ${i + 1}: المبلغ غير صالح`);
      const rate = P.docRate(companyId, cur.code, d, { exchangeRate: r.exchangeRate, rateQuote: r.rateQuote }, actor);
      const billDate = r.billDate || d;
      if (!isValidDate(billDate) || billDate > d) fail('invalid_bill_date', `السطر ${i + 1}: تاريخ الفاتورة غير صالح أو بعد تاريخ الرصيد الافتتاحي`);
      const legacy = !r.billDate && !r.dueDate;
      const due = legacy ? null : r.dueDate || billDate;
      if (due !== null && (!isValidDate(due) || due < billDate)) fail('invalid_due_date', `السطر ${i + 1}: تاريخ الاستحقاق غير صالح`);
      return { supplier, cur, amount, rate, base: P.toBase(companyId, cur.code, amount, rate), billDate, due, ref: r.ref ? String(r.ref).trim() : null };
    });
    if (mode === 'reclass') {
      const total = prepared.reduce((s, p) => s + p.base, 0);
      const avail = unassignedAp(companyId);
      if (total > avail) fail('exceeds_unassigned_ap', `المجموع أكبر من رصيد الموردين غير الموزع (${fromMinor(avail, P.base(companyId).minor_unit_digits)})`, 409, { unassigned_minor: avail });
    }
    const out = [];
    for (const p of prepared) {
      const number = P.issueNumber(companyId, 'PI', 'PI-');
      const iid = Number(
        db.prepare(`INSERT INTO supplier_invoices (company_id, invoice_number, supplier_invoice_ref, supplier_id, kind, invoice_date, due_date, currency_code, rate_e8, rate_quote, subtotal_minor, tax_minor, total_minor, total_base_minor, status, match_status, notes, created_by, posted_by, posted_at)
                    VALUES (?, ?, ?, ?, 'opening', ?, ?, ?, ?, ?, ?, 0, ?, ?, 'posted', 'not_required', ?, ?, ?, datetime('now'))`)
          .run(companyId, number, p.ref, p.supplier.id, p.billDate, p.due, p.cur.code, p.rate.rateE8, p.rate.quote, p.amount, p.amount, p.base, mode === 'reclass' ? 'إعادة تصنيف رصيد افتتاحي' : 'رصيد افتتاحي', actor?.id ?? null, actor?.id ?? null).lastInsertRowid
      );
      db.prepare('INSERT INTO supplier_invoice_lines (company_id, invoice_id, line_no, description, qty, unit_price_minor, net_minor) VALUES (?, ?, 1, ?, 1, ?, ?)').run(companyId, iid, 'رصيد افتتاحي', p.amount, p.amount);
      const fxl = p.cur.code === P.base(companyId).code ? {} : { currencyCode: p.cur.code, amountOriginalMinor: p.amount, rateE8: p.rate.rateE8, rateQuote: p.rate.quote };
      const entry = ledger.postEntry(companyId, {
        date: d, description: `رصيد افتتاحي للمورد ${p.supplier.name}`, sourceType: 'supplier_invoice', sourceId: iid,
        lines: [
          { accountId: contra, debitMinor: p.base, memo: mode === 'reclass' ? 'إعادة تصنيف من رصيد الموردين غير الموزع' : 'رصيد افتتاحي' },
          { accountId: ap, creditMinor: p.base, partyType: 'supplier', partyId: p.supplier.id, memo: `رصيد افتتاحي ${p.ref || ''}`.trim(), ...fxl },
        ],
      }, actor);
      db.prepare('UPDATE supplier_invoices SET journal_entry_id = ? WHERE id = ?').run(entry.id, iid);
      out.push(iid);
    }
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.opening.create', entityType: 'supplier_invoice', entityId: null, before: null, after: { mode, date: d, invoices: out } });
    return { mode, invoices: out.map((i) => getInvoice(companyId, i)), unassigned_minor: unassignedAp(companyId) };
  });
}

// Open-bills import: the supplier's opening balance as its individual
// unpaid bills, so they age by their own due dates.
// rows: [{ supplierId, billNumber, billDate, dueDate, amount, currencyCode? }]
// supplierTotals: [{ supplierId, amount }] — the opening balance per
// supplier (in the bills' currency); the bills of each supplier must add up
// to it exactly, and every supplier in rows must have a total.
function importOpenBills(companyId, { date, mode = 'reclass', rows, supplierTotals } = {}, actor) {
  return ledger.transaction(() => {
    if (!Array.isArray(rows) || !rows.length) fail('lines_required', 'أدخل فاتورة مفتوحة واحدة على الأقل');
    if (!Array.isArray(supplierTotals) || !supplierTotals.length) fail('supplier_totals_required', 'أدخل الرصيد الافتتاحي لكل مورد للتحقق من مجموع فواتيره');
    const sums = new Map();
    const seen = new Set();
    for (const [i, r] of rows.entries()) {
      const supplier = owned(companyId, 'supplier', r.supplierId);
      const n = i + 1;
      const bill = String(r.billNumber || '').trim();
      if (!bill) fail('bill_number_required', `السطر ${n}: رقم الفاتورة مطلوب`);
      if (!r.billDate || !isValidDate(r.billDate)) fail('invalid_bill_date', `السطر ${n}: تاريخ الفاتورة مطلوب`);
      if (!r.dueDate || !isValidDate(r.dueDate)) fail('invalid_due_date', `السطر ${n}: تاريخ الاستحقاق مطلوب`);
      const key = `${supplier.id}:${bill}`;
      if (seen.has(key)) fail('duplicate_bill', `السطر ${n}: رقم الفاتورة ${bill} مكرر لنفس المورد`);
      seen.add(key);
      const cur = P.currencyOf(companyId, r.currencyCode || supplier.currency_code);
      const amount = r.amountMinor !== undefined ? Number(r.amountMinor) : toMinor(r.amount, cur.minor_unit_digits);
      if (!Number.isSafeInteger(amount) || amount <= 0) fail('invalid_amount', `السطر ${n}: المبلغ غير صالح`);
      const s0 = sums.get(supplier.id) || { supplier, cur, sum: 0 };
      if (s0.cur.code !== cur.code) fail('mixed_currency', `السطر ${n}: فواتير المورد ${supplier.name} بعملات مختلفة`);
      s0.sum += amount;
      sums.set(supplier.id, s0);
    }
    const expected = new Map();
    for (const t of supplierTotals) {
      const supplier = owned(companyId, 'supplier', t.supplierId);
      const cur = sums.get(supplier.id)?.cur || P.currencyOf(companyId, supplier.currency_code);
      expected.set(supplier.id, t.amountMinor !== undefined ? Number(t.amountMinor) : toMinor(t.amount, cur.minor_unit_digits));
    }
    const mismatches = [];
    for (const [sid, s0] of sums) {
      const want = expected.get(sid);
      if (want !== s0.sum) mismatches.push({ supplier_id: sid, supplier_name: s0.supplier.name, currency_code: s0.cur.code, bills_minor: s0.sum, expected_minor: want ?? null });
    }
    for (const [sid, want] of expected) if (!sums.has(sid)) mismatches.push({ supplier_id: sid, bills_minor: 0, expected_minor: want });
    if (mismatches.length) {
      const m0 = mismatches[0];
      const d0 = P.currencyOf(companyId, m0.currency_code || P.base(companyId).code).minor_unit_digits;
      fail('supplier_sum_mismatch', `مجموع الفواتير المفتوحة لا يساوي الرصيد الافتتاحي للمورد ${m0.supplier_name || m0.supplier_id}: ${fromMinor(m0.bills_minor, d0)} مقابل ${m0.expected_minor === null ? 'غير مُدخل' : fromMinor(m0.expected_minor, d0)}`, 409, { mismatches });
    }
    const res = createOpeningBalances(companyId, {
      date, mode,
      rows: rows.map((r) => ({ supplierId: r.supplierId, amount: r.amount, amountMinor: r.amountMinor, currencyCode: r.currencyCode, exchangeRate: r.exchangeRate, rateQuote: r.rateQuote, billDate: r.billDate, dueDate: r.dueDate, ref: String(r.billNumber).trim() })),
    }, actor);
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.opening.import_bills', entityType: 'supplier_invoice', entityId: null, before: null, after: { mode, rows: rows.length, suppliers: [...sums.keys()], invoices: res.invoices.map((i) => i.id) } });
    return res;
  });
}

// ---------------------------------------------------------------------
// Supplier payments + allocation (realized FX)
// ---------------------------------------------------------------------

const CREDIT_KEY = { cash: 'cash_default', transfer: 'bank_in_transit', cheque: 'bank_in_transit', other: 'cash_default' };

function paymentUsed(paymentId) {
  return db.prepare('SELECT COALESCE(SUM(payment_amount_minor), 0) o, COALESCE(SUM(base_paid_minor), 0) b FROM supplier_payment_allocations WHERE payment_id = ?').get(paymentId);
}

function getPayment(companyId, id) {
  const p = owned(companyId, 'supplier_payment', id);
  const used = paymentUsed(p.id);
  const cur = P.currencyOf(companyId, p.currency_code);
  return {
    ...p,
    digits: cur.minor_unit_digits,
    exchange_rate: fx.formatRate(p.rate_e8),
    supplier: db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(p.supplier_id),
    allocations: db.prepare('SELECT a.*, i.invoice_number, i.supplier_invoice_ref, i.currency_code AS invoice_currency FROM supplier_payment_allocations a JOIN supplier_invoices i ON i.id = a.invoice_id WHERE a.payment_id = ? ORDER BY a.id').all(p.id),
    unallocated_minor: p.status === 'posted' ? p.amount_original_minor - used.o : 0,
    fx_settlements: db.prepare("SELECT s.*, e.entry_number FROM ap_fx_settlements s LEFT JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.payment_id = ? AND s.status = 'posted'").all(p.id),
    journal_entry: p.journal_entry_id ? db.prepare('SELECT id, entry_number FROM journal_entries WHERE id = ?').get(p.journal_entry_id) : null,
  };
}

function listPayments(companyId, { supplierId, status } = {}) {
  const where = ['p.company_id = ?'];
  const prm = [companyId];
  if (supplierId) { where.push('p.supplier_id = ?'); prm.push(owned(companyId, 'supplier', supplierId).id); }
  if (status) { where.push('p.status = ?'); prm.push(String(status)); }
  return db.prepare(`SELECT p.*, s.name AS supplier_name FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE ${where.join(' AND ')} ORDER BY p.payment_date DESC, p.id DESC LIMIT 500`).all(...prm)
    .map((p) => ({ ...p, unallocated_minor: p.status === 'posted' ? p.amount_original_minor - paymentUsed(p.id).o : 0 }));
}

function openSupplierInvoices(companyId, supplierId) {
  return db
    .prepare("SELECT * FROM supplier_invoices WHERE company_id = ? AND supplier_id = ? AND status = 'posted' ORDER BY due_date, invoice_date, id")
    .all(companyId, supplierId)
    .map((i) => ({ ...i, open_minor: invoiceOpenMinor(i) }))
    .filter((i) => i.open_minor > 0);
}

const sameOrBase = (companyId, a, b) => a === b || b === P.base(companyId).code;
function settleRate(companyId, payment, invoice, override, actor) {
  if (sameOrBase(companyId, payment.currency_code, invoice.currency_code)) return null;
  return P.docRate(companyId, invoice.currency_code, payment.payment_date, override || {}, actor);
}
function payToInvoice(companyId, payment, invoice, amt, sRate) {
  if (payment.currency_code === invoice.currency_code) return amt;
  const b = P.toBase(companyId, payment.currency_code, amt, P.rateOf(payment));
  return invoice.currency_code === P.base(companyId).code ? b : P.fromBase(companyId, invoice.currency_code, b, sRate);
}
function invoiceToPay(companyId, payment, invoice, amt, sRate) {
  if (payment.currency_code === invoice.currency_code) return amt;
  const b = invoice.currency_code === P.base(companyId).code ? amt : P.toBase(companyId, invoice.currency_code, amt, sRate);
  let need = payment.currency_code === P.base(companyId).code ? b : P.fromBase(companyId, payment.currency_code, b, P.rateOf(payment));
  while (payToInvoice(companyId, payment, invoice, need, sRate) < amt) need += 1;
  return need;
}

function removeAllocation(companyId, a, actor) {
  for (const s of db.prepare("SELECT * FROM ap_fx_settlements WHERE payment_id = ? AND invoice_id = ? AND status = 'posted'").all(a.payment_id, a.invoice_id)) {
    if (s.journal_entry_id) ledger.reverseEntry(companyId, s.journal_entry_id, { reason: 'إلغاء تخصيص دفعة المورد', fromSource: true }, actor);
    db.prepare("UPDATE ap_fx_settlements SET status = 'reversed' WHERE id = ?").run(s.id);
  }
  db.prepare('DELETE FROM supplier_payment_allocations WHERE id = ?').run(a.id);
}

// AP is a credit: base carried (relieved) vs base paid. Paid less base than
// carried = gain (Dr AP / Cr fx_realized); paid more = loss.
function sodBlocksPayment(companyId, invoice, actor) {
  return Boolean(actor?.id && invoice.posted_by === actor.id && P.separationApplies(companyId, 'pay', actor.id));
}
function addAllocation(companyId, payment, invoice, pAmt, actor, { override, breakGlassReason } = {}) {
  if (actor?.id && invoice.posted_by === actor.id) {
    P.sodGuard(companyId, 'pay', actor, breakGlassReason, { code: 'sod_invoice_poster', message: `فصل المهام: لا يمكنك دفع الفاتورة ${invoice.invoice_number} لأنك من رحّلها. يجب أن يدفعها مستخدم آخر.`, entityType: 'supplier_invoice', entityId: invoice.id });
  }
  const existing = db.prepare('SELECT * FROM supplier_payment_allocations WHERE payment_id = ? AND invoice_id = ?').get(payment.id, invoice.id);
  if (existing) {
    pAmt += existing.payment_amount_minor;
    removeAllocation(companyId, existing, actor);
  }
  const sRate = settleRate(companyId, payment, invoice, override, actor);
  const open = invoiceOpenMinor(invoice);
  let settled = payToInvoice(companyId, payment, invoice, pAmt, sRate);
  if (settled > open) settled = open;
  if (settled <= 0) fail('allocation_too_small', 'المبلغ المخصص أصغر من أصغر وحدة في عملة الفاتورة', 409);
  const used = paymentUsed(payment.id);
  const basePaid = pAmt === payment.amount_original_minor - used.o ? payment.amount_minor - used.b : P.toBase(companyId, payment.currency_code, pAmt, P.rateOf(payment));
  const baseRelieved = settled === open ? invoiceBaseOpen(invoice) : P.toBase(companyId, invoice.currency_code, settled, P.rateOf(invoice));
  const date = today() < payment.payment_date ? payment.payment_date : today();
  const aid = Number(
    db.prepare('INSERT INTO supplier_payment_allocations (company_id, payment_id, invoice_id, amount_minor, payment_amount_minor, base_paid_minor, base_relieved_minor, allocation_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, payment.id, invoice.id, settled, pAmt, basePaid, baseRelieved, date, actor?.id ?? null).lastInsertRowid
  );
  const fxMinor = baseRelieved - basePaid;
  if (fxMinor) {
    const sid = Number(db.prepare('INSERT INTO ap_fx_settlements (company_id, payment_id, invoice_id, supplier_id, fx_minor) VALUES (?, ?, ?, ?, ?)').run(companyId, payment.id, invoice.id, payment.supplier_id, fxMinor).lastInsertRowid);
    const ap = P.systemAccount(companyId, 'ap_control');
    const fxAcc = P.systemAccount(companyId, 'fx_realized');
    const amt = Math.abs(fxMinor);
    const memo = `فرق صرف محقق — ${invoice.invoice_number}`;
    const lines = fxMinor > 0
      ? [{ accountId: ap, debitMinor: amt, partyType: 'supplier', partyId: payment.supplier_id, memo }, { accountId: fxAcc, creditMinor: amt, memo: 'أرباح فروقات صرف محققة (موردون)' }]
      : [{ accountId: fxAcc, debitMinor: amt, memo: 'خسائر فروقات صرف محققة (موردون)' }, { accountId: ap, creditMinor: amt, partyType: 'supplier', partyId: payment.supplier_id, memo }];
    const post = (d) => ledger.postEntry(companyId, { date: d, description: `فرق صرف محقق: ${payment.payment_number} → ${invoice.invoice_number}`, sourceType: 'fx_realized_ap', sourceId: sid, lines }, actor);
    let entry;
    try {
      entry = post(payment.payment_date);
    } catch (err) {
      if (!(err instanceof ledger.LedgerError) || !['period_closed', 'period_locked', 'no_period'].includes(err.code) || payment.payment_date === date) throw err;
      entry = post(date);
    }
    db.prepare('UPDATE ap_fx_settlements SET journal_entry_id = ? WHERE id = ?').run(entry.id, sid);
    db.prepare('UPDATE supplier_payment_allocations SET fx_entry_id = ? WHERE id = ?').run(entry.id, aid);
    checkpoint('payables.allocation.after_fx');
  }
  return { invoice_id: invoice.id, amount_minor: settled, payment_amount_minor: pAmt, base_paid_minor: basePaid, base_relieved_minor: baseRelieved, fx_minor: fxMinor };
}

function autoAllocatePayment(companyId, paymentId, actor) {
  return ledger.transaction(() => {
    const p = owned(companyId, 'supplier_payment', paymentId);
    if (p.status !== 'posted') fail('payment_reversed', 'الدفعة معكوسة', 409);
    let remaining = p.amount_original_minor - paymentUsed(p.id).o;
    const made = [];
    for (const inv of openSupplierInvoices(companyId, p.supplier_id)) {
      if (remaining <= 0) break;
      if (sodBlocksPayment(companyId, inv, actor)) continue;
      const sRate = settleRate(companyId, p, inv, null, actor);
      const amt = Math.min(remaining, invoiceToPay(companyId, p, inv, inv.open_minor, sRate));
      if (payToInvoice(companyId, p, inv, amt, sRate) <= 0) continue;
      made.push(addAllocation(companyId, p, inv, amt, actor));
      remaining -= amt;
    }
    if (made.length) logAudit({ companyId, actor: actorOf(actor), action: 'payables.allocation.auto', entityType: 'supplier_payment', entityId: p.id, before: null, after: made });
    return getPayment(companyId, p.id);
  });
}

// allocations: [{ invoiceId, amount (PAYMENT currency) | amountMinor, settlementRate?, settlementRateQuote? }]
function setPaymentAllocations(companyId, paymentId, allocations, actor, { breakGlassReason } = {}) {
  return ledger.transaction(() => {
    const p = owned(companyId, 'supplier_payment', paymentId);
    if (p.status !== 'posted') fail('payment_reversed', 'الدفعة معكوسة', 409);
    const before = db.prepare('SELECT * FROM supplier_payment_allocations WHERE payment_id = ?').all(p.id);
    for (const a of before) removeAllocation(companyId, a, actor);
    const pd = P.currencyOf(companyId, p.currency_code).minor_unit_digits;
    let total = 0;
    const seen = new Set();
    for (const [i, a] of (allocations || []).entries()) {
      const inv = owned(companyId, 'supplier_invoice', a.invoiceId);
      if (seen.has(inv.id)) fail('duplicate_invoice', `السطر ${i + 1}: الفاتورة مكررة`);
      seen.add(inv.id);
      if (inv.supplier_id !== p.supplier_id) fail('invoice_supplier_mismatch', 'الفاتورة لا تخص مورد الدفعة');
      if (inv.status !== 'posted') fail('invoice_not_open', 'الفاتورة غير مرحّلة', 409);
      const amt = a.amountMinor !== undefined ? Number(a.amountMinor) : toMinor(a.amount, pd);
      if (!Number.isSafeInteger(amt) || amt <= 0) fail('invalid_amount', `السطر ${i + 1}: المبلغ غير صالح`);
      const override = a.settlementRate ? { exchangeRate: a.settlementRate, rateQuote: a.settlementRateQuote } : null;
      const need = invoiceToPay(companyId, p, inv, invoiceOpenMinor(inv), settleRate(companyId, p, inv, override, actor));
      if (amt > need) fail('exceeds_invoice_open', `المبلغ أكبر من المتبقي على الفاتورة ${inv.invoice_number}`, 409, { invoice_id: inv.id, payment_amount_needed_minor: need });
      total += amt;
      if (total > p.amount_original_minor) fail('exceeds_payment', 'مجموع التخصيص أكبر من مبلغ الدفعة', 409);
      addAllocation(companyId, p, inv, amt, actor, { override, breakGlassReason });
    }
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.allocation.set', entityType: 'supplier_payment', entityId: p.id, before, after: db.prepare('SELECT * FROM supplier_payment_allocations WHERE payment_id = ?').all(p.id) });
    return getPayment(companyId, p.id);
  });
}

// opts.creditAccountId (internal only — treasury cheques): credit this
// account (cheques_payable) instead of the method's default.
function createPayment(companyId, input, actor, opts = {}) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const supplier = owned(companyId, 'supplier', input.supplierId);
    const method = input.method || 'transfer';
    if (!CREDIT_KEY[method]) fail('invalid_method', 'طريقة الدفع غير صالحة');
    const date = input.paymentDate || input.date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const cur = P.currencyOf(companyId, input.currencyCode || supplier.currency_code);
    const original = input.amountMinor !== undefined ? Number(input.amountMinor) : toMinor(input.amount, cur.minor_unit_digits);
    if (!Number.isSafeInteger(original) || original <= 0) fail('invalid_amount', 'المبلغ يجب أن يكون أكبر من صفر');
    const rate = P.docRate(companyId, cur.code, date, { exchangeRate: input.exchangeRate, rateQuote: input.rateQuote }, actor);
    const baseMinor = P.toBase(companyId, cur.code, original, rate);
    if (baseMinor <= 0) fail('invalid_amount', 'المبلغ بعد التحويل يساوي صفرًا');
    const number = P.issueNumber(companyId, 'PAY', 'PAY-');
    const pid = Number(
      db.prepare('INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, method, currency_code, amount_original_minor, rate_e8, rate_quote, amount_minor, reference, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, number, supplier.id, date, method, cur.code, original, rate.rateE8, rate.quote, baseMinor, input.reference || null, input.notes || null, actor?.id ?? null).lastInsertRowid
    );
    const fxLine = cur.code === P.base(companyId).code ? {} : { currencyCode: cur.code, amountOriginalMinor: original, rateE8: rate.rateE8, rateQuote: rate.quote };
    const entry = ledger.postEntry(companyId, {
      date, description: `دفعة للمورد ${number} — ${supplier.name}`, sourceType: 'supplier_payment', sourceId: pid,
      lines: [
        { accountId: P.systemAccount(companyId, 'ap_control'), debitMinor: baseMinor, partyType: 'supplier', partyId: supplier.id, ...fxLine },
        { accountId: opts.creditAccountId || P.systemAccount(companyId, CREDIT_KEY[method]), creditMinor: baseMinor, ...fxLine },
      ],
    }, actor);
    db.prepare('UPDATE supplier_payments SET journal_entry_id = ? WHERE id = ?').run(entry.id, pid);
    checkpoint('payables.payment.after_entry');
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.payment.create', entityType: 'supplier_payment', entityId: pid, before: null, after: { number, supplier_id: supplier.id, currency_code: cur.code, amount_original_minor: original, amount_minor: baseMinor, rate_e8: rate.rateE8, rate_quote: rate.quote } });
    if (Array.isArray(input.allocations) && input.allocations.length) setPaymentAllocations(companyId, pid, input.allocations, actor, { breakGlassReason: input.breakGlassReason });
    else if (input.autoAllocate !== false) autoAllocatePayment(companyId, pid, actor);
    return getPayment(companyId, pid);
  });
}

function reversePayment(companyId, id, { reason, date } = {}, actor) {
  return ledger.transaction(() => {
    const p = owned(companyId, 'supplier_payment', id);
    if (p.status !== 'posted') fail('payment_reversed', 'الدفعة معكوسة مسبقًا', 409);
    if (!String(reason || '').trim()) fail('reason_required', 'سبب العكس مطلوب');
    for (const a of db.prepare('SELECT * FROM supplier_payment_allocations WHERE payment_id = ?').all(p.id)) removeAllocation(companyId, a, actor);
    const rev = ledger.reverseEntry(companyId, p.journal_entry_id, { reason: `عكس دفعة المورد ${p.payment_number} — ${reason}`, date, fromSource: true }, actor);
    db.prepare("UPDATE supplier_payments SET status = 'reversed', reversal_entry_id = ?, reversal_reason = ? WHERE id = ?").run(rev.reversal.id, reason, p.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.payment.reverse', entityType: 'supplier_payment', entityId: p.id, before: { status: 'posted' }, after: { status: 'reversed', reason } });
    return getPayment(companyId, p.id);
  });
}

// ---------------------------------------------------------------------
// Debit notes (purchase returns)
// ---------------------------------------------------------------------

// lines: [{ invoiceLineId, qty }]. Invoice currency at the invoice rate:
// Dr AP / Cr inventory (goods) or the expense account / Cr input tax.
// Tax credited back per tax account (Prompt 10: a coded line's own account;
// otherwise input_tax). One account -> the whole taxBase, as before.
function debitNoteTax(companyId, lines, tax, taxBase) {
  if (!taxBase) return [];
  const byAcc = new Map();
  for (const l of lines) {
    if (!l.tax) continue;
    const acc = TC.lineTax('supplier_invoice_line', l.il.id)?.account_id ?? P.systemAccount(companyId, 'input_tax');
    byAcc.set(acc, (byAcc.get(acc) || 0) + l.tax);
  }
  const accs = [...byAcc.keys()];
  const bases = accs.length === 1 ? [taxBase] : allocate(taxBase, accs.map((a) => byAcc.get(a)));
  return accs.map((a, i) => ({ accountId: a, amount: accs.length === 1 ? tax : byAcc.get(a), base: bases[i] })).filter((t) => t.base);
}

function createDebitNote(companyId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const inv = owned(companyId, 'supplier_invoice', input.invoiceId);
    if (inv.status !== 'posted') fail('invoice_not_posted', 'إشعار المدين لفاتورة مرحّلة فقط', 409);
    if (inv.kind === 'landed_cost') fail('landed_cost_debit_note', 'تكاليف الشحن لا تُرد بإشعار مدين — سجّل فاتورة معاكسة', 409);
    if (inv.kind === 'opening') fail('opening_debit_note', 'الرصيد الافتتاحي لا يُعدّل بإشعار مدين — صحّحه بقيد يدوي', 409);
    const date = input.date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const returnGoods = inv.kind === 'goods' && input.returnGoods !== false;
    const raw = Array.isArray(input.lines) ? input.lines : [];
    if (!raw.length) fail('lines_required', 'حدد السطور المرتجعة');
    const lines = raw.map((r, i) => {
      const n = i + 1;
      const il = db.prepare('SELECT * FROM supplier_invoice_lines WHERE id = ? AND invoice_id = ?').get(Number(r.invoiceLineId), inv.id);
      if (!il) fail('invalid_invoice_line', `السطر ${n}: سطر الفاتورة غير موجود`);
      const qty = P.parseQty(r.qty, n);
      if (db.prepare('SELECT 1 FROM supplier_invoice_line_assets WHERE invoice_line_id = ?').get(il.id)) fail('asset_line_debit_note', `السطر ${n}: هذا السطر أصل ثابت — استبعده أو بِعه من سجل الأصول`, 409);
      if (qty > il.qty - il.debited_qty + 1e-9) fail('qty_exceeds_invoice', `السطر ${n}: الكمية أكبر من المتبقي في الفاتورة (${il.qty - il.debited_qty})`);
      const net = P.roundHalfUp((il.net_minor * qty) / il.qty);
      return { n, il, qty, net, tax: P.roundHalfUp((net * il.tax_rate_bp) / 10000) };
    });
    const sub = lines.reduce((s, l) => s + l.net, 0);
    const tax = lines.reduce((s, l) => s + l.tax, 0);
    const total = sub + tax;
    TC.requirePriceModeChosen(companyId, tax);
    const open = invoiceOpenMinor(inv);
    if (total > open) fail('exceeds_invoice_open', 'إشعار المدين أكبر من المتبقي على الفاتورة — ألغِ تخصيص الدفعات أولًا', 409, { open_minor: open });
    const cur = P.currencyOf(companyId, inv.currency_code);
    const rate = P.rateOf(inv);
    // Closing the invoice relieves exactly the base it still carries.
    const apBase = total === open ? invoiceBaseOpen(inv) : P.toBase(companyId, cur.code, total, rate);
    const taxBase = tax ? P.toBase(companyId, cur.code, tax, rate) : 0;
    const number = P.issueNumber(companyId, 'DN', 'DN-');
    const did = Number(
      db.prepare('INSERT INTO supplier_debit_notes (company_id, debit_note_number, supplier_id, invoice_id, note_date, reason, return_goods, currency_code, rate_e8, rate_quote, subtotal_minor, tax_minor, total_minor, total_base_minor, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, number, inv.supplier_id, inv.id, date, input.reason || null, returnGoods ? 1 : 0, cur.code, rate.rateE8, rate.quote, sub, tax, total, apBase, actor?.id ?? null).lastInsertRowid
    );
    // The rest of the base (after tax) leaves inventory / the expense, split by line net.
    const restBase = apBase - taxBase;
    const shares = allocate(restBase, lines.map((l) => l.net)) || lines.map(() => 0);
    const credit = new Map();
    const ins = db.prepare('INSERT INTO supplier_debit_note_lines (company_id, debit_note_id, line_no, invoice_line_id, product_id, description, qty, net_minor, tax_minor, inventory_base_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // Prompt 8: with the stock ledger, returned goods leave stock at their
    // receipt's own cost incl. landed cost (stockDocs.purchaseReturn); the
    // difference vs the invoice value goes to purchase price variance.
    const stockOn = returnGoods && require('./stockLedger').isActive(companyId);
    const stockMoves = [];
    const addCredit = (acc, v) => credit.set(acc, (credit.get(acc) || 0) + v);
    for (const [k, l] of lines.entries()) {
      ins.run(companyId, did, l.n, l.il.id, l.il.product_id, l.il.description, l.qty, l.net, l.tax, shares[k]);
      db.prepare('UPDATE supplier_invoice_lines SET debited_qty = debited_qty + ? WHERE id = ?').run(l.qty, l.il.id);
      const acc = inv.kind === 'goods' ? P.systemAccount(companyId, 'inventory') : l.il.expense_account_id;
      if (!stockOn) addCredit(acc, shares[k]);
      if (returnGoods) {
        if (!stockOn) P.removeFromStock(companyId, l.il.product_id, l.qty);
        // Remove from the receipt lines it came from (latest first).
        let left = l.qty;
        let stockValue = 0;
        for (const rl of db.prepare('SELECT gl.* FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id WHERE gl.po_line_id = ? ORDER BY g.receipt_date DESC, gl.id DESC').all(l.il.po_line_id)) {
          if (left <= 1e-9) break;
          const room = rl.qty - rl.rejected_qty - rl.returned_qty;
          const take = Math.min(room, left);
          if (take > 0) {
            db.prepare('UPDATE goods_receipt_lines SET returned_qty = returned_qty + ? WHERE id = ?').run(take, rl.id);
            if (stockOn && rl.product_id) {
              const r = require('./stockDocs').purchaseReturn(companyId, { rl, qty: take, debitNoteId: did, date }, actor);
              for (const x of r.lines) addCredit(x.accountId, x.creditMinor);
              stockValue += r.value;
              stockMoves.push(...r.moveIds);
            }
          }
          left -= take;
        }
        if (stockOn) {
          if (left > 1e-9) fail('nothing_to_return', `السطر ${l.n}: لا توجد كمية مستلمة متبقية لإرجاعها`, 409);
          const ppv = shares[k] - stockValue;
          if (ppv) addCredit(P.systemAccount(companyId, 'purchase_price_variance'), ppv);
        }
      }
    }
    const fxl = cur.code === P.base(companyId).code ? () => ({}) : (orig) => ({ currencyCode: cur.code, amountOriginalMinor: orig, rateE8: rate.rateE8, rateQuote: rate.quote });
    const jl = [
      { accountId: P.systemAccount(companyId, 'ap_control'), debitMinor: apBase, partyType: 'supplier', partyId: inv.supplier_id, memo: `إشعار مدين ${number}`, ...fxl(total) },
      ...debitNoteTax(companyId, lines, tax, taxBase).map((t) => ({ accountId: t.accountId, creditMinor: t.base, ...fxl(t.amount) })),
      ...[...credit.entries()].filter(([, v]) => v).map(([acc, v]) => ({ accountId: acc, debitMinor: v < 0 ? -v : 0, creditMinor: v > 0 ? v : 0, memo: returnGoods ? 'بضاعة مرتجعة للمورد' : 'تخفيض فاتورة مورد' })),
    ];
    const entry = ledger.postEntry(companyId, { date, description: `إشعار مدين ${number} للفاتورة ${inv.invoice_number}`, sourceType: 'supplier_debit_note', sourceId: did, lines: jl }, actor);
    if (stockMoves.length) db.prepare(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${stockMoves.map(() => '?').join(',')})`).run(entry.id, ...stockMoves);
    db.prepare('UPDATE supplier_debit_notes SET journal_entry_id = ? WHERE id = ?').run(entry.id, did);
    db.prepare("UPDATE supplier_invoices SET debited_minor = debited_minor + ?, updated_at = datetime('now') WHERE id = ?").run(total, inv.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payables.debit_note.create', entityType: 'supplier_debit_note', entityId: did, before: null, after: { number, invoice_id: inv.id, total_minor: total, total_base_minor: apBase, return_goods: returnGoods } });
    return getDebitNote(companyId, did);
  });
}

function getDebitNote(companyId, id) {
  const d = owned(companyId, 'supplier_debit_note', id);
  return { ...d, lines: db.prepare('SELECT * FROM supplier_debit_note_lines WHERE debit_note_id = ? ORDER BY line_no').all(d.id), invoice: db.prepare('SELECT id, invoice_number, supplier_invoice_ref FROM supplier_invoices WHERE id = ?').get(d.invoice_id) };
}

function listDebitNotes(companyId, { supplierId } = {}) {
  return db.prepare(`SELECT d.*, s.name AS supplier_name, i.invoice_number FROM supplier_debit_notes d JOIN suppliers s ON s.id = d.supplier_id JOIN supplier_invoices i ON i.id = d.invoice_id WHERE d.company_id = ? ${supplierId ? 'AND d.supplier_id = ?' : ''} ORDER BY d.note_date DESC, d.id DESC`)
    .all(...[companyId, ...(supplierId ? [owned(companyId, 'supplier', supplierId).id] : [])]);
}

// ---------------------------------------------------------------------
// Aging, reconciliation, statement
// ---------------------------------------------------------------------

function apId(companyId) {
  return ledger.getAccountBySystemKey(companyId, 'ap_control')?.id ?? null;
}

function bucketOf(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return 'b1_30';
  if (days <= 60) return 'b31_60';
  if (days <= 90) return 'b61_90';
  return 'b90_plus';
}
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// Open payables per supplier as of a date, from the AP ledger lines grouped
// by document (invoice, payment, debit note, FX on an invoice, other). The
// total is the AP control balance by construction; base amounts, positive
// = owed to the supplier.
function legacyInvoice(id) {
  return Boolean(db.prepare("SELECT 1 FROM supplier_invoices WHERE id = ? AND kind = 'opening' AND due_date IS NULL").get(id));
}
function supplierOpenItems(companyId, supplierId, asOf) {
  const ap = apId(companyId);
  if (!ap) return [];
  const lines = db
    .prepare(
      `SELECT l.debit_minor, l.credit_minor, e.id AS entry_id, e.entry_number, e.entry_date, e.source_type, e.source_id, e.description
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'supplier' AND l.party_id = ? AND e.entry_date <= ?
       ORDER BY e.entry_date, e.id`
    )
    .all(companyId, ap, supplierId, asOf);
  const keyCache = new Map();
  const keyOf = (e) => {
    if (keyCache.has(e.entry_id)) return keyCache.get(e.entry_id);
    let k;
    if (e.source_type === 'supplier_invoice') k = `inv:${e.source_id}`;
    else if (e.source_type === 'supplier_debit_note') k = `inv:${db.prepare('SELECT invoice_id FROM supplier_debit_notes WHERE id = ?').get(e.source_id)?.invoice_id}`;
    else if (e.source_type === 'supplier_payment') k = `pay:${e.source_id}`;
    else if (e.source_type === 'fx_realized_ap') k = `inv:${db.prepare('SELECT invoice_id FROM ap_fx_settlements WHERE id = ?').get(e.source_id)?.invoice_id}`;
    else if (e.source_type === 'reversal') {
      const o = db.prepare('SELECT id AS entry_id, source_type, source_id FROM journal_entries WHERE id = ?').get(e.source_id);
      k = o ? keyOf(o) : `entry:${e.entry_id}`;
    } else k = `entry:${e.entry_id}`;
    keyCache.set(e.entry_id, k);
    return k;
  };
  const groups = new Map();
  const group = (k, seed) => {
    if (!groups.has(k)) groups.set(k, { key: k, amount_minor: 0, ...seed });
    return groups.get(k);
  };
  for (const l of lines) group(keyOf(l), { date: l.entry_date, entry_number: l.entry_number, description: l.description }).amount_minor += l.credit_minor - l.debit_minor;
  // Payment allocations move the base paid from the payment onto the invoice.
  for (const a of db.prepare(`SELECT a.* FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE p.supplier_id = ? AND p.status = 'posted' AND a.allocation_date <= ?`).all(supplierId, asOf)) {
    if (!groups.has(`pay:${a.payment_id}`)) continue;
    groups.get(`pay:${a.payment_id}`).amount_minor -= a.base_paid_minor;
    group(`inv:${a.invoice_id}`, {}).amount_minor += a.base_paid_minor;
  }
  const items = [];
  for (const g of groups.values()) {
    if (!g.amount_minor) continue;
    let due = g.date;
    let number = g.entry_number;
    let document = null;
    if (g.key.startsWith('inv:')) {
      const inv = db.prepare('SELECT * FROM supplier_invoices WHERE id = ?').get(Number(g.key.slice(4)));
      if (inv) { due = inv.due_date || inv.invoice_date; number = inv.invoice_number; document = { type: 'supplier_invoice', id: inv.id, ref: inv.supplier_invoice_ref, currency_code: inv.currency_code, open_minor: invoiceOpenMinor(inv) }; g.date = inv.invoice_date; }
    } else if (g.key.startsWith('pay:')) {
      const p = db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(Number(g.key.slice(4)));
      if (p) { number = p.payment_number; document = { type: 'supplier_payment', id: p.id }; }
    }
    const days = daysBetween(due, asOf);
    // Undated legacy opening balance (kind 'opening', no due date): the
    // 'legacy' bucket, same rule as customer_opening on receivables.
    const legacy = document?.type === 'supplier_invoice' && legacyInvoice(Number(g.key.slice(4)));
    items.push({ ...g, number, due_date: legacy ? null : due, days_overdue: legacy ? null : days, legacy, bucket: g.amount_minor < 0 ? 'advances' : legacy ? 'legacy' : bucketOf(days), document });
  }
  return items.sort((x, y) => ((x.due_date ?? '') < (y.due_date ?? '') ? -1 : 1));
}

function payablesAging(companyId, { asOf } = {}) {
  const date = asOf || today();
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  const empty = () => ({ current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0, legacy: 0, advances: 0, total: 0 });
  const rows = [];
  const totals = empty();
  for (const s of db.prepare('SELECT id, name FROM suppliers WHERE company_id = ? ORDER BY name').all(companyId)) {
    const items = supplierOpenItems(companyId, s.id, date);
    if (!items.length) continue;
    const b = empty();
    for (const it of items) { b[it.bucket] += it.amount_minor; b.total += it.amount_minor; }
    for (const k of Object.keys(totals)) totals[k] += b[k];
    rows.push({ supplier_id: s.id, supplier_name: s.name, ...b, items });
  }
  const ap = apId(companyId);
  const control = ap ? db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND e.entry_date <= ?`).get(companyId, ap, date).s : 0;
  return { as_of: date, rows, totals, control_minor: control, unassigned_minor: control - totals.total, digits: P.base(companyId).minor_unit_digits };
}

// AP control vs supplier sub-ledgers (as of a date).
function apReconciliation(companyId, { asOf } = {}) {
  const a = payablesAging(companyId, { asOf });
  return { as_of: a.as_of, control_minor: a.control_minor, subledger_minor: a.totals.total, difference_minor: a.unassigned_minor };
}

function supplierStatement(companyId, supplierId, { from, to } = {}) {
  const s = owned(companyId, 'supplier', supplierId);
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  if (!isValidDate(f) || !isValidDate(t) || f > t) fail('invalid_dates', 'الفترة غير صالحة');
  const ap = apId(companyId);
  const q = (cond) => db.prepare(
    `SELECT e.id AS entry_id, e.entry_number, e.entry_date, e.source_type, e.source_id, e.description, l.memo, l.debit_minor, l.credit_minor, l.currency_code, l.amount_original_minor
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'supplier' AND l.party_id = ? AND ${cond} ORDER BY e.entry_date, e.id`
  );
  const opening = db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'supplier' AND l.party_id = ? AND e.entry_date < ?`).get(companyId, ap, s.id, f).s;
  let running = opening;
  const lines = (ap ? q('e.entry_date BETWEEN ? AND ?').all(companyId, ap, s.id, f, t) : []).map((l) => {
    running += l.credit_minor - l.debit_minor;
    return { ...l, balance_minor: running };
  });
  return { supplier: { id: s.id, name: s.name, currency_code: s.currency_code }, from: f, to: t, opening_minor: opening, closing_minor: running, lines, digits: P.base(companyId).minor_unit_digits };
}

// ---------------------------------------------------------------------
// Reports + dashboard
// ---------------------------------------------------------------------

function ppvReport(companyId, { from, to, supplierId } = {}) {
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  const sup = supplierId ? owned(companyId, 'supplier', supplierId).id : null;
  const rows = db
    .prepare(
      `SELECT i.id AS invoice_id, i.invoice_number, i.invoice_date, i.supplier_id, s.name AS supplier_name, l.product_id, pr.name AS product_name, l.description, l.qty,
         l.unit_price_minor, pl.unit_price_minor AS po_unit_price_minor, i.currency_code, l.line_base_minor, l.grni_cleared_base_minor, l.ppv_base_minor
       FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN purchase_order_lines pl ON pl.id = l.po_line_id LEFT JOIN products pr ON pr.id = l.product_id
       WHERE i.company_id = ? AND i.status = 'posted' AND i.kind = 'goods' AND i.invoice_date BETWEEN ? AND ? ${sup ? 'AND i.supplier_id = ?' : ''} AND COALESCE(l.ppv_base_minor, 0) <> 0
       ORDER BY i.invoice_date, i.id, l.line_no`
    )
    .all(...[companyId, f, t, ...(sup ? [sup] : [])]);
  const acc = ledger.getAccountBySystemKey(companyId, 'purchase_price_variance');
  const ledgerTotal = acc ? db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND e.entry_date BETWEEN ? AND ?`).get(companyId, acc.id, f, t).s : 0;
  return { from: f, to: t, rows, total_minor: rows.reduce((s, r) => s + r.ppv_base_minor, 0), ledger_total_minor: ledgerTotal, account_id: acc?.id ?? null, digits: P.base(companyId).minor_unit_digits };
}

function purchasesBy(companyId, { from, to, by = 'supplier' } = {}) {
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  if (!['supplier', 'item'].includes(by)) fail('invalid_group', 'تجميع غير صالح');
  const lines = db
    .prepare(
      `SELECT i.id, i.supplier_id, s.name AS supplier_name, i.currency_code, i.rate_e8, i.rate_quote, l.product_id, COALESCE(pr.name, l.description) AS item, l.qty, l.net_minor, l.line_base_minor
       FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN products pr ON pr.id = l.product_id
       WHERE i.company_id = ? AND i.status = 'posted' AND i.kind IN ('goods', 'expense') AND i.invoice_date BETWEEN ? AND ?`
    )
    .all(companyId, f, t);
  const map = new Map();
  for (const l of lines) {
    const k = by === 'supplier' ? `s:${l.supplier_id}` : l.product_id ? `p:${l.product_id}` : `d:${l.item}`;
    const base = l.line_base_minor ?? P.toBase(companyId, l.currency_code, l.net_minor, P.rateOf(l));
    const r = map.get(k) || { key: k, label: by === 'supplier' ? l.supplier_name : l.item, product_id: l.product_id ?? null, supplier_id: by === 'supplier' ? l.supplier_id : null, qty: 0, base_minor: 0, invoices: new Set() };
    r.qty += l.qty;
    r.base_minor += base;
    r.invoices.add(l.id);
    map.set(k, r);
  }
  const rows = [...map.values()].map((r) => ({ ...r, invoices: r.invoices.size })).sort((a, b) => b.base_minor - a.base_minor);
  return { from: f, to: t, by, rows, total_minor: rows.reduce((s, r) => s + r.base_minor, 0), digits: P.base(companyId).minor_unit_digits };
}

function apControlBalance(companyId) {
  const ap = apId(companyId);
  if (!ap) return 0;
  return db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ?`).get(companyId, ap).s;
}

function dashboard(companyId) {
  const d = today();
  const aging = payablesAging(companyId, { asOf: d });
  const grni = ledger.getAccountBySystemKey(companyId, 'grni');
  const grniBal = grni ? db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ?`).get(companyId, grni.id).s : 0;
  const openInv = db.prepare("SELECT * FROM supplier_invoices WHERE company_id = ? AND status = 'posted'").all(companyId).map((i) => ({ ...i, open_minor: invoiceOpenMinor(i), base_open: invoiceBaseOpen(i) })).filter((i) => i.open_minor > 0);
  const week = addDays(d, 7);
  return {
    as_of: d,
    payables_minor: aging.control_minor,
    overdue_minor: aging.totals.b1_30 + aging.totals.b31_60 + aging.totals.b61_90 + aging.totals.b90_plus + aging.totals.legacy,
    due_this_week_minor: openInv.filter((i) => i.due_date >= d && i.due_date <= week).reduce((s, i) => s + i.base_open, 0),
    grni_minor: grniBal,
    open_pos: db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE company_id = ? AND status IN ('approved','partially_received')").get(companyId).c,
    pending_approval: db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE company_id = ? AND status = 'pending_approval'").get(companyId).c,
    pending_requests: db.prepare("SELECT COUNT(*) c FROM purchase_requests WHERE company_id = ? AND status = 'submitted'").get(companyId).c,
    mismatched_invoices: db.prepare("SELECT COUNT(*) c FROM supplier_invoices WHERE company_id = ? AND status = 'draft' AND match_status = 'mismatch'").get(companyId).c,
    active_suppliers: db.prepare('SELECT COUNT(*) c FROM suppliers WHERE company_id = ? AND is_active = 1').get(companyId).c,
    top_suppliers: purchasesBy(companyId, { by: 'supplier' }).rows.slice(0, 5),
    reconciliation: apReconciliation(companyId),
    digits: aging.digits,
  };
}

module.exports = {
  invoiceOpenMinor,
  invoiceBaseOpen,
  getInvoice,
  listInvoices,
  saveInvoice,
  deleteInvoice,
  threeWayMatch,
  approveMismatch,
  postInvoice,
  getPayment,
  listPayments,
  createPayment,
  autoAllocatePayment,
  setPaymentAllocations,
  reversePayment,
  openSupplierInvoices,
  createDebitNote,
  getDebitNote,
  listDebitNotes,
  supplierOpenItems,
  payablesAging,
  apReconciliation,
  supplierStatement,
  ppvReport,
  purchasesBy,
  apControlBalance,
  dashboard,
  unassignedAp,
  createOpeningBalances,
  importOpenBills,
};
