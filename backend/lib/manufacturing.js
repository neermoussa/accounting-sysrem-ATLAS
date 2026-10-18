// backend/lib/manufacturing.js
//
// Prompt 9 — manufacturing for nuts and mixes. Tables: db/manufacturingSchema.js.
// Postings: docs/posting-map.md §13.
//
// Quantities
//   A component's quantity per batch is NET (what ends up in the product).
//   Its expected loss is given per stage (sorting, roasting, mixing ...) in
//   basis points of the input; the GROSS quantity to issue is
//     gross = net / (1 - sum of stage losses)          (rounded to 0.001)
//   e.g. 30 kg almonds with 1.5% sorting + 2.5% roasting loss -> 30 / 0.96
//   = 31.250 kg. Multi-level: a component may itself have a recipe
//   (an intermediate mix); MRP explodes its shortfall into its components.
//
// Costs (minor units of the base currency)
//   Every cost input is effective-dated (mfg_cost_rates): material prices,
//   labour per hour, energy and overhead per kg / hour / batch (the
//   allocation basis), by-product values. Theoretical cost of a version:
//   components at the latest purchase price (or the stock average, or the
//   effective material rate) + labour + energy + overhead - by-products.
//   Actual cost of an order: the issued lots' cost (stock ledger, FEFO) +
//   labour (actual hours) + energy + overhead at the rates effective on the
//   production date - by-products. Output below the expected quantity is
//   abnormal loss: its share of the cost goes to inventory_wastage; the rest
//   is the finished goods' value (no rounding residue: FG takes the remainder).
//
// Flow: plan (allergen sequencing, MRP, purchase request) -> order (draft) ->
// release (version locked, materials reserved, QC required if the product has
// checks) -> issue (FEFO lots, Dr WIP / Cr inventory) -> output / by-products /
// wastage / rework (also offline from the workshop tablet) -> QC -> close
// (receipt into a new lot, costing, one entry) | reject (write-off).

const db = require('../db/init');
const ledger = require('./ledger');
const S = require('./stockLedger');
const documentNumbering = require('./documentNumbering');
const tenantRefs = require('./tenantRefs');
const { logAudit } = require('./auditLog');
const { checkpoint } = require('./faultInjection');

class MfgError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new MfgError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const today = () => new Date().toISOString().slice(0, 10);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const Q = (x) => Math.round(Number(x) * 1e6) / 1e6;
const Q3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
const roundHalfUp = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
const EPS = 1e-9;

const ALLERGENS = ['milk', 'peanuts', 'tree_nuts', 'sesame', 'gluten', 'soy', 'eggs', 'other'];
const STAGES = ['sorting', 'roasting', 'mixing', 'packing', 'other'];

function owned(companyId, kind, id) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 400);
    throw err;
  }
}
// Manufacturing rows are checked here the same way tenantRefs checks shared
// ones: another company's id answers exactly like a missing id.
function ownedRow(companyId, table, id, code, label) {
  const n = Number(id);
  const row = Number.isInteger(n) && n > 0 ? db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(n, companyId) : null;
  if (!row) fail(code, `${label} غير موجود أو لا يتبع لهذه الشركة`, 400);
  return row;
}
const product = (companyId, id) => owned(companyId, 'product', id);
function issueNumber(companyId, type, prefix) {
  if (!db.prepare('SELECT 1 FROM document_number_sequences WHERE company_id = ? AND document_type = ?').get(companyId, type)) documentNumbering.setConfig(companyId, type, { prefix });
  return documentNumbering.issueNext(companyId, type);
}
function requireActive(companyId) {
  if (!S.isActive(companyId)) fail('stock_ledger_not_active', 'التصنيع يحتاج دفتر المخزون — فعّله من شاشة المخزون أولًا', 409);
}
const digits = (companyId) => ledger.getBaseCurrency(companyId).minor_unit_digits;

// ---------------------------------------------------------------------
// Allergens
// ---------------------------------------------------------------------

function setAllergens(companyId, productId, { contains = [], mayContain = [] } = {}, actor) {
  const p = product(companyId, productId);
  for (const a of [...contains, ...mayContain]) if (!ALLERGENS.includes(a)) fail('invalid_allergen', `مسبب حساسية غير معروف: ${a} (${ALLERGENS.join('، ')})`);
  if (contains.some((a) => mayContain.includes(a))) fail('allergen_both', 'لا يكون مسبب الحساسية "يحتوي" و"قد يحتوي" معًا');
  return ledger.transaction(() => {
    const before = productAllergens(p.id);
    db.prepare('DELETE FROM product_allergens WHERE product_id = ?').run(p.id);
    const ins = db.prepare('INSERT INTO product_allergens (company_id, product_id, allergen, level) VALUES (?, ?, ?, ?)');
    for (const a of new Set(contains)) ins.run(companyId, p.id, a, 'contains');
    for (const a of new Set(mayContain)) ins.run(companyId, p.id, a, 'may_contain');
    const after = productAllergens(p.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.allergens.set', entityType: 'product', entityId: p.id, before, after });
    return after;
  });
}
function productAllergens(productId) {
  const rows = db.prepare('SELECT allergen, level FROM product_allergens WHERE product_id = ? ORDER BY allergen').all(productId);
  return { contains: rows.filter((r) => r.level === 'contains').map((r) => r.allergen), may_contain: rows.filter((r) => r.level === 'may_contain').map((r) => r.allergen) };
}
// Own flags plus, recursively, every component's (active version).
function effectiveAllergens(companyId, productId, seen = new Set()) {
  const own = productAllergens(productId);
  const contains = new Set(own.contains);
  const may = new Set(own.may_contain);
  if (!seen.has(productId)) {
    seen.add(productId);
    const v = activeVersion(companyId, productId);
    if (v) {
      for (const c of components(v.id)) {
        const e = effectiveAllergens(companyId, c.product_id, seen);
        e.contains.forEach((a) => contains.add(a));
        e.may_contain.forEach((a) => may.add(a));
      }
    }
  }
  return { contains: [...contains].sort(), may_contain: [...may].filter((a) => !contains.has(a)).sort() };
}
const ALLERGEN_AR = { milk: 'الحليب', peanuts: 'الفول السوداني', tree_nuts: 'المكسرات', sesame: 'السمسم', gluten: 'الغلوتين', soy: 'الصويا', eggs: 'البيض', other: 'مسببات أخرى' };
const ALLERGEN_EN = { milk: 'milk', peanuts: 'peanuts', tree_nuts: 'tree nuts', sesame: 'sesame', gluten: 'gluten', soy: 'soy', eggs: 'eggs', other: 'other allergens' };
// Label declaration; the barcode itself stays on the existing
// /api/products/:id/barcode endpoint (not duplicated here).
function labelDeclaration(companyId, productId) {
  const p = product(companyId, productId);
  const e = effectiveAllergens(companyId, p.id);
  const ar = [e.contains.length ? `يحتوي على: ${e.contains.map((a) => ALLERGEN_AR[a]).join('، ')}` : 'لا يحتوي على مسببات حساسية معلنة', e.may_contain.length ? `قد يحتوي على آثار: ${e.may_contain.map((a) => ALLERGEN_AR[a]).join('، ')}` : null].filter(Boolean).join('. ');
  const en = [e.contains.length ? `Contains: ${e.contains.map((a) => ALLERGEN_EN[a]).join(', ')}` : 'No declared allergens', e.may_contain.length ? `May contain traces of: ${e.may_contain.map((a) => ALLERGEN_EN[a]).join(', ')}` : null].filter(Boolean).join('. ');
  return { product_id: p.id, product_name: p.name, contains: e.contains, may_contain: e.may_contain, declaration_ar: ar, declaration_en: en, barcode_path: `/api/products/${p.id}/barcode`, sku: p.sku, barcode: p.barcode };
}

// ---------------------------------------------------------------------
// Recipes and versions
// ---------------------------------------------------------------------

function components(versionId) {
  return db.prepare('SELECT c.*, p.name AS product_name FROM mfg_recipe_components c JOIN products p ON p.id = c.product_id WHERE c.version_id = ? ORDER BY c.line_no').all(versionId)
    .map((c) => {
      const losses = db.prepare('SELECT stage, loss_bp FROM mfg_component_losses WHERE component_id = ? ORDER BY id').all(c.id).map((l) => ({ ...l }));
      return { ...c, losses, loss_bp: losses.reduce((s, l) => s + l.loss_bp, 0) };
    });
}
const outputs = (versionId) => db.prepare('SELECT o.*, p.name AS product_name FROM mfg_recipe_outputs o JOIN products p ON p.id = o.product_id WHERE o.version_id = ? ORDER BY o.id').all(versionId).map((o) => ({ ...o }));
// Gross quantity of a component for `batches` batches.
const grossQty = (c, batches) => Q3((c.qty_per_batch * batches) / (1 - c.loss_bp / 10000));

function getVersion(companyId, id) {
  const v = ownedRow(companyId, 'mfg_recipe_versions', id, 'invalid_recipe_version', 'إصدار الوصفة');
  const r = db.prepare('SELECT r.*, p.name AS product_name FROM mfg_recipes r JOIN products p ON p.id = r.product_id WHERE r.id = ?').get(v.recipe_id);
  return { ...v, recipe: { ...r }, product_id: r.product_id, product_name: r.product_name, components: components(v.id), outputs: outputs(v.id), used_in_orders: db.prepare('SELECT COUNT(*) c FROM mfg_orders WHERE version_id = ?').get(v.id).c };
}
function activeVersion(companyId, productId) {
  return db.prepare("SELECT v.* FROM mfg_recipe_versions v JOIN mfg_recipes r ON r.id = v.recipe_id WHERE r.company_id = ? AND r.product_id = ? AND r.active = 1 AND v.status = 'active' ORDER BY v.version_no DESC LIMIT 1").get(companyId, productId) || null;
}
function listRecipes(companyId) {
  return db.prepare(`SELECT r.*, p.name AS product_name,
      (SELECT MAX(version_no) FROM mfg_recipe_versions v WHERE v.recipe_id = r.id) AS latest_version,
      (SELECT version_no FROM mfg_recipe_versions v WHERE v.recipe_id = r.id AND v.status = 'active' ORDER BY version_no DESC LIMIT 1) AS active_version
    FROM mfg_recipes r JOIN products p ON p.id = r.product_id WHERE r.company_id = ? ORDER BY p.name`).all(companyId)
    .map((r) => ({ ...r, versions: db.prepare('SELECT id, version_no, status, locked_at, batch_output_qty, created_at FROM mfg_recipe_versions WHERE recipe_id = ? ORDER BY version_no DESC').all(r.id).map((v) => ({ ...v })) }));
}

// Cycle check: `componentId` may not (directly or through its own recipe)
// contain `productId`.
function containsProduct(companyId, rootId, targetId, depth = 0) {
  if (rootId === targetId) return true;
  if (depth > 20) return true;
  const v = activeVersion(companyId, rootId);
  if (!v) return false;
  return components(v.id).some((c) => containsProduct(companyId, c.product_id, targetId, depth + 1));
}

function parseVersionInput(companyId, outputProductId, input) {
  const batch = Number(input.batchOutputQty);
  if (!(batch > 0)) fail('invalid_batch_qty', 'كمية الإنتاج للدفعة يجب أن تكون أكبر من صفر');
  const kgPerUnit = input.outputKgPerUnit === undefined || input.outputKgPerUnit === null || input.outputKgPerUnit === '' ? 1 : Number(input.outputKgPerUnit);
  if (!(kgPerUnit > 0)) fail('invalid_kg_per_unit', 'وزن الوحدة بالكيلو غير صالح');
  const labour = Number(input.labourHoursPerBatch || 0);
  const machine = Number(input.machineHoursPerBatch || 0);
  if (!(labour >= 0) || !(machine >= 0)) fail('invalid_hours', 'الساعات غير صالحة');
  const shelf = input.shelfLifeDays === undefined || input.shelfLifeDays === null || input.shelfLifeDays === '' ? null : Number(input.shelfLifeDays);
  if (shelf !== null && !(Number.isInteger(shelf) && shelf > 0)) fail('invalid_shelf_life', 'مدة الصلاحية بالأيام غير صالحة');
  if (!Array.isArray(input.components) || !input.components.length) fail('components_required', 'الوصفة تحتاج مكوّنًا واحدًا على الأقل');
  const seen = new Set();
  const comps = input.components.map((c, i) => {
    const n = i + 1;
    const p = product(companyId, c.productId);
    if (p.id === outputProductId) fail('recipe_cycle', `السطر ${n}: لا تدخل المادة في وصفتها نفسها`);
    if (containsProduct(companyId, p.id, outputProductId)) fail('recipe_cycle', `السطر ${n}: ${p.name} يحتوي (عبر وصفته) على المادة المنتجة نفسها`);
    if (seen.has(p.id)) fail('duplicate_component', `السطر ${n}: المكوّن مكرر`);
    seen.add(p.id);
    const qty = Number(c.qtyPerBatch);
    if (!(qty > 0)) fail('invalid_qty', `السطر ${n}: الكمية غير صالحة`);
    const kind = c.kind || 'material';
    if (!['material', 'packaging', 'label'].includes(kind)) fail('invalid_kind', `السطر ${n}: نوع المكوّن غير صالح`);
    const losses = (c.losses || []).map((l) => {
      const bp = Math.round(Number(l.lossPct) * 100);
      if (!String(l.stage || '').trim()) fail('stage_required', `السطر ${n}: مرحلة الفقد مطلوبة`);
      if (!(bp >= 0 && bp < 10000)) fail('invalid_loss', `السطر ${n}: نسبة الفقد غير صالحة`);
      return { stage: String(l.stage).trim(), loss_bp: bp };
    });
    if (losses.reduce((s, l) => s + l.loss_bp, 0) >= 10000) fail('invalid_loss', `السطر ${n}: مجموع نسب الفقد يجب أن يقل عن 100%`);
    if (new Set(losses.map((l) => l.stage)).size !== losses.length) fail('duplicate_stage', `السطر ${n}: مرحلة فقد مكررة`);
    return { product_id: p.id, kind, qty_per_batch: qty, notes: c.notes || null, losses };
  });
  const outs = (input.outputs || []).map((o, i) => {
    const p = product(companyId, o.productId);
    if (p.id === outputProductId) fail('invalid_output', `المخرج ${i + 1}: المنتج الثانوي لا يكون المنتج الرئيسي`);
    const qty = Number(o.qtyPerBatch);
    if (!(qty > 0)) fail('invalid_qty', `المخرج ${i + 1}: الكمية غير صالحة`);
    return { product_id: p.id, kind: o.kind === 'secondary' ? 'secondary' : 'byproduct', qty_per_batch: qty };
  });
  return { batch, kgPerUnit, labour, machine, shelf, notes: input.notes || null, comps, outs };
}
function writeVersionLines(companyId, versionId, x) {
  db.prepare('DELETE FROM mfg_component_losses WHERE component_id IN (SELECT id FROM mfg_recipe_components WHERE version_id = ?)').run(versionId);
  db.prepare('DELETE FROM mfg_recipe_components WHERE version_id = ?').run(versionId);
  db.prepare('DELETE FROM mfg_recipe_outputs WHERE version_id = ?').run(versionId);
  x.comps.forEach((c, i) => {
    const cid = Number(db.prepare('INSERT INTO mfg_recipe_components (company_id, version_id, line_no, product_id, kind, qty_per_batch, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(companyId, versionId, i + 1, c.product_id, c.kind, c.qty_per_batch, c.notes).lastInsertRowid);
    for (const l of c.losses) db.prepare('INSERT INTO mfg_component_losses (company_id, component_id, stage, loss_bp) VALUES (?, ?, ?, ?)').run(companyId, cid, l.stage, l.loss_bp);
  });
  for (const o of x.outs) db.prepare('INSERT INTO mfg_recipe_outputs (company_id, version_id, product_id, kind, qty_per_batch) VALUES (?, ?, ?, ?, ?)').run(companyId, versionId, o.product_id, o.kind, o.qty_per_batch);
}

// New recipe (version 1) or a new version of the product's recipe.
function createVersion(companyId, { productId, name, ...input }, actor) {
  const p = product(companyId, productId);
  const x = parseVersionInput(companyId, p.id, input);
  return ledger.transaction(() => {
    let r = db.prepare('SELECT * FROM mfg_recipes WHERE company_id = ? AND product_id = ?').get(companyId, p.id);
    if (!r) {
      const rid = Number(db.prepare('INSERT INTO mfg_recipes (company_id, product_id, name, created_by) VALUES (?, ?, ?, ?)').run(companyId, p.id, String(name || p.name), actor?.id ?? null).lastInsertRowid);
      r = db.prepare('SELECT * FROM mfg_recipes WHERE id = ?').get(rid);
    }
    const no = (db.prepare('SELECT MAX(version_no) m FROM mfg_recipe_versions WHERE recipe_id = ?').get(r.id).m || 0) + 1;
    const vid = Number(db.prepare(`INSERT INTO mfg_recipe_versions (company_id, recipe_id, version_no, batch_output_qty, output_kg_per_unit, labour_hours_per_batch, machine_hours_per_batch, shelf_life_days, notes, copied_from_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, r.id, no, x.batch, x.kgPerUnit, x.labour, x.machine, x.shelf, x.notes, input.copiedFromId || null, actor?.id ?? null).lastInsertRowid);
    writeVersionLines(companyId, vid, x);
    const after = getVersion(companyId, vid);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.recipe_version.create', entityType: 'mfg_recipe_version', entityId: vid, before: null, after: { product_id: p.id, version_no: no, components: after.components.length } });
    return after;
  });
}
// Only a version no production order has used may be edited.
function updateVersion(companyId, versionId, input, actor) {
  const v = ownedRow(companyId, 'mfg_recipe_versions', versionId, 'invalid_recipe_version', 'إصدار الوصفة');
  if (v.locked_at) fail('version_locked', 'هذا الإصدار استُخدم في أمر إنتاج ولا يُعدّل — أنشئ إصدارًا جديدًا (نسخ وتعديل)', 409);
  const before = getVersion(companyId, v.id);
  const x = parseVersionInput(companyId, before.product_id, input);
  return ledger.transaction(() => {
    db.prepare('UPDATE mfg_recipe_versions SET batch_output_qty = ?, output_kg_per_unit = ?, labour_hours_per_batch = ?, machine_hours_per_batch = ?, shelf_life_days = ?, notes = ? WHERE id = ?')
      .run(x.batch, x.kgPerUnit, x.labour, x.machine, x.shelf, x.notes, v.id);
    writeVersionLines(companyId, v.id, x);
    const after = getVersion(companyId, v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.recipe_version.update', entityType: 'mfg_recipe_version', entityId: v.id, before: { components: before.components.map((c) => [c.product_id, c.qty_per_batch, c.loss_bp]) }, after: { components: after.components.map((c) => [c.product_id, c.qty_per_batch, c.loss_bp]) } });
    return after;
  });
}
// Copy a version (used or not) into a new draft version to change it.
function copyVersion(companyId, versionId, actor) {
  const v = getVersion(companyId, versionId);
  return createVersion(companyId, {
    productId: v.product_id,
    batchOutputQty: v.batch_output_qty, outputKgPerUnit: v.output_kg_per_unit, labourHoursPerBatch: v.labour_hours_per_batch, machineHoursPerBatch: v.machine_hours_per_batch, shelfLifeDays: v.shelf_life_days, notes: v.notes, copiedFromId: v.id,
    components: v.components.map((c) => ({ productId: c.product_id, kind: c.kind, qtyPerBatch: c.qty_per_batch, notes: c.notes, losses: c.losses.map((l) => ({ stage: l.stage, lossPct: l.loss_bp / 100 })) })),
    outputs: v.outputs.map((o) => ({ productId: o.product_id, kind: o.kind, qtyPerBatch: o.qty_per_batch })),
  }, actor);
}
// Activate a version (the previous active one is archived).
function activateVersion(companyId, versionId, actor) {
  const v = ownedRow(companyId, 'mfg_recipe_versions', versionId, 'invalid_recipe_version', 'إصدار الوصفة');
  if (v.status === 'archived') fail('version_archived', 'الإصدار مؤرشف', 409);
  return ledger.transaction(() => {
    const prev = db.prepare("SELECT id FROM mfg_recipe_versions WHERE recipe_id = ? AND status = 'active' AND id <> ?").get(v.recipe_id, v.id);
    if (prev) db.prepare("UPDATE mfg_recipe_versions SET status = 'archived' WHERE id = ?").run(prev.id);
    db.prepare("UPDATE mfg_recipe_versions SET status = 'active' WHERE id = ?").run(v.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.recipe_version.activate', entityType: 'mfg_recipe_version', entityId: v.id, before: { active_version_id: prev?.id ?? null }, after: { active_version_id: v.id } });
    return getVersion(companyId, v.id);
  });
}

// ---------------------------------------------------------------------
// Effective-dated cost inputs
// ---------------------------------------------------------------------

const RATE_BASES = { material: ['unit'], byproduct: ['unit'], labour: ['hour'], energy: ['kg', 'hour', 'batch'], overhead: ['kg', 'hour', 'batch'] };
function addRate(companyId, { kind, basis, productId, rateMinor, effectiveFrom, notes }, actor) {
  if (!RATE_BASES[kind]) fail('invalid_rate_kind', 'نوع التكلفة غير صالح');
  const b = basis || RATE_BASES[kind][0];
  if (!RATE_BASES[kind].includes(b)) fail('invalid_basis', `أساس التحميل غير صالح لـ ${kind} (${RATE_BASES[kind].join('، ')})`);
  const needsProduct = kind === 'material' || kind === 'byproduct';
  const pid = needsProduct ? product(companyId, productId).id : null;
  if (!needsProduct && productId) fail('invalid_product', 'هذا النوع لا يرتبط بمادة');
  const rate = Number(rateMinor);
  if (!(Number.isInteger(rate) && rate >= 0)) fail('invalid_rate', 'السعر بالوحدات الصغرى غير صالح');
  if (!isValidDate(effectiveFrom)) fail('invalid_date', 'تاريخ السريان مطلوب');
  return ledger.transaction(() => {
    try {
      const id = Number(db.prepare('INSERT INTO mfg_cost_rates (company_id, kind, basis, product_id, rate_minor, effective_from, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, kind, b, pid, rate, effectiveFrom, notes || null, actor?.id ?? null).lastInsertRowid);
      const row = { ...db.prepare('SELECT * FROM mfg_cost_rates WHERE id = ?').get(id) };
      logAudit({ companyId, actor: actorOf(actor), action: 'mfg.cost_rate.add', entityType: 'mfg_cost_rate', entityId: id, before: null, after: row });
      return row;
    } catch (err) {
      if (/UNIQUE/.test(err.message)) fail('rate_exists', 'يوجد سعر بنفس النوع والمادة وتاريخ السريان — أضف سعرًا بتاريخ آخر', 409);
      throw err;
    }
  });
}
function deleteRate(companyId, id, actor) {
  const r = ownedRow(companyId, 'mfg_cost_rates', id, 'invalid_cost_rate', 'سعر التكلفة');
  if (db.prepare('SELECT 1 FROM mfg_order_costs WHERE rate_id = ?').get(r.id)) fail('rate_used', 'سعر استُخدم في تكلفة أمر إنتاج مغلق — لا يُحذف؛ أضف سعرًا جديدًا بتاريخ سريان لاحق', 409);
  return ledger.transaction(() => {
    db.prepare('DELETE FROM mfg_cost_rates WHERE id = ?').run(r.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'mfg.cost_rate.delete', entityType: 'mfg_cost_rate', entityId: r.id, before: { ...r }, after: null });
    return { deleted: r.id };
  });
}
const listRates = (companyId) => db.prepare('SELECT r.*, p.name AS product_name FROM mfg_cost_rates r LEFT JOIN products p ON p.id = r.product_id WHERE r.company_id = ? ORDER BY r.kind, p.name, r.effective_from DESC').all(companyId).map((r) => ({ ...r }));
// The rate in effect on `date` (latest effective_from <= date).
function rateAt(companyId, kind, date, productId = null) {
  return db.prepare('SELECT * FROM mfg_cost_rates WHERE company_id = ? AND kind = ? AND IFNULL(product_id, 0) = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1').get(companyId, kind, productId || 0, date) || null;
}

// Unit price of a material for theoretical costing (minor per base unit).
//   latest : last goods receipt on or before `date` (base value incl. landed / accepted qty)
//   average: current average of the warehouse stock
//   standard: the effective material rate
// Each falls back to the next source when it has nothing.
function materialPrice(companyId, productId, date, basis = 'latest') {
  const latest = () => {
    const r = db.prepare(`SELECT l.value_base_minor + l.landed_base_minor v, l.qty - l.rejected_qty q, g.receipt_date d FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.receipt_id
      WHERE g.company_id = ? AND l.product_id = ? AND g.receipt_date <= ? AND l.qty - l.rejected_qty > 0 ORDER BY g.receipt_date DESC, l.id DESC LIMIT 1`).get(companyId, productId, date);
    return r ? { unit_minor: r.v / r.q, source: 'latest_purchase', as_of: r.d } : null;
  };
  const average = () => {
    const r = db.prepare("SELECT SUM(p.qty) q, SUM(p.value_minor) v FROM stock_pools p JOIN stock_holders h ON h.id = p.holder_id WHERE p.company_id = ? AND p.product_id = ? AND h.kind = 'warehouse'").get(companyId, productId);
    return r?.q > EPS ? { unit_minor: r.v / r.q, source: 'stock_average' } : null;
  };
  const standard = () => {
    const r = rateAt(companyId, 'material', date, productId);
    return r ? { unit_minor: r.rate_minor, source: 'material_rate', rate_id: r.id, as_of: r.effective_from } : null;
  };
  const order = basis === 'average' ? [average, latest, standard] : basis === 'standard' ? [standard, latest, average] : [latest, average, standard];
  for (const f of order) {
    const r = f();
    if (r) return r;
  }
  return { unit_minor: null, source: 'missing' };
}

// Quantity the energy / overhead basis is measured in.
function basisQty(basis, { kg, hours, batches }) {
  return basis === 'kg' ? kg : basis === 'hour' ? hours : batches;
}
function absorbed(companyId, kind, date, q) {
  const r = rateAt(companyId, kind, date);
  if (!r) return { kind, basis: null, basis_qty: 0, rate_id: null, rate_minor: null, amount_minor: 0, missing: true };
  const bq = basisQty(r.basis, q);
  return { kind, basis: r.basis, basis_qty: Q(bq), rate_id: r.id, rate_minor: r.rate_minor, amount_minor: roundHalfUp(bq * r.rate_minor) };
}

// Theoretical cost of a version for `batches` batches.
function versionCost(companyId, versionId, { date, basis = 'latest', batches = 1, sellingPriceMinor } = {}) {
  const v = getVersion(companyId, versionId);
  const d = date || today();
  if (!isValidDate(d)) fail('invalid_date', 'التاريخ غير صالح');
  const b = Number(batches);
  if (!(b > 0)) fail('invalid_batches', 'عدد الدفعات غير صالح');
  const lines = v.components.map((c) => {
    const qty = grossQty(c, b);
    const price = materialPrice(companyId, c.product_id, d, basis);
    const net = Q3(c.qty_per_batch * b);
    return { product_id: c.product_id, product_name: c.product_name, kind: c.kind, net_qty: net, loss_pct: c.loss_bp / 100, losses: c.losses, gross_qty: qty, loss_qty: Q3(qty - net), unit_minor: price.unit_minor, price_source: price.source, amount_minor: price.unit_minor == null ? null : roundHalfUp(qty * price.unit_minor) };
  });
  const units = Q(v.batch_output_qty * b);
  const kg = Q(units * v.output_kg_per_unit);
  const hours = Q(v.labour_hours_per_batch * b);
  const labour = absorbed(companyId, 'labour', d, { kg, hours, batches: b });
  const energy = absorbed(companyId, 'energy', d, { kg, hours, batches: b });
  const overhead = absorbed(companyId, 'overhead', d, { kg, hours, batches: b });
  const byproducts = v.outputs.map((o) => {
    const r = rateAt(companyId, 'byproduct', d, o.product_id);
    const qty = Q3(o.qty_per_batch * b);
    return { product_id: o.product_id, product_name: o.product_name, kind: o.kind, qty, rate_minor: r?.rate_minor ?? null, amount_minor: r ? roundHalfUp(qty * r.rate_minor) : 0 };
  });
  const materials = lines.filter((l) => l.kind === 'material').reduce((s, l) => s + (l.amount_minor || 0), 0);
  const packaging = lines.filter((l) => l.kind !== 'material').reduce((s, l) => s + (l.amount_minor || 0), 0);
  const credit = byproducts.reduce((s, x) => s + x.amount_minor, 0);
  const total = materials + packaging + labour.amount_minor + energy.amount_minor + overhead.amount_minor - credit;
  const out = {
    version_id: v.id, version_no: v.version_no, product_id: v.product_id, product_name: v.product_name, date: d, basis, batches: b,
    expected_units: units, expected_kg: kg, labour_hours: hours,
    lines, materials_minor: materials, packaging_minor: packaging, labour, energy, overhead, byproducts, byproduct_credit_minor: credit,
    total_minor: total, cost_per_unit_minor: units > EPS ? roundHalfUp(total / units) : null, cost_per_kg_minor: kg > EPS ? roundHalfUp(total / kg) : null,
    missing_prices: lines.filter((l) => l.unit_minor == null).map((l) => l.product_name),
    digits: digits(companyId),
  };
  if (sellingPriceMinor !== undefined && sellingPriceMinor !== null && sellingPriceMinor !== '') {
    const price = Number(sellingPriceMinor);
    out.selling_price_minor = price;
    out.margin_minor = out.cost_per_unit_minor == null ? null : price - out.cost_per_unit_minor;
    out.margin_pct = price > 0 && out.margin_minor != null ? Math.round((out.margin_minor / price) * 10000) / 100 : null;
  }
  return out;
}

module.exports = {
  MfgError, ALLERGENS, STAGES,
  setAllergens, productAllergens, effectiveAllergens, labelDeclaration,
  getVersion, activeVersion, listRecipes, createVersion, updateVersion, copyVersion, activateVersion, components, grossQty,
  addRate, deleteRate, listRates, rateAt, materialPrice, versionCost,
  // internal, used by the rest of the module (lib/manufacturingOrders.js)
  _: { fail, actorOf, today, isValidDate, addDays, Q, Q3, roundHalfUp, EPS, owned, ownedRow, product, issueNumber, requireActive, absorbed, digits },
};
