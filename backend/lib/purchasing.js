// backend/lib/purchasing.js
//
// Suppliers and the purchase side up to goods receipt (Prompt 6):
// suppliers + price history, purchase requests (approval), supplier
// quotations and their comparison, purchase orders (amount-threshold
// approval), goods receipts (Dr inventory / Cr GRNI, stock + item cost).
// Supplier invoices, three-way match, landed cost, payments, debit notes and
// the payables reports are in lib/payables.js.
//
// Every client-supplied id goes through lib/tenantRefs.js (owned()).
// Money: integer minor units of the document currency; base amounts are
// fixed at posting through the Prompt 5 engine (lib/currency.js, fxRate.js).

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const documentNumbering = require('./documentNumbering');
const fx = require('./fxRate');
const { logAudit } = require('./auditLog');
const { toMinor, fromMinor, roundToMinor } = require('./ledgerCurrencies');
const { checkpoint } = require('./faultInjection');

class PurchasingError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
const fail = (code, message, status, extra) => {
  throw new PurchasingError(code, message, status, extra);
};
const today = () => new Date().toISOString().slice(0, 10);
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const ONE_E8 = 100000000;

// The one place ids from the client are resolved (standing tenant rule).
function owned(companyId, kind, id, opts) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message);
    throw err;
  }
}
function optionalOwned(companyId, kind, id, opts) {
  if (id === null || id === undefined || id === '') return null;
  return owned(companyId, kind, id, opts);
}

function base(companyId) {
  return ledger.getBaseCurrency(companyId);
}
function currencyOf(companyId, code) {
  const b = base(companyId);
  const c = String(code || b.code).toUpperCase();
  if (c === b.code) return b;
  const cur = ledger.getCurrency(companyId, c);
  if (!cur || !cur.is_active) fail('invalid_currency', 'العملة غير معرّفة');
  return cur;
}
function systemAccount(companyId, key) {
  const a = ledger.getAccountBySystemKey(companyId, key);
  if (!a || !a.is_active) fail('missing_system_account', `الحساب النظامي ${key} غير معرّف — طبّق قالب دليل الحسابات`, 409);
  return a.id;
}
function issueNumber(companyId, type, prefix) {
  if (!db.prepare('SELECT 1 FROM document_number_sequences WHERE company_id = ? AND document_type = ?').get(companyId, type)) {
    documentNumbering.setConfig(companyId, type, { prefix });
  }
  return documentNumbering.issueNext(companyId, type);
}
function getSetting(companyId, key, fallback) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}
// Separation of duties (company setting enforce_purchasing_separation,
// default ON): the creator of a PO cannot approve it; the user who posted a
// supplier invoice cannot pay it. Also used by Prompt 7 vouchers.
function separationEnforced(companyId) {
  return getSetting(companyId, 'enforce_purchasing_separation', '1') !== '0';
}

// The two steps that must be done by different people, per document kind.
const SOD_STEPS = {
  po: { first: 'create_purchase_requests', second: 'approve_purchase_orders', label: 'اعتماد أوامر الشراء' },
  pay: { first: 'post_supplier_invoices', second: 'make_supplier_payments', label: 'دفعات الموردين' },
  voucher: { first: 'create_vouchers', second: 'approve_vouchers', label: 'اعتماد سندات الخزينة' },
  count: { first: 'manage_stock_counts', second: 'approve_stock_counts', label: 'اعتماد الجرد' },
  payroll: { first: 'manage_payroll_intake', second: 'approve_payroll_posting', label: 'ترحيل الرواتب' },
  // Prompt 12b: a report send is approved by another send_reports holder than the one who requested it.
  report_send: { first: 'send_reports', second: 'send_reports', label: 'اعتماد إرسال التقارير' },
};
// Users (other than `exceptUserId`) who could do the second step.
function otherHolders(companyId, kind, exceptUserId) {
  return db.prepare(
    `SELECT COUNT(DISTINCT u.id) c FROM users u JOIN user_permissions p ON p.user_id = u.id
     WHERE u.company_id = ? AND u.status = 'approved' AND u.id <> ? AND p.permission = ?`
  ).get(companyId, exceptUserId ?? 0, SOD_STEPS[kind].second).c;
}
// Enforced automatically only when the setting is on AND the company has
// 2+ active users for the step: the actor plus at least one other user who
// holds the second-step permission. A one-user company keeps operating.
function separationApplies(companyId, kind, actorId) {
  return separationEnforced(companyId) && otherHolders(companyId, kind, actorId) > 0;
}
// Per-step status for the settings screen: who holds each side, and
// whether the rule bites (2+ active users across the two steps, at least
// one of whom can do the second step).
function sodStatus(companyId) {
  const holders = (perm) => db.prepare("SELECT DISTINCT u.id, u.name FROM users u JOIN user_permissions p ON p.user_id = u.id WHERE u.company_id = ? AND u.status = 'approved' AND p.permission = ? ORDER BY u.name").all(companyId, perm);
  return Object.entries(SOD_STEPS).map(([kind, st]) => {
    const first = holders(st.first);
    const second = holders(st.second);
    const users = new Set([...first, ...second].map((u) => u.id));
    return { kind, label: st.label, first_permission: st.first, second_permission: st.second, first_holders: first, second_holders: second, active: separationEnforced(companyId) && users.size >= 2 && second.length >= 1 };
  });
}
function isOwner(actor) {
  return Boolean(actor?.id && db.prepare("SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = 'manage_permissions'").get(actor.id));
}
// The one guard for "the same person did both steps". Owner break-glass:
// the owner (manage_permissions holder) may proceed with a written reason
// (>= 10 characters); audited and announced to the company.
function sodGuard(companyId, kind, actor, breakGlassReason, { code, message, entityType, entityId }) {
  if (!actor?.id || !separationApplies(companyId, kind, actor.id)) return { breakGlass: false };
  const reason = String(breakGlassReason || '').trim();
  const owner = isOwner(actor);
  if (!reason) fail(code, `${message}${owner ? ' — كمالك يمكنك التجاوز الطارئ مع ذكر السبب كتابةً.' : ''}`, 403, { break_glass_available: owner });
  if (!owner) fail('break_glass_owner_only', 'التجاوز الطارئ لفصل المهام متاح لمالك الشركة فقط', 403);
  if (reason.length < 10) fail('break_glass_reason_too_short', 'سبب التجاوز الطارئ يجب أن يكون 10 أحرف على الأقل', 400);
  logAudit({ companyId, actor: actorOf(actor), action: 'sod.break_glass', entityType, entityId, before: null, after: { kind, step: SOD_STEPS[kind].label, rule: code, reason } });
  require('./notify').createNotification({
    companyId, type: 'sod_break_glass',
    message_ar: `تجاوز طارئ لفصل المهام (${SOD_STEPS[kind].label}) من ${actor.name || 'المالك'}: ${reason}`,
    message_en: `Separation-of-duties break-glass (${kind}) by ${actor.name || 'owner'}: ${reason}`,
    link_path: '/audit-log', entity_type: entityType, entity_id: entityId,
  });
  return { breakGlass: true };
}
function setSetting(companyId, key, value) {
  db.prepare('INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value').run(companyId, key, String(value));
}

// Rate for a document (Prompt 5 engine): history rate for the date, or a
// typed override with override_exchange_rate.
function docRate(companyId, code, date, { exchangeRate, rateQuote } = {}, actor) {
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
function toBase(companyId, code, minor, rate) {
  const b = base(companyId);
  const c = currencyOf(companyId, code);
  if (c.code === b.code) return minor;
  try {
    return fx.toBaseMinor(minor, rate.rateE8, rate.quote, c.minor_unit_digits, b.minor_unit_digits);
  } catch (err) {
    if (err instanceof fx.FxError) fail(err.code, err.message);
    throw err;
  }
}
function fromBase(companyId, code, baseMinor, rate) {
  const b = base(companyId);
  const c = currencyOf(companyId, code);
  if (c.code === b.code) return baseMinor;
  try {
    return fx.fromBaseMinor(baseMinor, rate.rateE8, rate.quote, c.minor_unit_digits, b.minor_unit_digits);
  } catch (err) {
    if (err instanceof fx.FxError) fail(err.code, err.message);
    throw err;
  }
}
const rateOf = (row) => (row.rate_e8 ? { rateE8: row.rate_e8, quote: row.rate_quote } : { rateE8: ONE_E8, quote: 'base_per_foreign' });

function parseQty(v, n, { allowZero = false } = {}) {
  const q = Number(v);
  if (!Number.isFinite(q) || q < 0 || (!allowZero && q === 0)) fail('invalid_qty', `السطر ${n}: الكمية غير صالحة`);
  return Math.round(q * 1000) / 1000;
}
function parseTaxBp(v, n) {
  if (v === undefined || v === null || v === '') return 0;
  const bp = toMinor(v, 2);
  if (bp < 0 || bp > 10000) fail('invalid_tax_rate', `السطر ${n}: نسبة الضريبة غير صالحة`);
  return bp;
}
const roundHalfUp = (x) => roundToMinor(x, 0);

// Lines priced in a currency: net = unit x qty, tax = net x rate; each
// rounded once to the minor unit.
function priceLines(companyId, rawLines, digits, { withProductCheck = true } = {}) {
  if (!Array.isArray(rawLines) || !rawLines.length) fail('lines_required', 'المستند يحتاج سطرًا واحدًا على الأقل');
  return rawLines.map((raw, i) => {
    const n = i + 1;
    const product = withProductCheck ? optionalOwned(companyId, 'product', raw.productId) : null;
    const description = String(raw.description || product?.name || '').trim();
    if (!description) fail('description_required', `السطر ${n}: اختر مادة أو اكتب وصفًا`);
    const qty = parseQty(raw.qty, n);
    const unit = raw.unitPriceMinor !== undefined ? Number(raw.unitPriceMinor) : toMinor(raw.unitPrice, digits);
    if (!Number.isSafeInteger(unit) || unit < 0) fail('invalid_price', `السطر ${n}: السعر غير صالح`);
    const taxBp = parseTaxBp(raw.taxRate, n);
    const net = roundHalfUp(unit * qty);
    return { line_no: n, product_id: product?.id ?? null, description, qty, unit_price_minor: unit, tax_rate_bp: taxBp, net_minor: net, tax_minor: roundHalfUp((net * taxBp) / 10000), raw };
  });
}

// ---------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------

function apBalances(companyId) {
  const ap = ledger.getAccountBySystemKey(companyId, 'ap_control');
  if (!ap) return new Map();
  return new Map(
    db
      .prepare(
        `SELECT l.party_id, SUM(l.credit_minor - l.debit_minor) bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ? AND l.party_type = 'supplier' GROUP BY l.party_id`
      )
      .all(companyId, ap.id)
      .map((r) => [r.party_id, r.bal])
  );
}

function listSuppliers(companyId, { q, active } = {}) {
  const where = ['company_id = ?'];
  const p = [companyId];
  if (q) { where.push('(name LIKE ? OR code LIKE ? OR phone LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (active === '1') where.push('is_active = 1');
  const bal = apBalances(companyId);
  return db.prepare(`SELECT * FROM suppliers WHERE ${where.join(' AND ')} ORDER BY name`).all(...p).map((s) => ({ ...s, balance_minor: bal.get(s.id) || 0 }));
}

function getSupplier(companyId, id) {
  const s = owned(companyId, 'supplier', id);
  return { ...s, balance_minor: apBalances(companyId).get(s.id) || 0, ratings: supplierRatings(companyId, s.id) };
}

function supplierFields(companyId, input, existing) {
  const out = {};
  const str = (k, col, max = 200) => {
    if (input[k] !== undefined) out[col] = input[k] === null || input[k] === '' ? null : String(input[k]).trim().slice(0, max);
  };
  if (input.name !== undefined || !existing) {
    const name = String(input.name ?? '').trim();
    if (!name) fail('name_required', 'اسم المورد مطلوب');
    out.name = name.slice(0, 200);
  }
  str('code', 'code', 40);
  str('contactName', 'contact_name');
  str('phone', 'phone', 40);
  str('email', 'email');
  str('address', 'address', 500);
  str('taxNumber', 'tax_number', 60);
  str('notes', 'notes', 2000);
  str('ratingNotes', 'rating_notes', 2000);
  if (input.currencyCode !== undefined) out.currency_code = input.currencyCode ? currencyOf(companyId, input.currencyCode).code : null;
  if (input.paymentTermsDays !== undefined) {
    const d = Number(input.paymentTermsDays);
    if (!Number.isInteger(d) || d < 0 || d > 3650) fail('invalid_terms', 'مدة السداد غير صالحة');
    out.payment_terms_days = d;
  }
  if (input.defaultTaxRate !== undefined) out.default_tax_rate_bp = parseTaxBp(input.defaultTaxRate, 1);
  if (input.manualRating !== undefined) {
    const r = input.manualRating === null || input.manualRating === '' ? null : Number(input.manualRating);
    if (r !== null && (!Number.isInteger(r) || r < 1 || r > 5)) fail('invalid_rating', 'التقييم من 1 إلى 5');
    out.manual_rating = r;
  }
  if (input.isActive !== undefined) out.is_active = input.isActive ? 1 : 0;
  return out;
}

function saveSupplier(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const existing = id ? owned(companyId, 'supplier', id) : null;
    const f = supplierFields(companyId, input || {}, existing);
    if (f.name && db.prepare('SELECT 1 FROM suppliers WHERE company_id = ? AND name = ? AND id <> ?').get(companyId, f.name, existing?.id ?? 0)) fail('duplicate_supplier', 'يوجد مورد بهذا الاسم', 409);
    if (f.code && db.prepare('SELECT 1 FROM suppliers WHERE company_id = ? AND code = ? AND id <> ?').get(companyId, f.code, existing?.id ?? 0)) fail('duplicate_code', 'رمز المورد مستخدم', 409);
    let sid = existing?.id;
    if (existing) {
      const keys = Object.keys(f);
      if (keys.length) db.prepare(`UPDATE suppliers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => f[k]), existing.id);
    } else {
      const keys = Object.keys(f);
      sid = Number(db.prepare(`INSERT INTO suppliers (company_id, created_by, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`).run(companyId, actor?.id ?? null, ...keys.map((k) => f[k])).lastInsertRowid);
    }
    const after = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sid);
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'purchasing.supplier.update' : 'purchasing.supplier.create', entityType: 'supplier', entityId: sid, before: existing, after });
    return getSupplier(companyId, sid);
  });
}

function recordPrice(companyId, { supplierId, productId, description, date, currencyCode, unitMinor, unitBaseMinor, sourceType, sourceId }) {
  db.prepare(
    `INSERT INTO supplier_price_history (company_id, supplier_id, product_id, description, price_date, currency_code, unit_price_minor, unit_price_base_minor, source_type, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(companyId, supplierId, productId ?? null, description ?? null, date, currencyCode, unitMinor, unitBaseMinor ?? null, sourceType, sourceId);
}

function priceHistory(companyId, { supplierId, productId } = {}) {
  const where = ['h.company_id = ?'];
  const p = [companyId];
  if (supplierId) { where.push('h.supplier_id = ?'); p.push(owned(companyId, 'supplier', supplierId).id); }
  if (productId) { where.push('h.product_id = ?'); p.push(owned(companyId, 'product', productId).id); }
  return db
    .prepare(`SELECT h.*, s.name AS supplier_name, pr.name AS product_name FROM supplier_price_history h JOIN suppliers s ON s.id = h.supplier_id LEFT JOIN products pr ON pr.id = h.product_id WHERE ${where.join(' AND ')} ORDER BY h.price_date DESC, h.id DESC LIMIT 1000`)
    .all(...p);
}

// Computed ratings: on-time delivery (receipts on/before the PO expected
// date), price consistency (invoice lines within the price tolerance of the
// PO price), quality (rejected / received qty). Percentages, null = no data.
function supplierRatings(companyId, supplierId) {
  const onTime = db
    .prepare(
      `SELECT COUNT(*) n, SUM(CASE WHEN r.receipt_date <= p.expected_date THEN 1 ELSE 0 END) ok
       FROM goods_receipts r JOIN purchase_orders p ON p.id = r.po_id WHERE r.company_id = ? AND r.supplier_id = ? AND p.expected_date IS NOT NULL`
    )
    .get(companyId, supplierId);
  const tolBp = Number(getSetting(companyId, 'purchase_price_tolerance_bp', '200'));
  const price = db
    .prepare(
      `SELECT COUNT(*) n, SUM(CASE WHEN ABS(l.unit_price_minor - pl.unit_price_minor) * 10000 <= pl.unit_price_minor * ? THEN 1 ELSE 0 END) ok
       FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id JOIN purchase_order_lines pl ON pl.id = l.po_line_id
       WHERE i.company_id = ? AND i.supplier_id = ? AND i.status = 'posted'`
    )
    .get(tolBp, companyId, supplierId);
  const quality = db
    .prepare('SELECT COALESCE(SUM(l.qty), 0) q, COALESCE(SUM(l.rejected_qty), 0) r FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.receipt_id WHERE g.company_id = ? AND g.supplier_id = ?')
    .get(companyId, supplierId);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    on_time_pct: pct(onTime.ok || 0, onTime.n), on_time_receipts: onTime.n,
    price_consistency_pct: pct(price.ok || 0, price.n), invoice_lines: price.n,
    quality_rejection_pct: pct(quality.r, quality.q), received_qty: quality.q,
  };
}

// ---------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------

function getRequest(companyId, id) {
  const r = owned(companyId, 'purchase_request', id);
  return {
    ...r,
    lines: db.prepare('SELECT l.*, p.name AS product_name FROM purchase_request_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.request_id = ? ORDER BY l.line_no').all(r.id),
    quotations: db.prepare('SELECT q.*, s.name AS supplier_name FROM supplier_quotations q JOIN suppliers s ON s.id = q.supplier_id WHERE q.request_id = ? ORDER BY q.id').all(r.id),
    purchase_orders: db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE request_id = ?').all(r.id),
  };
}

function listRequests(companyId, { status } = {}) {
  return db
    .prepare(`SELECT r.*, u.name AS requested_by_name, (SELECT COUNT(*) FROM purchase_request_lines l WHERE l.request_id = r.id) AS line_count
              FROM purchase_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.company_id = ? ${status ? 'AND r.status = ?' : ''} ORDER BY r.request_date DESC, r.id DESC LIMIT 500`)
    .all(...[companyId, ...(status ? [status] : [])]);
}

function requestLines(companyId, rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) fail('lines_required', 'الطلب يحتاج سطرًا واحدًا على الأقل');
  return rawLines.map((raw, i) => {
    const n = i + 1;
    const product = optionalOwned(companyId, 'product', raw.productId);
    const description = String(raw.description || product?.name || '').trim();
    if (!description) fail('description_required', `السطر ${n}: اختر مادة أو اكتب وصفًا`);
    return { line_no: n, product_id: product?.id ?? null, description, qty: parseQty(raw.qty, n) };
  });
}

function saveRequest(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const existing = id ? owned(companyId, 'purchase_request', id) : null;
    if (existing && existing.status !== 'draft') fail('request_not_draft', 'لا يُعدّل إلا الطلب المسودة', 409);
    const date = input.requestDate || existing?.request_date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const needed = input.neededBy !== undefined ? input.neededBy || null : existing?.needed_by ?? null;
    if (needed && !isValidDate(needed)) fail('invalid_date', 'تاريخ الحاجة غير صالح');
    const warehouseId = input.warehouseId !== undefined ? optionalOwned(companyId, 'warehouse', input.warehouseId)?.id ?? null : existing?.warehouse_id ?? null;
    let rid = existing?.id;
    if (existing) {
      db.prepare("UPDATE purchase_requests SET request_date = ?, needed_by = ?, warehouse_id = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
        .run(date, needed, warehouseId, input.notes !== undefined ? input.notes || null : existing.notes, rid);
    } else {
      rid = Number(db.prepare('INSERT INTO purchase_requests (company_id, request_date, needed_by, warehouse_id, notes, requested_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(companyId, date, needed, warehouseId, input.notes || null, actor?.id ?? null).lastInsertRowid);
    }
    if (input.lines !== undefined || !existing) {
      const lines = requestLines(companyId, input.lines);
      db.prepare('DELETE FROM purchase_request_lines WHERE request_id = ?').run(rid);
      const ins = db.prepare('INSERT INTO purchase_request_lines (company_id, request_id, line_no, product_id, description, qty) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) ins.run(companyId, rid, l.line_no, l.product_id, l.description, l.qty);
    }
    const after = getRequest(companyId, rid);
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'purchasing.request.update' : 'purchasing.request.create', entityType: 'purchase_request', entityId: rid, before: existing, after });
    return after;
  });
}

// submit (creator) | approve | reject (approve_purchase_orders) | cancel
function requestAction(companyId, id, action, { reason } = {}, actor) {
  return ledger.transaction(() => {
    const r = owned(companyId, 'purchase_request', id);
    const set = (status, extra = '') => db.prepare(`UPDATE purchase_requests SET status = ?, updated_at = datetime('now') ${extra} WHERE id = ?`);
    if (action === 'submit') {
      if (r.status !== 'draft') fail('invalid_transition', 'الطلب ليس مسودة', 409);
      if (!r.request_number) db.prepare('UPDATE purchase_requests SET request_number = ? WHERE id = ?').run(issueNumber(companyId, 'PR', 'PR-'), r.id);
      set('submitted').run('submitted', r.id);
    } else if (action === 'approve' || action === 'reject') {
      if (r.status !== 'submitted') fail('invalid_transition', 'الطلب غير مقدّم للاعتماد', 409);
      if (action === 'reject' && !String(reason || '').trim()) fail('reason_required', 'سبب الرفض مطلوب');
      set(action === 'approve' ? 'approved' : 'rejected', ", decided_by = ?, decided_at = datetime('now'), decision_reason = ?").run(action === 'approve' ? 'approved' : 'rejected', actor?.id ?? null, reason || null, r.id);
    } else if (action === 'cancel') {
      if (['ordered', 'cancelled'].includes(r.status)) fail('invalid_transition', 'لا يمكن إلغاء هذا الطلب', 409);
      set('cancelled').run('cancelled', r.id);
    } else fail('invalid_action', 'إجراء غير صالح');
    const after = getRequest(companyId, r.id);
    logAudit({ companyId, actor: actorOf(actor), action: `purchasing.request.${action}`, entityType: 'purchase_request', entityId: r.id, before: { status: r.status }, after: { status: after.status, reason: reason || null } });
    return after;
  });
}

// ---------------------------------------------------------------------
// Supplier quotations + comparison
// ---------------------------------------------------------------------

function getQuotation(companyId, id) {
  const q = owned(companyId, 'supplier_quotation', id);
  return { ...q, supplier: db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(q.supplier_id), lines: db.prepare('SELECT * FROM supplier_quotation_lines WHERE quotation_id = ? ORDER BY line_no').all(q.id) };
}

function createQuotation(companyId, input, actor) {
  return ledger.transaction(() => {
    const supplier = owned(companyId, 'supplier', input.supplierId, { active: true });
    const request = optionalOwned(companyId, 'purchase_request', input.requestId);
    if (request && !['approved', 'submitted'].includes(request.status)) fail('request_not_open', 'طلب الشراء غير مفتوح لعروض الأسعار', 409);
    const date = input.quotationDate || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const cur = currencyOf(companyId, input.currencyCode || supplier.currency_code);
    const lines = priceLines(companyId, input.lines, cur.minor_unit_digits);
    for (const [i, l] of lines.entries()) {
      l.request_line_id = l.raw.requestLineId ? (() => {
        const rl = db.prepare('SELECT * FROM purchase_request_lines WHERE id = ? AND company_id = ?').get(Number(l.raw.requestLineId), companyId);
        if (!rl || (request && rl.request_id !== request.id)) fail('invalid_request_line', `السطر ${i + 1}: سطر الطلب غير موجود`);
        return rl.id;
      })() : null;
    }
    const total = lines.reduce((s, l) => s + l.net_minor + l.tax_minor, 0);
    const number = issueNumber(companyId, 'QT', 'QT-');
    const qid = Number(
      db.prepare(
        `INSERT INTO supplier_quotations (company_id, quotation_number, request_id, supplier_id, quotation_date, valid_until, supplier_ref, currency_code, lead_time_days, total_minor, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(companyId, number, request?.id ?? null, supplier.id, date, input.validUntil || null, input.supplierRef || null, cur.code, input.leadTimeDays ?? null, total, input.notes || null, actor?.id ?? null).lastInsertRowid
    );
    const ins = db.prepare('INSERT INTO supplier_quotation_lines (company_id, quotation_id, line_no, request_line_id, product_id, description, qty, unit_price_minor, tax_rate_bp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of lines) {
      ins.run(companyId, qid, l.line_no, l.request_line_id, l.product_id, l.description, l.qty, l.unit_price_minor, l.tax_rate_bp);
      recordPrice(companyId, { supplierId: supplier.id, productId: l.product_id, description: l.description, date, currencyCode: cur.code, unitMinor: l.unit_price_minor, sourceType: 'quotation', sourceId: qid });
    }
    const after = getQuotation(companyId, qid);
    logAudit({ companyId, actor: actorOf(actor), action: 'purchasing.quotation.create', entityType: 'supplier_quotation', entityId: qid, before: null, after });
    return after;
  });
}

// Side by side per request line: every quotation's unit price in its own
// currency and in base at the quotation-date rate; the cheapest is marked.
function compareQuotations(companyId, requestId) {
  const req = getRequest(companyId, requestId);
  const b = base(companyId);
  const quotes = db.prepare('SELECT q.*, s.name AS supplier_name FROM supplier_quotations q JOIN suppliers s ON s.id = q.supplier_id WHERE q.request_id = ? ORDER BY q.id').all(req.id);
  const rows = req.lines.map((rl) => {
    const offers = [];
    for (const q of quotes) {
      const l = db.prepare('SELECT * FROM supplier_quotation_lines WHERE quotation_id = ? AND (request_line_id = ? OR (request_line_id IS NULL AND product_id IS ? AND product_id IS NOT NULL)) LIMIT 1').get(q.id, rl.id, rl.product_id);
      if (!l) continue;
      const rate = q.currency_code === b.code ? { rateE8: ONE_E8, quote: 'base_per_foreign' } : require('./currency').rateFor(companyId, q.currency_code, q.quotation_date);
      const unitBase = rate ? toBase(companyId, q.currency_code, l.unit_price_minor, rate.rate_e8 ? { rateE8: rate.rate_e8, quote: rate.rate_quote } : rate) : null;
      offers.push({ quotation_id: q.id, quotation_number: q.quotation_number, supplier_id: q.supplier_id, supplier_name: q.supplier_name, currency_code: q.currency_code, unit_price_minor: l.unit_price_minor, unit_base_minor: unitBase, lead_time_days: q.lead_time_days, status: q.status });
    }
    const priced = offers.filter((o) => o.unit_base_minor !== null);
    const best = priced.length ? priced.reduce((m, o) => (o.unit_base_minor < m.unit_base_minor ? o : m)) : null;
    return { request_line_id: rl.id, description: rl.description, qty: rl.qty, offers: offers.map((o) => ({ ...o, best: best && o.quotation_id === best.quotation_id })) };
  });
  const totals = quotes.map((q) => {
    const sum = rows.reduce((s, r) => s + (r.offers.find((o) => o.quotation_id === q.id)?.unit_base_minor ?? 0) * r.qty, 0);
    return { quotation_id: q.id, supplier_name: q.supplier_name, base_total_minor: Math.round(sum), covers: rows.filter((r) => r.offers.some((o) => o.quotation_id === q.id)).length };
  });
  return { request: { id: req.id, request_number: req.request_number, status: req.status }, base_currency: b.code, rows, totals };
}

// ---------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------

function getPurchaseOrder(companyId, id) {
  const po = owned(companyId, 'purchase_order', id);
  const cur = currencyOf(companyId, po.currency_code);
  return {
    ...po,
    digits: cur.minor_unit_digits,
    supplier: db.prepare('SELECT id, name, currency_code, payment_terms_days FROM suppliers WHERE id = ?').get(po.supplier_id),
    lines: db.prepare('SELECT l.*, p.name AS product_name FROM purchase_order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.po_id = ? ORDER BY l.line_no').all(po.id),
    receipts: db.prepare('SELECT id, receipt_number, receipt_date, total_base_minor FROM goods_receipts WHERE po_id = ? ORDER BY id').all(po.id),
    invoices: db.prepare('SELECT id, invoice_number, supplier_invoice_ref, status, match_status, total_minor FROM supplier_invoices WHERE po_id = ? ORDER BY id').all(po.id),
    approval_threshold_minor: Number(getSetting(companyId, 'po_approval_threshold_minor', '0')),
  };
}

function listPurchaseOrders(companyId, { status, supplierId } = {}) {
  const where = ['p.company_id = ?'];
  const prm = [companyId];
  if (status) { where.push('p.status = ?'); prm.push(String(status)); }
  if (supplierId) { where.push('p.supplier_id = ?'); prm.push(owned(companyId, 'supplier', supplierId).id); }
  return db.prepare(`SELECT p.*, s.name AS supplier_name FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE ${where.join(' AND ')} ORDER BY p.order_date DESC, p.id DESC LIMIT 500`).all(...prm);
}

function savePurchaseOrder(companyId, id, input, actor) {
  return ledger.transaction(() => {
    const existing = id ? owned(companyId, 'purchase_order', id) : null;
    if (existing && existing.status !== 'draft') fail('po_not_draft', 'لا يُعدّل إلا أمر الشراء المسودة', 409);
    const supplier = owned(companyId, 'supplier', input.supplierId ?? existing?.supplier_id, { active: !existing });
    const request = input.requestId !== undefined ? optionalOwned(companyId, 'purchase_request', input.requestId) : existing?.request_id ? owned(companyId, 'purchase_request', existing.request_id) : null;
    if (request && !existing && request.status !== 'approved') fail('request_not_approved', 'طلب الشراء غير معتمد', 409);
    const quotation = input.quotationId !== undefined ? optionalOwned(companyId, 'supplier_quotation', input.quotationId) : null;
    if (quotation && quotation.supplier_id !== supplier.id) fail('quotation_supplier_mismatch', 'عرض السعر لا يخص هذا المورد');
    const warehouse = input.warehouseId !== undefined ? optionalOwned(companyId, 'warehouse', input.warehouseId) : existing?.warehouse_id ? { id: existing.warehouse_id } : null;
    const approver = input.approverUserId !== undefined ? optionalOwned(companyId, 'user', input.approverUserId, { active: true }) : existing?.approver_user_id ? { id: existing.approver_user_id } : null;
    const date = input.orderDate || existing?.order_date || today();
    const expected = input.expectedDate !== undefined ? input.expectedDate || null : existing?.expected_date ?? null;
    if (!isValidDate(date) || (expected && !isValidDate(expected))) fail('invalid_date', 'التاريخ غير صالح');
    const cur = currencyOf(companyId, input.currencyCode || quotation?.currency_code || existing?.currency_code || supplier.currency_code);
    let lines = null;
    if (input.lines !== undefined || !existing) {
      const raw = input.lines || (quotation ? db.prepare('SELECT * FROM supplier_quotation_lines WHERE quotation_id = ?').all(quotation.id).map((l) => ({ productId: l.product_id, description: l.description, qty: l.qty, unitPriceMinor: l.unit_price_minor, taxRate: fromMinor(l.tax_rate_bp, 2), requestLineId: l.request_line_id })) : null);
      lines = priceLines(companyId, raw, cur.minor_unit_digits);
      for (const l of lines) {
        l.request_line_id = l.raw.requestLineId ? db.prepare('SELECT id FROM purchase_request_lines WHERE id = ? AND company_id = ?').get(Number(l.raw.requestLineId), companyId)?.id ?? null : null;
      }
    }
    const fields = [supplier.id, request?.id ?? null, quotation?.id ?? existing?.quotation_id ?? null, warehouse?.id ?? null, date, expected, cur.code, approver?.id ?? null, input.notes !== undefined ? input.notes || null : existing?.notes ?? null];
    let pid = existing?.id;
    if (existing) {
      db.prepare("UPDATE purchase_orders SET supplier_id = ?, request_id = ?, quotation_id = ?, warehouse_id = ?, order_date = ?, expected_date = ?, currency_code = ?, approver_user_id = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(...fields, pid);
    } else {
      pid = Number(db.prepare('INSERT INTO purchase_orders (company_id, supplier_id, request_id, quotation_id, warehouse_id, order_date, expected_date, currency_code, approver_user_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, ...fields, actor?.id ?? null).lastInsertRowid);
    }
    if (lines) {
      db.prepare('DELETE FROM purchase_order_lines WHERE po_id = ?').run(pid);
      const ins = db.prepare('INSERT INTO purchase_order_lines (company_id, po_id, line_no, request_line_id, product_id, description, qty, unit_price_minor, tax_rate_bp, net_minor, tax_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const l of lines) ins.run(companyId, pid, l.line_no, l.request_line_id, l.product_id, l.description, l.qty, l.unit_price_minor, l.tax_rate_bp, l.net_minor, l.tax_minor);
      const sub = lines.reduce((s, l) => s + l.net_minor, 0);
      const tax = lines.reduce((s, l) => s + l.tax_minor, 0);
      db.prepare('UPDATE purchase_orders SET subtotal_minor = ?, tax_minor = ?, total_minor = ? WHERE id = ?').run(sub, tax, sub + tax, pid);
    }
    const after = getPurchaseOrder(companyId, pid);
    logAudit({ companyId, actor: actorOf(actor), action: existing ? 'purchasing.po.update' : 'purchasing.po.create', entityType: 'purchase_order', entityId: pid, before: existing, after });
    return after;
  });
}

// Submit: numbers the PO and estimates its base value at the order-date
// rate. At or below the approval threshold (setting
// po_approval_threshold_minor, base minor units) it is approved at once;
// above it waits for approvePurchaseOrder.
//
// PROMPT 13 HOOK: replace this threshold + approver_user_id check with the
// approvals engine (multi-level rules, delegation, SoD).
function submitPurchaseOrder(companyId, id, actor) {
  return ledger.transaction(() => {
    const po = owned(companyId, 'purchase_order', id);
    if (po.status !== 'draft') fail('invalid_transition', 'أمر الشراء ليس مسودة', 409);
    if (po.total_minor <= 0) fail('zero_total', 'أمر الشراء بقيمة صفر');
    const rate = docRate(companyId, po.currency_code, po.order_date, {}, actor);
    const est = toBase(companyId, po.currency_code, po.total_minor, rate);
    const threshold = Number(getSetting(companyId, 'po_approval_threshold_minor', '0'));
    const number = po.po_number || issueNumber(companyId, 'PO', 'PO-');
    const auto = threshold > 0 && est <= threshold;
    db.prepare(`UPDATE purchase_orders SET po_number = ?, estimated_base_minor = ?, status = ?, ${auto ? "approved_by = ?, approved_at = datetime('now')," : ''} updated_at = datetime('now') WHERE id = ?`)
      .run(...[number, est, auto ? 'approved' : 'pending_approval', ...(auto ? [actor?.id ?? null] : []), po.id]);
    for (const l of db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ?').all(po.id)) {
      recordPrice(companyId, { supplierId: po.supplier_id, productId: l.product_id, description: l.description, date: po.order_date, currencyCode: po.currency_code, unitMinor: l.unit_price_minor, unitBaseMinor: toBase(companyId, po.currency_code, l.unit_price_minor, rate), sourceType: 'purchase_order', sourceId: po.id });
    }
    if (po.request_id) db.prepare("UPDATE purchase_requests SET status = 'ordered', updated_at = datetime('now') WHERE id = ? AND status = 'approved'").run(po.request_id);
    if (po.quotation_id) {
      db.prepare("UPDATE supplier_quotations SET status = 'selected' WHERE id = ?").run(po.quotation_id);
      const q = db.prepare('SELECT request_id FROM supplier_quotations WHERE id = ?').get(po.quotation_id);
      if (q?.request_id) db.prepare("UPDATE supplier_quotations SET status = 'rejected' WHERE request_id = ? AND id <> ? AND status = 'received'").run(q.request_id, po.quotation_id);
    }
    const after = getPurchaseOrder(companyId, po.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'purchasing.po.submit', entityType: 'purchase_order', entityId: po.id, before: { status: 'draft' }, after: { status: after.status, estimated_base_minor: est, threshold_minor: threshold, auto_approved: auto } });
    return after;
  });
}

function approvePurchaseOrder(companyId, id, { decision = 'approve', reason, breakGlassReason } = {}, actor) {
  return ledger.transaction(() => {
    const po = owned(companyId, 'purchase_order', id);
    if (po.status !== 'pending_approval') fail('invalid_transition', 'أمر الشراء ليس بانتظار الاعتماد', 409);
    if (po.approver_user_id && po.approver_user_id !== actor?.id) {
      const name = db.prepare('SELECT name FROM users WHERE id = ?').get(po.approver_user_id)?.name;
      fail('not_the_approver', `هذا الأمر مخصص لاعتماد ${name || 'مستخدم آخر'}`, 403);
    }
    if (decision !== 'reject' && actor?.id && po.created_by === actor.id) {
      sodGuard(companyId, 'po', actor, breakGlassReason, { code: 'sod_po_creator', message: 'فصل المهام: لا يمكنك اعتماد أمر شراء أنشأته بنفسك. يجب أن يعتمده مستخدم آخر.', entityType: 'purchase_order', entityId: po.id });
    }
    if (decision === 'reject') {
      if (!String(reason || '').trim()) fail('reason_required', 'سبب الرفض مطلوب');
      db.prepare("UPDATE purchase_orders SET status = 'draft', notes = COALESCE(notes || char(10), '') || ?, updated_at = datetime('now') WHERE id = ?").run(`رُفض: ${reason}`, po.id);
    } else {
      db.prepare("UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(actor?.id ?? null, po.id);
    }
    const after = getPurchaseOrder(companyId, po.id);
    logAudit({ companyId, actor: actorOf(actor), action: `purchasing.po.${decision === 'reject' ? 'reject' : 'approve'}`, entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status: after.status, reason: reason || null } });
    return after;
  });
}

function cancelPurchaseOrder(companyId, id, { reason } = {}, actor) {
  return ledger.transaction(() => {
    const po = owned(companyId, 'purchase_order', id);
    if (['received', 'closed', 'cancelled'].includes(po.status)) fail('invalid_transition', 'لا يمكن إلغاء أمر الشراء', 409);
    if (db.prepare('SELECT 1 FROM goods_receipts WHERE po_id = ?').get(po.id)) fail('po_has_receipts', 'استُلمت بضاعة على هذا الأمر — أغلقه بدل إلغائه', 409);
    db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(po.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'purchasing.po.cancel', entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status: 'cancelled', reason: reason || null } });
    return getPurchaseOrder(companyId, po.id);
  });
}

function refreshPoStatus(poId) {
  const lines = db.prepare('SELECT qty, received_qty, invoiced_qty FROM purchase_order_lines WHERE po_id = ?').all(poId);
  const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(poId);
  if (!['approved', 'partially_received', 'received'].includes(po.status)) return;
  const fullyReceived = lines.every((l) => l.received_qty >= l.qty - 1e-9);
  const anyReceived = lines.some((l) => l.received_qty > 1e-9);
  const fullyInvoiced = lines.every((l) => l.invoiced_qty >= l.received_qty - 1e-9);
  const status = fullyReceived ? (fullyInvoiced ? 'closed' : 'received') : anyReceived ? 'partially_received' : 'approved';
  db.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, poId);
}

// ---------------------------------------------------------------------
// Stock + item cost (until Prompt 8's stock ledger)
// ---------------------------------------------------------------------

// Moving weighted average on products.cost_price (major units of base):
// newCost = (onHand x cost + addedBase) / (onHand + addedQty).
function addToStockAndCost(companyId, productId, qty, valueBaseMinor) {
  if (!productId) return null;
  const d = base(companyId).minor_unit_digits;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  let inv = db.prepare('SELECT * FROM factory_inventory WHERE company_id = ? AND product_id = ? ORDER BY id LIMIT 1').get(companyId, productId);
  const onHand = Math.max(0, inv?.current_quantity || 0);
  const oldCost = product.cost_price ?? 0;
  const totalMinor = Math.round(onHand * oldCost * 10 ** d) + valueBaseMinor;
  const newQty = onHand + qty;
  const newCost = newQty > 0 ? roundToMinor(totalMinor / newQty, 0) / 10 ** d : oldCost;
  db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(newCost, productId);
  if (qty) {
    if (!inv) {
      let name = product.name;
      if (db.prepare('SELECT 1 FROM factory_inventory WHERE company_id = ? AND item_name = ?').get(companyId, name)) name = `${name} #${product.id}`;
      db.prepare('INSERT INTO factory_inventory (company_id, item_name, product_id, current_quantity) VALUES (?, ?, ?, ?)').run(companyId, name, productId, qty);
    } else {
      db.prepare("UPDATE factory_inventory SET current_quantity = current_quantity + ?, updated_at = datetime('now') WHERE id = ?").run(qty, inv.id);
    }
  }
  return { before: product.cost_price, after: newCost, on_hand_before: onHand };
}

// Landed cost on goods already in stock: spreads over what is on hand
// (or the received qty when nothing is on hand any more).
function addCostOnly(companyId, productId, valueBaseMinor, fallbackQty) {
  if (!productId) return null;
  const d = base(companyId).minor_unit_digits;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const inv = db.prepare('SELECT * FROM factory_inventory WHERE company_id = ? AND product_id = ? ORDER BY id LIMIT 1').get(companyId, productId);
  const onHand = Math.max(0, inv?.current_quantity || 0);
  const qty = onHand > 0 ? onHand : fallbackQty;
  const oldCost = product.cost_price ?? 0;
  const newCost = qty > 0 ? roundToMinor((Math.round(qty * oldCost * 10 ** d) + valueBaseMinor) / qty, 0) / 10 ** d : oldCost;
  db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(newCost, productId);
  return { before: product.cost_price, after: newCost, spread_qty: qty };
}

function removeFromStock(companyId, productId, qty) {
  if (!productId || !qty) return;
  const inv = db.prepare('SELECT * FROM factory_inventory WHERE company_id = ? AND product_id = ? ORDER BY id LIMIT 1').get(companyId, productId);
  if (inv) db.prepare("UPDATE factory_inventory SET current_quantity = current_quantity - ?, updated_at = datetime('now') WHERE id = ?").run(qty, inv.id);
}

// ---------------------------------------------------------------------
// Goods receipt: Dr inventory / Cr GRNI at the receipt-date rate
// ---------------------------------------------------------------------

function getReceipt(companyId, id) {
  const r = owned(companyId, 'goods_receipt', id);
  return {
    ...r,
    supplier: db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(r.supplier_id),
    purchase_order: db.prepare('SELECT id, po_number FROM purchase_orders WHERE id = ?').get(r.po_id),
    lines: db.prepare('SELECT l.*, p.name AS product_name FROM goods_receipt_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.receipt_id = ? ORDER BY l.line_no').all(r.id),
    journal_entry: r.journal_entry_id ? db.prepare('SELECT id, entry_number FROM journal_entries WHERE id = ?').get(r.journal_entry_id) : null,
    exchange_rate: fx.formatRate(r.rate_e8),
  };
}

function listReceipts(companyId, { poId, supplierId } = {}) {
  const where = ['r.company_id = ?'];
  const p = [companyId];
  if (poId) { where.push('r.po_id = ?'); p.push(owned(companyId, 'purchase_order', poId).id); }
  if (supplierId) { where.push('r.supplier_id = ?'); p.push(owned(companyId, 'supplier', supplierId).id); }
  return db.prepare(`SELECT r.*, s.name AS supplier_name, p.po_number FROM goods_receipts r JOIN suppliers s ON s.id = r.supplier_id JOIN purchase_orders p ON p.id = r.po_id WHERE ${where.join(' AND ')} ORDER BY r.receipt_date DESC, r.id DESC LIMIT 500`).all(...p);
}

// lines: [{ poLineId, qty, rejectedQty?, weightKg? }]
function receiveGoods(companyId, poId, input, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const po = owned(companyId, 'purchase_order', poId);
    if (!['approved', 'partially_received'].includes(po.status)) fail('po_not_receivable', 'أمر الشراء غير معتمد أو مستلم بالكامل', 409);
    const date = input.receiptDate || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const warehouse = input.warehouseId !== undefined ? optionalOwned(companyId, 'warehouse', input.warehouseId) : po.warehouse_id ? { id: po.warehouse_id } : null;
    const rate = docRate(companyId, po.currency_code, date, { exchangeRate: input.exchangeRate, rateQuote: input.rateQuote }, actor);
    const qtyTolBp = Number(getSetting(companyId, 'purchase_qty_tolerance_bp', '0'));
    const raw = Array.isArray(input.lines) && input.lines.length ? input.lines : null;
    if (!raw) fail('lines_required', 'حدد الكميات المستلمة');
    const lines = [];
    const seen = new Set();
    for (const [i, r] of raw.entries()) {
      const n = i + 1;
      const pl = db.prepare('SELECT * FROM purchase_order_lines WHERE id = ? AND company_id = ? AND po_id = ?').get(Number(r.poLineId), companyId, po.id);
      if (!pl) fail('invalid_po_line', `السطر ${n}: سطر أمر الشراء غير موجود`);
      if (seen.has(pl.id)) fail('duplicate_line', `السطر ${n}: مكرر`);
      seen.add(pl.id);
      const qty = parseQty(r.qty, n);
      const rejected = parseQty(r.rejectedQty || 0, n, { allowZero: true });
      if (rejected > qty) fail('invalid_qty', `السطر ${n}: المرفوض أكبر من المستلم`);
      const accepted = Math.round((qty - rejected) * 1000) / 1000;
      const max = pl.qty * (1 + qtyTolBp / 10000) - pl.received_qty;
      if (accepted > max + 1e-9) fail('over_receipt', `السطر ${n}: الكمية أكبر من المتبقي في أمر الشراء (${Math.max(0, pl.qty - pl.received_qty)})`, 409, { line: n });
      const weight = r.weightKg !== undefined && r.weightKg !== null && r.weightKg !== '' ? Number(r.weightKg) : null;
      if (weight !== null && (!Number.isFinite(weight) || weight < 0)) fail('invalid_weight', `السطر ${n}: الوزن غير صالح`);
      const valueDoc = roundHalfUp(pl.unit_price_minor * accepted);
      const lot = r.lotCode ? { lotCode: r.lotCode, expiryDate: r.expiryDate || null, productionDate: r.productionDate || null, supplierLot: r.supplierLot || null } : null;
      if (lot && ((lot.expiryDate && !isValidDate(lot.expiryDate)) || (lot.productionDate && !isValidDate(lot.productionDate)))) fail('invalid_date', `السطر ${n}: تاريخ الدفعة غير صالح`);
      lines.push({ n, pl, qty, rejected, accepted, weight, lot, value_base: accepted > 0 ? toBase(companyId, po.currency_code, valueDoc, rate) : 0 });
    }
    const total = lines.reduce((s, l) => s + l.value_base, 0);
    const number = issueNumber(companyId, 'GRN', 'GRN-');
    const rid = Number(
      db.prepare(
        `INSERT INTO goods_receipts (company_id, receipt_number, po_id, supplier_id, warehouse_id, receipt_date, supplier_delivery_ref, currency_code, rate_e8, rate_quote, total_base_minor, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(companyId, number, po.id, po.supplier_id, warehouse?.id ?? null, date, input.deliveryRef || null, po.currency_code, rate.rateE8, rate.quote, total, input.notes || null, actor?.id ?? null).lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO goods_receipt_lines (company_id, receipt_id, line_no, po_line_id, product_id, description, qty, rejected_qty, weight_kg, unit_price_minor, value_base_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const costChanges = [];
    // Prompt 8: with the stock ledger the receipt is a 'receipt' stock move
    // into the receipt's warehouse (standard cost: the difference goes to
    // purchase price variance); without it, as before.
    const stockOn = require('./stockLedger').isActive(companyId);
    const stockLines = [];
    for (const l of lines) {
      const lineId = Number(ins.run(companyId, rid, l.n, l.pl.id, l.pl.product_id, l.pl.description, l.qty, l.rejected, l.weight, l.pl.unit_price_minor, l.value_base).lastInsertRowid);
      db.prepare('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?').run(l.accepted, l.pl.id);
      if (stockOn) stockLines.push({ lineId, productId: l.pl.product_id, description: l.pl.description, qty: l.accepted, value: l.value_base, supplierId: po.supplier_id, lot: l.lot });
      else if (l.accepted > 0) costChanges.push({ product_id: l.pl.product_id, ...addToStockAndCost(companyId, l.pl.product_id, l.accepted, l.value_base) });
    }
    const sm = stockOn ? require('./stockDocs').receiptMoves(companyId, { receiptId: rid, date, warehouseId: warehouse?.id ?? null, lines: stockLines }, actor) : null;
    checkpoint('purchasing.receipt.after_stock');
    if (total > 0) {
      const entry = ledger.postEntry(
        companyId,
        {
          date,
          description: `استلام بضاعة ${number} — أمر الشراء ${po.po_number}`,
          sourceType: 'goods_receipt',
          sourceId: rid,
          lines: [
            ...(sm
              ? [
                  ...sm.inventoryLines.filter((x) => x.debitMinor).map((x) => ({ ...x, memo: `استلام ${number}` })),
                  ...(sm.variance ? [{ accountId: systemAccount(companyId, 'purchase_price_variance'), debitMinor: sm.variance > 0 ? sm.variance : 0, creditMinor: sm.variance < 0 ? -sm.variance : 0, memo: 'فرق التكلفة المعيارية' }] : []),
                ]
              : [{ accountId: systemAccount(companyId, 'inventory'), debitMinor: total, memo: `استلام ${number}` }]),
            { accountId: systemAccount(companyId, 'grni'), creditMinor: total, memo: `بضاعة مستلمة لم تصل فاتورتها — ${po.po_number}` },
          ],
        },
        actor
      );
      db.prepare('UPDATE goods_receipts SET journal_entry_id = ? WHERE id = ?').run(entry.id, rid);
      if (sm?.moveIds.length) db.prepare(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${sm.moveIds.map(() => '?').join(',')})`).run(entry.id, ...sm.moveIds);
    }
    checkpoint('purchasing.receipt.after_entry');
    refreshPoStatus(po.id);
    const after = getReceipt(companyId, rid);
    logAudit({ companyId, actor: actorOf(actor), action: 'purchasing.receipt.create', entityType: 'goods_receipt', entityId: rid, before: null, after: { ...after, cost_changes: costChanges } });
    return after;
  });
}

module.exports = {
  PurchasingError,
  fail,
  owned,
  optionalOwned,
  base,
  currencyOf,
  systemAccount,
  issueNumber,
  getSetting,
  setSetting,
  docRate,
  toBase,
  fromBase,
  rateOf,
  parseQty,
  parseTaxBp,
  priceLines,
  roundHalfUp,
  recordPrice,
  addToStockAndCost,
  addCostOnly,
  removeFromStock,
  refreshPoStatus,
  // suppliers
  listSuppliers,
  getSupplier,
  saveSupplier,
  priceHistory,
  supplierRatings,
  apBalances,
  // requests / quotations / orders / receipts
  listRequests,
  getRequest,
  saveRequest,
  requestAction,
  createQuotation,
  getQuotation,
  compareQuotations,
  listPurchaseOrders,
  getPurchaseOrder,
  savePurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  separationEnforced,
  separationApplies,
  sodGuard,
  isOwner,
  sodStatus,
  cancelPurchaseOrder,
  listReceipts,
  getReceipt,
  receiveGoods,
};
