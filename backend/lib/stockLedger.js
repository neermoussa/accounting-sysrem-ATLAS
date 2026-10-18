// backend/lib/stockLedger.js
//
// Stock ledger engine (Prompt 8a). Every quantity change of an ACTIVATED
// company is a stock_moves row per product per holder, valued by the
// product's method (weighted average — default —, FIFO, or standard cost),
// kept per holder in stock_pools (+ stock_layers for FIFO). The legacy
// pooled tables factory_inventory / car_inventory are kept equal to the sum
// of the warehouse / custody holders. Inventory accounts: warehouse holders
// -> `inventory`, custody holders (vehicle / rep / car pool) ->
// `inventory_custody`; their ledger total = valuation total (daily check).
//
// Not activated (the default): nothing here is called by the old flows,
// which stay byte-identical (test/warehouseGolden.test.js). Activation =
// dry run (opening moves from today's quantities, recorded with a
// fingerprint) -> execute the same plan: opening moves + one
// `inventory_opening` entry (so the inventory-opening banner goes away).
//
// Negative stock is refused (insufficient_stock): a holder never goes
// below zero, so FIFO layers and average costs stay meaningful.

const crypto = require('crypto');
const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const { logAudit } = require('./auditLog');
const { fromMinor } = require('./ledgerCurrencies');
const { checkpoint } = require('./faultInjection');

class StockError extends Error {
  constructor(code, message, status = 400, extra) {
    super(message);
    this.code = code;
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new StockError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const today = () => new Date().toISOString().slice(0, 10);
const Q = (x) => Math.round(Number(x) * 1e6) / 1e6;
const EPS = 1e-9;
const METHODS = ['average', 'fifo', 'standard'];

function owned(companyId, kind, id, opts) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
    throw err;
  }
}
function setting(companyId, key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}
function setSetting(companyId, key, value) {
  db.prepare('INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value').run(companyId, key, String(value));
}
function sysAcc(companyId, key) {
  const a = ledger.getAccountBySystemKey(companyId, key);
  if (!a || !a.is_active) fail('missing_system_account', `الحساب النظامي ${key} غير معرّف — طبّق قالب دليل الحسابات أو شغّل الترحيلات`, 409);
  return a.id;
}
function baseDigits(companyId) {
  return ledger.getBaseCurrency(companyId).minor_unit_digits;
}

function isActive(companyId) {
  const row = db.prepare('SELECT modules_json FROM companies WHERE id = ?').get(companyId);
  try {
    return JSON.parse(row?.modules_json || '{}').stock_ledger === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------

function holderRow(companyId, kind, refId, name) {
  const r = db.prepare('SELECT * FROM stock_holders WHERE company_id = ? AND kind = ? AND ref_id = ?').get(companyId, kind, refId);
  if (r) return r;
  const id = db.prepare('INSERT INTO stock_holders (company_id, kind, ref_id, name) VALUES (?, ?, ?, ?)').run(companyId, kind, refId, name).lastInsertRowid;
  return db.prepare('SELECT * FROM stock_holders WHERE id = ?').get(id);
}
function defaultWarehouse(companyId) {
  let w = db.prepare("SELECT * FROM warehouses WHERE company_id = ? AND kind <> 'car' ORDER BY id LIMIT 1").get(companyId);
  if (!w) {
    const id = db.prepare("INSERT INTO warehouses (company_id, name, kind) VALUES (?, 'المستودع الرئيسي', 'factory')").run(companyId).lastInsertRowid;
    w = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  }
  return w;
}
function warehouseHolder(companyId, warehouseId) {
  const w = warehouseId ? owned(companyId, 'warehouse', warehouseId) : defaultWarehouse(companyId);
  return holderRow(companyId, 'warehouse', w.id, w.name);
}
function carPoolHolder(companyId) {
  return holderRow(companyId, 'car_pool', 0, 'بضاعة السيارات (غير محددة)');
}
function vehicleHolder(companyId, vehicleId) {
  const v = owned(companyId, 'vehicle', vehicleId);
  return holderRow(companyId, 'vehicle', v.id, v.label);
}
function repHolder(companyId, userId) {
  const u = owned(companyId, 'user', userId);
  return holderRow(companyId, 'rep', u.id, u.name);
}
// A rep's stock is in their vehicle when they have one, else on them.
function custodyHolderForRep(companyId, repId) {
  if (!repId) return carPoolHolder(companyId);
  const v = db.prepare('SELECT vehicle_id FROM vehicle_reps WHERE user_id = ? ORDER BY vehicle_id LIMIT 1').get(repId);
  if (v && db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND company_id = ?').get(v.vehicle_id, companyId)) return vehicleHolder(companyId, v.vehicle_id);
  return repHolder(companyId, repId);
}
const isCustody = (h) => h.kind !== 'warehouse';
const holderAccount = (companyId, h) => sysAcc(companyId, isCustody(h) ? 'inventory_custody' : 'inventory');
const legacyTable = (h) => (isCustody(h) ? 'car_inventory' : 'factory_inventory');
function holderById(companyId, id) {
  const h = db.prepare('SELECT * FROM stock_holders WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!h) fail('invalid_holder', 'مكان التخزين غير موجود', 400);
  return h;
}

// ---------------------------------------------------------------------
// Methods, units, costs
// ---------------------------------------------------------------------

function productRow(companyId, productId) {
  return owned(companyId, 'product', productId);
}
function methodFor(companyId, productId) {
  const p = db.prepare('SELECT category FROM products WHERE id = ?').get(productId);
  if (p?.category) {
    const m = db.prepare('SELECT method FROM stock_category_methods WHERE company_id = ? AND category = ?').get(companyId, p.category)?.method;
    if (m) return m;
  }
  const m = setting(companyId, 'inventory_valuation_method', 'average');
  return METHODS.includes(m) ? m : 'average';
}
function productHasStock(companyId, productIds) {
  if (!productIds.length) return false;
  return Boolean(db.prepare(`SELECT 1 FROM stock_pools WHERE company_id = ? AND product_id IN (${productIds.map(() => '?').join(',')}) AND (ABS(qty) > 1e-9 OR value_minor <> 0) LIMIT 1`).get(companyId, ...productIds));
}
// Changing a method while a product holds stock would mix two valuations
// in one pool: refused (empty it or revalue first).
function setMethod(companyId, { category, method }, actor) {
  if (!METHODS.includes(method)) fail('invalid_method', 'طريقة التقييم غير صالحة');
  return ledger.transaction(() => {
    const products = db.prepare(`SELECT id FROM products WHERE company_id = ? ${category ? 'AND category = ?' : ''}`).all(...[companyId, ...(category ? [category] : [])]).map((r) => r.id)
      .filter((pid) => methodFor(companyId, pid) !== method);
    if (productHasStock(companyId, products)) fail('method_locked', 'لا يمكن تغيير طريقة التقييم لمواد عليها رصيد — صفّر رصيدها أو استخدم فئة جديدة', 409);
    if (method === 'standard') {
      const missing = db.prepare(`SELECT name FROM products p WHERE company_id = ? ${category ? 'AND category = ?' : ''} AND NOT EXISTS (SELECT 1 FROM product_standard_costs s WHERE s.product_id = p.id) LIMIT 1`).get(...[companyId, ...(category ? [category] : [])]);
      if (missing && products.length) fail('standard_cost_missing', `أدخل التكلفة المعيارية للمادة ${missing.name} أولًا`, 409);
    }
    const before = { category: category || null, method: category ? db.prepare('SELECT method FROM stock_category_methods WHERE company_id = ? AND category = ?').get(companyId, category)?.method ?? null : setting(companyId, 'inventory_valuation_method', 'average') };
    if (category) db.prepare('INSERT INTO stock_category_methods (company_id, category, method) VALUES (?, ?, ?) ON CONFLICT(company_id, category) DO UPDATE SET method = excluded.method').run(companyId, category, method);
    else setSetting(companyId, 'inventory_valuation_method', method);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.method.set', entityType: 'settings', entityId: null, before, after: { category: category || null, method } });
    return { category: category || null, method };
  });
}

function stdCost(productId) {
  return db.prepare('SELECT standard_cost_minor s FROM product_standard_costs WHERE product_id = ?').get(productId)?.s ?? null;
}

// Quantity in the product's base unit.
function baseQty(productId, qty, unitKey) {
  if (!unitKey) return Q(qty);
  const base = db.prepare('SELECT factor FROM product_units WHERE product_id = ? AND is_base = 1').get(productId);
  const f = db.prepare('SELECT factor FROM product_units WHERE product_id = ? AND unit_key = ?').get(productId, unitKey)?.factor;
  return base && f ? Q((qty * f) / base.factor) : Q(qty);
}
// Cost for quantity that has no document cost (an adjustment in, an
// opening): the holder's average, else the product's standard cost, else
// products.cost_price (major units), else 0. Minor units per base unit.
function fallbackUnitCost(companyId, productId, holderId) {
  const pool = poolRow(companyId, productId, holderId);
  if (pool.qty > EPS && pool.value_minor > 0) return pool.value_minor / pool.qty;
  const any = db.prepare('SELECT SUM(qty) q, SUM(value_minor) v FROM stock_pools WHERE company_id = ? AND product_id = ? AND qty > 0').get(companyId, productId);
  if (any.q > EPS && any.v > 0) return any.v / any.q;
  const p = { ...db.prepare('SELECT cost_price FROM products WHERE id = ?').get(productId), standard_cost_minor: stdCost(productId) };
  if (p?.standard_cost_minor != null) return p.standard_cost_minor;
  if (p?.cost_price != null) return p.cost_price * 10 ** baseDigits(companyId);
  return 0;
}

// ---------------------------------------------------------------------
// Lots (Prompt 8b): a quantity dimension inside each holder; cost stays in
// the holder's pool. FEFO picking for lot-tracked products.
// ---------------------------------------------------------------------

function stockSettings(companyId, productId) {
  return db.prepare('SELECT * FROM product_stock_settings WHERE product_id = ? AND company_id = ?').get(productId, companyId) || null;
}
function isTracked(companyId, productId) {
  return Boolean(stockSettings(companyId, productId)?.track_lots);
}
function checkLot(companyId, productId, lotId) {
  const lot = db.prepare('SELECT * FROM stock_lots WHERE id = ? AND company_id = ?').get(lotId, companyId);
  if (!lot || lot.product_id !== productId) fail('invalid_lot', 'الدفعة غير موجودة أو لا تخص هذه المادة');
  return lot;
}
function lotBalance(lotId, holderId) {
  return db.prepare('SELECT qty FROM stock_lot_balances WHERE lot_id = ? AND holder_id = ?').get(lotId, holderId)?.qty ?? 0;
}
function addLotBalance(companyId, lotId, holderId, productId, delta) {
  db.prepare('INSERT INTO stock_lot_balances (company_id, lot_id, holder_id, product_id, qty) VALUES (?, ?, ?, ?, ?) ON CONFLICT(lot_id, holder_id) DO UPDATE SET qty = ROUND(qty + excluded.qty, 6)')
    .run(companyId, lotId, holderId, productId, Q(delta));
}
// Stock with no known lot (opening, adjustments in, a product that starts
// being tracked): the product's 'UNASSIGNED' lot, no expiry (picked last).
function defaultLot(companyId, productId) {
  const ex = db.prepare("SELECT * FROM stock_lots WHERE company_id = ? AND product_id = ? AND lot_code = 'UNASSIGNED'").get(companyId, productId);
  if (ex) return ex;
  const id = db.prepare("INSERT INTO stock_lots (company_id, product_id, lot_code) VALUES (?, ?, 'UNASSIGNED')").run(companyId, productId).lastInsertRowid;
  return db.prepare('SELECT * FROM stock_lots WHERE id = ?').get(id);
}
function getOrCreateLot(companyId, productId, { lotCode, productionDate, expiryDate, supplierId, supplierLot }) {
  const code = String(lotCode || '').trim();
  if (!code) fail('lot_code_required', 'رقم الدفعة مطلوب');
  const ex = db.prepare('SELECT * FROM stock_lots WHERE company_id = ? AND product_id = ? AND lot_code = ?').get(companyId, productId, code);
  if (ex) {
    if (expiryDate && ex.expiry_date && ex.expiry_date !== expiryDate) fail('lot_expiry_conflict', `الدفعة ${code} مسجلة بتاريخ صلاحية ${ex.expiry_date}`, 409);
    return ex;
  }
  const id = db.prepare('INSERT INTO stock_lots (company_id, product_id, lot_code, production_date, expiry_date, supplier_id, supplier_lot) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(companyId, productId, code, productionDate || null, expiryDate || null, supplierId || null, supplierLot || null).lastInsertRowid;
  return db.prepare('SELECT * FROM stock_lots WHERE id = ?').get(id);
}
// Lots to take `qty` from in a holder. FEFO (default): earliest expiry
// first, no-expiry lots last; FIFO: oldest lot first. Only 'available'
// lots; preferLotIds first (a purchase return takes its own lots).
function pickLots(companyId, productId, holderId, qty, { strategy = 'fefo', preferLotIds = [] } = {}) {
  const order = strategy === 'fifo' ? 'l.id' : "CASE WHEN l.expiry_date IS NULL THEN 1 ELSE 0 END, l.expiry_date, l.id";
  const lots = db.prepare(`SELECT l.id, l.lot_code, l.expiry_date, b.qty FROM stock_lot_balances b JOIN stock_lots l ON l.id = b.lot_id
    WHERE b.holder_id = ? AND b.product_id = ? AND b.qty > 1e-9 AND l.status = 'available' ORDER BY ${order}`).all(holderId, productId);
  if (preferLotIds.length) lots.sort((a, b) => preferLotIds.includes(b.id) - preferLotIds.includes(a.id));
  const out = [];
  let need = Q(qty);
  for (const l of lots) {
    if (need <= EPS) break;
    const take = Math.min(l.qty, need);
    out.push({ lotId: l.id, lotCode: l.lot_code, expiryDate: l.expiry_date, qty: Q(take) });
    need = Q(need - take);
  }
  if (need > EPS) {
    const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    fail('insufficient_stock', `الرصيد المتاح (دفعات صالحة) غير كافٍ للمادة ${p?.name || ''} — ينقص ${need}`, 409, { product_id: productId, holder_id: holderId, short: need });
  }
  return out;
}
// Out for any product: lot-tracked without a lot -> split by FEFO.
function moveOutAuto(companyId, params) {
  if (params.lotId || !isTracked(companyId, params.productId)) {
    const r = moveOut(companyId, params);
    return { value: r.value, moveIds: [r.moveId], moveId: r.moveId, pieces: [{ lotId: params.lotId ?? null, qty: params.qty, value: r.value }] };
  }
  const res = { value: 0, moveIds: [], pieces: [] };
  const lots = pickLots(companyId, params.productId, params.holderId, params.qty, { preferLotIds: params.preferLotIds || [] });
  let overrideLeft = params.valueOverride;
  for (const [i, pc] of lots.entries()) {
    // A value override (purchase return at receipt cost) is shared by quantity.
    let valueOverride;
    if (params.valueOverride != null) {
      valueOverride = i === lots.length - 1 ? overrideLeft : Math.round((params.valueOverride * pc.qty) / params.qty);
      overrideLeft -= valueOverride;
    }
    const r = moveOut(companyId, { ...params, qty: pc.qty, lotId: pc.lotId, valueOverride });
    res.value += r.value;
    res.moveIds.push(r.moveId);
    res.pieces.push({ lotId: pc.lotId, qty: pc.qty, value: r.value });
  }
  res.moveId = res.moveIds[0];
  return res;
}
// Turning lot tracking on moves existing stock into the UNASSIGNED lot.
function setProductSettings(companyId, productId, { trackLots, reorderPoint, reorderQty }, actor) {
  const p = productRow(companyId, productId);
  return ledger.transaction(() => {
    const before = stockSettings(companyId, p.id);
    const track = trackLots !== undefined ? (trackLots ? 1 : 0) : before?.track_lots ?? 0;
    if (before?.track_lots && !track && db.prepare("SELECT 1 FROM stock_lot_balances b JOIN stock_lots l ON l.id = b.lot_id WHERE b.product_id = ? AND ABS(b.qty) > 1e-9 AND l.lot_code <> 'UNASSIGNED'").get(p.id)) {
      fail('lots_in_stock', 'لا يمكن إيقاف تتبع الدفعات ومادة لها دفعات برصيد', 409);
    }
    const rp = reorderPoint !== undefined ? (reorderPoint === null || reorderPoint === '' ? null : Number(reorderPoint)) : before?.reorder_point ?? null;
    const rq = reorderQty !== undefined ? (reorderQty === null || reorderQty === '' ? null : Number(reorderQty)) : before?.reorder_qty ?? null;
    if ((rp !== null && !(rp >= 0)) || (rq !== null && !(rq > 0))) fail('invalid_reorder', 'حد إعادة الطلب أو كميته غير صالحة');
    db.prepare("INSERT INTO product_stock_settings (product_id, company_id, track_lots, reorder_point, reorder_qty) VALUES (?, ?, ?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET track_lots = excluded.track_lots, reorder_point = excluded.reorder_point, reorder_qty = excluded.reorder_qty, updated_at = datetime('now')")
      .run(p.id, companyId, track, rp, rq);
    if (track && !before?.track_lots) {
      const lot = defaultLot(companyId, p.id);
      for (const pool of db.prepare('SELECT * FROM stock_pools WHERE product_id = ? AND qty > 1e-9').all(p.id)) addLotBalance(companyId, lot.id, pool.holder_id, p.id, pool.qty);
    }
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.product_settings', entityType: 'product', entityId: p.id, before, after: stockSettings(companyId, p.id) });
    return stockSettings(companyId, p.id);
  });
}

// ---------------------------------------------------------------------
// Pools, moves, legacy projection
// ---------------------------------------------------------------------

function poolRow(companyId, productId, holderId) {
  return db.prepare('SELECT * FROM stock_pools WHERE product_id = ? AND holder_id = ?').get(productId, holderId) || { company_id: companyId, product_id: productId, holder_id: holderId, qty: 0, value_minor: 0 };
}
function savePool(companyId, productId, holderId, qty, value) {
  db.prepare('INSERT INTO stock_pools (company_id, product_id, holder_id, qty, value_minor) VALUES (?, ?, ?, ?, ?) ON CONFLICT(product_id, holder_id) DO UPDATE SET qty = excluded.qty, value_minor = excluded.value_minor')
    .run(companyId, productId, holderId, Q(qty), value);
}
function insertMove(companyId, m) {
  const id = Number(
    db.prepare(`INSERT INTO stock_moves (company_id, product_id, holder_id, lot_id, qty, unit_cost_minor, value_minor, method, move_type, source_type, source_id, group_key, reason_code, move_date, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(companyId, m.productId, m.holderId, m.lotId ?? null, Q(m.qty), m.qty ? Math.abs(m.value) / Math.abs(m.qty) : 0, m.value, m.method, m.moveType, m.sourceType, m.sourceId ?? null, m.groupKey ?? null, m.reasonCode ?? null, m.date || today(), m.actor?.id ?? null).lastInsertRowid
  );
  return id;
}
// Keeps factory_inventory / car_inventory = sum over the holders of that kind.
function syncLegacy(companyId, h, productId, delta) {
  if (Math.abs(delta) < EPS) return;
  const name = db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name;
  require('./holderStock').applyQty(legacyTable(h), companyId, productId, name, Q(delta));
}
// Legacy readers (sales COGS of non-activated companies, screens) see
// products.cost_price: keep it = company-wide average, in major units.
function refreshCostPrice(companyId, productId) {
  const r = db.prepare('SELECT SUM(qty) q, SUM(value_minor) v FROM stock_pools WHERE company_id = ? AND product_id = ?').get(companyId, productId);
  if (r.q > EPS) db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(Math.round((r.v / r.q) * 1e4) / 1e4 / 10 ** baseDigits(companyId), productId);
}

// In: qty > 0 with its value (minor, base). Standard method books the
// standard value and returns the difference as `variance` (to PPV).
// origin: { type, id } of the document the quantity came in on (FIFO layer).
function moveIn(companyId, { productId, holderId, qty, valueMinor, moveType, sourceType, sourceId, date, groupKey, reasonCode, origin, lotId, legacy = true, actor }) {
  qty = Q(qty);
  if (!(qty > EPS)) fail('invalid_qty', 'الكمية يجب أن تكون أكبر من صفر');
  const method = methodFor(companyId, productId);
  let value = Math.round(valueMinor ?? fallbackUnitCost(companyId, productId, holderId) * qty);
  let variance = 0;
  if (method === 'standard') {
    const std = stdCost(productId);
    if (std == null) fail('standard_cost_missing', 'المادة على طريقة التكلفة المعيارية بلا تكلفة معيارية', 409);
    const stdValue = Math.round(std * qty);
    variance = value - stdValue;
    value = stdValue;
  }
  if (!lotId && isTracked(companyId, productId)) lotId = defaultLot(companyId, productId).id;
  if (lotId) checkLot(companyId, productId, lotId);
  const moveId = insertMove(companyId, { productId, holderId, lotId, qty, value, method, moveType, sourceType, sourceId, date, groupKey, reasonCode, actor });
  const pool = poolRow(companyId, productId, holderId);
  savePool(companyId, productId, holderId, pool.qty + qty, pool.value_minor + value);
  if (lotId) addLotBalance(companyId, lotId, holderId, productId, qty);
  if (method === 'fifo') {
    db.prepare('INSERT INTO stock_layers (company_id, product_id, holder_id, in_move_id, origin_type, origin_id, layer_date, qty_in, qty_remaining, value_remaining_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, productId, holderId, moveId, origin?.type ?? sourceType, origin?.id ?? sourceId ?? null, date || today(), qty, qty, value);
  }
  if (legacy) syncLegacy(companyId, holderById(companyId, holderId), productId, qty);
  refreshCostPrice(companyId, productId);
  return { moveId, value, variance, method };
}

// Out: qty > 0 taken from the holder at the method's cost. preferOrigin
// {type, id}: FIFO consumes that document's layers first (a purchase
// return goes back at its own receipt cost).
// valueOverride (average method only): take this value instead of the
// average — a purchase return leaves at its own receipt cost.
function moveOut(companyId, { productId, holderId, qty, moveType, sourceType, sourceId, date, groupKey, reasonCode, preferOrigin, valueOverride, lotId, legacy = true, actor }) {
  qty = Q(qty);
  if (!(qty > EPS)) fail('invalid_qty', 'الكمية يجب أن تكون أكبر من صفر');
  const method = methodFor(companyId, productId);
  const pool = poolRow(companyId, productId, holderId);
  if (pool.qty + EPS < qty) {
    const h = holderById(companyId, holderId);
    const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    fail('insufficient_stock', `الرصيد غير كافٍ: ${p?.name || ''} في ${h.name} — المتوفر ${pool.qty} والمطلوب ${qty}`, 409, { product_id: productId, holder_id: holderId, available: pool.qty, requested: qty });
  }
  if (lotId) {
    checkLot(companyId, productId, lotId);
    const lb = lotBalance(lotId, holderId);
    if (lb + EPS < qty) {
      const lot = db.prepare('SELECT lot_code FROM stock_lots WHERE id = ?').get(lotId);
      fail('insufficient_lot_stock', `رصيد الدفعة ${lot?.lot_code} غير كافٍ — المتوفر ${lb} والمطلوب ${qty}`, 409, { lot_id: lotId, available: lb, requested: qty });
    }
  } else if (isTracked(companyId, productId)) {
    fail('lot_required', 'المادة متتبعة بالدفعات — حدّد الدفعة أو استخدم الاختيار التلقائي (FEFO)', 400);
  }
  const all = Math.abs(pool.qty - qty) < EPS;
  let value;
  const pieces = [];
  if (method === 'fifo') {
    const layers = db.prepare('SELECT * FROM stock_layers WHERE product_id = ? AND holder_id = ? AND qty_remaining > 1e-9 ORDER BY layer_date, id').all(productId, holderId);
    if (preferOrigin) layers.sort((a, b) => (b.origin_type === preferOrigin.type && b.origin_id === preferOrigin.id) - (a.origin_type === preferOrigin.type && a.origin_id === preferOrigin.id));
    let need = qty;
    value = 0;
    for (const l of layers) {
      if (need <= EPS) break;
      const take = Math.min(l.qty_remaining, need);
      const whole = Math.abs(take - l.qty_remaining) < EPS;
      const v = whole ? l.value_remaining_minor : Math.round((l.value_remaining_minor * take) / l.qty_remaining);
      pieces.push({ layer: l, qty: Q(take), value: v });
      value += v;
      need = Q(need - take);
    }
    if (all) value = pool.value_minor; // layers sum to the pool by construction
  } else if (method === 'standard') {
    const std = stdCost(productId) ?? 0;
    value = all ? pool.value_minor : Math.round(std * qty);
  } else if (valueOverride != null) {
    value = Math.round(valueOverride);
  } else {
    value = all ? pool.value_minor : Math.round((pool.value_minor * qty) / pool.qty);
  }
  const moveId = insertMove(companyId, { productId, holderId, lotId, qty: -qty, value: -value, method, moveType, sourceType, sourceId, date, groupKey, reasonCode, actor });
  for (const p of pieces) {
    db.prepare('UPDATE stock_layers SET qty_remaining = ?, value_remaining_minor = ? WHERE id = ?').run(Q(p.layer.qty_remaining - p.qty), p.layer.value_remaining_minor - p.value, p.layer.id);
    db.prepare('INSERT INTO stock_move_layers (move_id, layer_id, qty, value_minor) VALUES (?, ?, ?, ?)').run(moveId, p.layer.id, p.qty, p.value);
  }
  savePool(companyId, productId, holderId, pool.qty - qty, pool.value_minor - value);
  if (lotId) addLotBalance(companyId, lotId, holderId, productId, -qty);
  if (legacy) syncLegacy(companyId, holderById(companyId, holderId), productId, -qty);
  refreshCostPrice(companyId, productId);
  return { moveId, value, pieces, method };
}

// Adds value without quantity (landed cost) to the stock that came in on
// `origin` (a goods receipt line, originQty accepted there):
//   FIFO: to that origin's open layers (wherever they were transferred),
//         in proportion to what is left of originQty; the rest belongs to
//         quantity already gone -> returned as `residual` (to COGS);
//   average: to the receipt holder's pool if it holds stock, else residual;
//   standard: all residual (to purchase price variance).
// Returns { parts: [{ holderId, value, moveId }], residual }.
function addValue(companyId, { productId, holderId, origin, originQty, valueMinor, sourceType, sourceId, date, actor }) {
  const method = methodFor(companyId, productId);
  const parts = [];
  let residual = valueMinor;
  const book = (hid, v) => {
    if (!v) return;
    const moveId = insertMove(companyId, { productId, holderId: hid, qty: 0, value: v, method, moveType: 'landed_cost', sourceType, sourceId, date, actor });
    const pool = poolRow(companyId, productId, hid);
    savePool(companyId, productId, hid, pool.qty, pool.value_minor + v);
    parts.push({ holderId: hid, value: v, moveId });
    residual -= v;
  };
  if (method === 'fifo') {
    const layers = db.prepare('SELECT * FROM stock_layers WHERE company_id = ? AND product_id = ? AND origin_type = ? AND origin_id = ? AND qty_remaining > 1e-9 ORDER BY id').all(companyId, productId, origin.type, origin.id);
    const remaining = layers.reduce((s, l) => s + l.qty_remaining, 0);
    if (remaining > EPS && originQty > EPS) {
      const toStock = Math.round((valueMinor * Math.min(remaining, originQty)) / originQty);
      let left = toStock;
      layers.forEach((l, i) => {
        const v = i === layers.length - 1 ? left : Math.round((toStock * l.qty_remaining) / remaining);
        left -= v;
        if (!v) return;
        db.prepare('UPDATE stock_layers SET value_remaining_minor = value_remaining_minor + ? WHERE id = ?').run(v, l.id);
        book(l.holder_id, v);
      });
    }
  } else if (method === 'average') {
    if (poolRow(companyId, productId, holderId).qty > EPS) book(holderId, valueMinor);
  }
  refreshCostPrice(companyId, productId);
  return { parts, residual };
}

// Transfer between holders at cost (FIFO layers keep their origin).
function moveTransfer(companyId, { productId, fromHolderId, toHolderId, qty, sourceType, sourceId, date, groupKey, lotId, legacy = true, actor }) {
  if (fromHolderId === toHolderId) fail('same_holder', 'لا يمكن التحويل إلى المكان نفسه');
  // Lot-tracked without a lot: one transfer per FEFO lot.
  if (!lotId && isTracked(companyId, productId)) {
    const res = { value: 0, outMoveId: null, inMoveId: null, moveIds: [] };
    for (const pc of pickLots(companyId, productId, fromHolderId, qty)) {
      const t = moveTransfer(companyId, { productId, fromHolderId, toHolderId, qty: pc.qty, sourceType, sourceId, date, groupKey, lotId: pc.lotId, legacy, actor });
      res.value += t.value;
      res.outMoveId = res.outMoveId || t.outMoveId;
      res.inMoveId = res.inMoveId || t.inMoveId;
      res.moveIds.push(...t.moveIds);
    }
    return res;
  }
  const out = moveOut(companyId, { productId, holderId: fromHolderId, qty, moveType: 'transfer_out', sourceType, sourceId, date, groupKey, lotId, legacy, actor });
  let inMove;
  if (out.method === 'fifo') {
    let first = null;
    for (const p of out.pieces) {
      const r = moveIn(companyId, { productId, holderId: toHolderId, qty: p.qty, valueMinor: p.value, moveType: 'transfer_in', sourceType, sourceId, date, groupKey, lotId, origin: { type: p.layer.origin_type, id: p.layer.origin_id }, legacy, actor });
      first = first || r;
    }
    inMove = first;
  } else {
    const pool = poolRow(companyId, productId, toHolderId);
    const moveId = insertMove(companyId, { productId, holderId: toHolderId, lotId, qty, value: out.value, method: out.method, moveType: 'transfer_in', sourceType, sourceId, date, groupKey, actor });
    savePool(companyId, productId, toHolderId, pool.qty + qty, pool.value_minor + out.value);
    if (lotId) addLotBalance(companyId, lotId, toHolderId, productId, qty);
    if (legacy) syncLegacy(companyId, holderById(companyId, toHolderId), productId, qty);
    inMove = { moveId };
  }
  return { value: out.value, outMoveId: out.moveId, inMoveId: inMove.moveId, moveIds: [out.moveId, inMove.moveId] };
}

// Posts one entry for a set of moves and links them to it. lines:
// [{ accountId, amount (+ debit / - credit), memo }] — zero lines dropped.
function post(companyId, { date, description, sourceType = 'stock_move', sourceId, lines, moveIds = [] }, actor) {
  const merged = new Map();
  for (const l of lines) {
    if (!l.amount) continue;
    const k = `${l.accountId}|${l.memo || ''}`;
    merged.set(k, { ...l, amount: (merged.get(k)?.amount || 0) + l.amount });
  }
  const out = [...merged.values()].filter((l) => l.amount).map((l) => ({ accountId: l.accountId, debitMinor: l.amount > 0 ? l.amount : 0, creditMinor: l.amount < 0 ? -l.amount : 0, memo: l.memo || null }));
  if (!out.length) return null;
  const entry = ledger.postEntry(companyId, { date: date || today(), description, sourceType, sourceId: sourceId ?? moveIds[0], lines: out }, actor);
  if (moveIds.length) db.prepare(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${moveIds.map(() => '?').join(',')})`).run(entry.id, ...moveIds);
  return entry;
}

// ---------------------------------------------------------------------
// Adjustments (screens, counts, offline counts)
// ---------------------------------------------------------------------

// Sets one holder's quantity; the difference is an adjustment move posted
// against inventory_adjustments (moveType 'count' for stock counts).
function adjustHolder(companyId, { productId, holderId, newQty, moveType = 'adjustment', reasonCode, sourceType = 'stock_adjustment', sourceId, date, lotId, legacy = false, actor, description }) {
  // With a lot: newQty is that lot's quantity in the holder.
  const pool = poolRow(companyId, productId, holderId);
  const current = lotId ? lotBalance(lotId, holderId) : pool.qty;
  const delta = Q(newQty - current);
  if (Math.abs(delta) < EPS) return null;
  const h = holderById(companyId, holderId);
  const r = delta > 0
    ? moveIn(companyId, { productId, holderId, qty: delta, moveType, sourceType, sourceId, date, reasonCode, lotId, legacy, actor })
    : moveOutAuto(companyId, { productId, holderId, qty: -delta, moveType, sourceType, sourceId, date, reasonCode, lotId, legacy, actor });
  const signed = delta > 0 ? r.value : -r.value;
  const name = db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name;
  post(companyId, {
    date, description: description || `${moveType === 'count' ? 'فرق جرد' : 'تسوية مخزون'} — ${name} في ${h.name}`,
    lines: [
      { accountId: holderAccount(companyId, h), amount: signed, memo: name },
      { accountId: sysAcc(companyId, 'inventory_adjustments'), amount: -signed, memo: reasonCode || null },
    ],
    moveIds: r.moveIds || [r.moveId],
  }, actor);
  return { delta, value: signed, moveId: r.moveId || r.moveIds?.[0] };
}

// A legacy screen / count / offline count set the POOLED quantity of a
// product (factory = all warehouse holders, car = all custody holders).
// Increase -> the default holder of that kind; decrease -> taken from the
// default holder first, then the others. The legacy row is already set by
// the caller (legacy: false).
function setPooledTotal(companyId, table, productId, newTotal, opts = {}) {
  const custody = table === 'car_inventory';
  const holders = db.prepare(`SELECT h.*, COALESCE(p.qty, 0) qty FROM stock_holders h LEFT JOIN stock_pools p ON p.holder_id = h.id AND p.product_id = ? WHERE h.company_id = ? AND h.kind ${custody ? "<> 'warehouse'" : "= 'warehouse'"} ORDER BY h.id`).all(productId, companyId);
  const def = custody ? carPoolHolder(companyId) : warehouseHolder(companyId, null);
  const total = holders.reduce((s, h) => s + h.qty, 0);
  let delta = Q(newTotal - total);
  if (Math.abs(delta) < EPS) return [];
  const done = [];
  if (delta > 0) {
    const cur = poolRow(companyId, productId, def.id).qty;
    done.push(adjustHolder(companyId, { ...opts, productId, holderId: def.id, newQty: cur + delta }));
    return done;
  }
  const order = [def.id, ...holders.map((h) => h.id).filter((id) => id !== def.id)];
  for (const hid of order) {
    if (delta >= -EPS) break;
    const cur = poolRow(companyId, productId, hid).qty;
    if (cur <= EPS) continue;
    const take = Math.min(cur, -delta);
    done.push(adjustHolder(companyId, { ...opts, productId, holderId: hid, newQty: cur - take }));
    delta = Q(delta + take);
  }
  if (delta < -EPS) fail('insufficient_stock', 'الكمية الجديدة أقل من صفر في مجموع أماكن التخزين', 409);
  return done;
}

// Standard cost change: products on the standard method are revalued at
// the new cost (difference -> purchase price variance, one entry).
function setStandardCost(companyId, productId, stdMinor, actor) {
  const p = productRow(companyId, productId);
  const std = Math.round(Number(stdMinor));
  if (!Number.isSafeInteger(std) || std < 0) fail('invalid_cost', 'التكلفة المعيارية غير صالحة');
  return ledger.transaction(() => {
    const before = stdCost(p.id);
    db.prepare("INSERT INTO product_standard_costs (product_id, company_id, standard_cost_minor) VALUES (?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET standard_cost_minor = excluded.standard_cost_minor, updated_at = datetime('now')").run(p.id, companyId, std);
    const lines = [];
    const moveIds = [];
    if (methodFor(companyId, p.id) === 'standard') {
      for (const pool of db.prepare('SELECT * FROM stock_pools WHERE company_id = ? AND product_id = ? AND ABS(qty) > 1e-9').all(companyId, p.id)) {
        const delta = Math.round(std * pool.qty) - pool.value_minor;
        if (!delta) continue;
        const moveId = insertMove(companyId, { productId: p.id, holderId: pool.holder_id, qty: 0, value: delta, method: 'standard', moveType: 'revaluation', sourceType: 'standard_cost', sourceId: p.id, actor });
        savePool(companyId, p.id, pool.holder_id, pool.qty, pool.value_minor + delta);
        moveIds.push(moveId);
        lines.push({ accountId: holderAccount(companyId, holderById(companyId, pool.holder_id)), amount: delta, memo: p.name }, { accountId: sysAcc(companyId, 'purchase_price_variance'), amount: -delta, memo: 'إعادة تقييم بالتكلفة المعيارية' });
      }
      post(companyId, { description: `تغيير التكلفة المعيارية — ${p.name}`, lines, moveIds }, actor);
      refreshCostPrice(companyId, p.id);
    }
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.standard_cost.set', entityType: 'product', entityId: p.id, before: { standard_cost_minor: before }, after: { standard_cost_minor: std, revalued_moves: moveIds.length } });
    return { product_id: p.id, standard_cost_minor: std, revalued: moveIds.length };
  });
}

// Transfer document between any two holders (posted: Dr to-holder account
// / Cr from-holder account — same account for warehouse -> warehouse).
function transferDoc(companyId, { productId, fromHolderId, toHolderId, qty, date, reference }, actor) {
  const p = productRow(companyId, productId);
  const from = holderById(companyId, fromHolderId);
  const to = holderById(companyId, toHolderId);
  return ledger.transaction(() => {
    const t = moveTransfer(companyId, { productId: p.id, fromHolderId: from.id, toHolderId: to.id, qty: Number(qty), sourceType: 'stock_transfer', date, groupKey: reference || null, actor });
    checkpoint('stock.transfer.after_moves');
    const entry = post(companyId, { date, description: `تحويل مخزون ${p.name}: ${from.name} ← ${to.name}`, lines: [{ accountId: holderAccount(companyId, to), amount: t.value, memo: `إلى ${to.name}` }, { accountId: holderAccount(companyId, from), amount: -t.value, memo: `من ${from.name}` }], moveIds: t.moveIds || [t.outMoveId, t.inMoveId] }, actor);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.transfer', entityType: 'product', entityId: p.id, before: null, after: { from: from.id, to: to.id, qty: Number(qty), value_minor: t.value, journal_entry_id: entry?.id ?? null } });
    return { ...t, journal_entry_id: entry?.id ?? null };
  });
}

// ---------------------------------------------------------------------
// Activation (opening moves) — dry run first
// ---------------------------------------------------------------------

function ledgerBalance(companyId, key, asOf) {
  const acc = ledger.getAccountBySystemKey(companyId, key);
  if (!acc) return 0;
  return db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? ${asOf ? 'AND e.entry_date <= ?' : ''}`)
    .get(...[companyId, acc.id, ...(asOf ? [asOf] : [])]).s;
}

function activationPlan(companyId, { date } = {}) {
  const d = date || today();
  const digits = baseDigits(companyId);
  const problems = [];
  const warnings = [];
  if (isActive(companyId)) problems.push({ code: 'already_active', message: 'دفتر المخزون مفعّل مسبقًا' });
  for (const k of ['inventory', 'inventory_custody', 'opening_balance_equity', 'inventory_adjustments']) {
    if (!ledger.getAccountBySystemKey(companyId, k)) problems.push({ code: 'missing_system_account', message: `الحساب النظامي ${k} غير معرّف — طبّق قالب دليل الحسابات وشغّل الترحيلات` });
  }
  const period = db.prepare('SELECT status FROM fiscal_periods WHERE company_id = ? AND start_date <= ? AND end_date >= ?').get(companyId, d, d);
  if (!period) problems.push({ code: 'no_period', message: 'لا توجد فترة مالية تغطي تاريخ التفعيل' });
  else if (period.status !== 'open') problems.push({ code: 'period_closed', message: 'الفترة المالية لتاريخ التفعيل غير مفتوحة' });
  const rows = [];
  const costIssues = new Map();
  for (const [table, kind] of [['factory_inventory', 'warehouse'], ['car_inventory', 'car_pool']]) {
    for (const r of db.prepare(`SELECT t.*, p.name AS product_name, p.cost_price, s.standard_cost_minor, p.category FROM ${table} t LEFT JOIN products p ON p.id = t.product_id LEFT JOIN product_standard_costs s ON s.product_id = t.product_id WHERE t.company_id = ? ORDER BY t.id`).all(companyId)) {
      if (!r.product_id) {
        if (r.current_quantity) warnings.push({ code: 'no_product', message: `السطر "${r.item_name}" غير مربوط بمادة — لن يدخل دفتر المخزون حتى يُربط` });
        continue;
      }
      if (r.current_quantity < -EPS) problems.push({ code: 'negative_quantity', message: `رصيد سالب للمادة ${r.product_name} (${r.current_quantity}) — صحّحه قبل التفعيل` });
      if (r.current_quantity <= EPS) continue;
      const method = methodFor(companyId, r.product_id);
      const unit = method === 'standard' ? r.standard_cost_minor : r.cost_price != null ? r.cost_price * 10 ** digits : null;
      if (unit == null && method === 'standard') problems.push({ code: 'standard_cost_missing', message: `أدخل التكلفة المعيارية للمادة ${r.product_name}` });
      else if (!(unit > 0)) {
        // Missing or zero cost: listed, and blocks activation until the cost
        // is entered or the zero value is acknowledged with a reason.
        let ci = costIssues.get(r.product_id);
        if (!ci) {
          const ack = db.prepare('SELECT a.reason, a.created_at, a.created_by, u.name AS created_by_name FROM stock_cost_acknowledgements a LEFT JOIN users u ON u.id = a.created_by WHERE a.company_id = ? AND a.product_id = ?').get(companyId, r.product_id);
          ci = { product_id: r.product_id, product_name: r.product_name, method, issue: unit == null ? 'missing' : 'zero', qty: 0, acknowledged: ack ? { ...ack } : null };
          costIssues.set(r.product_id, ci);
        }
        ci.qty = Q(ci.qty + r.current_quantity);
      }
      rows.push({ table, holder_kind: kind, product_id: r.product_id, product_name: r.product_name, qty: Q(r.current_quantity), method, unit_cost_minor: unit ?? 0, value_minor: Math.round((unit ?? 0) * r.current_quantity) });
    }
  }
  const cost_issues = [...costIssues.values()];
  for (const ci of cost_issues) {
    if (ci.acknowledged) warnings.push({ code: 'cost_acknowledged', message: `المادة ${ci.product_name} تُقيَّم بصفر (تأكيد: ${ci.acknowledged.reason})` });
    else problems.push({ code: 'cost_missing', product_id: ci.product_id, message: `المادة ${ci.product_name} لها رصيد ${ci.qty} و${ci.issue === 'missing' ? 'بلا تكلفة' : 'تكلفتها صفر'} — أدخل التكلفة أو أكّد التقييم بصفر مع ذكر السبب` });
  }
  const warehouseValue = rows.filter((r) => r.holder_kind === 'warehouse').reduce((s, r) => s + r.value_minor, 0);
  const custodyValue = rows.filter((r) => r.holder_kind === 'car_pool').reduce((s, r) => s + r.value_minor, 0);
  const ledgerInventory = ledgerBalance(companyId, 'inventory', d);
  const ledgerCustody = ledgerBalance(companyId, 'inventory_custody', d);
  return {
    date: d, ok: problems.length === 0, problems, warnings, rows, cost_issues,
    method_default: setting(companyId, 'inventory_valuation_method', 'average'),
    warehouse_value_minor: warehouseValue, custody_value_minor: custodyValue, valuation_minor: warehouseValue + custodyValue,
    ledger_inventory_minor: ledgerInventory, ledger_custody_minor: ledgerCustody,
    opening_entry: { inventory_minor: warehouseValue - ledgerInventory, custody_minor: custodyValue - ledgerCustody },
    digits, valuation: fromMinor(warehouseValue + custodyValue, digits),
  };
}
const fingerprint = (plan) => crypto.createHash('sha256').update(JSON.stringify([plan.date, plan.rows.map((r) => [r.table, r.product_id, r.qty, r.value_minor]), plan.ledger_inventory_minor, plan.ledger_custody_minor])).digest('hex');

// Acknowledge valuing a product with stock and no / zero cost at zero on
// activation (reason >= 10 characters; audited). Revoked by entering a cost.
function acknowledgeZeroCost(companyId, productId, { reason } = {}, actor) {
  const p = productRow(companyId, productId);
  const r = String(reason || '').trim();
  if (r.length < 10) fail('reason_required', 'اكتب سبب التقييم بصفر (10 أحرف على الأقل)');
  if (isActive(companyId)) fail('already_active', 'دفتر المخزون مفعّل مسبقًا', 409);
  return ledger.transaction(() => {
    const before = db.prepare('SELECT reason FROM stock_cost_acknowledgements WHERE company_id = ? AND product_id = ?').get(companyId, p.id) || null;
    db.prepare("INSERT INTO stock_cost_acknowledgements (company_id, product_id, reason, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(company_id, product_id) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, created_at = datetime('now')").run(companyId, p.id, r, actor?.id ?? null);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.activation.zero_cost_ack', entityType: 'product', entityId: p.id, before: before ? { ...before } : null, after: { reason: r } });
    return { product_id: p.id, reason: r };
  });
}

function activationDryRun(companyId, { date } = {}, actor) {
  const plan = activationPlan(companyId, { date });
  const fp = fingerprint(plan);
  const id = Number(db.prepare("INSERT INTO stock_activation_runs (company_id, kind, fingerprint, plan_json, created_by) VALUES (?, 'dry_run', ?, ?, ?)").run(companyId, fp, JSON.stringify(plan), actor?.id ?? null).lastInsertRowid);
  logAudit({ companyId, actor: actorOf(actor), action: 'stock.activation.dry_run', entityType: 'stock_activation_run', entityId: id, before: null, after: { date: plan.date, rows: plan.rows.length, valuation_minor: plan.valuation_minor, ok: plan.ok } });
  return { dry_run_id: id, fingerprint: fp, ...plan };
}

function activate(companyId, { dryRunId } = {}, actor) {
  return ledger.transaction(() => {
    const dry = db.prepare("SELECT * FROM stock_activation_runs WHERE id = ? AND company_id = ? AND kind = 'dry_run' AND created_at >= datetime('now', '-24 hours')").get(Number(dryRunId) || 0, companyId);
    if (!dry) fail('dry_run_required', 'نفّذ تجربة تفعيل دفتر المخزون وراجعها خلال آخر 24 ساعة أولًا', 409);
    const stored = JSON.parse(dry.plan_json);
    const plan = activationPlan(companyId, { date: stored.date });
    if (!plan.ok) fail(plan.problems[0].code, plan.problems[0].message, 409);
    if (fingerprint(plan) !== dry.fingerprint) fail('plan_changed', 'تغيّرت الكميات أو الأرصدة منذ التجربة — نفّذ تجربة جديدة', 409);
    const moveIds = [];
    for (const r of plan.rows) {
      const h = r.holder_kind === 'warehouse' ? warehouseHolder(companyId, null) : carPoolHolder(companyId);
      const m = moveIn(companyId, { productId: r.product_id, holderId: h.id, qty: r.qty, valueMinor: r.value_minor, moveType: 'opening', sourceType: 'inventory_opening', sourceId: dry.id, date: plan.date, legacy: false, actor });
      moveIds.push(m.moveId);
    }
    checkpoint('stock.activation.after_moves');
    const runId = Number(db.prepare("INSERT INTO stock_activation_runs (company_id, kind, fingerprint, plan_json, dry_run_id, created_by) VALUES (?, 'executed', ?, ?, ?, ?)").run(companyId, dry.fingerprint, JSON.stringify(plan), dry.id, actor?.id ?? null).lastInsertRowid);
    const obe = sysAcc(companyId, 'opening_balance_equity');
    const e = plan.opening_entry;
    const entry = post(companyId, {
      date: plan.date, description: 'الرصيد الافتتاحي للمخزون عند تفعيل دفتر المخزون', sourceType: 'inventory_opening', sourceId: runId,
      lines: [
        { accountId: sysAcc(companyId, 'inventory'), amount: e.inventory_minor, memo: 'مخزون المستودعات' },
        { accountId: sysAcc(companyId, 'inventory_custody'), amount: e.custody_minor, memo: 'بضاعة السيارات' },
        { accountId: obe, amount: -(e.inventory_minor + e.custody_minor), memo: 'رصيد افتتاحي' },
      ],
      moveIds,
    }, actor);
    db.prepare('UPDATE stock_activation_runs SET journal_entry_id = ? WHERE id = ?').run(entry?.id ?? null, runId);
    const company = db.prepare('SELECT modules_json FROM companies WHERE id = ?').get(companyId);
    db.prepare("UPDATE companies SET modules_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ ...JSON.parse(company.modules_json || '{}'), stock_ledger: true }), companyId);
    logAudit({ companyId, actor: actorOf(actor), action: 'stock.activation.execute', entityType: 'stock_activation_run', entityId: runId, before: { stock_ledger: false }, after: { stock_ledger: true, moves: moveIds.length, valuation_minor: plan.valuation_minor, journal_entry_id: entry?.id ?? null } });
    return { run_id: runId, moves: moveIds.length, journal_entry_id: entry?.id ?? null, valuation_minor: plan.valuation_minor };
  });
}

// ---------------------------------------------------------------------
// Valuation, reconciliation
// ---------------------------------------------------------------------

function valuation(companyId, { holderId, productId } = {}) {
  const rows = db.prepare(`SELECT p.product_id, pr.name AS product_name, p.holder_id, h.name AS holder_name, h.kind AS holder_kind, p.qty, p.value_minor
    FROM stock_pools p JOIN stock_holders h ON h.id = p.holder_id JOIN products pr ON pr.id = p.product_id
    WHERE p.company_id = ? ${holderId ? 'AND p.holder_id = ?' : ''} ${productId ? 'AND p.product_id = ?' : ''} AND (ABS(p.qty) > 1e-9 OR p.value_minor <> 0)
    ORDER BY pr.name, h.id`).all(...[companyId, ...(holderId ? [holderId] : []), ...(productId ? [productId] : [])])
    .map((r) => ({ ...r, method: methodFor(companyId, r.product_id), unit_cost_minor: r.qty > EPS ? r.value_minor / r.qty : 0 }));
  const warehouse = rows.filter((r) => r.holder_kind === 'warehouse').reduce((s, r) => s + r.value_minor, 0);
  const custody = rows.filter((r) => r.holder_kind !== 'warehouse').reduce((s, r) => s + r.value_minor, 0);
  return { rows, warehouse_minor: warehouse, custody_minor: custody, total_minor: warehouse + custody, digits: baseDigits(companyId) };
}

function reconcile(companyId, { store = false } = {}) {
  const v = valuation(companyId);
  const ledgerInv = ledgerBalance(companyId, 'inventory');
  const ledgerCus = ledgerBalance(companyId, 'inventory_custody');
  const mismatches = [];
  for (const [table, kindSql] of [['factory_inventory', "= 'warehouse'"], ['car_inventory', "<> 'warehouse'"]]) {
    const rows = db.prepare(`SELECT t.product_id, t.item_name, t.current_quantity legacy, COALESCE((SELECT SUM(p.qty) FROM stock_pools p JOIN stock_holders h ON h.id = p.holder_id WHERE p.product_id = t.product_id AND h.company_id = t.company_id AND h.kind ${kindSql}), 0) moves
      FROM ${table} t WHERE t.company_id = ? AND t.product_id IS NOT NULL`).all(companyId);
    for (const r of rows) if (Math.abs(r.legacy - r.moves) > 1e-6) mismatches.push({ table, ...r });
  }
  const result = {
    as_of: today(), ledger_inventory_minor: ledgerInv, ledger_custody_minor: ledgerCus, ledger_minor: ledgerInv + ledgerCus,
    valuation_warehouse_minor: v.warehouse_minor, valuation_custody_minor: v.custody_minor, valuation_minor: v.total_minor,
    difference_minor: ledgerInv + ledgerCus - v.total_minor, inventory_difference_minor: ledgerInv - v.warehouse_minor, custody_difference_minor: ledgerCus - v.custody_minor,
    qty_mismatches: mismatches,
  };
  result.ok = result.difference_minor === 0 && result.inventory_difference_minor === 0 && mismatches.length === 0;
  if (store) {
    db.prepare('INSERT INTO stock_reconciliation_checks (company_id, as_of, ledger_minor, valuation_minor, difference_minor, qty_mismatches, details_json, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, result.as_of, result.ledger_minor, result.valuation_minor, result.difference_minor, mismatches.length, JSON.stringify(result), result.ok ? 1 : 0);
    if (!result.ok && !require('./notify').hasUnreadNotification(companyId, 'stock_reconciliation_failed', companyId, 'company')) {
      require('./notify').createNotification({
        companyId, type: 'stock_reconciliation_failed',
        message_ar: `مطابقة المخزون: حسابات المخزون ${fromMinor(result.ledger_minor, v.digits)} مقابل التقييم ${fromMinor(result.valuation_minor, v.digits)}${mismatches.length ? ` و${mismatches.length} اختلاف كميات` : ''} — راجع تقرير المطابقة`,
        message_en: 'Stock reconciliation failed — inventory accounts differ from the valuation.',
        link_path: '/stock?tab=reconciliation', entity_type: 'company', entity_id: companyId,
      });
    }
  }
  return result;
}

// Once a day per activated company (called from the 15-minute sweep).
function runDailyReconciliation() {
  const d = today();
  for (const c of db.prepare("SELECT id FROM companies WHERE modules_json LIKE '%\"stock_ledger\":true%'").all()) {
    if (db.prepare('SELECT 1 FROM stock_reconciliation_checks WHERE company_id = ? AND as_of = ?').get(c.id, d)) continue;
    try {
      reconcile(c.id, { store: true });
    } catch (err) {
      console.error('[stock] reconciliation failed for company', c.id, err.message);
    }
  }
}

module.exports = {
  StockError,
  isActive,
  defaultWarehouse,
  warehouseHolder,
  carPoolHolder,
  vehicleHolder,
  repHolder,
  custodyHolderForRep,
  holderById,
  holderAccount,
  isCustody,
  methodFor,
  setMethod,
  setStandardCost,
  transferDoc,
  baseQty,
  poolRow,
  fallbackUnitCost,
  stdCost,
  moveIn,
  moveOut,
  moveTransfer,
  moveOutAuto,
  pickLots,
  isTracked,
  stockSettings,
  setProductSettings,
  getOrCreateLot,
  defaultLot,
  lotBalance,
  checkLot,
  addValue,
  post,
  adjustHolder,
  setPooledTotal,
  activationPlan,
  activationDryRun,
  acknowledgeZeroCost,
  activate,
  valuation,
  reconcile,
  runDailyReconciliation,
  ledgerBalance,
  sysAcc,
  productRow,
};
