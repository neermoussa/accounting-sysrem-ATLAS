// backend/lib/manufacturingOrders.js
//
// Prompt 9 — plans (allergen sequencing, MRP, purchase request), production
// orders (release / FEFO issue / return / output, by-products, wastage,
// rework / QC / close with costing and one entry / reject), lot trace
// through production, reports. Recipes, allergens and cost inputs:
// lib/manufacturing.js. Postings: docs/posting-map.md §13.

const db = require('../db/init');
const ledger = require('./ledger');
const S = require('./stockLedger');
const M = require('./manufacturing');
const { logAudit } = require('./auditLog');
const { checkpoint } = require('./faultInjection');

const { fail, actorOf, today, isValidDate, addDays, Q, Q3, roundHalfUp, EPS, owned, ownedRow, product, issueNumber, requireActive, absorbed, digits } = M._;

// Stock errors raised inside a production step keep their code / status.
function stockSafe(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof S.StockError) fail(err.code, err.message, err.status, { product_id: err.product_id, short: err.short });
    throw err;
  }
}
const holderFor = (companyId, warehouseId) => (warehouseId ? S.warehouseHolder(companyId, owned(companyId, 'warehouse', warehouseId).id) : S.warehouseHolder(companyId, null));

// ---------------------------------------------------------------------
// Allergen sequencing
// ---------------------------------------------------------------------

// Walk the lines in order. Allergens of everything produced since the last
// sanitation step stay on the line; a product that does not itself contain
// one of them would pick up traces -> violation (a sanitation step is
// required between them). Suggested order: fewest allergens first.
function sequenceCheck(companyId, lines) {
  const warnings = [];
  let residue = new Map(); // allergen -> product name that left it
  for (const l of lines) {
    if (l.kind === 'sanitation') {
      residue = new Map();
      continue;
    }
    const a = M.effectiveAllergens(companyId, l.product_id).contains;
    const carried = [...residue.keys()].filter((x) => !a.includes(x));
    if (carried.length) {
      warnings.push({ seq: l.seq, product_id: l.product_id, product_name: l.product_name, carried, after: [...new Set(carried.map((x) => residue.get(x)))], message: `${l.product_name}: يُنتج بعد منتج يحتوي على (${carried.join('، ')}) دون خطوة تعقيم — خطر انتقال مسببات الحساسية` });
    }
    for (const x of a) residue.set(x, l.product_name);
  }
  const productLines = lines.filter((l) => l.kind !== 'sanitation');
  const suggested = [...productLines].sort((x, y) => M.effectiveAllergens(companyId, x.product_id).contains.length - M.effectiveAllergens(companyId, y.product_id).contains.length || x.seq - y.seq).map((l) => l.product_name);
  return { ok: warnings.length === 0, warnings, suggested_order: suggested };
}

// ---------------------------------------------------------------------
// Plans and MRP
// ---------------------------------------------------------------------

function planLines(planId) {
  return db.prepare('SELECT l.*, p.name AS product_name FROM mfg_plan_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.plan_id = ? ORDER BY l.seq').all(planId).map((l) => ({ ...l }));
}
function getPlan(companyId, id) {
  const p = ownedRow(companyId, 'mfg_plans', id, 'invalid_production_plan', 'خطة الإنتاج');
  const lines = planLines(p.id);
  return { ...p, lines, sequence: sequenceCheck(companyId, lines), orders: db.prepare('SELECT id, order_number, product_id, status FROM mfg_orders WHERE plan_id = ? ORDER BY id').all(p.id).map((o) => ({ ...o })) };
}
const listPlans = (companyId) => db.prepare('SELECT p.*, (SELECT COUNT(*) FROM mfg_plan_lines l WHERE l.plan_id = p.id AND l.kind = \'production\') AS line_count FROM mfg_plans p WHERE p.company_id = ? ORDER BY p.id DESC LIMIT 200').all(companyId).map((p) => ({ ...p }));

function savePlan(companyId, id, { planDate, warehouseId, notes, lines } = {}, actor) {
  const existing = id ? ownedRow(companyId, 'mfg_plans', id, 'invalid_production_plan', 'خطة الإنتاج') : null;
  if (existing && existing.status !== 'draft') fail('plan_not_draft', 'لا تُعدّل إلا الخطة المسودة', 409);
  const d = planDate || existing?.plan_date || today();
  if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
  const wh = warehouseId !== undefined ? (warehouseId ? owned(companyId, 'warehouse', warehouseId).id : null) : existing?.warehouse_id ?? null;
  if (!Array.isArray(lines) || !lines.some((l) => (l.kind || 'production') === 'production')) fail('lines_required', 'الخطة تحتاج منتجًا واحدًا على الأقل');
  const parsed = lines.map((l, i) => {
    const kind = l.kind === 'sanitation' ? 'sanitation' : 'production';
    if (kind === 'sanitation') return { seq: i + 1, kind, product_id: null, qty: null, notes: l.notes || 'تعقيم الخط' };
    const p = product(companyId, l.productId);
    if (!M.activeVersion(companyId, p.id)) fail('no_active_recipe', `السطر ${i + 1}: ${p.name} بلا وصفة مفعّلة`);
    const qty = Number(l.qty);
    if (!(qty > 0)) fail('invalid_qty', `السطر ${i + 1}: الكمية غير صالحة`);
    return { seq: i + 1, kind, product_id: p.id, qty, notes: l.notes || null };
  });
  return ledger.transaction(() => {
    let pid = existing?.id;
    if (existing) db.prepare('UPDATE mfg_plans SET plan_date = ?, warehouse_id = ?, notes = ? WHERE id = ?').run(d, wh, notes !== undefined ? notes || null : existing.notes, pid);
    else pid = Number(db.prepare('INSERT INTO mfg_plans (company_id, plan_number, plan_date, warehouse_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, issueNumber(companyId, 'MP', 'MP-'), d, wh, notes || null, actor?.id ?? null).lastInsertRowid);
    db.prepare('DELETE FROM mfg_plan_lines WHERE plan_id = ?').run(pid);
    const ins = db.prepare('INSERT INTO mfg_plan_lines (company_id, plan_id, seq, kind, product_id, qty, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const l of parsed) ins.run(companyId, pid, l.seq, l.kind, l.product_id, l.qty, l.notes);
    const after = getPlan(companyId, pid);
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'mfg.plan.update' : 'mfg.plan.create', entityType: 'mfg_plan', entityId: pid, before: existing ? { ...existing } : null, after: { lines: parsed.length, sequence_ok: after.sequence.ok } });
    return after;
  });
}

// Confirming a plan whose sequence breaks the allergen rule needs a written
// override reason (audited) — otherwise 409 with the warnings.
function confirmPlan(companyId, id, { overrideReason } = {}, actor) {
  const p = getPlan(companyId, id);
  if (p.status !== 'draft') fail('plan_not_draft', 'الخطة ليست مسودة', 409);
  const reason = String(overrideReason || '').trim();
  if (!p.sequence.ok && reason.length < 10) fail('allergen_sequence_violation', 'تسلسل الإنتاج يخالف قواعد مسببات الحساسية — أضف خطوة تعقيم أو أعد الترتيب، أو اكتب سبب التجاوز (10 أحرف على الأقل)', 409, { warnings: p.sequence.warnings, suggested_order: p.sequence.suggested_order });
  return ledger.transaction(() => {
    db.prepare("UPDATE mfg_plans SET status = 'confirmed', confirmed_by = ?, sequence_override_reason = ? WHERE id = ?").run(actor?.id ?? null, p.sequence.ok ? null : reason, p.id);
    logAudit({ companyId, actor: actorOf(actor), action: p.sequence.ok ? 'mfg.plan.confirm' : 'mfg.plan.confirm_override', entityType: 'mfg_plan', entityId: p.id, before: { status: 'draft' }, after: { status: 'confirmed', override_reason: p.sequence.ok ? null : reason, warnings: p.sequence.warnings.length } });
    return getPlan(companyId, p.id);
  });
}

// Reserved by open production orders (required - issued + returned).
function reservedForProduction(companyId, productId, exceptOrderId = 0) {
  return Q(db.prepare(`SELECT COALESCE(SUM(MAX(m.required_qty - m.issued_qty + m.returned_qty, 0)), 0) q FROM mfg_order_materials m JOIN mfg_orders o ON o.id = m.order_id
    WHERE o.company_id = ? AND m.product_id = ? AND o.status IN ('released', 'in_progress') AND o.id <> ?`).get(companyId, productId, exceptOrderId).q);
}
function onHand(companyId, productId, holderId) {
  if (holderId) return Q(S.poolRow(companyId, productId, holderId).qty);
  return Q(db.prepare("SELECT COALESCE(SUM(p.qty), 0) q FROM stock_pools p JOIN stock_holders h ON h.id = p.holder_id WHERE p.company_id = ? AND p.product_id = ? AND h.kind = 'warehouse'").get(companyId, productId).q);
}

// MRP settings (per company): open sales reservations (approved, not yet
// delivered orders) as extra demand — off by default.
function mrpSettings(companyId) {
  const v = db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'mrp_include_sales_reservations'").get(companyId)?.value;
  return { include_sales_reservations: v === '1' };
}
function setMrpSettings(companyId, { includeSalesReservations } = {}, actor) {
  const before = mrpSettings(companyId);
  return ledger.transaction(() => {
    db.prepare("INSERT INTO settings (company_id, key, value) VALUES (?, 'mrp_include_sales_reservations', ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value").run(companyId, includeSalesReservations ? '1' : '0');
    const after = mrpSettings(companyId);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.mrp.settings', entityType: 'company', entityId: companyId, before, after });
    return after;
  });
}
// Open purchase orders (approved / partially received): quantity still to
// arrive, split into due by the plan date (expected date on or before it,
// or none) and later.
function onOrder(companyId, productId, byDate) {
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN o.expected_date IS NULL OR o.expected_date <= ? THEN l.qty - l.received_qty ELSE 0 END), 0) due,
      COALESCE(SUM(CASE WHEN o.expected_date > ? THEN l.qty - l.received_qty ELSE 0 END), 0) late
    FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
    WHERE o.company_id = ? AND l.product_id = ? AND o.status IN ('approved', 'partially_received') AND l.qty > l.received_qty`).get(byDate, byDate, companyId, productId);
  return { due: Q(r.due), late: Q(r.late) };
}
// Open purchase requests (draft / submitted / approved, not yet ordered).
const requestedQty = (companyId, productId) => Q(db.prepare("SELECT COALESCE(SUM(l.qty), 0) q FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id WHERE r.company_id = ? AND l.product_id = ? AND r.status IN ('draft', 'submitted', 'approved')").get(companyId, productId).q);

// Material requirements of a plan: gross requirement per product over all
// levels; available = on hand - reserved by open production orders - (if
// enabled) open sales reservations; open purchase orders due by the plan
// date cover part of the shortfall; a short product with its own active
// recipe is produced (its net shortfall exploded into its components), else
// purchased — minus what open purchase requests already ask for.
function mrp(companyId, planId) {
  requireActive(companyId);
  const plan = getPlan(companyId, planId);
  const holderId = plan.warehouse_id ? S.warehouseHolder(companyId, plan.warehouse_id).id : null;
  const settings = mrpSettings(companyId);
  const salesReserved = (pid) => (settings.include_sales_reservations ? require('./stockOps').reservedQty(companyId, pid) : 0);
  const position = (pid) => {
    const stock = onHand(companyId, pid, holderId);
    const reserved = reservedForProduction(companyId, pid);
    const sales = salesReserved(pid);
    const po = onOrder(companyId, pid, plan.plan_date);
    return { stock, reserved, sales, available: Math.max(0, Q(stock - reserved - sales)), po };
  };
  const req = new Map();
  const produce = new Map();
  const queue = plan.lines.filter((l) => l.kind === 'production').map((l) => ({ productId: l.product_id, qty: l.qty, level: 1 }));
  const explode = (item) => {
    const v = M.activeVersion(companyId, item.productId);
    if (!v) return;
    const batches = item.qty / v.batch_output_qty;
    for (const c of M.components(v.id)) {
      const r = req.get(c.product_id) || { product_id: c.product_id, product_name: c.product_name, kind: c.kind, required: 0, level: item.level, for: new Set() };
      r.required = Q3(r.required + M.grossQty(c, batches));
      r.level = Math.min(r.level, item.level);
      r.for.add(db.prepare('SELECT name FROM products WHERE id = ?').get(item.productId).name);
      req.set(c.product_id, r);
    }
  };
  let guard = 0;
  while (queue.length && guard++ < 200) {
    explode(queue.shift());
    if (!queue.length) {
      for (const r of req.values()) {
        const pos = position(r.product_id);
        const short = Math.max(0, Q3(r.required - pos.available - pos.po.due));
        if (short > EPS && M.activeVersion(companyId, r.product_id)) {
          const planned = produce.get(r.product_id) || 0;
          if (short > planned + EPS) {
            produce.set(r.product_id, short);
            queue.push({ productId: r.product_id, qty: Q3(short - planned), level: r.level + 1 });
          }
        }
      }
    }
  }
  const rows = [...req.values()].map((r) => {
    const pos = position(r.product_id);
    const gross = Math.max(0, Q3(r.required - pos.available));
    const shortfall = Math.max(0, Q3(gross - pos.po.due));
    const source = shortfall > EPS ? (produce.has(r.product_id) ? 'produce' : 'purchase') : null;
    const requested = source === 'purchase' ? requestedQty(companyId, r.product_id) : 0;
    const toRequest = source === 'purchase' ? Math.max(0, Q3(shortfall - requested)) : 0;
    return {
      product_id: r.product_id, product_name: r.product_name, kind: r.kind, level: r.level, for: [...r.for], required: r.required,
      on_hand: pos.stock, reserved: pos.reserved, sales_reserved: pos.sales, available: pos.available,
      on_order_due: pos.po.due, on_order_late: pos.po.late, shortfall, source, requested, to_request: toRequest,
    };
  }).sort((a, b) => a.level - b.level || a.product_name.localeCompare(b.product_name));
  return { plan_id: plan.id, plan_number: plan.plan_number, plan_date: plan.plan_date, settings, rows, shortages: rows.filter((r) => r.shortfall > EPS).length, purchase_lines: rows.filter((r) => r.to_request > EPS) };
}

// Purchase request (Prompt 6) for what is still short after open purchase
// orders and open requests — running it twice never asks twice.
function mrpPurchaseRequest(companyId, planId, actor) {
  const r = mrp(companyId, planId);
  if (!r.purchase_lines.length) fail('no_shortage', 'لا توجد نواقص تحتاج طلب شراء جديدًا (مغطاة بالمخزون أو بأوامر شراء أو طلبات شراء مفتوحة)', 409);
  const plan = ownedRow(companyId, 'mfg_plans', planId, 'invalid_production_plan', 'خطة الإنتاج');
  const pr = require('./purchasing').saveRequest(companyId, null, {
    requestDate: today(), neededBy: plan.plan_date >= today() ? plan.plan_date : undefined, warehouseId: plan.warehouse_id, notes: `احتياجات خطة الإنتاج ${plan.plan_number}`,
    lines: r.purchase_lines.map((l) => ({ productId: l.product_id, qty: Math.ceil(l.to_request * 1000) / 1000, description: l.product_name })),
  }, actor);
  logAudit({ companyId, actor: actorOf(actor), action: 'mfg.plan.purchase_request', entityType: 'mfg_plan', entityId: plan.id, before: null, after: { purchase_request_id: pr.id, lines: pr.lines.length } });
  return pr;
}

// ---------------------------------------------------------------------
// Production orders
// ---------------------------------------------------------------------

function getOrder(companyId, id) {
  const o = ownedRow(companyId, 'mfg_orders', id, 'invalid_production_order', 'أمر الإنتاج');
  const v = db.prepare('SELECT * FROM mfg_recipe_versions WHERE id = ?').get(o.version_id);
  const events = db.prepare('SELECT e.*, p.name AS product_name, l.lot_code FROM mfg_order_events e LEFT JOIN products p ON p.id = e.product_id LEFT JOIN stock_lots l ON l.id = e.lot_id WHERE e.order_id = ? ORDER BY e.id').all(o.id).map((e) => ({ ...e }));
  const sum = (kind) => Q(events.filter((e) => e.kind === kind).reduce((s, e) => s + e.qty, 0));
  return {
    ...o,
    product_name: db.prepare('SELECT name FROM products WHERE id = ?').get(o.product_id).name,
    version_no: v.version_no, batch_output_qty: v.batch_output_qty, output_kg_per_unit: v.output_kg_per_unit,
    holder_name: S.holderById(companyId, o.holder_id).name,
    materials: db.prepare('SELECT m.*, p.name AS product_name FROM mfg_order_materials m JOIN products p ON p.id = m.product_id WHERE m.order_id = ? ORDER BY m.id').all(o.id).map((m) => ({ ...m, open_qty: Math.max(0, Q(m.required_qty - m.issued_qty + m.returned_qty)) })),
    events,
    output_qty: sum('output'), wastage_qty: sum('wastage'), rework_qty: sum('rework'),
    qc_checks: db.prepare('SELECT c.*, r.value_num, r.passed, r.notes AS result_notes FROM mfg_qc_checks c LEFT JOIN mfg_qc_results r ON r.check_id = c.id AND r.order_id = ? WHERE c.company_id = ? AND c.product_id = ? AND c.active = 1 ORDER BY c.id').all(o.id, companyId, o.product_id).map((c) => ({ ...c })),
    // Checks defined after release still apply: QC is pending until recorded.
    qc_status: o.qc_status === 'not_required' && ['released', 'in_progress'].includes(o.status) && db.prepare('SELECT 1 FROM mfg_qc_checks WHERE company_id = ? AND product_id = ? AND active = 1').get(companyId, o.product_id) ? 'pending' : o.qc_status,
    output_lot: o.output_lot_id ? { ...db.prepare('SELECT * FROM stock_lots WHERE id = ?').get(o.output_lot_id) } : null,
    costs: db.prepare('SELECT * FROM mfg_order_costs WHERE order_id = ? ORDER BY id').all(o.id).map((c) => ({ ...c })),
    production_request_id: db.prepare('SELECT production_request_id r FROM mfg_order_requests WHERE order_id = ?').get(o.id)?.r ?? null,
    cost: o.cost_json ? JSON.parse(o.cost_json) : null,
  };
}
function listOrders(companyId, { status } = {}) {
  return db.prepare(`SELECT o.*, p.name AS product_name FROM mfg_orders o JOIN products p ON p.id = o.product_id WHERE o.company_id = ? ${status ? 'AND o.status = ?' : ''} ORDER BY o.id DESC LIMIT 300`).all(...[companyId, ...(status ? [status] : [])]).map((o) => ({ ...o }));
}

// Draft order for a product (its active version, or a given version) — the
// version is locked from now on. Output products are lot-tracked.
function createOrder(companyId, { productId, versionId, batches, warehouseId, plannedDate, planId, planLineId, notes } = {}, actor) {
  requireActive(companyId);
  const p = product(companyId, productId);
  const v = versionId ? ownedRow(companyId, 'mfg_recipe_versions', versionId, 'invalid_recipe_version', 'إصدار الوصفة') : M.activeVersion(companyId, p.id);
  if (!v) fail('no_active_recipe', `${p.name} بلا وصفة مفعّلة`, 409);
  const recipe = db.prepare('SELECT product_id FROM mfg_recipes WHERE id = ?').get(v.recipe_id);
  if (recipe.product_id !== p.id) fail('invalid_recipe_version', 'الإصدار لا يخص هذه المادة');
  if (v.status === 'archived') fail('version_archived', 'الإصدار مؤرشف', 409);
  const b = Number(batches);
  if (!(b > 0)) fail('invalid_batches', 'عدد الدفعات غير صالح');
  if (plannedDate && !isValidDate(plannedDate)) fail('invalid_date', 'التاريخ غير صالح');
  const plan = planId ? ownedRow(companyId, 'mfg_plans', planId, 'invalid_production_plan', 'خطة الإنتاج') : null;
  if (plan && plan.status !== 'confirmed') fail('plan_not_confirmed', 'الخطة غير معتمدة', 409);
  const line = planLineId ? db.prepare('SELECT * FROM mfg_plan_lines WHERE id = ? AND plan_id = ?').get(Number(planLineId), plan?.id ?? 0) : null;
  if (planLineId && !line) fail('invalid_plan_line', 'سطر الخطة غير موجود', 400);
  const h = holderFor(companyId, warehouseId || plan?.warehouse_id);
  return ledger.transaction(() => {
    if (!S.isTracked(companyId, p.id)) S.setProductSettings(companyId, p.id, { trackLots: true }, actor);
    const id = Number(db.prepare(`INSERT INTO mfg_orders (company_id, order_number, plan_id, plan_line_id, product_id, version_id, batches, planned_qty, holder_id, planned_date, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, issueNumber(companyId, 'MO', 'MO-'), plan?.id ?? null, line?.id ?? null, p.id, v.id, b, Q(v.batch_output_qty * b), h.id, plannedDate || null, notes || null, actor?.id ?? null).lastInsertRowid);
    if (!v.locked_at) db.prepare("UPDATE mfg_recipe_versions SET locked_at = datetime('now') WHERE id = ?").run(v.id);
    for (const c of M.components(v.id)) {
      db.prepare('INSERT INTO mfg_order_materials (company_id, order_id, component_id, product_id, kind, required_qty) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, id, c.id, c.product_id, c.kind, M.grossQty(c, b));
    }
    const after = getOrder(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.create', entityType: 'mfg_order', entityId: id, before: null, after: { product_id: p.id, version_id: v.id, batches: b, planned_qty: after.planned_qty } });
    return after;
  });
}

// Production order from a production request (raised by an order shortage):
// product and quantity from the request (batches = shortage / batch output,
// unless given), linked one-to-one; the request moves to 'in_production'
// and to 'ready' when the order closes.
function createFromRequest(companyId, requestId, { batches, warehouseId, plannedDate } = {}, actor) {
  const r = ownedRow(companyId, 'production_requests', requestId, 'invalid_production_request', 'طلب الإنتاج');
  if (!r.product_id) fail('request_without_product', 'طلب الإنتاج غير مربوط بمادة', 409);
  if (['fulfilled', 'cancelled'].includes(r.status)) fail('request_closed', 'طلب الإنتاج منتهٍ أو ملغى', 409);
  const linked = db.prepare('SELECT order_id FROM mfg_order_requests WHERE production_request_id = ?').get(r.id);
  if (linked) fail('request_already_ordered', `طلب الإنتاج مرتبط بأمر إنتاج قائم (${db.prepare('SELECT order_number FROM mfg_orders WHERE id = ?').get(linked.order_id).order_number})`, 409, { order_id: linked.order_id });
  const v = M.activeVersion(companyId, r.product_id);
  if (!v) fail('no_active_recipe', `${r.product_name} بلا وصفة مفعّلة`, 409);
  const b = batches !== undefined && batches !== null && batches !== '' ? Number(batches) : Math.ceil((r.shortage_qty / v.batch_output_qty) * 1000) / 1000;
  return ledger.transaction(() => {
    const o = createOrder(companyId, { productId: r.product_id, batches: b, warehouseId, plannedDate: plannedDate || r.expected_delivery_date || undefined, notes: `من طلب الإنتاج #${r.id} (طلب المبيعات #${r.order_id})` }, actor);
    try {
      db.prepare('INSERT INTO mfg_order_requests (company_id, production_request_id, order_id, created_by) VALUES (?, ?, ?, ?)').run(companyId, r.id, o.id, actor?.id ?? null);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) fail('request_already_ordered', 'طلب الإنتاج مرتبط بأمر إنتاج قائم', 409);
      throw err;
    }
    db.prepare("UPDATE production_requests SET status = 'in_production', updated_by_id = ?, updated_by_name = ?, updated_at = datetime('now') WHERE id = ?").run(actor?.id ?? null, actor?.name ?? null, r.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.from_request', entityType: 'mfg_order', entityId: o.id, before: { production_request_status: r.status }, after: { production_request_id: r.id, batches: b } });
    return getOrder(companyId, o.id);
  });
}

// Release: materials reserved (they count against MRP availability);
// refused when the warehouse cannot cover them. QC pending if the product
// has active checks.
function releaseOrder(companyId, id, actor) {
  const o = getOrder(companyId, id);
  if (o.status !== 'draft') fail('order_not_draft', 'أمر الإنتاج ليس مسودة', 409);
  const short = o.materials.map((m) => ({ ...m, available: Math.max(0, Q(onHand(companyId, m.product_id, o.holder_id) - reservedForProduction(companyId, m.product_id, o.id))) })).filter((m) => m.available + EPS < m.required_qty);
  if (short.length) fail('materials_short', `المواد غير كافية: ${short.map((m) => `${m.product_name} (المتاح ${m.available} من ${m.required_qty})`).join('، ')}`, 409, { shortages: short.map((m) => ({ product_id: m.product_id, required: m.required_qty, available: m.available })) });
  return ledger.transaction(() => {
    const qc = o.qc_checks.length ? 'pending' : 'not_required';
    db.prepare("UPDATE mfg_orders SET status = 'released', qc_status = ?, updated_at = datetime('now') WHERE id = ?").run(qc, o.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.release', entityType: 'mfg_order', entityId: o.id, before: { status: 'draft' }, after: { status: 'released', qc_status: qc } });
    return getOrder(companyId, o.id);
  });
}
function cancelOrder(companyId, id, { reason } = {}, actor) {
  const o = getOrder(companyId, id);
  if (!['draft', 'released'].includes(o.status)) fail('order_not_cancellable', 'لا يُلغى إلا أمر لم تُصرف له مواد — بعد الصرف: أعد المواد أو ارفض الدفعة', 409);
  if (!String(reason || '').trim()) fail('reason_required', 'سبب الإلغاء مطلوب');
  return ledger.transaction(() => {
    db.prepare("UPDATE mfg_orders SET status = 'cancelled', reject_reason = ?, updated_at = datetime('now') WHERE id = ?").run(String(reason).trim(), o.id);
    const link = db.prepare('SELECT production_request_id r FROM mfg_order_requests WHERE order_id = ?').get(o.id);
    if (link) {
      db.prepare('DELETE FROM mfg_order_requests WHERE order_id = ?').run(o.id);
      db.prepare("UPDATE production_requests SET status = 'pending_processing', updated_at = datetime('now') WHERE id = ? AND status = 'in_production'").run(link.r);
    }
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.cancel', entityType: 'mfg_order', entityId: o.id, before: { status: o.status }, after: { status: 'cancelled', reason } });
    return getOrder(companyId, o.id);
  });
}

const openForWork = (o) => {
  if (!['released', 'in_progress'].includes(o.status)) fail('order_not_open', 'أمر الإنتاج غير مفتوح للعمل (يجب إطلاقه أولًا)', 409);
};
function clientKeyDone(companyId, clientKey) {
  return clientKey ? db.prepare('SELECT * FROM mfg_order_events WHERE company_id = ? AND client_key = ?').get(companyId, String(clientKey)) : null;
}

// Issue materials (lot-picked, FEFO unless a lot is named) from the
// order's warehouse into WIP: one entry Dr WIP / Cr inventory.
// lines: [{ productId, qty?, lotId? }] — no lines = everything still open.
function issueMaterials(companyId, id, { lines, date, clientKey } = {}, actor) {
  requireActive(companyId);
  const o = getOrder(companyId, id);
  openForWork(o);
  if (clientKeyDone(companyId, clientKey)) return getOrder(companyId, o.id);
  const d = date || today();
  if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
  const req = (Array.isArray(lines) && lines.length ? lines : o.materials.filter((m) => m.open_qty > EPS).map((m) => ({ productId: m.product_id, qty: m.open_qty })));
  if (!req.length) fail('nothing_to_issue', 'لا توجد مواد متبقية للصرف', 409);
  const h = S.holderById(companyId, o.holder_id);
  return ledger.transaction(() => stockSafe(() => {
    const moveIds = [];
    let total = 0;
    req.forEach((l, i) => {
      const p = product(companyId, l.productId);
      const m = o.materials.find((x) => x.product_id === p.id);
      if (!m) fail('not_in_recipe', `السطر ${i + 1}: ${p.name} ليس من مكونات هذا الأمر`);
      const qty = Q3(l.qty ?? m.open_qty);
      if (!(qty > 0)) fail('invalid_qty', `السطر ${i + 1}: الكمية غير صالحة`);
      const lotId = l.lotId ? S.checkLot(companyId, p.id, Number(l.lotId)).id : null;
      const r = S.moveOutAuto(companyId, { productId: p.id, holderId: h.id, qty, lotId, moveType: 'production_issue', sourceType: 'mfg_order', sourceId: o.id, date: d, actor });
      for (const pc of r.pieces) db.prepare("INSERT INTO mfg_order_events (company_id, order_id, kind, product_id, qty, lot_id, value_minor, client_key, created_by) VALUES (?, ?, 'issue', ?, ?, ?, ?, ?, ?)").run(companyId, o.id, p.id, pc.qty, pc.lotId, pc.value, clientKey && i === 0 && pc === r.pieces[0] ? String(clientKey) : null, actor?.id ?? null);
      db.prepare('UPDATE mfg_order_materials SET issued_qty = ROUND(issued_qty + ?, 6), issued_value_minor = issued_value_minor + ? WHERE id = ?').run(qty, r.value, m.id);
      moveIds.push(...r.moveIds);
      total += r.value;
    });
    checkpoint('mfg.issue.after_moves');
    S.post(companyId, { date: d, description: `صرف مواد لأمر الإنتاج ${o.order_number}`, lines: [{ accountId: S.sysAcc(companyId, 'wip'), amount: total, memo: o.order_number }, { accountId: S.holderAccount(companyId, h), amount: -total, memo: 'صرف للإنتاج' }], moveIds }, actor);
    db.prepare("UPDATE mfg_orders SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(o.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.issue', entityType: 'mfg_order', entityId: o.id, before: null, after: { lines: req.length, value_minor: total } });
    return getOrder(companyId, o.id);
  }));
}

// Unused material back to stock at its issued cost (into the lot it came
// from): Dr inventory / Cr WIP.
function returnMaterials(companyId, id, { lines, date } = {}, actor) {
  requireActive(companyId);
  const o = getOrder(companyId, id);
  openForWork(o);
  if (!Array.isArray(lines) || !lines.length) fail('lines_required', 'حدد المواد المعادة');
  const d = date || today();
  const h = S.holderById(companyId, o.holder_id);
  return ledger.transaction(() => stockSafe(() => {
    const moveIds = [];
    let total = 0;
    lines.forEach((l, i) => {
      const p = product(companyId, l.productId);
      const m = o.materials.find((x) => x.product_id === p.id);
      const net = m ? Q(m.issued_qty - m.returned_qty) : 0;
      const qty = Q3(l.qty);
      if (!(qty > 0) || qty > net + EPS) fail('invalid_qty', `السطر ${i + 1}: الكمية المعادة أكبر من المصروفة (${net})`);
      const value = roundHalfUp(((m.issued_value_minor - m.returned_value_minor) * qty) / net);
      const lot = db.prepare("SELECT lot_id FROM mfg_order_events WHERE order_id = ? AND kind = 'issue' AND product_id = ? AND lot_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(o.id, p.id);
      const r = S.moveIn(companyId, { productId: p.id, holderId: h.id, qty, valueMinor: value, moveType: 'production_return', sourceType: 'mfg_order', sourceId: o.id, date: d, lotId: lot?.lot_id ?? null, actor });
      db.prepare("INSERT INTO mfg_order_events (company_id, order_id, kind, product_id, qty, lot_id, value_minor, created_by) VALUES (?, ?, 'return', ?, ?, ?, ?, ?)").run(companyId, o.id, p.id, qty, lot?.lot_id ?? null, r.value, actor?.id ?? null);
      db.prepare('UPDATE mfg_order_materials SET returned_qty = ROUND(returned_qty + ?, 6), returned_value_minor = returned_value_minor + ? WHERE id = ?').run(qty, r.value, m.id);
      moveIds.push(r.moveId);
      total += r.value;
    });
    checkpoint('mfg.return.after_moves');
    S.post(companyId, { date: d, description: `إعادة مواد من أمر الإنتاج ${o.order_number}`, lines: [{ accountId: S.holderAccount(companyId, h), amount: total, memo: 'مواد معادة' }, { accountId: S.sysAcc(companyId, 'wip'), amount: -total, memo: o.order_number }], moveIds }, actor);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.return', entityType: 'mfg_order', entityId: o.id, before: null, after: { value_minor: total } });
    return getOrder(companyId, o.id);
  }));
}

// Output / by-product / wastage / rework records (quantities only; stock
// and money move at close). Also the offline workshop path (clientKey).
function recordEvent(companyId, id, { kind, qty, productId, stage, notes, clientKey, labourHours } = {}, actor) {
  const o = getOrder(companyId, id);
  openForWork(o);
  if (clientKeyDone(companyId, clientKey)) return getOrder(companyId, o.id);
  if (!['output', 'byproduct', 'wastage', 'rework'].includes(kind)) fail('invalid_kind', 'نوع التسجيل غير صالح');
  const q = Q3(qty);
  if (!(q > 0)) fail('invalid_qty', 'الكمية غير صالحة');
  let pid = o.product_id;
  if (kind === 'byproduct') {
    pid = product(companyId, productId).id;
    if (!db.prepare('SELECT 1 FROM mfg_recipe_outputs WHERE version_id = ? AND product_id = ?').get(o.version_id, pid)) fail('not_a_byproduct', 'المادة ليست منتجًا ثانويًا في هذه الوصفة');
  } else if (kind === 'wastage' && productId) {
    pid = product(companyId, productId).id;
  }
  if (kind === 'wastage' && !String(stage || '').trim()) fail('stage_required', 'مرحلة الهدر مطلوبة (فرز، تحميص، خلط، تعبئة...)');
  return ledger.transaction(() => {
    db.prepare('INSERT INTO mfg_order_events (company_id, order_id, kind, product_id, qty, stage, notes, client_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, o.id, kind, pid, q, stage ? String(stage).trim() : null, notes || null, clientKey ? String(clientKey) : null, actor?.id ?? null);
    if (labourHours !== undefined && labourHours !== null && labourHours !== '') {
      const hrs = Number(labourHours);
      if (!(hrs >= 0)) fail('invalid_hours', 'ساعات العمل غير صالحة');
      db.prepare("UPDATE mfg_orders SET labour_hours = ROUND(COALESCE(labour_hours, 0) + ?, 6), updated_at = datetime('now') WHERE id = ?").run(hrs, o.id);
    }
    logAudit({ companyId, actor: actorOf(actor), action: `mfg.order.${kind}`, entityType: 'mfg_order', entityId: o.id, before: null, after: { product_id: pid, qty: q, stage: stage || null } });
    return getOrder(companyId, o.id);
  });
}
function setHours(companyId, id, { labourHours, machineHours } = {}, actor) {
  const o = getOrder(companyId, id);
  openForWork(o);
  const lh = Number(labourHours);
  const mh = machineHours === undefined || machineHours === null || machineHours === '' ? o.machine_hours : Number(machineHours);
  if (!(lh >= 0) || (mh != null && !(mh >= 0))) fail('invalid_hours', 'الساعات غير صالحة');
  return ledger.transaction(() => {
    db.prepare("UPDATE mfg_orders SET labour_hours = ?, machine_hours = ?, updated_at = datetime('now') WHERE id = ?").run(lh, mh ?? null, o.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.hours', entityType: 'mfg_order', entityId: o.id, before: { labour_hours: o.labour_hours, machine_hours: o.machine_hours }, after: { labour_hours: lh, machine_hours: mh ?? null } });
    return getOrder(companyId, o.id);
  });
}

// ---------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------

function saveQcCheck(companyId, id, { productId, name, kind = 'pass_fail', minValue, maxValue, unit, active = true } = {}, actor) {
  const existing = id ? ownedRow(companyId, 'mfg_qc_checks', id, 'invalid_qc_check', 'فحص الجودة') : null;
  const p = product(companyId, productId ?? existing?.product_id);
  if (!String(name || existing?.name || '').trim()) fail('name_required', 'اسم الفحص مطلوب');
  if (!['range', 'pass_fail'].includes(kind)) fail('invalid_kind', 'نوع الفحص غير صالح');
  const min = minValue === undefined || minValue === null || minValue === '' ? null : Number(minValue);
  const max = maxValue === undefined || maxValue === null || maxValue === '' ? null : Number(maxValue);
  if (kind === 'range' && min === null && max === null) fail('range_required', 'فحص المدى يحتاج حدًا أدنى أو أعلى');
  return ledger.transaction(() => {
    let cid = existing?.id;
    if (existing) db.prepare('UPDATE mfg_qc_checks SET product_id = ?, name = ?, kind = ?, min_value = ?, max_value = ?, unit = ?, active = ? WHERE id = ?').run(p.id, String(name || existing.name).trim(), kind, min, max, unit || null, active ? 1 : 0, cid);
    else cid = Number(db.prepare('INSERT INTO mfg_qc_checks (company_id, product_id, name, kind, min_value, max_value, unit, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, p.id, String(name).trim(), kind, min, max, unit || null, active ? 1 : 0).lastInsertRowid);
    const row = { ...db.prepare('SELECT * FROM mfg_qc_checks WHERE id = ?').get(cid) };
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'mfg.qc_check.update' : 'mfg.qc_check.create', entityType: 'mfg_qc_check', entityId: cid, before: existing ? { ...existing } : null, after: row });
    return row;
  });
}
const listQcChecks = (companyId, { productId } = {}) => db.prepare(`SELECT c.*, p.name AS product_name FROM mfg_qc_checks c JOIN products p ON p.id = c.product_id WHERE c.company_id = ? ${productId ? 'AND c.product_id = ?' : ''} ORDER BY p.name, c.id`).all(...[companyId, ...(productId ? [Number(productId)] : [])]).map((c) => ({ ...c }));

// Results of the batch's checks: all active checks must be recorded; the
// batch passes when every one is within spec.
function recordQc(companyId, id, { results } = {}, actor) {
  const o = getOrder(companyId, id);
  openForWork(o);
  if (!o.qc_checks.length) fail('no_qc_checks', 'لا توجد فحوص جودة معرّفة لهذه المادة', 409);
  if (!Array.isArray(results)) fail('results_required', 'أدخل نتائج الفحوص');
  return ledger.transaction(() => {
    for (const r of results) {
      const c = o.qc_checks.find((x) => x.id === Number(r.checkId));
      if (!c) fail('invalid_qc_check', 'الفحص لا يخص هذه المادة', 400);
      let passed;
      let value = null;
      if (c.kind === 'range') {
        value = Number(r.value);
        if (!Number.isFinite(value)) fail('invalid_value', `${c.name}: القيمة مطلوبة`);
        passed = (c.min_value == null || value >= c.min_value) && (c.max_value == null || value <= c.max_value);
      } else passed = Boolean(r.passed);
      db.prepare('INSERT INTO mfg_qc_results (company_id, order_id, check_id, value_num, passed, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_id, check_id) DO UPDATE SET value_num = excluded.value_num, passed = excluded.passed, notes = excluded.notes, created_by = excluded.created_by').run(companyId, o.id, c.id, value, passed ? 1 : 0, r.notes || null, actor?.id ?? null);
    }
    const res = db.prepare('SELECT c.id, r.passed FROM mfg_qc_checks c LEFT JOIN mfg_qc_results r ON r.check_id = c.id AND r.order_id = ? WHERE c.company_id = ? AND c.product_id = ? AND c.active = 1').all(o.id, companyId, o.product_id);
    const status = res.some((r) => r.passed === 0) ? 'failed' : res.every((r) => r.passed === 1) ? 'passed' : 'pending';
    db.prepare("UPDATE mfg_orders SET qc_status = ?, updated_at = datetime('now') WHERE id = ?").run(status, o.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.qc', entityType: 'mfg_order', entityId: o.id, before: { qc_status: o.qc_status }, after: { qc_status: status, results: results.length } });
    return getOrder(companyId, o.id);
  });
}

// ---------------------------------------------------------------------
// Costing, close, reject
// ---------------------------------------------------------------------

// Actual cost of an order on its production date (see the header of
// lib/manufacturing.js for the rule).
function actualCost(companyId, o, date) {
  const materials = o.materials.reduce((s, m) => s + m.issued_value_minor - m.returned_value_minor, 0);
  const units = o.output_qty;
  const kg = Q(units * o.output_kg_per_unit);
  const hours = o.labour_hours != null ? o.labour_hours : Q(db.prepare('SELECT labour_hours_per_batch h FROM mfg_recipe_versions WHERE id = ?').get(o.version_id).h * o.batches);
  const q = { kg, hours, batches: o.batches };
  const labour = absorbed(companyId, 'labour', date, q);
  const energy = absorbed(companyId, 'energy', date, q);
  const overhead = absorbed(companyId, 'overhead', date, q);
  const byMap = new Map();
  for (const e of o.events.filter((x) => x.kind === 'byproduct')) byMap.set(e.product_id, Q((byMap.get(e.product_id) || 0) + e.qty));
  const byproducts = [...byMap.entries()].map(([pid, qty]) => {
    const r = M.rateAt(companyId, 'byproduct', date, pid);
    if (!r) fail('byproduct_value_missing', `أدخل قيمة المنتج الثانوي ${db.prepare('SELECT name FROM products WHERE id = ?').get(pid).name} (تكاليف الإنتاج)`, 409);
    return { product_id: pid, qty, rate_id: r.id, rate_minor: r.rate_minor, amount_minor: roundHalfUp(qty * r.rate_minor) };
  });
  const credit = byproducts.reduce((s, b) => s + b.amount_minor, 0);
  const total = materials + labour.amount_minor + energy.amount_minor + overhead.amount_minor;
  const net = total - credit;
  const expected = o.planned_qty;
  const abnormalQty = Math.max(0, Q(expected - units));
  const abnormal = abnormalQty > EPS && expected > EPS ? roundHalfUp((net * abnormalQty) / expected) : 0;
  const fg = net - abnormal;
  return {
    date, materials_minor: materials, labour, energy, overhead, byproducts, byproduct_credit_minor: credit,
    total_minor: total, net_minor: net, expected_units: expected, actual_units: units, actual_kg: kg, abnormal_loss_qty: abnormalQty, abnormal_loss_minor: abnormal,
    fg_value_minor: fg, cost_per_unit_minor: units > EPS ? roundHalfUp(fg / units) : null, cost_per_kg_minor: kg > EPS ? roundHalfUp(fg / kg) : null,
    yield_pct: expected > EPS ? Math.round((units / expected) * 10000) / 100 : null,
    wastage_qty: o.wastage_qty, rework_qty: o.rework_qty,
  };
}

// Close: receive the output into a new lot (code: given or the order
// number; expiry: production date + shelf life, else the earliest
// component lot expiry), by-products into stock at their value, abnormal
// loss to inventory_wastage; one entry clears WIP and the absorbed costs.
function closeOrder(companyId, id, { date, lotCode, expiryDate, quarantine = false } = {}, actor) {
  requireActive(companyId);
  const o = getOrder(companyId, id);
  if (o.status !== 'in_progress') fail('order_not_in_progress', 'أمر الإنتاج لم تُصرف له مواد بعد', 409);
  if (!(o.output_qty > EPS)) fail('no_output', 'سجّل كمية الإنتاج الفعلي قبل الإغلاق', 409);
  if (o.qc_status === 'pending') fail('qc_pending', 'سجّل نتائج فحص الجودة قبل استلام الدفعة', 409);
  if (o.qc_status === 'failed' && !quarantine) fail('qc_failed', 'الدفعة لم تجتز فحص الجودة — ارفضها، أو استلمها في الحجر (quarantine)', 409);
  const d = date || today();
  if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
  if (expiryDate && !isValidDate(expiryDate)) fail('invalid_date', 'تاريخ الصلاحية غير صالح');
  const cost = actualCost(companyId, o, d);
  if (cost.fg_value_minor < 0) fail('negative_cost', 'قيمة المنتجات الثانوية تتجاوز تكلفة الدفعة — راجع أسعارها', 409);
  // Theoretical cost on the production date, fixed now for every basis
  // (the variance report reads it; later purchases must not move it).
  const theoretical = THEORETICAL_BASES.map((basis) => [basis, M.versionCost(companyId, o.version_id, { date: d, basis, batches: o.batches })]);
  const v = db.prepare('SELECT shelf_life_days FROM mfg_recipe_versions WHERE id = ?').get(o.version_id);
  const minComponentExpiry = db.prepare("SELECT MIN(l.expiry_date) e FROM mfg_order_events e JOIN stock_lots l ON l.id = e.lot_id WHERE e.order_id = ? AND e.kind = 'issue' AND l.expiry_date IS NOT NULL").get(o.id).e;
  const expiry = expiryDate || (v.shelf_life_days ? addDays(d, v.shelf_life_days) : minComponentExpiry || null);
  const h = S.holderById(companyId, o.holder_id);
  return ledger.transaction(() => stockSafe(() => {
    const lot = S.getOrCreateLot(companyId, o.product_id, { lotCode: String(lotCode || o.order_number), productionDate: d, expiryDate: expiry });
    if (db.prepare('SELECT 1 FROM stock_lot_balances WHERE lot_id = ? AND ABS(qty) > 1e-9').get(lot.id)) fail('lot_exists', `الدفعة ${lot.lot_code} مستخدمة — اختر رقم دفعة جديدًا`, 409);
    const fg = S.moveIn(companyId, { productId: o.product_id, holderId: h.id, qty: cost.actual_units, valueMinor: cost.fg_value_minor, moveType: 'production_output', sourceType: 'mfg_order', sourceId: o.id, date: d, lotId: lot.id, actor });
    db.prepare("INSERT INTO mfg_order_events (company_id, order_id, kind, product_id, qty, lot_id, value_minor, notes, created_by) VALUES (?, ?, 'output', ?, 0, ?, ?, 'استلام الدفعة', ?)").run(companyId, o.id, o.product_id, lot.id, fg.value, actor?.id ?? null);
    const moveIds = [fg.moveId];
    const acc = S.holderAccount(companyId, h);
    const lines = [{ accountId: acc, amount: fg.value, memo: `إنتاج تام ${lot.lot_code}` }];
    // Standard cost on the output: the difference to the absorbed cost -> PPV.
    if (fg.value !== cost.fg_value_minor) lines.push({ accountId: S.sysAcc(companyId, 'purchase_price_variance'), amount: cost.fg_value_minor - fg.value, memo: 'فرق التكلفة المعيارية للإنتاج' });
    for (const b of cost.byproducts) {
      if (!b.amount_minor && !b.qty) continue;
      const bl = S.isTracked(companyId, b.product_id) ? S.getOrCreateLot(companyId, b.product_id, { lotCode: `${lot.lot_code}-BP`, productionDate: d }).id : null;
      const r = S.moveIn(companyId, { productId: b.product_id, holderId: h.id, qty: b.qty, valueMinor: b.amount_minor, moveType: 'production_byproduct', sourceType: 'mfg_order', sourceId: o.id, date: d, lotId: bl, actor });
      moveIds.push(r.moveId);
      lines.push({ accountId: acc, amount: r.value, memo: 'منتج ثانوي' });
      if (r.value !== b.amount_minor) lines.push({ accountId: S.sysAcc(companyId, 'purchase_price_variance'), amount: b.amount_minor - r.value, memo: 'فرق التكلفة المعيارية للمنتج الثانوي' });
    }
    if (cost.abnormal_loss_minor) lines.push({ accountId: S.sysAcc(companyId, 'inventory_wastage'), amount: cost.abnormal_loss_minor, memo: `فاقد غير طبيعي ${cost.abnormal_loss_qty}` });
    lines.push({ accountId: S.sysAcc(companyId, 'wip'), amount: -cost.materials_minor, memo: o.order_number });
    lines.push({ accountId: S.sysAcc(companyId, 'production_labour'), amount: -cost.labour.amount_minor, memo: 'أجور محمّلة' });
    lines.push({ accountId: S.sysAcc(companyId, 'production_energy'), amount: -cost.energy.amount_minor, memo: 'طاقة محمّلة' });
    lines.push({ accountId: S.sysAcc(companyId, 'production_overhead'), amount: -cost.overhead.amount_minor, memo: 'مصاريف غير مباشرة محمّلة' });
    checkpoint('mfg.close.after_moves');
    const entry = S.post(companyId, { date: d, description: `إغلاق أمر الإنتاج ${o.order_number} — ${o.product_name}`, sourceType: 'mfg_order', sourceId: o.id, lines, moveIds }, actor);
    const costRow = db.prepare('INSERT INTO mfg_order_costs (company_id, order_id, kind, basis, basis_qty, rate_id, rate_minor, amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    costRow.run(companyId, o.id, 'materials', null, null, null, null, cost.materials_minor);
    for (const k of ['labour', 'energy', 'overhead']) costRow.run(companyId, o.id, k, cost[k].basis, cost[k].basis_qty, cost[k].rate_id, cost[k].rate_minor, cost[k].amount_minor);
    for (const b of cost.byproducts) costRow.run(companyId, o.id, 'byproduct_credit', 'unit', b.qty, b.rate_id, b.rate_minor, -b.amount_minor);
    if (cost.abnormal_loss_minor) costRow.run(companyId, o.id, 'abnormal_loss', 'unit', cost.abnormal_loss_qty, null, null, -cost.abnormal_loss_minor);
    const thRow = db.prepare("INSERT INTO mfg_order_theoretical_costs (company_id, order_id, basis, cost_json, source) VALUES (?, ?, ?, ?, 'close')");
    for (const [basis, th] of theoretical) thRow.run(companyId, o.id, basis, JSON.stringify(th));
    db.prepare("UPDATE production_requests SET status = 'ready', updated_at = datetime('now') WHERE id IN (SELECT production_request_id FROM mfg_order_requests WHERE order_id = ?) AND status = 'in_production'").run(o.id);
    if (quarantine) db.prepare("UPDATE stock_lots SET status = 'quarantine', status_reason = ? WHERE id = ?").run(o.qc_status === 'failed' ? 'لم تجتز فحص الجودة' : 'استلام في الحجر', lot.id);
    db.prepare("UPDATE mfg_orders SET status = 'closed', production_date = ?, output_lot_id = ?, journal_entry_id = ?, cost_json = ?, updated_at = datetime('now') WHERE id = ?").run(d, lot.id, entry?.id ?? null, JSON.stringify(cost), o.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.close', entityType: 'mfg_order', entityId: o.id, before: { status: 'in_progress' }, after: { status: 'closed', lot_id: lot.id, fg_value_minor: cost.fg_value_minor, abnormal_loss_minor: cost.abnormal_loss_minor, journal_entry_id: entry?.id ?? null } });
    return getOrder(companyId, o.id);
  }));
}

// Reject a batch (failed QC, or abandoned after issue): nothing is
// received; everything charged to the order is written off to
// inventory_wastage.
function rejectOrder(companyId, id, { reason, date } = {}, actor) {
  const o = getOrder(companyId, id);
  if (o.status !== 'in_progress') fail('order_not_in_progress', 'لا تُرفض إلا دفعة بدأ إنتاجها — قبل الصرف استخدم الإلغاء', 409);
  if (String(reason || '').trim().length < 5) fail('reason_required', 'سبب رفض الدفعة مطلوب');
  const d = date || today();
  const materials = o.materials.reduce((s, m) => s + m.issued_value_minor - m.returned_value_minor, 0);
  const hours = o.labour_hours ?? 0;
  const q = { kg: Q(o.output_qty * o.output_kg_per_unit), hours, batches: o.batches };
  const labour = absorbed(companyId, 'labour', d, q);
  const energy = absorbed(companyId, 'energy', d, q);
  const overhead = absorbed(companyId, 'overhead', d, q);
  const total = materials + labour.amount_minor + energy.amount_minor + overhead.amount_minor;
  return ledger.transaction(() => {
    const entry = S.post(companyId, {
      date: d, description: `رفض دفعة أمر الإنتاج ${o.order_number}: ${reason}`, sourceType: 'mfg_order', sourceId: o.id,
      lines: [
        { accountId: S.sysAcc(companyId, 'inventory_wastage'), amount: total, memo: 'دفعة مرفوضة' },
        { accountId: S.sysAcc(companyId, 'wip'), amount: -materials, memo: o.order_number },
        { accountId: S.sysAcc(companyId, 'production_labour'), amount: -labour.amount_minor, memo: 'أجور محمّلة' },
        { accountId: S.sysAcc(companyId, 'production_energy'), amount: -energy.amount_minor, memo: 'طاقة محمّلة' },
        { accountId: S.sysAcc(companyId, 'production_overhead'), amount: -overhead.amount_minor, memo: 'مصاريف غير مباشرة محمّلة' },
      ],
    }, actor);
    checkpoint('mfg.reject.after_entry');
    const costRow = db.prepare('INSERT INTO mfg_order_costs (company_id, order_id, kind, basis, basis_qty, rate_id, rate_minor, amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    costRow.run(companyId, o.id, 'materials', null, null, null, null, materials);
    for (const x of [labour, energy, overhead]) costRow.run(companyId, o.id, x.kind, x.basis, x.basis_qty, x.rate_id, x.rate_minor, x.amount_minor);
    costRow.run(companyId, o.id, 'rejected_writeoff', null, null, null, null, -total);
    db.prepare("UPDATE mfg_orders SET status = 'rejected', reject_reason = ?, production_date = ?, journal_entry_id = ?, cost_json = ?, updated_at = datetime('now') WHERE id = ?").run(String(reason).trim(), d, entry?.id ?? null, JSON.stringify({ materials_minor: materials, labour, energy, overhead, written_off_minor: total }), o.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.order.reject', entityType: 'mfg_order', entityId: o.id, before: { status: o.status, qc_status: o.qc_status }, after: { status: 'rejected', reason, written_off_minor: total } });
    return getOrder(companyId, o.id);
  });
}

// ---------------------------------------------------------------------
// Lot trace through production
// ---------------------------------------------------------------------

// Output lots of the production orders a lot was issued to.
function producedFrom(companyId, lotId) {
  return db.prepare(`SELECT DISTINCT o.id AS order_id, o.order_number, o.output_lot_id, l.lot_code, p.name AS product_name, o.production_date
    FROM mfg_order_events e JOIN mfg_orders o ON o.id = e.order_id JOIN stock_lots l ON l.id = o.output_lot_id JOIN products p ON p.id = o.product_id
    WHERE e.company_id = ? AND e.kind = 'issue' AND e.lot_id = ? AND o.status = 'closed'`).all(companyId, lotId).map((r) => ({ ...r }));
}
// Component lots issued to the order that produced a lot (one level).
function madeFrom(companyId, lotId) {
  const o = db.prepare("SELECT id, order_number FROM mfg_orders WHERE company_id = ? AND output_lot_id = ? AND status = 'closed'").get(companyId, lotId);
  if (!o) return null;
  const comps = db.prepare(`SELECT e.lot_id, l.lot_code, l.supplier_lot, l.expiry_date, s.name AS supplier_name, p.name AS product_name, SUM(e.qty) qty
    FROM mfg_order_events e JOIN stock_lots l ON l.id = e.lot_id JOIN products p ON p.id = e.product_id LEFT JOIN suppliers s ON s.id = l.supplier_id
    WHERE e.order_id = ? AND e.kind = 'issue' GROUP BY e.lot_id ORDER BY p.name`).all(o.id).map((c) => ({ ...c }));
  return { order_id: o.id, order_number: o.order_number, components: comps };
}

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------

const period = (q) => {
  const to = q.to || today();
  return { from: q.from || `${to.slice(0, 4)}-01-01`, to };
};
function closedOrders(companyId, q) {
  const { from, to } = period(q);
  return db.prepare("SELECT o.*, p.name AS product_name FROM mfg_orders o JOIN products p ON p.id = o.product_id WHERE o.company_id = ? AND o.status IN ('closed', 'rejected') AND o.production_date BETWEEN ? AND ? ORDER BY o.production_date, o.id").all(companyId, from, to).map((o) => ({ ...o, cost: o.cost_json ? JSON.parse(o.cost_json) : null }));
}
function batchCost(companyId, q = {}) {
  return closedOrders(companyId, q).map((o) => ({ order_id: o.id, order_number: o.order_number, product_name: o.product_name, production_date: o.production_date, status: o.status, actual_units: o.cost?.actual_units ?? 0, materials_minor: o.cost?.materials_minor ?? 0, labour_minor: o.cost?.labour?.amount_minor ?? 0, energy_minor: o.cost?.energy?.amount_minor ?? 0, overhead_minor: o.cost?.overhead?.amount_minor ?? 0, byproduct_credit_minor: o.cost?.byproduct_credit_minor ?? 0, abnormal_loss_minor: o.cost?.abnormal_loss_minor ?? o.cost?.written_off_minor ?? 0, fg_value_minor: o.cost?.fg_value_minor ?? 0, cost_per_unit_minor: o.cost?.cost_per_unit_minor ?? null, cost_per_kg_minor: o.cost?.cost_per_kg_minor ?? null }));
}
function yieldReport(companyId, q = {}) {
  return closedOrders(companyId, q).filter((o) => o.status === 'closed').map((o) => ({ order_number: o.order_number, product_name: o.product_name, production_date: o.production_date, expected_units: o.planned_qty, actual_units: o.cost.actual_units, yield_pct: o.cost.yield_pct, wastage_qty: o.cost.wastage_qty, rework_qty: o.cost.rework_qty, abnormal_loss_qty: o.cost.abnormal_loss_qty }));
}
function wastageReport(companyId, q = {}) {
  const { from, to } = period(q);
  return db.prepare(`SELECT p.name AS product_name, e.stage, SUM(e.qty) qty, COUNT(DISTINCT e.order_id) orders FROM mfg_order_events e JOIN mfg_orders o ON o.id = e.order_id JOIN products p ON p.id = e.product_id
    WHERE e.company_id = ? AND e.kind = 'wastage' AND date(e.created_at) BETWEEN ? AND ? GROUP BY p.name, e.stage ORDER BY p.name, e.stage`).all(companyId, from, to).map((r) => ({ ...r }));
}
function consumption(companyId, q = {}) {
  const { from, to } = period(q);
  return db.prepare(`SELECT p.name AS product_name, SUM(-m.qty) qty, SUM(-m.value_minor) value_minor, COUNT(DISTINCT m.source_id) orders
    FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE m.company_id = ? AND m.move_type IN ('production_issue', 'production_return') AND m.move_date BETWEEN ? AND ? GROUP BY p.name ORDER BY value_minor DESC`).all(companyId, from, to).map((r) => ({ ...r }));
}
// The theoretical cost an order closed with (taken at close; orders closed
// before migration 0030 have the one taken when it ran). Without a row
// (none should remain) it is computed live and marked 'live'.
const THEORETICAL_BASES = ['latest', 'average', 'standard'];
function theoreticalCost(companyId, o, basis) {
  const row = db.prepare('SELECT cost_json FROM mfg_order_theoretical_costs WHERE order_id = ? AND basis = ?').get(o.id, basis);
  if (row) return { th: JSON.parse(row.cost_json), source: 'snapshot' };
  return { th: M.versionCost(companyId, o.version_id, { date: o.production_date, basis, batches: o.batches }), source: 'live' };
}

// Actual vs theoretical (production date, actual output). Theoretical =
// the cost fixed when the order closed, so a closed period does not move.
function variances(companyId, q = {}) {
  const basis = q.basis || 'latest';
  if (!THEORETICAL_BASES.includes(basis)) fail('invalid_basis', 'أساس التسعير غير صالح');
  return closedOrders(companyId, q).filter((o) => o.status === 'closed').map((o) => {
    const v = db.prepare('SELECT batch_output_qty FROM mfg_recipe_versions WHERE id = ?').get(o.version_id);
    const { th, source } = theoreticalCost(companyId, o, basis);
    const thMaterials = th.materials_minor + th.packaging_minor;
    return {
      order_number: o.order_number, product_name: o.product_name, production_date: o.production_date, batches: o.batches, expected_units: Q(v.batch_output_qty * o.batches), actual_units: o.cost.actual_units, theoretical_source: source,
      theoretical_materials_minor: thMaterials, actual_materials_minor: o.cost.materials_minor, materials_variance_minor: o.cost.materials_minor - thMaterials,
      theoretical_labour_minor: th.labour.amount_minor, actual_labour_minor: o.cost.labour.amount_minor, labour_variance_minor: o.cost.labour.amount_minor - th.labour.amount_minor,
      theoretical_overhead_minor: th.overhead.amount_minor + th.energy.amount_minor, actual_overhead_minor: o.cost.overhead.amount_minor + o.cost.energy.amount_minor,
      theoretical_unit_minor: th.cost_per_unit_minor, actual_unit_minor: o.cost.cost_per_unit_minor,
    };
  });
}
// Product / customer profitability with the production cost: sales lines
// against the cost of the stock moves that left (which carry the produced
// lots' cost).
function profitability(companyId, q = {}) {
  const { from, to } = period(q);
  const byProduct = db.prepare(`SELECT p.id product_id, p.name product_name, SUM(l.qty) qty, SUM(l.net_minor) revenue_minor,
      (SELECT COALESCE(-SUM(m.value_minor), 0) FROM stock_moves m JOIN sales_invoice_lines l2 ON l2.id = m.source_id JOIN sales_invoices i2 ON i2.id = l2.invoice_id WHERE m.source_type = 'sales_invoice_line' AND l2.product_id = p.id AND i2.company_id = ? AND i2.invoice_date BETWEEN ? AND ?) cost_minor
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN products p ON p.id = l.product_id WHERE i.company_id = ? AND i.status = 'posted' AND i.invoice_date BETWEEN ? AND ? GROUP BY p.id ORDER BY revenue_minor DESC`).all(companyId, from, to, companyId, from, to)
    .map((r) => ({ ...r, produced: Boolean(db.prepare("SELECT 1 FROM mfg_orders WHERE company_id = ? AND product_id = ? AND status = 'closed'").get(companyId, r.product_id)), margin_minor: r.revenue_minor - r.cost_minor, margin_pct: r.revenue_minor ? Math.round(((r.revenue_minor - r.cost_minor) / r.revenue_minor) * 10000) / 100 : null }));
  const byCustomer = db.prepare(`SELECT s.id shop_id, s.name shop_name, SUM(l.net_minor) revenue_minor, COALESCE(-SUM(m.value_minor), 0) cost_minor
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN shops s ON s.id = i.shop_id LEFT JOIN stock_moves m ON m.source_type = 'sales_invoice_line' AND m.source_id = l.id
    WHERE i.company_id = ? AND i.status = 'posted' AND i.invoice_date BETWEEN ? AND ? GROUP BY s.id ORDER BY revenue_minor DESC`).all(companyId, from, to)
    .map((r) => ({ ...r, margin_minor: r.revenue_minor - r.cost_minor, margin_pct: r.revenue_minor ? Math.round(((r.revenue_minor - r.cost_minor) / r.revenue_minor) * 10000) / 100 : null }));
  return { by_product: byProduct, by_customer: byCustomer };
}

// Certificate of analysis data (document template 'coa').
function coaData(companyId, id) {
  const o = getOrder(companyId, id);
  if (o.status !== 'closed' || !o.output_lot) fail('order_not_closed', 'شهادة التحليل تصدر لدفعة مستلمة (أمر مغلق)', 409);
  const label = M.labelDeclaration(companyId, o.product_id);
  return {
    productName: o.product_name, lotCode: o.output_lot.lot_code, productionDate: o.production_date, expiryDate: o.output_lot.expiry_date, orderNumber: o.order_number, quantity: o.cost?.actual_units,
    qcStatus: o.qc_status, lotStatus: o.output_lot.status,
    checks: o.qc_checks.map((c) => ({ name: c.name, spec: c.kind === 'range' ? `${c.min_value ?? '—'} – ${c.max_value ?? '—'} ${c.unit || ''}`.trim() : 'مطابق', result: c.kind === 'range' ? `${c.value_num ?? '—'} ${c.unit || ''}`.trim() : c.passed === 1 ? 'مطابق' : c.passed === 0 ? 'غير مطابق' : '—', passed: c.passed })),
    allergens: label.declaration_ar,
  };
}

module.exports = {
  sequenceCheck, getPlan, listPlans, savePlan, confirmPlan, mrp, mrpPurchaseRequest, mrpSettings, setMrpSettings, reservedForProduction,
  getOrder, listOrders, createOrder, createFromRequest, releaseOrder, cancelOrder, issueMaterials, returnMaterials, recordEvent, setHours,
  saveQcCheck, listQcChecks, recordQc, actualCost, closeOrder, rejectOrder,
  producedFrom, madeFrom,
  batchCost, yieldReport, wastageReport, consumption, variances, profitability, coaData,
};
