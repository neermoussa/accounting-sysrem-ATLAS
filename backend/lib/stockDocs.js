// backend/lib/stockDocs.js
//
// The stock side of documents for companies that ACTIVATED the stock
// ledger (lib/stockLedger.js). Each function moves stock and returns the
// inventory journal lines the calling document posts in its own entry, so
// one document = one entry and the moves point at it. Not activated:
// nobody calls these (the documents post exactly as before).

const db = require('../db/init');
const S = require('./stockLedger');

const fail = (code, message, status) => {
  throw new S.StockError(code, message, status);
};

// Where a sale leaves from: the invoice's warehouse, else the rep of its
// order (their vehicle / themselves), else the default warehouse.
function salesHolder(companyId, inv) {
  if (inv.warehouse_id) return S.warehouseHolder(companyId, inv.warehouse_id);
  if (inv.order_id) {
    const o = db.prepare('SELECT rep_id FROM orders WHERE id = ? AND company_id = ?').get(inv.order_id, companyId);
    if (o?.rep_id) return S.custodyHolderForRep(companyId, o.rep_id);
  }
  return S.warehouseHolder(companyId, null);
}

// Sales invoice: one 'sale' move per product line at valuation cost.
// Returns entry parts (salesPosting entryLines format) + moves + per line
// unit cost (sold unit) to store on the line.
function salesIssue(companyId, inv, lines, actor) {
  const h = salesHolder(companyId, inv);
  const cogs = S.sysAcc(companyId, 'cogs');
  const acc = S.holderAccount(companyId, h);
  let total = 0;
  const moveIds = [];
  const unitCosts = new Map();
  for (const l of lines) {
    if (!l.product_id || !(l.qty > 0)) continue;
    const qty = S.baseQty(l.product_id, l.qty, l.unit_key);
    const r = S.moveOutAuto(companyId, { productId: l.product_id, holderId: h.id, qty, moveType: 'sale', sourceType: 'sales_invoice_line', sourceId: l.id, date: inv.invoice_date, actor });
    total += r.value;
    moveIds.push(...r.moveIds);
    unitCosts.set(l.id, Math.round(r.value / l.qty));
  }
  const parts = total ? [{ accountId: cogs, side: 'debit', amount: total, memo: 'تكلفة البضاعة المباعة', base: true }, { accountId: acc, side: 'credit', amount: total, base: true }] : [];
  return { parts, moveIds, unitCosts, holder: h };
}

// Credit note with restock: back into the holder the sale left from, at
// the sale's own cost (lines of an invoice), else the default warehouse at
// the current cost.
function salesReturn(companyId, { date, lines, sourceId }, actor) {
  const cogs = S.sysAcc(companyId, 'cogs');
  const parts = [];
  const moveIds = [];
  for (const l of lines) {
    if (!l.product_id || !(l.qty > 0)) continue;
    const qty = S.baseQty(l.product_id, l.qty, l.unit_key);
    const sale = l.invoice_line_id ? db.prepare("SELECT holder_id, SUM(-qty) q, SUM(-value_minor) v FROM stock_moves WHERE company_id = ? AND source_type = 'sales_invoice_line' AND source_id = ? AND move_type = 'sale' GROUP BY holder_id").get(companyId, l.invoice_line_id) : null;
    const holderId = sale?.holder_id ?? S.warehouseHolder(companyId, null).id;
    const value = sale?.q > 1e-9 ? Math.round((sale.v * qty) / sale.q) : undefined;
    // Back into the lot it was sold from (the first lot of that sale).
    const lotId = l.invoice_line_id ? db.prepare("SELECT lot_id FROM stock_moves WHERE company_id = ? AND source_type = 'sales_invoice_line' AND source_id = ? AND move_type = 'sale' AND lot_id IS NOT NULL ORDER BY id LIMIT 1").get(companyId, l.invoice_line_id)?.lot_id : null;
    const r = S.moveIn(companyId, { productId: l.product_id, holderId, qty, valueMinor: value, moveType: 'sale_return', sourceType: 'sales_credit_note', sourceId, date, lotId, actor });
    moveIds.push(r.moveId);
    const h = S.holderById(companyId, holderId);
    parts.push({ accountId: S.holderAccount(companyId, h), side: 'debit', amount: r.value, memo: 'إعادة البضاعة إلى المخزون', base: true }, { accountId: cogs, side: 'credit', amount: r.value, base: true });
  }
  return { parts, moveIds };
}

// Approved return (inspected valid): into the custody of the rep who filed
// it at the current cost; posts Dr custody stock / Cr COGS itself (the
// return's credit note carries no inventory leg when the ledger is active).
function returnRestock(companyId, request, items, actor) {
  const h = S.custodyHolderForRep(companyId, request.requested_by_id);
  const lines = [];
  const moveIds = [];
  for (const it of items) {
    if (it.inspection_status !== 'valid' || it.restocked || !it.product_id || !it.inspected_qty) continue;
    const qty = S.baseQty(it.product_id, it.inspected_qty, it.unit_key);
    const r = S.moveIn(companyId, { productId: it.product_id, holderId: h.id, qty, moveType: 'return_restock', sourceType: 'return_request', sourceId: request.id, actor });
    moveIds.push(r.moveId);
    lines.push({ accountId: S.holderAccount(companyId, h), amount: r.value, memo: it.product_name }, { accountId: S.sysAcc(companyId, 'cogs'), amount: -r.value, memo: 'مرتجع زبون' });
    db.prepare('UPDATE return_items SET restocked = 1 WHERE id = ?').run(it.id);
  }
  S.post(companyId, { description: `إعادة مرتجع #${request.id} إلى ${h.name}`, lines, moveIds }, actor);
}

// Goods receipt lines -> 'receipt' moves into the receipt's warehouse;
// returns { inventoryLines, variance, moveIds } for the receipt entry.
function receiptMoves(companyId, { receiptId, date, warehouseId, lines }, actor) {
  const h = S.warehouseHolder(companyId, warehouseId);
  const acc = S.holderAccount(companyId, h);
  let stockValue = 0;
  let variance = 0;
  const moveIds = [];
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    if (!l.productId) fail('non_stock_line', `السطر "${l.description}" بلا مادة — مع دفتر المخزون تُسجَّل المشتريات غير المخزنية بفاتورة مصاريف`, 409);
    // Lot-tracked products: the receipt line names its lot (code, expiry,
    // production date, supplier lot) — the start of the lot's trace.
    let lotId = null;
    if (S.isTracked(companyId, l.productId)) {
      if (!l.lot?.lotCode) fail('lot_required', `السطر "${l.description}": المادة متتبعة بالدفعات — أدخل رقم الدفعة وتاريخ الصلاحية`, 400);
      lotId = S.getOrCreateLot(companyId, l.productId, { ...l.lot, supplierId: l.supplierId }).id;
    }
    const r = S.moveIn(companyId, { productId: l.productId, holderId: h.id, qty: l.qty, valueMinor: l.value, moveType: 'receipt', sourceType: 'goods_receipt', sourceId: receiptId, origin: { type: 'goods_receipt_line', id: l.lineId }, date, lotId, actor });
    stockValue += r.value;
    variance += r.variance;
    moveIds.push(r.moveId);
  }
  return { inventoryLines: [{ accountId: acc, debitMinor: stockValue, memo: 'استلام بضاعة' }], stockValue, variance, moveIds, holder: h };
}

// Landed cost share on a receipt line: to the stock still on hand from it;
// the part belonging to quantity already sold / gone -> COGS (standard
// cost: purchase price variance). Returns entry lines (debits).
function landedCost(companyId, { receipt, receiptLine, share, invoiceId, date }, actor) {
  const accepted = receiptLine.qty - receiptLine.rejected_qty;
  const h = S.warehouseHolder(companyId, receipt.warehouse_id);
  const r = S.addValue(companyId, { productId: receiptLine.product_id, holderId: h.id, origin: { type: 'goods_receipt_line', id: receiptLine.id }, originQty: accepted, valueMinor: share, sourceType: 'supplier_invoice', sourceId: invoiceId, date, actor });
  const out = r.parts.map((p) => ({ accountId: S.holderAccount(companyId, S.holderById(companyId, p.holderId)), debitMinor: p.value, memo: 'تكاليف إضافية على المخزون' }));
  if (r.residual) {
    const key = S.methodFor(companyId, receiptLine.product_id) === 'standard' ? 'purchase_price_variance' : 'cogs';
    out.push({ accountId: S.sysAcc(companyId, key), debitMinor: r.residual, memo: 'تكاليف إضافية لبضاعة خرجت من المخزون' });
  }
  return { lines: out, moveIds: r.parts.map((p) => p.moveId) };
}

// Purchase return of `qty` taken off receipt line `rl`: out of the holder
// that still has that receipt's stock, at the receipt's own cost incl.
// landed cost (FIFO: its layers; average: (receipt value + landed) / qty;
// standard: standard cost). Returns { value, lines (credits), moveIds }.
function purchaseReturn(companyId, { rl, qty, debitNoteId, date }, actor) {
  const accepted = rl.qty - rl.rejected_qty;
  const method = S.methodFor(companyId, rl.product_id);
  const origin = { type: 'goods_receipt_line', id: rl.id };
  let holderId = db.prepare('SELECT holder_id FROM stock_layers WHERE company_id = ? AND origin_type = ? AND origin_id = ? AND qty_remaining > 1e-9 ORDER BY qty_remaining DESC LIMIT 1').get(companyId, origin.type, origin.id)?.holder_id;
  if (!holderId) {
    const receipt = db.prepare('SELECT warehouse_id FROM goods_receipts WHERE id = ?').get(rl.receipt_id);
    holderId = S.warehouseHolder(companyId, receipt.warehouse_id).id;
  }
  const original = method === 'average' ? Math.round(((rl.value_base_minor + (rl.landed_base_minor || 0)) * qty) / accepted) : undefined;
  const ownLots = db.prepare("SELECT DISTINCT lot_id FROM stock_moves WHERE company_id = ? AND source_type = 'goods_receipt' AND source_id = ? AND product_id = ? AND lot_id IS NOT NULL").all(companyId, rl.receipt_id, rl.product_id).map((x) => x.lot_id);
  const r = S.moveOutAuto(companyId, { productId: rl.product_id, holderId, qty, moveType: 'purchase_return', sourceType: 'supplier_debit_note', sourceId: debitNoteId, date, preferOrigin: origin, preferLotIds: ownLots, valueOverride: original, actor });
  const h = S.holderById(companyId, holderId);
  return { value: r.value, lines: [{ accountId: S.holderAccount(companyId, h), creditMinor: r.value, memo: 'بضاعة مرتجعة للمورد بتكلفة استلامها' }], moveIds: r.moveIds };
}

module.exports = { salesHolder, salesIssue, salesReturn, returnRestock, receiptMoves, landedCost, purchaseReturn };
