const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const db = require('../db/init');
const { getGlobalSettings, enrichShop, getAllEnrichedShops, filterByClassification } = require('../lib/shopData');
const { recomputeShopClassification, recomputeAllClassifications } = require('../lib/classification');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const { STATUS_LABEL } = require('../lib/stats');
const { normalizePhone } = require('../lib/phone');
const { findShopByPhone } = require('../lib/shopLookup');
const { isValidCoordPair } = require('../lib/geo');
const { logAudit } = require('../lib/auditLog');
const { computeShopStats } = require('../lib/shopStats');
const { computeDiscontinuedItems } = require('../lib/discontinuedItems');
const { sendTablePdf } = require('../lib/pdfExport');
const { sendToCustomer } = require('../lib/whatsapp');
const shopPhones = require('../lib/shopPhones');
const { findDuplicateGroups } = require('../lib/shopDedup');
const { suggestRep } = require('../lib/repAssignment');
const { priceLine } = require('../lib/pricingEngine');
const { checkCreditLimit, repManualAutoApprove, notifyOrderPendingApproval, getSetting } = require('../lib/orderLifecycle');
const { checkStockAndRoute } = require('../lib/stockCheck');

const router = express.Router();

const SHOP_MEDIA_DIR = path.join(__dirname, '..', 'uploads', 'shop-media');
if (!fs.existsSync(SHOP_MEDIA_DIR)) fs.mkdirSync(SHOP_MEDIA_DIR, { recursive: true });

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, SHOP_MEDIA_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error('الملف يجب أن يكون صورة (PNG/JPG/WEBP) أو مستند PDF'), ok);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Edits are only allowed within this window of the order's original entry —
// a same-day typo fix, not a way to rewrite sales history later.
const ORDER_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// SQLite's datetime('now') stores "YYYY-MM-DD HH:MM:SS" in UTC but without a
// timezone marker, which JS would otherwise parse as local time — normalize
// to a proper UTC ISO string first so this doesn't drift with server TZ.
function parseUtc(sqliteDatetime) {
  return new Date(sqliteDatetime.replace(' ', 'T') + 'Z');
}

function editableUntil(order) {
  return new Date(parseUtc(order.created_at).getTime() + ORDER_EDIT_WINDOW_MS).toISOString();
}

// import_manager also gets read access here — needed to link an unmatched
// phone number to an existing shop during Amin import review.
router.get('/', requireAnyPermission('view_app', 'import_amin'), (req, res) => {
  if (req.query.status === 'inactive') {
    const globalSettings = getGlobalSettings(req.companyId);
    const rows = db
      .prepare('SELECT * FROM shops WHERE company_id = ? AND active = 0 ORDER BY name COLLATE NOCASE')
      .all(req.companyId);
    return res.json(filterByClassification(rows.map((s) => enrichShop(s, globalSettings)), req.query.classification));
  }
  if (req.query.status === 'all') {
    return res.json(filterByClassification(getAllEnrichedShops(req.companyId, { includeInactive: true }), req.query.classification));
  }
  res.json(filterByClassification(getAllEnrichedShops(req.companyId), req.query.classification));
});

router.get('/export', requireAnyPermission('view_app', 'import_amin'), requirePermission('export_data'), async (req, res) => {
  const shops =
    req.query.status === 'all'
      ? getAllEnrichedShops(req.companyId, { includeInactive: true })
      : req.query.status === 'inactive'
        ? db
            .prepare('SELECT * FROM shops WHERE company_id = ? AND active = 0 ORDER BY name COLLATE NOCASE')
            .all(req.companyId)
            .map((s) => enrichShop(s, getGlobalSettings(req.companyId)))
        : getAllEnrichedShops(req.companyId);
  const filtered = filterByClassification(shops, req.query.classification);
  const customFields = db.prepare('SELECT * FROM company_custom_fields WHERE company_id = ? ORDER BY id').all(req.companyId);
  const rows = filtered.map((s) => {
    const custom = JSON.parse(s.custom_fields_json || '{}');
    const row = {
      name: s.name,
      phone: s.phone || '',
      owner_name: s.owner_name || '',
      address: s.address || '',
      region: s.region || '',
      branch: s.branch || '',
      balance: s.balance ?? '',
      status: STATUS_LABEL[s.status] || s.status,
      classification: s.classification || 'غير مصنّف',
      active: s.active ? 'نشط' : 'معطّل',
    };
    for (const f of customFields) row[f.key] = custom[f.key] ?? '';
    return row;
  });
  const lang = langFromQuery(req);
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId);
  const classificationLabel = { hot: 'ساخن', warm: 'دافئ', cold: 'بارد' }[req.query.classification];
  const statusLabel = { all: 'الكل (شامل غير النشط)', inactive: 'غير النشط فقط' }[req.query.status];
  const filterParts = [classificationLabel, statusLabel].filter(Boolean);
  const workbook = new ExcelJS.Workbook();
  addSheet(
    workbook,
    'محلات',
    [
      { header: 'الاسم', headerEn: 'Name', key: 'name', width: 26 },
      { header: 'الهاتف', headerEn: 'Phone', key: 'phone', width: 16 },
      { header: 'المالك', headerEn: 'Owner', key: 'owner_name', width: 20 },
      { header: 'العنوان', headerEn: 'Address', key: 'address', width: 30 },
      { header: 'المنطقة', headerEn: 'Region', key: 'region', width: 16 },
      { header: 'الفرع', headerEn: 'Branch', key: 'branch', width: 16 },
      { header: 'الرصيد', headerEn: 'Balance', key: 'balance', width: 14 },
      { header: 'الحالة', headerEn: 'Status', key: 'status', width: 16 },
      { header: 'التصنيف', headerEn: 'Classification', key: 'classification', width: 14 },
      { header: 'نشط', headerEn: 'Active', key: 'active', width: 10 },
      ...customFields.map((f) => ({ header: f.label, key: f.key, width: 20 })),
    ],
    rows,
    {
      title: lang === 'en' ? 'Shops export' : 'تصدير المحلات',
      lang,
      companyName: company?.name,
      filterLabel: filterParts.length ? filterParts.join(' / ') : undefined,
    }
  );
  await sendWorkbook(res, workbook, 'shops-export.xlsx');
});

const shopImportUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Bulk create/update from the same column layout as /export, including
// whatever custom fields the company has defined — matched to an existing
// shop by phone (when the row has one), otherwise always inserted as new.
router.post('/import', requirePermission('manage_shops'), shopImportUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(req.file.buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return res.status(400).json({ error: 'empty_file' });

  const customFields = db.prepare('SELECT * FROM company_custom_fields WHERE company_id = ?').all(req.companyId);
  const headerMap = { 'الاسم': 'name', 'الهاتف': 'phone', 'المالك': 'owner_name', 'العنوان': 'address', 'المنطقة': 'region', 'الفرع': 'branch' };
  for (const f of customFields) headerMap[f.label] = `__custom__${f.key}`;

  const headerRow = worksheet.getRow(1).values.slice(1).map((v) => String(v || '').trim());
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let r = 2; r <= worksheet.rowCount; r++) {
    const values = worksheet.getRow(r).values.slice(1);
    if (values.every((v) => v === null || v === undefined || v === '')) continue;
    const record = { custom: {} };
    headerRow.forEach((h, i) => {
      const key = headerMap[h];
      if (!key) return;
      const val = values[i] === undefined ? '' : String(values[i]).trim();
      if (key.startsWith('__custom__')) record.custom[key.replace('__custom__', '')] = val;
      else record[key] = val;
    });
    if (!record.name) {
      skipped++;
      continue;
    }
    const existing = record.phone ? findShopByPhone(req.companyId, normalizePhone(record.phone)) : null;
    if (existing) {
      const mergedCustom = { ...JSON.parse(existing.custom_fields_json || '{}'), ...record.custom };
      db.prepare(
        `UPDATE shops SET name = ?, owner_name = ?, address = ?, region = ?, branch = ?, custom_fields_json = ?, updated_at = datetime('now')
         WHERE id = ? AND company_id = ?`
      ).run(record.name, record.owner_name || existing.owner_name, record.address || existing.address, record.region || existing.region, record.branch || existing.branch, JSON.stringify(mergedCustom), existing.id, req.companyId);
      updated++;
    } else {
      const publicToken = crypto.randomBytes(16).toString('hex');
      const info = db
        .prepare(
          `INSERT INTO shops (company_id, name, phone, owner_name, address, region, branch, custom_fields_json, public_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.companyId, record.name, record.phone || null, record.owner_name || null, record.address || null, record.region || null, record.branch || null, JSON.stringify(record.custom), publicToken);
      if (record.phone) {
        db.prepare('INSERT OR IGNORE INTO shop_phones (company_id, shop_id, phone, is_primary) VALUES (?, ?, ?, 1)').run(req.companyId, info.lastInsertRowid, record.phone);
      }
      created++;
    }
  }

  res.json({ created, updated, skipped });
});

// Fixed-segment routes below must stay ahead of GET/:id — Express would
// otherwise match e.g. "/duplicates" as :id="duplicates" first.
router.get('/duplicates', requirePermission('manage_shops'), (req, res) => {
  res.json(findDuplicateGroups(req.companyId));
});

router.post('/merge', requirePermission('manage_shops'), (req, res) => {
  const { keepId, mergeId } = req.body || {};
  if (!keepId || !mergeId || keepId === mergeId) {
    return res.status(400).json({ error: 'keepId_and_mergeId_required' });
  }
  const keep = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(keepId, req.companyId);
  const merge = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(mergeId, req.companyId);
  if (!keep || !merge) return res.status(404).json({ error: 'shop_not_found' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET shop_id = ? WHERE shop_id = ? AND company_id = ?').run(keep.id, merge.id, req.companyId);
    db.prepare('UPDATE balances SET shop_id = ? WHERE shop_id = ?').run(keep.id, merge.id);
    db.prepare('UPDATE shop_notes SET shop_id = ? WHERE shop_id = ? AND company_id = ?').run(keep.id, merge.id, req.companyId);
    db.prepare('UPDATE shop_media SET shop_id = ? WHERE shop_id = ? AND company_id = ?').run(keep.id, merge.id, req.companyId);
    db.prepare('UPDATE shop_rep_transfers SET shop_id = ? WHERE shop_id = ? AND company_id = ?').run(keep.id, merge.id, req.companyId);
    db.prepare('UPDATE import_batch_rows SET matched_shop_id = ? WHERE matched_shop_id = ?').run(keep.id, merge.id);
    // Phones: keep merge's numbers too (never silently drop a verified
    // WhatsApp line), skipping any that would collide with a number the
    // surviving shop already owns.
    const mergePhones = db.prepare('SELECT * FROM shop_phones WHERE shop_id = ?').all(merge.id);
    for (const p of mergePhones) {
      const dupe = db.prepare('SELECT 1 FROM shop_phones WHERE shop_id = ? AND phone = ?').get(keep.id, p.phone);
      if (dupe) {
        db.prepare('DELETE FROM shop_phones WHERE id = ?').run(p.id);
      } else {
        db.prepare('UPDATE shop_phones SET shop_id = ?, is_primary = 0 WHERE id = ?').run(keep.id, p.id);
      }
    }
    if (!keep.phone && merge.phone) {
      db.prepare("UPDATE shops SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(merge.phone, keep.id);
    }
    db.prepare('INSERT INTO shop_merges (company_id, kept_shop_id, merged_shop_id, merged_shop_name, merged_shop_phone, merged_by_id, merged_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      req.companyId,
      keep.id,
      merge.id,
      merge.name,
      merge.phone,
      req.user.id,
      req.user.name
    );
    logAudit({
      companyId: req.companyId,
      actor: req.user,
      action: 'shop_merge',
      entityType: 'shop',
      entityId: keep.id,
      shopId: keep.id,
      before: { keep: { id: keep.id, name: keep.name }, merged: { id: merge.id, name: merge.name, phone: merge.phone } },
      after: null,
    });
    db.prepare('DELETE FROM shops WHERE id = ? AND company_id = ?').run(merge.id, req.companyId);
  });
  tx();

  const updatedKeep = db.prepare('SELECT * FROM shops WHERE id = ?').get(keep.id);
  recomputeShopClassification(keep.id, getGlobalSettings(req.companyId));
  res.json(enrichShop(updatedKeep, getGlobalSettings(req.companyId)));
});

router.get('/assignment-suggestion', requireAnyPermission('manage_shops', 'reassign_shops'), (req, res) => {
  const result = suggestRep(req.companyId, { region: req.query.region || null, excludeShopId: req.query.shopId ? Number(req.query.shopId) : null });
  if (!result) return res.status(404).json({ error: 'no_reps_available' });
  res.json(result);
});

router.get('/:id', requireAnyPermission('view_app', 'import_amin'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const globalSettings = getGlobalSettings(req.companyId);
  const enriched = enrichShop(shop, globalSettings);

  const balanceHistory = db
    .prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC LIMIT 30')
    .all(shop.id);

  const recentOrders = db
    .prepare('SELECT * FROM orders WHERE shop_id = ? AND deleted_at IS NULL ORDER BY order_date DESC, id DESC LIMIT 5')
    .all(shop.id)
    .map((o) => ({ ...o, items: JSON.parse(o.items_json || '[]'), editableUntil: editableUntil(o) }));

  const phones = db.prepare('SELECT * FROM shop_phones WHERE shop_id = ? ORDER BY is_primary DESC, id ASC').all(shop.id);
  const media = db.prepare('SELECT * FROM shop_media WHERE shop_id = ? ORDER BY id DESC').all(shop.id);

  res.json({
    ...enriched,
    custom_fields: JSON.parse(shop.custom_fields_json || '{}'),
    phones: phones.map((p) => ({ ...p, otp_code: undefined })),
    media,
    balanceHistory,
    recentOrders,
  });
});

router.get('/:id/discontinued-items', requireAnyPermission('view_app', 'import_amin'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  res.json(computeDiscontinuedItems(req.companyId, shop.id));
});

// Full account statement (every order + running total + current balance) as
// a printable PDF — same table-render pipeline as the Statistics exports.
router.get('/:id/statement', requireAnyPermission('view_app', 'import_amin'), requirePermission('export_data'), async (req, res, next) => {
  try {
    await sendShopStatement(req, res);
  } catch (err) {
    next(err);
  }
});

async function sendShopStatement(req, res) {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });

  const orders = db
    .prepare('SELECT order_date, items_json, total_value FROM orders WHERE shop_id = ? AND deleted_at IS NULL ORDER BY order_date ASC, id ASC')
    .all(shop.id);
  const latestBalance = db
    .prepare('SELECT balance, report_date FROM balances WHERE shop_id = ? ORDER BY report_date DESC LIMIT 1')
    .get(shop.id);

  const rows = orders.map((o) => {
    let items = [];
    try {
      items = JSON.parse(o.items_json || '[]');
    } catch {
      items = [];
    }
    const summary = items.map((i) => `${i.product_name} × ${i.qty}`).join('، ');
    return {
      date: o.order_date,
      items: summary,
      total: Math.round(o.total_value).toLocaleString('ar'),
    };
  });

  const totalOrdered = orders.reduce((sum, o) => sum + Number(o.total_value || 0), 0);

  await sendTablePdf(
    res,
    {
      title: `كشف حساب — ${shop.name}`,
      subtitle: shop.phone,
      meta: [
        `الرصيد الحالي: ${latestBalance ? Math.round(latestBalance.balance).toLocaleString('ar') : 0} $`,
        `إجمالي الطلبات: ${Math.round(totalOrdered).toLocaleString('ar')} $`,
        `عدد الطلبات: ${orders.length}`,
        `تاريخ التصدير: ${new Date().toISOString().slice(0, 10)}`,
      ],
      columns: [
        { key: 'date', header: 'التاريخ' },
        { key: 'items', header: 'الأصناف' },
        { key: 'total', header: 'الإجمالي' },
      ],
      rows,
    },
    `كشف-حساب-${shop.name}.pdf`
  );
}

router.get('/:id/stats', requireAnyPermission('view_app', 'import_amin'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  res.json(computeShopStats(req.companyId, shop.id));
});

router.post('/', requirePermission('manage_shops'), (req, res) => {
  const {
    name,
    phone,
    address,
    lat,
    lng,
    notes,
    owner_name,
    contact_person,
    email,
    working_hours,
    business_type,
    region,
    branch,
    warehouse_id,
    assigned_rep_id,
    custom_fields,
  } = req.body;
  // Phone is intentionally optional: a shop with no phone at all is a valid,
  // fully-usable customer whose orders/visits are entered manually.
  if (!name) return res.status(400).json({ error: 'name_required' });

  if ((lat !== null && lat !== undefined) || (lng !== null && lng !== undefined)) {
    if (!isValidCoordPair(Number(lat), Number(lng))) {
      return res.status(400).json({ error: 'invalid_coordinates' });
    }
  }

  // Same phone-matching logic as the Amin import (normalized digits, plus
  // known aliases) so a differently-formatted duplicate can't slip past the
  // raw UNIQUE constraint and create a second record for the same customer.
  if (phone) {
    const existing = findShopByPhone(req.companyId, normalizePhone(phone));
    if (existing) {
      return res.status(409).json({ error: 'phone_already_exists', shop: { id: existing.id, name: existing.name } });
    }
  }

  try {
    const publicToken = crypto.randomBytes(16).toString('hex');
    const stmt = db.prepare(
      `INSERT INTO shops (
         company_id, name, phone, address, lat, lng, notes,
         owner_name, contact_person, email, working_hours, business_type,
         region, branch, warehouse_id, assigned_rep_id, custom_fields_json, public_token
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      req.companyId,
      name,
      phone || null,
      address || null,
      lat ?? null,
      lng ?? null,
      notes || null,
      owner_name || null,
      contact_person || null,
      email || null,
      working_hours || null,
      business_type || null,
      region || null,
      branch || null,
      warehouse_id ?? null,
      assigned_rep_id ?? null,
      JSON.stringify(custom_fields && typeof custom_fields === 'object' ? custom_fields : {}),
      publicToken
    );
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(info.lastInsertRowid);
    if (phone) {
      db.prepare('INSERT INTO shop_phones (company_id, shop_id, phone, is_primary) VALUES (?, ?, ?, 1)').run(
        req.companyId,
        shop.id,
        phone
      );
    }
    res.status(201).json({ ...enrichShop(shop, getGlobalSettings(req.companyId)), custom_fields: JSON.parse(shop.custom_fields_json) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'phone_already_exists' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.put('/:id', requirePermission('manage_shops'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const {
    name,
    phone,
    address,
    lat,
    lng,
    notes,
    debt_threshold_override,
    order_overdue_days_override,
    whatsapp_customer_notify_enabled,
    owner_name,
    contact_person,
    email,
    working_hours,
    business_type,
    region,
    branch,
    warehouse_id,
    custom_fields,
  } = req.body;

  // Validate whatever will actually end up saved (new value, or the
  // existing one when a field is omitted from this update) — same
  // fallback the UPDATE statement below uses.
  const effectiveLat = lat ?? shop.lat;
  const effectiveLng = lng ?? shop.lng;
  if (effectiveLat !== null && effectiveLng !== null) {
    if (!isValidCoordPair(Number(effectiveLat), Number(effectiveLng))) {
      return res.status(400).json({ error: 'invalid_coordinates' });
    }
  }

  if (phone && normalizePhone(phone) !== normalizePhone(shop.phone)) {
    const existing = findShopByPhone(req.companyId, normalizePhone(phone));
    if (existing && existing.id !== shop.id) {
      return res.status(409).json({ error: 'phone_already_exists', shop: { id: existing.id, name: existing.name } });
    }
  }

  const editedFields = ['name', 'phone', 'address', 'notes', 'debt_threshold_override', 'order_overdue_days_override'];
  const before = Object.fromEntries(editedFields.map((k) => [k, shop[k]]));

  try {
    db.prepare(
      `UPDATE shops SET name = ?, phone = ?, address = ?, lat = ?, lng = ?, notes = ?,
       debt_threshold_override = ?, order_overdue_days_override = ?, whatsapp_customer_notify_enabled = ?,
       owner_name = ?, contact_person = ?, email = ?, working_hours = ?, business_type = ?,
       region = ?, branch = ?, warehouse_id = ?, custom_fields_json = ?, updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(
      name ?? shop.name,
      phone ?? shop.phone,
      address ?? shop.address,
      lat ?? shop.lat,
      lng ?? shop.lng,
      notes ?? shop.notes,
      debt_threshold_override ?? shop.debt_threshold_override,
      order_overdue_days_override ?? shop.order_overdue_days_override,
      whatsapp_customer_notify_enabled != null ? (whatsapp_customer_notify_enabled ? 1 : 0) : shop.whatsapp_customer_notify_enabled,
      owner_name ?? shop.owner_name,
      contact_person ?? shop.contact_person,
      email ?? shop.email,
      working_hours ?? shop.working_hours,
      business_type ?? shop.business_type,
      region ?? shop.region,
      branch ?? shop.branch,
      warehouse_id ?? shop.warehouse_id,
      custom_fields && typeof custom_fields === 'object' ? JSON.stringify(custom_fields) : shop.custom_fields_json,
      shop.id,
      req.companyId
    );
    const updated = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id);
    const after = Object.fromEntries(editedFields.map((k) => [k, updated[k]]));
    logAudit({ companyId: req.companyId, actor: req.user, action: 'shop_edit', entityType: 'shop', entityId: shop.id, shopId: shop.id, before, after });
    res.json({ ...enrichShop(updated, getGlobalSettings(req.companyId)), custom_fields: JSON.parse(updated.custom_fields_json || '{}') });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'phone_already_exists' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.delete('/:id', requirePermission('manage_shops'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const tx = db.transaction(() => {
    // import_batch_rows.matched_shop_id and audit_log.shop_id both have no
    // ON DELETE CASCADE on purpose (they're historical records, not owned by
    // the shop) — detach both first so deleting a shop that was ever part of
    // an Amin import or had an audited order edit/delete doesn't fail with a
    // foreign-key error. The new "shop_delete" entry itself is logged with
    // shopId: null for the same reason — the shop it's about is gone the
    // instant this transaction commits, so it can't hold a live FK to it
    // either; entity_id (unconstrained) plus the `before` snapshot are what
    // keep the record meaningful afterward.
    db.prepare('UPDATE import_batch_rows SET matched_shop_id = NULL WHERE matched_shop_id = ? AND company_id = ?').run(shop.id, req.companyId);
    db.prepare('UPDATE audit_log SET shop_id = NULL WHERE shop_id = ? AND company_id = ?').run(shop.id, req.companyId);
    logAudit({ companyId: req.companyId, actor: req.user, action: 'shop_delete', entityType: 'shop', entityId: shop.id, shopId: null, before: shop, after: null });
    db.prepare('DELETE FROM shops WHERE id = ? AND company_id = ?').run(shop.id, req.companyId);
  });
  tx();
  res.status(204).end();
});

router.post('/:id/deactivate', requirePermission('manage_shops'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  db.prepare(`UPDATE shops SET active = 0, updated_at = datetime('now') WHERE id = ? AND company_id = ?`).run(shop.id, req.companyId);
  const updated = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id);
  res.json(enrichShop(updated, getGlobalSettings(req.companyId)));
});

router.post('/:id/reactivate', requirePermission('manage_shops'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  db.prepare(`UPDATE shops SET active = 1, updated_at = datetime('now') WHERE id = ? AND company_id = ?`).run(shop.id, req.companyId);
  const updated = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id);
  res.json(enrichShop(updated, getGlobalSettings(req.companyId)));
});

// ---------------------------------------------------------------------
// Bulk actions (spec item 4) — a handful of the most common multi-select
// operations, applied atomically to every id in the list. Each row is
// still scoped to req.companyId individually, same isolation guarantee as
// every single-record endpoint in this file.
// ---------------------------------------------------------------------

router.post('/bulk-reassign-rep', requireAnyPermission('manage_shops', 'reassign_shops'), (req, res) => {
  const { shopIds, repId } = req.body || {};
  if (!Array.isArray(shopIds) || shopIds.length === 0) return res.status(400).json({ error: 'shop_ids_required' });
  const tx = db.transaction(() => {
    const stmt = db.prepare(`UPDATE shops SET assigned_rep_id = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`);
    let updated = 0;
    for (const id of shopIds) updated += stmt.run(repId || null, id, req.companyId).changes;
    return updated;
  });
  res.json({ updated: tx() });
});

router.post('/bulk-set-active', requirePermission('manage_shops'), (req, res) => {
  const { shopIds, active } = req.body || {};
  if (!Array.isArray(shopIds) || shopIds.length === 0) return res.status(400).json({ error: 'shop_ids_required' });
  const tx = db.transaction(() => {
    const stmt = db.prepare(`UPDATE shops SET active = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`);
    let updated = 0;
    for (const id of shopIds) updated += stmt.run(active ? 1 : 0, id, req.companyId).changes;
    return updated;
  });
  res.json({ updated: tx() });
});

router.post('/recompute-classifications', requirePermission('manage_shops'), (req, res) => {
  const result = recomputeAllClassifications(req.companyId, getGlobalSettings(req.companyId));
  res.json(result);
});

router.post('/:id/orders', requirePermission('add_orders'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const { order_date, items, total_value, credit_override_reason } = req.body;
  if (!order_date) {
    return res.status(400).json({ error: 'order_date_required' });
  }
  let itemsList = Array.isArray(items) ? items : [];
  const willUsePricingEngine = itemsList.length > 0 && itemsList.every((it) => it.product_id && it.unit_key);
  if (!willUsePricingEngine && total_value === undefined) {
    return res.status(400).json({ error: 'order_date_and_total_value_required' });
  }
  if (itemsList.some((it) => !(Number(it.qty) > 0))) {
    return res.status(400).json({ error: 'item_quantity_must_be_positive' });
  }

  // Only when EVERY item carries both product_id and unit_key does this run
  // the catalog/pricing engine — that pair is new to this flow, so any
  // order built the old way (product_name + qty only, as the existing
  // QuickOrderForm still sends) is completely untouched below and behaves
  // exactly as before.
  let finalTotalValue = total_value;
  const usesPricingEngine = willUsePricingEngine;
  if (usesPricingEngine) {
    const priced = itemsList.map((it) =>
      priceLine(req.companyId, {
        productId: it.product_id,
        unitKey: it.unit_key,
        qty: Number(it.qty),
        shopId: shop.id,
        region: shop.region,
        channel: it.channel || req.body.channel || null,
        currency: req.body.currency || null,
      })
    );
    const blockedLine = priced.find((l) => l.blocked);
    if (blockedLine) {
      return res.status(403).json({ error: 'pricing_blocked', detail: blockedLine });
    }
    const paidItems = priced.map((l, i) => ({
      product_id: l.productId,
      product_name: itemsList[i].product_name,
      qty: l.qty,
      unit_key: l.unitKey,
      unit_price: l.discountedUnitPrice,
      line_total: l.lineTotal,
      promotion_id: l.appliedPromotionId,
      is_free: false,
    }));
    const freeItems = priced.flatMap((l) =>
      l.freeLines.map((f) => ({
        product_id: f.productId,
        product_name: db.prepare('SELECT name FROM products WHERE id = ?').get(f.productId)?.name || '',
        qty: f.qty,
        unit_key: f.unitKey,
        unit_price: 0,
        line_total: 0,
        promotion_id: f.promotionId,
        is_free: true,
        free_reason: f.free_reason,
      }))
    );
    itemsList = [...paidItems, ...freeItems];
    finalTotalValue = priced.reduce((sum, l) => sum + l.lineTotal, 0);
    if (!(finalTotalValue > 0)) {
      // An order that's entirely free goods (e.g. a pure sample drop) is
      // legitimate — allow zero, but never negative.
      finalTotalValue = Math.max(0, finalTotalValue);
    }
    // AI advisory layer: flag any line whose discount off the product's own
    // base_price exceeds the company's configured threshold. Deliberately
    // computed here, after pricing but before the order is even inserted,
    // then run again just below once the order id exists — see the
    // flagDiscountAnomaly call after INSERT INTO orders.
  } else if (!(Number(total_value) > 0)) {
    return res.status(400).json({ error: 'total_value_must_be_positive' });
  }

  // Overdue-color policy (collections item 6): independent of the
  // credit-limit projection below — this looks at the shop's CURRENT
  // red/yellow/green status (debt threshold OR payment-overdue, whichever
  // is enabled) rather than what this specific order would push the
  // balance to. 'allow' (default) does nothing extra here.
  const overduePolicy = getSetting(req.companyId, 'overdue_new_order_policy', 'allow');
  let forcesApprovalFromOverdueStatus = false;
  if (overduePolicy !== 'allow') {
    const currentStatus = enrichShop(shop, getGlobalSettings(req.companyId));
    if (currentStatus.status === 'red') {
      if (overduePolicy === 'blocked') {
        return res.status(403).json({ error: 'shop_overdue_blocked', status: currentStatus.status });
      }
      if (overduePolicy === 'requires_approval') forcesApprovalFromOverdueStatus = true;
    }
  }

  // Credit limit (item 9): projects the shop's balance forward by this
  // order's total. 'blocked' rejects outright; 'requires_approval' forces
  // pending_approval regardless of the auto-approve setting below;
  // 'rep_decides' (default) allows it through but only with a mandatory,
  // non-empty override reason recorded against the order.
  const creditCheck = checkCreditLimit(req.companyId, shop, finalTotalValue);
  // Prompt 3: a hard block can be overridden by someone holding
  // override_credit_limit who gives a reason (recorded on the order).
  const creditOverridden = creditCheck.exceeded && creditCheck.mode === 'blocked'
    && req.user.permissions.includes('override_credit_limit') && !!credit_override_reason?.trim();
  if (creditCheck.exceeded && creditCheck.mode === 'blocked' && !creditOverridden) {
    return res.status(403).json({ error: 'credit_limit_blocked', limit: creditCheck.limit, projectedBalance: creditCheck.projectedBalance, canOverride: req.user.permissions.includes('override_credit_limit') });
  }
  if (creditCheck.exceeded && creditCheck.mode === 'rep_decides' && !credit_override_reason?.trim()) {
    return res.status(400).json({
      error: 'credit_override_reason_required',
      limit: creditCheck.limit,
      projectedBalance: creditCheck.projectedBalance,
    });
  }

  // Source + initial status: a manual entry from a rep only skips the
  // approval queue when the company has explicitly turned that on
  // (rep_manual_order_auto_approve) — otherwise (and for a credit-limit
  // breach set to 'requires_approval') it starts life as pending_approval
  // and only becomes an official, stock-checked order once someone holding
  // approve_orders approves it. The office/direct-entry path (no source
  // sent by the caller) keeps today's behavior: approved immediately.
  const source = req.body.source === 'rep_manual' ? 'rep_manual' : 'direct';
  const needsApproval =
    forcesApprovalFromOverdueStatus ||
    (creditCheck.exceeded && creditCheck.mode === 'requires_approval') ||
    (source === 'rep_manual' && !repManualAutoApprove(req.companyId));
  const initialStatus = needsApproval ? 'pending_approval' : 'approved';

  const info = db
    .prepare(
      `INSERT INTO orders (company_id, shop_id, rep_id, order_date, items_json, total_value, status, source, credit_limit_exceeded, credit_override_reason, approved_by_id, approved_by_name, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.companyId,
      shop.id,
      req.user.id,
      order_date,
      JSON.stringify(itemsList),
      finalTotalValue,
      initialStatus,
      source,
      creditCheck.exceeded ? 1 : 0,
      creditCheck.exceeded ? credit_override_reason?.trim() || null : null,
      initialStatus === 'approved' ? req.user.id : null,
      initialStatus === 'approved' ? req.user.name : null,
      initialStatus === 'approved' ? new Date().toISOString() : null
    );
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);

  if (usesPricingEngine) {
    const { flagDiscountAnomaly } = require('../lib/aiRecommendations');
    for (const it of itemsList) {
      if (it.is_free || !it.product_id) continue;
      const product = db.prepare('SELECT base_price FROM products WHERE id = ?').get(it.product_id);
      if (!product?.base_price || product.base_price <= 0) continue;
      const discountPercent = ((product.base_price - it.unit_price) / product.base_price) * 100;
      if (discountPercent > 0) {
        try {
          flagDiscountAnomaly(req.companyId, { shop, order, item: it, discountPercent });
        } catch (err) {
          console.error('[shops] AI discount anomaly flagging failed:', err.message);
        }
      }
    }
  }

  if (initialStatus === 'pending_approval') {
    notifyOrderPendingApproval(req.companyId, order, shop);
    return res.status(201).json({ ...order, items: JSON.parse(order.items_json) });
  }

  if (usesPricingEngine) {
    const freeInsert = db.prepare(
      `INSERT INTO free_goods_log (company_id, shop_id, product_id, product_name, qty, unit_key, reason, promotion_id, order_id, created_by_id, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const it of itemsList) {
      if (it.is_free) {
        freeInsert.run(req.companyId, shop.id, it.product_id, it.product_name, it.qty, it.unit_key, it.free_reason || 'promo', it.promotion_id || null, order.id, req.user.id, req.user.name);
      }
    }
  }
  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));

  // Automatic customer confirmation — order details + current balance.
  // sendToCustomer no-ops quietly unless both the global switch and this
  // shop's own toggle are on and WhatsApp is connected, so this is safe to
  // fire unconditionally on every confirmed order.
  const latestBalance = db
    .prepare('SELECT balance FROM balances WHERE shop_id = ? ORDER BY report_date DESC LIMIT 1')
    .get(shop.id);
  const itemsSummary = itemsList.map((it) => `${it.product_name} × ${it.qty}`).join('، ');
  const customerMessage =
    `مرحبًا ${shop.name}،\n` +
    `تم تسجيل طلبكم بتاريخ ${order_date}.\n` +
    `الأصناف: ${itemsSummary || '—'}\n` +
    `إجمالي الطلب: ${Math.round(finalTotalValue).toLocaleString('ar')} $\n` +
    `الرصيد الحالي: ${latestBalance ? Math.round(latestBalance.balance).toLocaleString('ar') : 0} $`;
  sendToCustomer(req.companyId, shop, customerMessage).catch((err) => console.error('[whatsapp] customer send failed:', err.message));

  // Stock check (item 1 of the spec): car first, then the factory
  // warehouse, per line — only ever fires once an order is actually
  // approved, matching every other approved-order side effect above.
  checkStockAndRoute(req.companyId, order, shop);

  res.status(201).json({ ...order, items: JSON.parse(order.items_json) });
});

router.put('/:id/orders/:orderId', requirePermission('add_orders'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND shop_id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(req.params.orderId, shop.id, req.companyId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  if (Date.now() > parseUtc(order.created_at).getTime() + ORDER_EDIT_WINDOW_MS) {
    return res.status(403).json({ error: 'edit_window_expired' });
  }

  const { order_date, items, total_value } = req.body;
  if (!order_date || total_value === undefined) {
    return res.status(400).json({ error: 'order_date_and_total_value_required' });
  }
  if (!(Number(total_value) > 0)) {
    return res.status(400).json({ error: 'total_value_must_be_positive' });
  }
  const itemsList = Array.isArray(items) ? items : [];
  if (itemsList.some((it) => !(Number(it.qty) > 0))) {
    return res.status(400).json({ error: 'item_quantity_must_be_positive' });
  }

  const before = { ...order, items: JSON.parse(order.items_json) };

  db.prepare(
    `UPDATE orders SET order_date = ?, items_json = ?, total_value = ?, edited_at = datetime('now') WHERE id = ? AND company_id = ?`
  ).run(order_date, JSON.stringify(itemsList), total_value, order.id, req.companyId);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const after = { ...updated, items: JSON.parse(updated.items_json) };

  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: 'order_edit',
    entityType: 'order',
    entityId: order.id,
    shopId: shop.id,
    before,
    after,
  });

  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
  res.json({ ...after, editableUntil: editableUntil(updated) });
});

// Soft delete only, and gated by its own delete_orders permission regardless
// of who has add_orders — an order edit is a same-day self-correction, but
// removing one outright is closer to erasing sales history, so it gets a
// stricter, separately-grantable gate.
router.delete('/:id/orders/:orderId', requirePermission('add_orders'), requirePermission('delete_orders'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND shop_id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(req.params.orderId, shop.id, req.companyId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  const before = { ...order, items: JSON.parse(order.items_json) };
  db.prepare(`UPDATE orders SET deleted_at = datetime('now') WHERE id = ? AND company_id = ?`).run(order.id, req.companyId);

  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: 'order_delete',
    entityType: 'order',
    entityId: order.id,
    shopId: shop.id,
    before,
    after: null,
  });

  recomputeShopClassification(shop.id, getGlobalSettings(req.companyId));
  res.status(204).end();
});

// Product/service notes: any view_app holder (admin, rep) can read/add.
// Customer notes: same reach, but additionally gated by view_customer_notes —
// checked here explicitly (not just left to view_app) so the restriction stays
// correct even if a future role gets view_app without earning this one.
// Reminder notes: same reach as product notes (no extra gate) — any user who
// can see the shop at all can leave/read/resolve one.
function resolveNoteType(raw) {
  if (raw === 'customer') return 'customer';
  if (raw === 'reminder') return 'reminder';
  return 'product';
}

router.get('/:id/notes', requirePermission('view_app'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const type = resolveNoteType(req.query.type);
  if (type === 'customer' && !req.user.permissions.includes('view_customer_notes')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const notes = db
    .prepare('SELECT * FROM shop_notes WHERE shop_id = ? AND type = ? ORDER BY created_at DESC, id DESC')
    .all(shop.id, type);
  res.json(notes);
});

router.post('/:id/notes', requirePermission('view_app'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const type = resolveNoteType(req.body.type);
  if (type === 'customer' && !req.user.permissions.includes('view_customer_notes')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body_required' });
  const info = db
    .prepare('INSERT INTO shop_notes (company_id, shop_id, type, body, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, shop.id, type, body, req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM shop_notes WHERE id = ?').get(info.lastInsertRowid));
});

// Toggles a reminder note between "open" and "handled" — kept generic (any
// note type could technically call it) since only the reminder UI exposes
// the control, and there's no harm in the capability existing underneath.
router.post('/:id/notes/:noteId/resolve', requirePermission('view_app'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const note = db.prepare('SELECT * FROM shop_notes WHERE id = ? AND shop_id = ?').get(req.params.noteId, shop.id);
  if (!note) return res.status(404).json({ error: 'note_not_found' });
  if (note.resolved_at) {
    db.prepare('UPDATE shop_notes SET resolved_at = NULL, resolved_by_id = NULL, resolved_by_name = NULL WHERE id = ?').run(note.id);
  } else {
    db.prepare("UPDATE shop_notes SET resolved_at = datetime('now'), resolved_by_id = ?, resolved_by_name = ? WHERE id = ?").run(
      req.user.id,
      req.user.name,
      note.id
    );
  }
  res.json(db.prepare('SELECT * FROM shop_notes WHERE id = ?').get(note.id));
});

// ---------------------------------------------------------------------
// Storefront/shelf images and documents
// ---------------------------------------------------------------------

router.post('/:id/media', requirePermission('manage_shops'), mediaUpload.single('file'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const kind = req.body?.kind === 'document' ? 'document' : 'image';
  const url = `/uploads/shop-media/${req.file.filename}`;
  const info = db
    .prepare('INSERT INTO shop_media (company_id, shop_id, kind, url, label, uploaded_by_id, uploaded_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.companyId, shop.id, kind, url, req.body?.label || null, req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM shop_media WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/:id/media/:mediaId', requirePermission('manage_shops'), (req, res) => {
  const media = db.prepare('SELECT * FROM shop_media WHERE id = ? AND shop_id = ? AND company_id = ?').get(req.params.mediaId, req.params.id, req.companyId);
  if (!media) return res.status(404).json({ error: 'media_not_found' });
  const filePath = path.join(SHOP_MEDIA_DIR, path.basename(media.url));
  fs.unlink(filePath, () => {});
  db.prepare('DELETE FROM shop_media WHERE id = ?').run(media.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Multi-phone / WhatsApp OTP verification
// ---------------------------------------------------------------------

function getPhoneRow(companyId, shopId, phoneId) {
  return db.prepare('SELECT * FROM shop_phones WHERE id = ? AND shop_id = ? AND company_id = ?').get(phoneId, shopId, companyId);
}

router.get('/:id/phones', requirePermission('view_app'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const phones = db.prepare('SELECT * FROM shop_phones WHERE shop_id = ? ORDER BY is_primary DESC, id ASC').all(shop.id);
  res.json(phones.map((p) => ({ ...p, otp_code: undefined })));
});

router.post('/:id/phones', requirePermission('manage_shops'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const { phone, label } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone_required' });
  try {
    const row = shopPhones.addPhone(req.companyId, shop.id, { phone, label });
    res.status(201).json({ ...row, otp_code: undefined });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'phone_already_exists' });
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

router.put('/:id/phones/:phoneId', requirePermission('manage_shops'), (req, res) => {
  const phoneRow = getPhoneRow(req.companyId, req.params.id, req.params.phoneId);
  if (!phoneRow) return res.status(404).json({ error: 'phone_not_found' });
  const { label, excluded_from_notify, is_primary } = req.body || {};
  if (is_primary) {
    db.prepare('UPDATE shop_phones SET is_primary = 0 WHERE shop_id = ?').run(phoneRow.shop_id);
    db.prepare("UPDATE shops SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(phoneRow.phone, phoneRow.shop_id);
  }
  db.prepare('UPDATE shop_phones SET label = ?, excluded_from_notify = ?, is_primary = ? WHERE id = ?').run(
    label ?? phoneRow.label,
    excluded_from_notify != null ? (excluded_from_notify ? 1 : 0) : phoneRow.excluded_from_notify,
    is_primary ? 1 : phoneRow.is_primary,
    phoneRow.id
  );
  res.json({ ...db.prepare('SELECT * FROM shop_phones WHERE id = ?').get(phoneRow.id), otp_code: undefined });
});

router.delete('/:id/phones/:phoneId', requirePermission('manage_shops'), (req, res) => {
  const phoneRow = getPhoneRow(req.companyId, req.params.id, req.params.phoneId);
  if (!phoneRow) return res.status(404).json({ error: 'phone_not_found' });
  db.prepare('DELETE FROM shop_phones WHERE id = ?').run(phoneRow.id);
  if (phoneRow.is_primary) {
    const next = db.prepare('SELECT * FROM shop_phones WHERE shop_id = ? ORDER BY id ASC LIMIT 1').get(phoneRow.shop_id);
    db.prepare("UPDATE shops SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(next ? next.phone : null, phoneRow.shop_id);
    if (next) db.prepare('UPDATE shop_phones SET is_primary = 1 WHERE id = ?').run(next.id);
  }
  res.status(204).end();
});

router.post('/:id/phones/:phoneId/request-otp', requirePermission('manage_shops'), async (req, res) => {
  const phoneRow = getPhoneRow(req.companyId, req.params.id, req.params.phoneId);
  if (!phoneRow) return res.status(404).json({ error: 'phone_not_found' });
  if (phoneRow.verified) return res.status(400).json({ error: 'already_verified' });
  const result = await shopPhones.requestOtp(req.companyId, phoneRow);
  res.json({
    sent: result.sent,
    expiresAt: result.expiresAt,
    // WhatsApp not being connected still lets the OTP flow itself be
    // exercised/tested end-to-end (code generated + persisted); only actual
    // delivery depends on a live connected session.
    note: result.sent ? undefined : 'whatsapp_not_connected_code_generated_anyway',
  });
});

router.post('/:id/phones/:phoneId/verify-otp', requirePermission('manage_shops'), (req, res) => {
  const phoneRow = getPhoneRow(req.companyId, req.params.id, req.params.phoneId);
  if (!phoneRow) return res.status(404).json({ error: 'phone_not_found' });
  const result = shopPhones.verifyOtp(req.companyId, phoneRow, req.body?.code);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...db.prepare('SELECT * FROM shop_phones WHERE id = ?').get(phoneRow.id), otp_code: undefined });
});

router.post('/:id/phones/:phoneId/manual-confirm', requirePermission('manage_shops'), (req, res) => {
  const phoneRow = getPhoneRow(req.companyId, req.params.id, req.params.phoneId);
  if (!phoneRow) return res.status(404).json({ error: 'phone_not_found' });
  const updated = shopPhones.manualConfirm(phoneRow, req.user);
  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: 'shop_phone_manual_confirm',
    entityType: 'shop_phone',
    entityId: phoneRow.id,
    shopId: phoneRow.shop_id,
    before: { verified: false },
    after: { verified: true },
  });
  res.json({ ...updated, otp_code: undefined });
});

// ---------------------------------------------------------------------
// Rep assignment + transfer history
// ---------------------------------------------------------------------

router.put('/:id/assign', requireAnyPermission('manage_shops', 'reassign_shops'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const { repId, reason } = req.body || {};
  const newRep = repId ? db.prepare('SELECT id, name FROM users WHERE id = ? AND company_id = ?').get(repId, req.companyId) : null;
  if (repId && !newRep) return res.status(400).json({ error: 'rep_not_found' });
  const oldRep = shop.assigned_rep_id ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(shop.assigned_rep_id) : null;

  db.prepare("UPDATE shops SET assigned_rep_id = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?").run(
    newRep ? newRep.id : null,
    shop.id,
    req.companyId
  );
  db.prepare(
    `INSERT INTO shop_rep_transfers (company_id, shop_id, from_rep_id, from_rep_name, to_rep_id, to_rep_name, reason, changed_by_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.companyId,
    shop.id,
    oldRep?.id ?? null,
    oldRep?.name ?? null,
    newRep?.id ?? null,
    newRep?.name ?? null,
    reason || null,
    req.user.id,
    req.user.name
  );
  const updated = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id);
  res.json(enrichShop(updated, getGlobalSettings(req.companyId)));
});

router.get('/:id/transfers', requirePermission('view_app'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  res.json(db.prepare('SELECT * FROM shop_rep_transfers WHERE shop_id = ? ORDER BY id DESC').all(shop.id));
});

// ---------------------------------------------------------------------
// QR / shareable link
// ---------------------------------------------------------------------

router.get('/:id/qrcode', requirePermission('manage_shops'), async (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const base = process.env.PUBLIC_APP_URL || 'http://localhost:5173';
  const url = `${base}/shop/${shop.public_token}`;
  const dataUrl = await QRCode.toDataURL(url);
  res.json({ url, qrDataUrl: dataUrl });
});

// ---------------------------------------------------------------------
// Unified activity log (orders + notes + rep transfers), filterable
// ---------------------------------------------------------------------

router.get('/:id/activity', requirePermission('view_app'), (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const { type, product, from, to } = req.query;

  const events = [];

  if (!type || type === 'order') {
    const orders = db
      .prepare('SELECT * FROM orders WHERE shop_id = ? AND deleted_at IS NULL ORDER BY order_date DESC, id DESC')
      .all(shop.id);
    for (const o of orders) {
      const items = JSON.parse(o.items_json || '[]');
      if (product && !items.some((it) => String(it.product_name || '').includes(product))) continue;
      if (from && o.order_date < from) continue;
      if (to && o.order_date > to) continue;
      events.push({
        type: 'order',
        date: o.order_date,
        summary: items.map((it) => `${it.product_name} × ${it.qty}`).join('، '),
        total_value: o.total_value,
        id: o.id,
      });
    }
  }

  if (!type || type === 'note') {
    const notes = db.prepare('SELECT * FROM shop_notes WHERE shop_id = ? ORDER BY created_at DESC').all(shop.id);
    for (const n of notes) {
      const date = n.created_at.slice(0, 10);
      if (from && date < from) continue;
      if (to && date > to) continue;
      events.push({ type: 'note', date, summary: n.body, noteType: n.type, author: n.author_name, id: n.id });
    }
  }

  if (!type || type === 'transfer') {
    const transfers = db.prepare('SELECT * FROM shop_rep_transfers WHERE shop_id = ? ORDER BY created_at DESC').all(shop.id);
    for (const t of transfers) {
      const date = t.created_at.slice(0, 10);
      if (from && date < from) continue;
      if (to && date > to) continue;
      events.push({
        type: 'transfer',
        date,
        summary: `${t.from_rep_name || '—'} ← ${t.to_rep_name || '—'} (${t.reason || 'بدون سبب'})`,
        id: t.id,
      });
    }
  }

  events.sort((a, b) => (a.date < b.date ? 1 : -1));
  res.json(events);
});

module.exports = router;
