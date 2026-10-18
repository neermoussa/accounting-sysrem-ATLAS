// backend/lib/openItems.js
//
// Go-live open-items import. Excel columns (Arabic or English headers):
//   customer (shop id, exact name or phone) | invoice number | invoice date |
//   due date | amount (base currency)
// Every row is validated; per customer the items are compared with the
// latest balance snapshot and the difference is shown. Nothing is staged
// while any row has an error. A staged import is consumed by the go-live
// dry run / execution (lib/customerLedger.js): one opening entry per open
// item (aged by its due date) plus one legacy line for the residual.

const db = require('../db/init');
const { readSheetRows } = require('./excelParse');
const { logAudit } = require('./auditLog');
const { toMinor, fromMinor, roundToMinor } = require('./ledgerCurrencies');

class OpenItemsError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const HEADERS = {
  customer: ['customer', 'shop', 'الزبون', 'اسم الزبون', 'رقم الزبون', 'العميل'],
  invoice_number: ['invoice number', 'invoice_number', 'invoice', 'رقم الفاتورة'],
  invoice_date: ['invoice date', 'invoice_date', 'date', 'تاريخ الفاتورة'],
  due_date: ['due date', 'due_date', 'تاريخ الاستحقاق'],
  amount: ['amount', 'open amount', 'المبلغ', 'المبلغ المتبقي', 'الرصيد'],
};

function digitsOf(companyId) {
  const c = db.prepare('SELECT currency FROM companies WHERE id = ?').get(companyId);
  return db.prepare('SELECT minor_unit_digits d FROM currencies WHERE company_id = ? AND code = ?').get(companyId, c?.currency)?.d ?? 2;
}

function cellDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // dd/mm/yyyy (Syrian usage)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function validDate(s) {
  return !!s && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

function matchShop(companyId, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { error: 'الزبون مطلوب' };
  if (/^\d+$/.test(v)) {
    const byId = db.prepare('SELECT id, name FROM shops WHERE company_id = ? AND id = ?').get(companyId, Number(v));
    if (byId) return { shop: byId };
  }
  const byName = db.prepare('SELECT id, name FROM shops WHERE company_id = ? AND TRIM(name) = ?').all(companyId, v);
  if (byName.length === 1) return { shop: byName[0] };
  if (byName.length > 1) return { error: `اسم الزبون "${v}" مكرر — استخدم رقم الزبون` };
  const byPhone = db.prepare('SELECT id, name FROM shops WHERE company_id = ? AND phone = ?').all(companyId, v);
  if (byPhone.length === 1) return { shop: byPhone[0] };
  return { error: `الزبون "${v}" غير موجود` };
}

// Per-customer comparison with the latest balance snapshot minus what the
// ledger already holds; residual = legacy/undated line.
function customerSummary(companyId, itemsByShop) {
  const digits = digitsOf(companyId);
  const { shopBalanceMinor } = require('./customerLedger');
  const out = [];
  for (const [shopId, items] of itemsByShop) {
    const shop = db.prepare('SELECT id, name FROM shops WHERE id = ?').get(shopId);
    const snap = db.prepare('SELECT report_date, balance FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shopId);
    const snapshotMinor = snap ? roundToMinor(snap.balance, digits) : 0;
    const existing = shopBalanceMinor(companyId, shopId);
    const itemsMinor = items.reduce((s, i) => s + i.amount_minor, 0);
    const legacy = snapshotMinor - existing - itemsMinor;
    out.push({
      shop_id: shopId,
      shop_name: shop?.name,
      items: items.length,
      items_minor: itemsMinor,
      snapshot_minor: snapshotMinor,
      snapshot_date: snap?.report_date ?? null,
      existing_ledger_minor: existing,
      legacy_minor: legacy,
      difference: fromMinor(legacy, digits),
      warning: legacy < 0 ? 'items_exceed_snapshot' : null,
    });
  }
  return out;
}

async function importOpenItems(companyId, filePath, filename, actor) {
  const { header, dataRows } = await readSheetRows(filePath);
  const norm = header.map((h) => String(h || '').trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADERS)) col[key] = norm.findIndex((h) => aliases.includes(h));
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) {
    throw new OpenItemsError('invalid_headers', 'الأعمدة المطلوبة: الزبون، رقم الفاتورة، تاريخ الفاتورة، تاريخ الاستحقاق، المبلغ', 400, { missing });
  }
  const digits = digitsOf(companyId);
  const rows = [];
  const seen = new Set();
  dataRows.forEach((r, i) => {
    const row = { row: i + 2, errors: [] };
    const m = matchShop(companyId, r[col.customer]);
    if (m.error) row.errors.push(m.error);
    else {
      row.shop_id = m.shop.id;
      row.shop_name = m.shop.name;
    }
    row.invoice_number = String(r[col.invoice_number] ?? '').trim();
    if (!row.invoice_number) row.errors.push('رقم الفاتورة مطلوب');
    row.invoice_date = cellDate(r[col.invoice_date]);
    row.due_date = cellDate(r[col.due_date]);
    if (!validDate(row.invoice_date)) row.errors.push('تاريخ الفاتورة غير صالح');
    if (!validDate(row.due_date)) row.errors.push('تاريخ الاستحقاق غير صالح');
    if (row.invoice_date && row.due_date && row.due_date < row.invoice_date) row.errors.push('تاريخ الاستحقاق قبل تاريخ الفاتورة');
    try {
      const raw = r[col.amount];
      row.amount_minor = typeof raw === 'number' ? roundToMinor(raw, digits) : toMinor(String(raw ?? '').trim(), digits);
      if (!(row.amount_minor > 0)) row.errors.push('المبلغ يجب أن يكون أكبر من صفر');
    } catch (err) {
      row.errors.push(err.message);
    }
    const key = `${row.shop_id}|${row.invoice_number}`;
    if (row.shop_id && row.invoice_number && seen.has(key)) row.errors.push('رقم الفاتورة مكرر لنفس الزبون');
    seen.add(key);
    rows.push(row);
  });
  const errorCount = rows.filter((r) => r.errors.length).length;
  const byShop = new Map();
  for (const r of rows.filter((x) => !x.errors.length)) {
    if (!byShop.has(r.shop_id)) byShop.set(r.shop_id, []);
    byShop.get(r.shop_id).push(r);
  }
  const summary = customerSummary(companyId, byShop);
  const result = { rows, error_count: errorCount, customers: summary, import_id: null, digits };
  if (errorCount || !rows.length) return result;

  const tx = db.transaction(() => {
    db.prepare("UPDATE open_item_imports SET status = 'discarded' WHERE company_id = ? AND status = 'staged'").run(companyId);
    const total = rows.reduce((s, r) => s + r.amount_minor, 0);
    const id = Number(
      db.prepare('INSERT INTO open_item_imports (company_id, filename, row_count, total_minor, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(companyId, filename || null, rows.length, total, actor?.id ?? null).lastInsertRowid
    );
    const ins = db.prepare(
      'INSERT INTO open_items (company_id, import_id, row_no, shop_id, invoice_number, invoice_date, due_date, amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of rows) ins.run(companyId, id, r.row, r.shop_id, r.invoice_number, r.invoice_date, r.due_date, r.amount_minor);
    logAudit({ companyId, actor, action: 'ledger.go_live.open_items_import', entityType: 'open_item_import', entityId: id, before: null, after: { rows: rows.length, total_minor: total, customers: summary.length } });
    return id;
  });
  result.import_id = tx();
  return result;
}

function stagedImport(companyId) {
  return db.prepare("SELECT * FROM open_item_imports WHERE company_id = ? AND status = 'staged' ORDER BY id DESC LIMIT 1").get(companyId) || null;
}

function itemsByShop(companyId, importId) {
  const map = new Map();
  if (!importId) return map;
  for (const it of db.prepare('SELECT * FROM open_items WHERE company_id = ? AND import_id = ? ORDER BY shop_id, due_date, id').all(companyId, importId)) {
    if (!map.has(it.shop_id)) map.set(it.shop_id, []);
    map.get(it.shop_id).push(it);
  }
  return map;
}

function stagedSummary(companyId) {
  const imp = stagedImport(companyId);
  if (!imp) return { import: null, customers: [] };
  return { import: imp, customers: customerSummary(companyId, itemsByShop(companyId, imp.id)) };
}

function discardImport(companyId, actor) {
  const imp = stagedImport(companyId);
  if (!imp) return { ok: true };
  db.prepare("UPDATE open_item_imports SET status = 'discarded' WHERE id = ?").run(imp.id);
  logAudit({ companyId, actor, action: 'ledger.go_live.open_items_discard', entityType: 'open_item_import', entityId: imp.id, before: { status: 'staged' }, after: { status: 'discarded' } });
  return { ok: true };
}

module.exports = { OpenItemsError, importOpenItems, stagedImport, stagedSummary, itemsByShop, discardImport };
