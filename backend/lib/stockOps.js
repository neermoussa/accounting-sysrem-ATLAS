// backend/lib/stockOps.js
//
// Prompt 8b on top of the stock ledger (lib/stockLedger.js):
//  - stock count documents: draft -> approve (differences posted as
//    'count' moves with reason codes, one entry; separation of duties) ;
//  - wastage / damage / loss documents (Dr inventory_wastage) and repacking
//    (out of one product, into another at the same value);
//  - lot status (quarantine / release / reject), expiry sweep (expired lots
//    marked, near-expiry and reorder alerts through notifications);
//  - reserved stock (approved orders), forward / reverse lot trace, recall;
//  - reports: item balance, ageing, slow-moving, near-expiry, count
//    variances, inventory cost, turnover, product profitability, wastage
//    analysis; the item card.

const db = require('../db/init');
const ledger = require('./ledger');
const S = require('./stockLedger');
const documentNumbering = require('./documentNumbering');
const { logAudit } = require('./auditLog');
const { createNotification, hasUnreadNotification } = require('./notify');
const { checkpoint } = require('./faultInjection');

const fail = (code, message, status, extra) => {
  throw new S.StockError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const today = () => new Date().toISOString().slice(0, 10);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const Q = (x) => Math.round(Number(x) * 1e6) / 1e6;
const DEFAULT_REASONS = ['counting_error', 'damage', 'expiry', 'loss', 'theft', 'found', 'other'];

function requireActive(companyId) {
  if (!S.isActive(companyId)) fail('stock_ledger_not_active', 'دفتر المخزون غير مفعّل لهذه الشركة', 409);
}
function issueNumber(companyId, type, prefix) {
  if (!db.prepare('SELECT 1 FROM document_number_sequences WHERE company_id = ? AND document_type = ?').get(companyId, type)) documentNumbering.setConfig(companyId, type, { prefix });
  return documentNumbering.issueNext(companyId, type);
}
function reasonCodes(companyId) {
  const v = db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'stock_reason_codes'").get(companyId)?.value;
  try {
    const arr = v ? JSON.parse(v) : null;
    return Array.isArray(arr) && arr.length ? arr : DEFAULT_REASONS;
  } catch {
    return DEFAULT_REASONS;
  }
}
function checkReason(companyId, code, n) {
  if (!code) fail('reason_required', `${n ? `السطر ${n}: ` : ''}رمز السبب مطلوب`);
  if (!reasonCodes(companyId).includes(code)) fail('invalid_reason', `${n ? `السطر ${n}: ` : ''}رمز السبب غير معرّف (${reasonCodes(companyId).join('، ')})`);
}
const productName = (id) => db.prepare('SELECT name FROM products WHERE id = ?').get(id)?.name;

// ---------------------------------------------------------------------
// Stock counts
// ---------------------------------------------------------------------

function getCount(companyId, id) {
  const c = db.prepare('SELECT * FROM stock_counts WHERE id = ? AND company_id = ?').get(Number(id), companyId);
  if (!c) fail('invalid_stock_count', 'مستند الجرد غير موجود', 400);
  const h = S.holderById(companyId, c.holder_id);
  const lines = db.prepare('SELECT l.*, p.name AS product_name, lt.lot_code FROM stock_count_lines l JOIN products p ON p.id = l.product_id LEFT JOIN stock_lots lt ON lt.id = l.lot_id WHERE l.count_id = ? ORDER BY l.id').all(c.id)
    .map((l) => ({ ...l, variance: Q(l.counted_qty - l.expected_qty) }));
  return { ...c, holder_name: h.name, lines };
}
function listCounts(companyId) {
  return db.prepare('SELECT c.*, h.name AS holder_name, (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) lines FROM stock_counts c JOIN stock_holders h ON h.id = c.holder_id WHERE c.company_id = ? ORDER BY c.id DESC LIMIT 200').all(companyId);
}
// lines: [{ productId, lotId?, countedQty, reasonCode? }] — expected = the
// holder's (lot's) balance now (snapshot for the variance report).
function createCount(companyId, { holderId, countDate, notes, lines }, actor) {
  requireActive(companyId);
  return ledger.transaction(() => {
    const h = S.holderById(companyId, Number(holderId));
    const d = countDate || today();
    if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
    if (!Array.isArray(lines) || !lines.length) fail('lines_required', 'أدخل سطرًا واحدًا على الأقل');
    const id = Number(db.prepare('INSERT INTO stock_counts (company_id, count_number, holder_id, count_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, issueNumber(companyId, 'SC', 'SC-'), h.id, d, notes || null, actor?.id ?? null).lastInsertRowid);
    lines.forEach((l, i) => addCountLine(companyId, id, h, l, i + 1));
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.count.create', entityType: 'stock_count', entityId: id, before: null, after: { holder_id: h.id, lines: lines.length } });
    return getCount(companyId, id);
  });
}
function addCountLine(companyId, countId, h, l, n) {
  const p = S.productRow(companyId, l.productId);
  const lotId = l.lotId ? S.checkLot(companyId, p.id, Number(l.lotId)).id : null;
  const counted = Number(l.countedQty);
  if (!Number.isFinite(counted) || counted < 0) fail('invalid_qty', `السطر ${n}: الكمية المعدودة غير صالحة`);
  if (S.isTracked(companyId, p.id) && !lotId) fail('lot_required', `السطر ${n}: المادة متتبعة بالدفعات — اعدّ كل دفعة على حدة`);
  const expected = lotId ? S.lotBalance(lotId, h.id) : S.poolRow(companyId, p.id, h.id).qty;
  if (Math.abs(counted - expected) > 1e-9) checkReason(companyId, l.reasonCode, n);
  try {
    db.prepare('INSERT INTO stock_count_lines (count_id, company_id, product_id, lot_id, expected_qty, counted_qty, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?)').run(countId, companyId, p.id, lotId, Q(expected), Q(counted), l.reasonCode || null);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) fail('duplicate_line', `السطر ${n}: المادة/الدفعة مكررة في الجرد`);
    throw err;
  }
}
// Approval posts the counted quantities against the CURRENT balance (moves
// after the count was taken are respected), one entry for the document.
function approveCount(companyId, id, { breakGlassReason } = {}, actor) {
  requireActive(companyId);
  return ledger.transaction(() => {
    const c = getCount(companyId, id);
    if (c.status !== 'draft') fail('count_not_draft', 'مستند الجرد ليس مسودة', 409);
    if (actor?.id && c.created_by === actor.id) {
      require('./purchasing').sodGuard(companyId, 'count', actor, breakGlassReason, { code: 'sod_count_creator', message: 'فصل المهام: لا يعتمد الجرد من أدخله. يجب أن يعتمده مستخدم آخر.', entityType: 'stock_count', entityId: c.id });
    }
    const h = S.holderById(companyId, c.holder_id);
    const acc = S.holderAccount(companyId, h);
    const adj = S.sysAcc(companyId, 'inventory_adjustments');
    const entryLines = [];
    const moveIds = [];
    for (const l of c.lines) {
      const current = l.lot_id ? S.lotBalance(l.lot_id, h.id) : S.poolRow(companyId, l.product_id, h.id).qty;
      const delta = Q(l.counted_qty - current);
      if (Math.abs(delta) < 1e-9) continue;
      const r = delta > 0
        ? S.moveIn(companyId, { productId: l.product_id, holderId: h.id, qty: delta, moveType: 'count', reasonCode: l.reason_code, sourceType: 'stock_count', sourceId: c.id, date: c.count_date, lotId: l.lot_id, actor })
        : S.moveOutAuto(companyId, { productId: l.product_id, holderId: h.id, qty: -delta, moveType: 'count', reasonCode: l.reason_code, sourceType: 'stock_count', sourceId: c.id, date: c.count_date, lotId: l.lot_id, actor });
      const v = delta > 0 ? r.value : -r.value;
      db.prepare('UPDATE stock_count_lines SET value_minor = ? WHERE id = ?').run(v, l.id);
      moveIds.push(...(r.moveIds || [r.moveId]));
      entryLines.push({ accountId: acc, amount: v, memo: l.product_name }, { accountId: adj, amount: -v, memo: l.reason_code });
    }
    checkpoint('stock.count.after_moves');
    const entry = S.post(companyId, { date: c.count_date, description: `جرد ${c.count_number} — ${h.name}`, lines: entryLines, moveIds }, actor);
    db.prepare("UPDATE stock_counts SET status = 'approved', approved_by = ?, approved_at = datetime('now'), journal_entry_id = ? WHERE id = ?").run(actor?.id ?? null, entry?.id ?? null, c.id);
    const after = getCount(companyId, c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.count.approve', entityType: 'stock_count', entityId: c.id, before: { status: 'draft' }, after: { status: 'approved', journal_entry_id: entry?.id ?? null, moves: moveIds.length } });
    return after;
  });
}
function rejectCount(companyId, id, { reason } = {}, actor) {
  return ledger.transaction(() => {
    const c = getCount(companyId, id);
    if (c.status !== 'draft') fail('count_not_draft', 'مستند الجرد ليس مسودة', 409);
    if (!String(reason || '').trim()) fail('reason_required', 'سبب الرفض مطلوب');
    db.prepare("UPDATE stock_counts SET status = 'rejected', reject_reason = ? WHERE id = ?").run(String(reason).trim(), c.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.count.reject', entityType: 'stock_count', entityId: c.id, before: { status: 'draft' }, after: { status: 'rejected', reason } });
    return getCount(companyId, c.id);
  });
}

// ---------------------------------------------------------------------
// Wastage / damage / loss and repacking
// ---------------------------------------------------------------------

function getDoc(companyId, id) {
  const d = db.prepare('SELECT * FROM stock_documents WHERE id = ? AND company_id = ?').get(Number(id), companyId);
  if (!d) fail('invalid_stock_document', 'المستند غير موجود', 400);
  return { ...d, holder_name: S.holderById(companyId, d.holder_id).name, lines: db.prepare('SELECT l.*, p.name AS product_name, lt.lot_code FROM stock_document_lines l JOIN products p ON p.id = l.product_id LEFT JOIN stock_lots lt ON lt.id = l.lot_id WHERE l.document_id = ? ORDER BY l.id').all(d.id) };
}
function listDocs(companyId, { kind } = {}) {
  return db.prepare(`SELECT d.*, h.name AS holder_name FROM stock_documents d JOIN stock_holders h ON h.id = d.holder_id WHERE d.company_id = ? ${kind ? 'AND d.kind = ?' : ''} ORDER BY d.id DESC LIMIT 300`).all(...[companyId, ...(kind ? [kind] : [])]);
}
// lines: [{ productId, lotId?, qty }]; reasonCode: damage / expiry / loss / theft / other.
function postWastage(companyId, { holderId, date, reasonCode, notes, lines }, actor) {
  requireActive(companyId);
  return ledger.transaction(() => {
    const h = S.holderById(companyId, Number(holderId));
    const d = date || today();
    if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
    checkReason(companyId, reasonCode);
    if (!Array.isArray(lines) || !lines.length) fail('lines_required', 'أدخل سطرًا واحدًا على الأقل');
    const did = Number(db.prepare("INSERT INTO stock_documents (company_id, doc_number, kind, reason_code, holder_id, doc_date, notes, created_by) VALUES (?, ?, 'wastage', ?, ?, ?, ?, ?)").run(companyId, issueNumber(companyId, 'WS', 'WS-'), reasonCode, h.id, d, notes || null, actor?.id ?? null).lastInsertRowid);
    const moveIds = [];
    let total = 0;
    lines.forEach((l, i) => {
      const p = S.productRow(companyId, l.productId);
      const qty = Number(l.qty);
      if (!(qty > 0)) fail('invalid_qty', `السطر ${i + 1}: الكمية غير صالحة`);
      const lotId = l.lotId ? S.checkLot(companyId, p.id, Number(l.lotId)).id : null;
      const r = S.moveOutAuto(companyId, { productId: p.id, holderId: h.id, qty, lotId, moveType: 'wastage', reasonCode, sourceType: 'stock_document', sourceId: did, date: d, actor });
      for (const pc of r.pieces) db.prepare("INSERT INTO stock_document_lines (document_id, company_id, direction, product_id, lot_id, qty, value_minor) VALUES (?, ?, 'out', ?, ?, ?, ?)").run(did, companyId, p.id, pc.lotId, pc.qty, pc.value);
      moveIds.push(...r.moveIds);
      total += r.value;
    });
    checkpoint('stock.wastage.after_moves');
    const entry = S.post(companyId, { date: d, description: `تالف/هدر — ${h.name} (${reasonCode})`, lines: [{ accountId: S.sysAcc(companyId, 'inventory_wastage'), amount: total, memo: reasonCode }, { accountId: S.holderAccount(companyId, h), amount: -total, memo: 'تالف/هدر' }], moveIds }, actor);
    db.prepare('UPDATE stock_documents SET value_minor = ?, journal_entry_id = ? WHERE id = ?').run(total, entry?.id ?? null, did);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.wastage.post', entityType: 'stock_document', entityId: did, before: null, after: { reason_code: reasonCode, value_minor: total } });
    return getDoc(companyId, did);
  });
}
// Repacking / reclassification: out of `from`, into `to` (same holder) at
// the same value — e.g. a carton opened into units of another product.
function postRepack(companyId, { holderId, date, reasonCode = 'other', notes, from, to }, actor) {
  requireActive(companyId);
  return ledger.transaction(() => {
    const h = S.holderById(companyId, Number(holderId));
    const d = date || today();
    if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
    checkReason(companyId, reasonCode);
    const pf = S.productRow(companyId, from?.productId);
    const pt = S.productRow(companyId, to?.productId);
    if (pf.id === pt.id) fail('same_product', 'إعادة التعبئة بين مادتين مختلفتين');
    if (!(Number(from.qty) > 0) || !(Number(to.qty) > 0)) fail('invalid_qty', 'الكميتان مطلوبتان');
    const did = Number(db.prepare("INSERT INTO stock_documents (company_id, doc_number, kind, reason_code, holder_id, doc_date, notes, created_by) VALUES (?, ?, 'repack', ?, ?, ?, ?, ?)").run(companyId, issueNumber(companyId, 'RP', 'RP-'), reasonCode, h.id, d, notes || null, actor?.id ?? null).lastInsertRowid);
    const out = S.moveOutAuto(companyId, { productId: pf.id, holderId: h.id, qty: Number(from.qty), lotId: from.lotId ? Number(from.lotId) : null, moveType: 'reclass_out', reasonCode, sourceType: 'stock_document', sourceId: did, date: d, actor });
    let lotId = to.lotId ? S.checkLot(companyId, pt.id, Number(to.lotId)).id : null;
    if (!lotId && to.lotCode) lotId = S.getOrCreateLot(companyId, pt.id, { lotCode: to.lotCode, expiryDate: to.expiryDate, productionDate: to.productionDate }).id;
    const inn = S.moveIn(companyId, { productId: pt.id, holderId: h.id, qty: Number(to.qty), valueMinor: out.value, moveType: 'reclass_in', reasonCode, sourceType: 'stock_document', sourceId: did, date: d, lotId, actor });
    for (const pc of out.pieces) db.prepare("INSERT INTO stock_document_lines (document_id, company_id, direction, product_id, lot_id, qty, value_minor) VALUES (?, ?, 'out', ?, ?, ?, ?)").run(did, companyId, pf.id, pc.lotId, pc.qty, pc.value);
    db.prepare("INSERT INTO stock_document_lines (document_id, company_id, direction, product_id, lot_id, qty, value_minor) VALUES (?, ?, 'in', ?, ?, ?, ?)").run(did, companyId, pt.id, lotId, Number(to.qty), inn.value);
    const acc = S.holderAccount(companyId, h);
    const lines = [{ accountId: acc, amount: inn.value, memo: pt.name }, { accountId: acc, amount: -out.value, memo: pf.name }];
    // Standard cost on the target: the difference vs the standard value -> PPV.
    if (inn.value !== out.value) lines.push({ accountId: S.sysAcc(companyId, 'purchase_price_variance'), amount: out.value - inn.value, memo: 'فرق التكلفة المعيارية' });
    const entry = S.post(companyId, { date: d, description: `إعادة تعبئة: ${pf.name} ← ${pt.name}`, lines, moveIds: [...out.moveIds, inn.moveId] }, actor);
    db.prepare('UPDATE stock_documents SET value_minor = ?, journal_entry_id = ? WHERE id = ?').run(out.value, entry?.id ?? null, did);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.repack.post', entityType: 'stock_document', entityId: did, before: null, after: { from: pf.id, to: pt.id, value_minor: out.value } });
    return getDoc(companyId, did);
  });
}

// ---------------------------------------------------------------------
// Lots, expiry, reorder, reserved stock
// ---------------------------------------------------------------------

function lotRow(companyId, lotId) {
  const l = db.prepare('SELECT l.*, p.name AS product_name, s.name AS supplier_name FROM stock_lots l JOIN products p ON p.id = l.product_id LEFT JOIN suppliers s ON s.id = l.supplier_id WHERE l.id = ? AND l.company_id = ?').get(Number(lotId), companyId);
  if (!l) fail('invalid_lot', 'الدفعة غير موجودة', 400);
  return l;
}
function listLots(companyId, { productId, status, expiringWithin } = {}) {
  const where = ['l.company_id = ?'];
  const p = [companyId];
  if (productId) { where.push('l.product_id = ?'); p.push(Number(productId)); }
  if (status) { where.push('l.status = ?'); p.push(String(status)); }
  if (expiringWithin) { where.push('l.expiry_date IS NOT NULL AND l.expiry_date <= ?'); p.push(addDays(today(), Number(expiringWithin))); }
  return db.prepare(`SELECT l.*, pr.name AS product_name, COALESCE((SELECT SUM(b.qty) FROM stock_lot_balances b WHERE b.lot_id = l.id), 0) qty
    FROM stock_lots l JOIN products pr ON pr.id = l.product_id WHERE ${where.join(' AND ')} ORDER BY CASE WHEN l.expiry_date IS NULL THEN 1 ELSE 0 END, l.expiry_date, l.id`).all(...p)
    .map((l) => ({ ...l, days_to_expiry: l.expiry_date ? daysBetween(today(), l.expiry_date) : null }));
}
function setLotStatus(companyId, lotId, { status, reason } = {}, actor) {
  if (!['available', 'quarantine', 'rejected'].includes(status)) fail('invalid_status', 'الحالة غير صالحة');
  return ledger.transaction(() => {
    const l = lotRow(companyId, lotId);
    if (l.status === 'expired' && status === 'available') fail('lot_expired', 'الدفعة منتهية الصلاحية — لا يمكن إتاحتها', 409);
    if (status !== 'available' && !String(reason || '').trim()) fail('reason_required', 'السبب مطلوب');
    db.prepare('UPDATE stock_lots SET status = ?, status_reason = ? WHERE id = ?').run(status, reason || null, l.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.lot.status', entityType: 'stock_lot', entityId: l.id, before: { status: l.status }, after: { status, reason: reason || null } });
    return lotRow(companyId, l.id);
  });
}

// Approved, not yet delivered orders reserve stock (base units).
function reservedQty(companyId, productId) {
  let total = 0;
  for (const o of db.prepare("SELECT items_json FROM orders WHERE company_id = ? AND status IN ('approved', 'processing', 'out_for_delivery') AND deleted_at IS NULL").all(companyId)) {
    let items = [];
    try {
      items = JSON.parse(o.items_json || '[]');
    } catch {
      items = [];
    }
    for (const it of items) {
      const pid = Number(it.product_id ?? it.productId);
      if (pid !== Number(productId)) continue;
      total += S.baseQty(pid, Number(it.qty ?? it.quantity ?? 0), it.unit_key ?? it.unitKey ?? null);
    }
  }
  return Q(total);
}
function onHand(companyId, productId, { warehousesOnly = false } = {}) {
  return db.prepare(`SELECT COALESCE(SUM(p.qty), 0) q, COALESCE(SUM(p.value_minor), 0) v FROM stock_pools p JOIN stock_holders h ON h.id = p.holder_id WHERE p.company_id = ? AND p.product_id = ? ${warehousesOnly ? "AND h.kind = 'warehouse'" : ''}`).get(companyId, productId);
}
function openPoQty(companyId, productId) {
  return db.prepare("SELECT COALESCE(SUM(l.qty - l.received_qty), 0) q FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id WHERE o.company_id = ? AND l.product_id = ? AND o.status IN ('pending_approval', 'approved', 'partially_received')").get(companyId, productId).q;
}
function reorderSuggestions(companyId) {
  return db.prepare('SELECT s.*, p.name FROM product_stock_settings s JOIN products p ON p.id = s.product_id WHERE s.company_id = ? AND s.reorder_point IS NOT NULL ORDER BY p.name').all(companyId).map((s) => {
    const qty = onHand(companyId, s.product_id, { warehousesOnly: true }).q;
    const reserved = reservedQty(companyId, s.product_id);
    const onOrder = openPoQty(companyId, s.product_id);
    const available = Q(qty - reserved + onOrder);
    const needed = available <= s.reorder_point;
    const suggested = needed ? Q(Math.max(s.reorder_qty || 0, s.reorder_point - available + (s.reorder_qty || 0))) : 0;
    return { product_id: s.product_id, product_name: s.name, on_hand: Q(qty), reserved, on_order: onOrder, available, reorder_point: s.reorder_point, reorder_qty: s.reorder_qty, needed, suggested_qty: suggested };
  });
}

// Alert sweep (15-minute cadence; one unread notification per subject):
// expired lots marked 'expired'; near-expiry lots with stock; reorder.
function sweepAlerts({ now } = {}) {
  const d = (now || new Date()).toISOString().slice(0, 10);
  let created = 0;
  for (const c of db.prepare("SELECT id FROM companies WHERE modules_json LIKE '%\"stock_ledger\":true%'").all()) {
    const cid = c.id;
    for (const l of db.prepare("SELECT l.*, p.name pn FROM stock_lots l JOIN products p ON p.id = l.product_id WHERE l.company_id = ? AND l.status = 'available' AND l.expiry_date IS NOT NULL AND l.expiry_date < ?").all(cid, d)) {
      db.prepare("UPDATE stock_lots SET status = 'expired', status_reason = 'انتهت الصلاحية' WHERE id = ?").run(l.id);
      logAudit({ companyId: cid, actor: null, action: 'stock.lot.expired', entityType: 'stock_lot', entityId: l.id, before: { status: 'available' }, after: { status: 'expired' } });
      const qty = db.prepare('SELECT COALESCE(SUM(qty), 0) q FROM stock_lot_balances WHERE lot_id = ?').get(l.id).q;
      if (qty > 1e-9) {
        createNotification({ companyId: cid, type: 'lot_expired', message_ar: `انتهت صلاحية الدفعة ${l.lot_code} من ${l.pn} (${qty}) — سجّلها تالفًا أو أعدها للمورد`, message_en: `Lot ${l.lot_code} of ${l.pn} expired (${qty}).`, link_path: `/stock?tab=lots&lot=${l.id}`, entity_type: 'stock_lot', entity_id: l.id });
        created += 1;
      }
    }
    const days = Number(db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'expiry_alert_days'").get(cid)?.value ?? 30);
    for (const l of db.prepare("SELECT l.*, p.name pn, (SELECT COALESCE(SUM(b.qty), 0) FROM stock_lot_balances b WHERE b.lot_id = l.id) q FROM stock_lots l JOIN products p ON p.id = l.product_id WHERE l.company_id = ? AND l.status = 'available' AND l.expiry_date IS NOT NULL AND l.expiry_date <= ?").all(cid, addDays(d, days))) {
      if (l.q <= 1e-9 || hasUnreadNotification(cid, 'lot_near_expiry', l.id, 'stock_lot')) continue;
      createNotification({ companyId: cid, type: 'lot_near_expiry', message_ar: `الدفعة ${l.lot_code} من ${l.pn} تنتهي صلاحيتها في ${l.expiry_date} (الرصيد ${l.q})`, message_en: `Lot ${l.lot_code} of ${l.pn} expires ${l.expiry_date}.`, link_path: `/stock?tab=lots&lot=${l.id}`, entity_type: 'stock_lot', entity_id: l.id });
      created += 1;
    }
    for (const r of reorderSuggestions(cid)) {
      if (!r.needed || hasUnreadNotification(cid, 'reorder_needed', r.product_id, 'product')) continue;
      createNotification({ companyId: cid, type: 'reorder_needed', message_ar: `إعادة طلب: ${r.product_name} — المتاح ${r.available} (حد الطلب ${r.reorder_point})، الكمية المقترحة ${r.suggested_qty}`, message_en: `Reorder ${r.product_name}: available ${r.available}, suggested ${r.suggested_qty}.`, link_path: `/stock/items/${r.product_id}`, entity_type: 'product', entity_id: r.product_id });
      created += 1;
    }
  }
  return created;
}

// ---------------------------------------------------------------------
// Lot trace and recall
// ---------------------------------------------------------------------

function describeMove(companyId, m) {
  const out = { id: m.id, date: m.move_date, type: m.move_type, qty: m.qty, holder: m.holder_name, holder_id: m.holder_id };
  if (m.source_type === 'goods_receipt') {
    const g = db.prepare('SELECT g.receipt_number, s.id sid, s.name sname FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id WHERE g.id = ?').get(m.source_id);
    return { ...out, document: g?.receipt_number, supplier_id: g?.sid, supplier_name: g?.sname };
  }
  if (m.source_type === 'sales_invoice_line') {
    const i = db.prepare('SELECT i.id, i.invoice_number, i.invoice_date, s.id shop_id, s.name shop_name, s.phone FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN shops s ON s.id = i.shop_id WHERE l.id = ?').get(m.source_id);
    return { ...out, document: i?.invoice_number, invoice_id: i?.id, shop_id: i?.shop_id, shop_name: i?.shop_name, phone: i?.phone };
  }
  if (m.source_type === 'sales_credit_note') {
    const c = db.prepare('SELECT c.credit_note_number, s.id shop_id, s.name shop_name FROM sales_credit_notes c JOIN shops s ON s.id = c.shop_id WHERE c.id = ?').get(m.source_id);
    return { ...out, document: c?.credit_note_number, shop_id: c?.shop_id, shop_name: c?.shop_name };
  }
  if (m.source_type === 'mfg_order') {
    const o = db.prepare('SELECT order_number FROM mfg_orders WHERE id = ?').get(m.source_id);
    return { ...out, document: o?.order_number, order_id: m.source_id };
  }
  return { ...out, document: `${m.source_type}${m.source_id ? ` #${m.source_id}` : ''}` };
}
function lotMoves(companyId, lotId) {
  return db.prepare('SELECT m.*, h.name holder_name FROM stock_moves m JOIN stock_holders h ON h.id = m.holder_id WHERE m.company_id = ? AND m.lot_id = ? ORDER BY m.id').all(companyId, lotId).map((m) => describeMove(companyId, m));
}
// Supplier lot -> receipts -> holders -> customers (net of returns).
function forwardTrace(companyId, lotId, depth = 0) {
  const lot = lotRow(companyId, lotId);
  const moves = lotMoves(companyId, lot.id);
  const customers = new Map();
  for (const m of moves) {
    if (!m.shop_id || !['sale', 'sale_return'].includes(m.type)) continue;
    const c = customers.get(m.shop_id) || { shop_id: m.shop_id, shop_name: m.shop_name, phone: m.phone || null, qty: 0, documents: [] };
    c.qty = Q(c.qty - m.qty);
    c.documents.push({ document: m.document, invoice_id: m.invoice_id || null, date: m.date, qty: -m.qty });
    if (m.phone) c.phone = m.phone;
    customers.set(m.shop_id, c);
  }
  const balances = db.prepare('SELECT b.holder_id, h.name holder_name, b.qty FROM stock_lot_balances b JOIN stock_holders h ON h.id = b.holder_id WHERE b.lot_id = ? AND ABS(b.qty) > 1e-9').all(lot.id);
  const receipts = moves.filter((m) => m.type === 'receipt' || m.type === 'production_output');
  // Prompt 9: a lot issued to production reaches the customers of the lots
  // produced from it (recursively, e.g. a roasted-almond lot -> a mix lot).
  const productions = [];
  if (depth < 10) {
    for (const p of require('./manufacturingOrders').producedFrom(companyId, lot.id)) {
      const t = forwardTrace(companyId, p.output_lot_id, depth + 1);
      productions.push({ ...p, customers: t.customers, on_hand_qty: t.on_hand_qty });
      for (const c of t.customers) {
        const cur = customers.get(c.shop_id) || { shop_id: c.shop_id, shop_name: c.shop_name, phone: c.phone || null, qty: 0, documents: [], via_lots: [] };
        cur.via_lots = [...new Set([...(cur.via_lots || []), p.lot_code, ...(c.via_lots || [])])];
        cur.documents.push(...c.documents.map((x) => ({ ...x, via_lot: p.lot_code })));
        cur.product_qty = Q((cur.product_qty || 0) + c.qty);
        if (c.phone) cur.phone = c.phone;
        customers.set(c.shop_id, cur);
      }
    }
  }
  return { lot, receipts, moves, customers: [...customers.values()], productions, balances, received_qty: Q(receipts.reduce((t, r) => t + r.qty, 0)), on_hand_qty: Q(balances.reduce((t, b) => t + b.qty, 0)) };
}
// Customer (or one invoice) -> lots they received -> back to the supplier lot.
function reverseTrace(companyId, { shopId, invoiceId }) {
  let where;
  let p;
  if (invoiceId) {
    const inv = db.prepare('SELECT id FROM sales_invoices WHERE id = ? AND company_id = ?').get(Number(invoiceId), companyId);
    if (!inv) fail('invalid_sales_invoice', 'الفاتورة غير موجودة', 400);
    where = 'l.invoice_id = ?';
    p = inv.id;
  } else {
    const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(Number(shopId), companyId);
    if (!shop) fail('invalid_shop', 'الزبون غير موجود', 400);
    where = 'i.shop_id = ?';
    p = shop.id;
  }
  const rows = db.prepare(`SELECT m.lot_id, -SUM(m.qty) qty, MIN(i.invoice_date) first_date, GROUP_CONCAT(DISTINCT i.invoice_number) invoices
    FROM stock_moves m JOIN sales_invoice_lines l ON l.id = m.source_id JOIN sales_invoices i ON i.id = l.invoice_id
    WHERE m.company_id = ? AND m.source_type = 'sales_invoice_line' AND m.lot_id IS NOT NULL AND ${where} GROUP BY m.lot_id`).all(companyId, p);
  return rows.map((r) => {
    const lot = lotRow(companyId, r.lot_id);
    const receipts = lotMoves(companyId, lot.id).filter((m) => m.type === 'receipt');
    return { made_from: require('./manufacturingOrders').madeFrom(companyId, lot.id), lot_id: lot.id, lot_code: lot.lot_code, product_name: lot.product_name, expiry_date: lot.expiry_date, supplier_lot: lot.supplier_lot, supplier_name: lot.supplier_name || receipts[0]?.supplier_name || null, receipts: receipts.map((x) => ({ document: x.document, date: x.date, qty: x.qty })), qty: r.qty, invoices: r.invoices ? r.invoices.split(',') : [], first_date: r.first_date };
  });
}
// Recall: everyone who received the lot (net of returns), what is still in
// stock where (to pull), quarantine status.
function recallReport(companyId, lotId) {
  const t = forwardTrace(companyId, lotId);
  return {
    lot: t.lot, supplier: { name: t.lot.supplier_name, supplier_lot: t.lot.supplier_lot }, received_qty: t.received_qty,
    customers: t.customers.filter((c) => c.qty > 1e-9 || c.product_qty > 1e-9).sort((a, b) => (b.qty || 0) - (a.qty || 0)),
    productions: t.productions,
    customers_all: t.customers, in_stock: t.balances, in_stock_qty: t.on_hand_qty,
    sold_qty: Q(t.customers.reduce((s, c) => s + c.qty, 0)),
  };
}

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------

function itemBalance(companyId) {
  const v = S.valuation(companyId);
  const byProduct = new Map();
  for (const r of v.rows) {
    const p = byProduct.get(r.product_id) || { product_id: r.product_id, product_name: r.product_name, method: r.method, qty: 0, value_minor: 0, warehouse_qty: 0, custody_qty: 0 };
    p.qty = Q(p.qty + r.qty);
    p.value_minor += r.value_minor;
    if (r.holder_kind === 'warehouse') p.warehouse_qty = Q(p.warehouse_qty + r.qty);
    else p.custody_qty = Q(p.custody_qty + r.qty);
    byProduct.set(r.product_id, p);
  }
  const rows = [...byProduct.values()].map((p) => {
    const reserved = reservedQty(companyId, p.product_id);
    return { ...p, reserved, available: Q(p.qty - reserved), unit_cost_minor: p.qty > 1e-9 ? p.value_minor / p.qty : 0 };
  });
  return { rows, total_minor: rows.reduce((s, r) => s + r.value_minor, 0), digits: v.digits };
}

// Ageing of what is on hand: the quantity is matched to the most recent
// arrivals in each holder (stock leaves oldest-first), aged from their date.
function ageing(companyId, { asOf } = {}) {
  const d = asOf || today();
  const buckets = ['d0_30', 'd31_60', 'd61_90', 'd91_180', 'd180_plus'];
  const bucketOf = (days) => (days <= 30 ? 'd0_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : days <= 180 ? 'd91_180' : 'd180_plus');
  const out = [];
  for (const p of db.prepare("SELECT p.product_id, p.holder_id, p.qty, p.value_minor, pr.name FROM stock_pools p JOIN products pr ON pr.id = p.product_id WHERE p.company_id = ? AND p.qty > 1e-9").all(companyId)) {
    const ins = db.prepare("SELECT move_date, qty FROM stock_moves WHERE company_id = ? AND product_id = ? AND holder_id = ? AND qty > 0 AND move_date <= ? ORDER BY move_date DESC, id DESC").all(companyId, p.product_id, p.holder_id, d);
    const row = { product_id: p.product_id, product_name: p.name, holder_id: p.holder_id, qty: p.qty, value_minor: p.value_minor };
    for (const b of buckets) row[b] = 0;
    let left = p.qty;
    for (const i of ins) {
      if (left <= 1e-9) break;
      const take = Math.min(left, i.qty);
      row[bucketOf(daysBetween(i.move_date, d))] = Q(row[bucketOf(daysBetween(i.move_date, d))] + take);
      left = Q(left - take);
    }
    if (left > 1e-9) row.d180_plus = Q(row.d180_plus + left);
    out.push(row);
  }
  return { as_of: d, buckets, rows: out };
}

function slowMoving(companyId, { days = 90 } = {}) {
  const since = addDays(today(), -Number(days));
  return itemBalance(companyId).rows.filter((r) => r.qty > 1e-9).map((r) => {
    const last = db.prepare("SELECT MAX(move_date) d FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_type = 'sale'").get(companyId, r.product_id).d;
    const sold = -db.prepare("SELECT COALESCE(SUM(qty), 0) q FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_type = 'sale' AND move_date >= ?").get(companyId, r.product_id, since).q;
    return { ...r, last_sale_date: last, sold_in_period: Q(sold), days_since_sale: last ? daysBetween(last, today()) : null };
  }).filter((r) => !r.last_sale_date || r.last_sale_date < since).sort((a, b) => b.value_minor - a.value_minor);
}

function countVariances(companyId, { from, to } = {}) {
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  return db.prepare(`SELECT c.count_number, c.count_date, h.name holder_name, p.name product_name, lt.lot_code, l.expected_qty, l.counted_qty, l.counted_qty - l.expected_qty variance, l.reason_code, l.value_minor
    FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id JOIN stock_holders h ON h.id = c.holder_id JOIN products p ON p.id = l.product_id LEFT JOIN stock_lots lt ON lt.id = l.lot_id
    WHERE c.company_id = ? AND c.status = 'approved' AND c.count_date BETWEEN ? AND ? AND ABS(l.counted_qty - l.expected_qty) > 1e-9 ORDER BY c.count_date, c.id`).all(companyId, f, t);
}

// Value of a product's stock on a date = sum of its moves up to then.
const valueAt = (companyId, productId, d) => db.prepare('SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_date <= ?').get(companyId, productId, d).v;
function turnover(companyId, { from, to } = {}) {
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  const days = Math.max(1, daysBetween(f, t) + 1);
  return db.prepare('SELECT DISTINCT m.product_id, p.name FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE m.company_id = ?').all(companyId).map((r) => {
    const cogs = -db.prepare("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_type IN ('sale', 'sale_return') AND move_date BETWEEN ? AND ?").get(companyId, r.product_id, f, t).v;
    const avg = (valueAt(companyId, r.product_id, addDays(f, -1)) + valueAt(companyId, r.product_id, t)) / 2;
    const turns = avg > 0 ? cogs / avg : null;
    return { product_id: r.product_id, product_name: r.name, cogs_minor: cogs, average_inventory_minor: Math.round(avg), turnover: turns === null ? null : Math.round(turns * 100) / 100, days_on_hand: turns ? Math.round(days / turns) : null };
  });
}

function profitability(companyId, { from, to } = {}) {
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  const rows = db.prepare(`SELECT l.product_id, p.name, SUM(l.qty) qty,
      SUM(CASE WHEN i.total_minor > 0 AND i.total_base_minor IS NOT NULL THEN l.net_minor * 1.0 * i.total_base_minor / i.total_minor ELSE l.net_minor END) revenue
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN products p ON p.id = l.product_id
    WHERE i.company_id = ? AND i.status IN ('posted', 'cancelled') AND i.invoice_date BETWEEN ? AND ? GROUP BY l.product_id`).all(companyId, f, t);
  return rows.map((r) => {
    const cogs = -db.prepare("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_type IN ('sale', 'sale_return') AND move_date BETWEEN ? AND ?").get(companyId, r.product_id, f, t).v;
    const revenue = Math.round(r.revenue);
    return { product_id: r.product_id, product_name: r.name, qty: r.qty, revenue_minor: revenue, cogs_minor: cogs, margin_minor: revenue - cogs, margin_pct: revenue ? Math.round(((revenue - cogs) / revenue) * 10000) / 100 : null };
  }).sort((a, b) => b.margin_minor - a.margin_minor);
}

function wastageAnalysis(companyId, { from, to } = {}) {
  const t = to || today();
  const f = from || `${t.slice(0, 4)}-01-01`;
  const rows = db.prepare(`SELECT m.reason_code, m.product_id, p.name product_name, -SUM(m.qty) qty, -SUM(m.value_minor) value_minor
    FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE m.company_id = ? AND m.move_type = 'wastage' AND m.move_date BETWEEN ? AND ? GROUP BY m.reason_code, m.product_id ORDER BY value_minor DESC`).all(companyId, f, t);
  const byReason = {};
  for (const r of rows) byReason[r.reason_code || 'other'] = (byReason[r.reason_code || 'other'] || 0) + r.value_minor;
  return { from: f, to: t, rows, by_reason: byReason, total_minor: rows.reduce((s, r) => s + r.value_minor, 0) };
}

// ---------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------

function itemCard(companyId, productId) {
  const p = S.productRow(companyId, productId);
  const settings = S.stockSettings(companyId, p.id) || { track_lots: 0, reorder_point: null, reorder_qty: null };
  const v = S.valuation(companyId, { productId: p.id });
  const qty = Q(v.rows.reduce((s, r) => s + r.qty, 0));
  const reserved = reservedQty(companyId, p.id);
  const since = addDays(today(), -90);
  const sales = db.prepare(`SELECT COALESCE(SUM(l.qty), 0) qty, COALESCE(SUM(l.net_minor), 0) revenue, COUNT(DISTINCT i.id) invoices FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
    WHERE i.company_id = ? AND l.product_id = ? AND i.status IN ('posted', 'cancelled') AND i.invoice_date >= ?`).get(companyId, p.id, since);
  const cogs = -db.prepare("SELECT COALESCE(SUM(value_minor), 0) v FROM stock_moves WHERE company_id = ? AND product_id = ? AND move_type IN ('sale', 'sale_return') AND move_date >= ?").get(companyId, p.id, since).v;
  const suppliers = db.prepare(`SELECT s.id, s.name, COUNT(DISTINCT g.id) receipts, SUM(gl.qty - gl.rejected_qty) qty, MAX(g.receipt_date) last_date,
      (SELECT gl2.unit_price_minor FROM goods_receipt_lines gl2 JOIN goods_receipts g2 ON g2.id = gl2.receipt_id WHERE g2.supplier_id = s.id AND gl2.product_id = ? ORDER BY g2.receipt_date DESC, gl2.id DESC LIMIT 1) last_unit_price_minor
    FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id JOIN suppliers s ON s.id = g.supplier_id WHERE g.company_id = ? AND gl.product_id = ? GROUP BY s.id ORDER BY last_date DESC`).all(p.id, companyId, p.id);
  const moves = db.prepare('SELECT m.*, h.name holder_name, lt.lot_code FROM stock_moves m JOIN stock_holders h ON h.id = m.holder_id LEFT JOIN stock_lots lt ON lt.id = m.lot_id WHERE m.company_id = ? AND m.product_id = ? ORDER BY m.id DESC LIMIT 50').all(companyId, p.id);
  return {
    product: { id: p.id, name: p.name, category: p.category, cost_price: p.cost_price, standard_cost_minor: S.stdCost(p.id) },
    method: S.methodFor(companyId, p.id), settings,
    qty, value_minor: v.total_minor, unit_cost_minor: qty > 1e-9 ? v.total_minor / qty : 0, reserved, available: Q(qty - reserved), on_order: openPoQty(companyId, p.id),
    holders: v.rows,
    lots: listLots(companyId, { productId: p.id }).filter((l) => l.qty > 1e-9 || l.status !== 'available'),
    suppliers,
    sales_90d: { qty: sales.qty, revenue_minor: sales.revenue, invoices: sales.invoices, cogs_minor: cogs, margin_minor: sales.revenue - cogs, margin_pct: sales.revenue ? Math.round(((sales.revenue - cogs) / sales.revenue) * 10000) / 100 : null },
    moves,
    digits: v.digits,
  };
}

module.exports = {
  reasonCodes,
  listCounts,
  getCount,
  createCount,
  approveCount,
  rejectCount,
  listDocs,
  getDoc,
  postWastage,
  postRepack,
  listLots,
  lotRow,
  setLotStatus,
  reservedQty,
  reorderSuggestions,
  sweepAlerts,
  forwardTrace,
  reverseTrace,
  recallReport,
  itemBalance,
  ageing,
  slowMoving,
  countVariances,
  turnover,
  profitability,
  wastageAnalysis,
  itemCard,
};
