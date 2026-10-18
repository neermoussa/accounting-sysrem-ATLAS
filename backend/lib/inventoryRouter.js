const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const db = require('../db/init');
const { requirePermission, requireAdminRole } = require('../middleware/auth');
const { addSheet, sendWorkbook, langFromQuery } = require('./xlsxExport');
const { readSheetRows } = require('./excelParse');
const { sendToManager } = require('./whatsapp');
const { matchColumns, validateRow } = require('./inventoryImportValidation');
const { createNotification, hasUnreadNotification } = require('./notify');
const { matchItemName, classifyVariance, MINOR_VARIANCE_PCT } = require('./inventoryCountMatch');

const COUNT_COLUMN_ALIASES = {
  item_name: ['اسم المادة', 'اسم الصنف', 'الصنف', 'المادة', 'item name', 'item', 'name'],
  counted_quantity: [
    'الكمية المجرودة فعليا',
    'الكمية المجرودة فعليًا',
    'الكمية المجرودة',
    'الكمية الفعلية',
    'الكمية',
    'quantity',
    'counted quantity',
  ],
};

function matchCountColumns(header) {
  const normalized = header.map((h) => String(h || '').trim().toLowerCase());
  const indices = {};
  for (const [field, aliases] of Object.entries(COUNT_COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    indices[field] = idx === -1 ? null : idx;
  }
  return indices;
}

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `invimport-${Date.now()}-${file.originalname}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

function withAlert(item) {
  return { ...item, lowStock: item.current_quantity <= item.min_quantity };
}

// Shared by car_inventory and factory_inventory, and reused as-is by
// seed scripts so a seeded item that starts below threshold goes through the
// exact same alert path (WhatsApp attempt + low_stock_alert_active flag) a
// real quantity update would trigger — not a separate, easy-to-drift copy.
// Inventory has no time-based transitions (nothing changes without a
// write), so unlike shops it's checked right here instead of a sweep.
async function evaluateInventoryAlert({ companyId, table, warehouseLabel, item }) {
  const lowStock = item.current_quantity <= item.min_quantity;
  if (lowStock && !item.low_stock_alert_active) {
    const message = `⚠️ صنف وصل للحد الأدنى بـ${warehouseLabel}\n${item.item_name}\nالمتبقي: ${item.current_quantity} (الحد الأدنى: ${item.min_quantity})`;
    if (!hasUnreadNotification(companyId, 'low_stock', item.id, table)) {
      createNotification({
        companyId,
        type: 'low_stock',
        message_ar: message,
        message_en: `Low stock — ${item.item_name} (${warehouseLabel}): ${item.current_quantity} left (min: ${item.min_quantity})`,
        link_path: table === 'car_inventory' ? '/inventory' : '/factory-inventory',
        entity_type: table,
        entity_id: item.id,
      });
    }
    const sent = await sendToManager(companyId, message);
    if (sent) {
      db.prepare(`UPDATE ${table} SET low_stock_alert_active = 1 WHERE id = ? AND company_id = ?`).run(item.id, companyId);
    }
  } else if (!lowStock && item.low_stock_alert_active) {
    db.prepare(`UPDATE ${table} SET low_stock_alert_active = 0 WHERE id = ? AND company_id = ?`).run(item.id, companyId);
  }
}

// One implementation shared by car_inventory and factory_inventory — they're
// independent tables/alert-state, but identical in shape and behavior.
// `table` is never user input (only ever 'car_inventory' or
// 'factory_inventory', hardcoded by the two route files below), so building
// SQL with it via template literals here is safe. Every query below is
// additionally filtered by `req.companyId` (set by requirePermission at the
// top of this router), so one company's inventory rows are never visible
// or writable from another's request.
function buildInventoryRouter({ table, warehouseLabel, exportFilename, sheetName, sheetNameEn, permission }) {
  const router = express.Router();
  router.use(requirePermission(permission));

  const evaluateAlert = (companyId, item) => evaluateInventoryAlert({ companyId, table, warehouseLabel, item });

  // Prompt 8: with the stock ledger activated, a quantity written here is
  // the pooled total of the warehouse (factory) or custody (car) holders;
  // the difference becomes an adjustment / count move posted to the
  // ledger, in ONE transaction with the row write. Not activated: the
  // write runs alone exactly as before.
  const stock = require('./stockLedger');
  function withStock(req, res, write, after) {
    if (!stock.isActive(req.companyId)) return write();
    try {
      return require('./ledger').transaction(() => {
        const r = write();
        after(r);
        return r;
      });
    } catch (err) {
      if (err.code && err.status) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return undefined;
      }
      throw err;
    }
  }
  const pooled = (req, productId, qty, opts = {}) => {
    if (productId) stock.setPooledTotal(req.companyId, table, productId, Number(qty) || 0, { sourceType: `${table}_screen`, actor: req.user, ...opts });
  };

  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE company_id = ? ORDER BY item_name COLLATE NOCASE`).all(req.companyId);
    res.json(rows.map(withAlert));
  });

  router.get('/export', requirePermission('export_data'), async (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE company_id = ? ORDER BY item_name COLLATE NOCASE`)
      .all(req.companyId)
      .map((i) => ({
        item_name: i.item_name,
        current_quantity: i.current_quantity,
        min_quantity: i.min_quantity,
        state: i.current_quantity <= i.min_quantity ? 'منخفض' : 'طبيعي',
      }));
    const lang = langFromQuery(req);
    const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId);
    const workbook = new ExcelJS.Workbook();
    addSheet(
      workbook,
      sheetName,
      [
        { header: 'الصنف', headerEn: 'Item', key: 'item_name', width: 26 },
        { header: 'الكمية الحالية', headerEn: 'Current quantity', key: 'current_quantity', width: 16 },
        { header: 'الحد الأدنى', headerEn: 'Min quantity', key: 'min_quantity', width: 16 },
        { header: 'الحالة', headerEn: 'Status', key: 'state', width: 14 },
      ],
      rows,
      {
        title: lang === 'en' ? sheetNameEn || sheetName : sheetName,
        lang,
        companyName: company?.name,
      }
    );
    await sendWorkbook(res, workbook, exportFilename);
  });

  router.get('/alerts', (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE company_id = ? AND current_quantity <= min_quantity ORDER BY item_name COLLATE NOCASE`)
      .all(req.companyId);
    res.json(rows.map(withAlert));
  });

  // Reading (list/alerts/export) stays open to anyone with the section's
  // view permission (e.g. a warehouse keeper) — only these mutating routes
  // additionally require the admin role, per spec: quantities and minimum
  // thresholds are admin-edited only, everyone else is read-only.
  router.post('/', requireAdminRole, async (req, res) => {
    const { item_name, current_quantity, min_quantity, product_id } = req.body;
    try {
      // Every item is backed by a product master row: link to an existing
      // one if picked, otherwise create one on the fly from the typed name
      // so the invariant "every inventory row has a product_id" always holds.
      let productId = product_id || null;
      let resolvedName = item_name;
      if (productId) {
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(productId, req.companyId);
        if (!product) return res.status(400).json({ error: 'product_not_found' });
        resolvedName = product.name;
        // One stock row per product: goods receipts, returns and stock
        // checks all read/write the product's row, so a second row would
        // double count it.
        if (db.prepare(`SELECT 1 FROM ${table} WHERE company_id = ? AND product_id = ?`).get(req.companyId, productId)) {
          return res.status(409).json({ error: 'product_already_in_inventory', message: 'هذا المنتج له سطر مخزون بالفعل — عدّل الكمية على السطر الموجود' });
        }
      } else {
        if (!resolvedName) return res.status(400).json({ error: 'item_name_required' });
        const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM products WHERE company_id = ?').get(req.companyId).m || 0;
        const info = db
          .prepare('INSERT INTO products (company_id, name, sort_order) VALUES (?, ?, ?)')
          .run(req.companyId, resolvedName, maxOrder + 1);
        productId = info.lastInsertRowid;
      }
      const info = withStock(req, res, () => db
        .prepare(`INSERT INTO ${table} (company_id, item_name, product_id, current_quantity, min_quantity) VALUES (?, ?, ?, ?, ?)`)
        .run(req.companyId, resolvedName, productId, Number(current_quantity) || 0, Number(min_quantity) || 0), (r) => pooled(req, productId, current_quantity, { sourceId: Number(r.lastInsertRowid) }));
      if (!info) return undefined;
      let item = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
      await evaluateAlert(req.companyId, item);
      item = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item.id);
      res.status(201).json(withAlert(item));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'item_already_exists' });
      }
      res.status(500).json({ error: 'server_error', detail: err.message });
    }
  });

  router.put('/:id', requireAdminRole, async (req, res) => {
    const item = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(req.params.id, req.companyId);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const { item_name, current_quantity, min_quantity } = req.body;
    const newQty = current_quantity === undefined ? item.current_quantity : Number(current_quantity);
    const ok = withStock(req, res, () => db.prepare(
      `UPDATE ${table} SET item_name = ?, current_quantity = ?, min_quantity = ?, updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(
      item_name ?? item.item_name,
      newQty,
      min_quantity === undefined ? item.min_quantity : Number(min_quantity),
      item.id,
      req.companyId
    ), () => { if (newQty !== item.current_quantity) pooled(req, item.product_id, newQty, { sourceId: item.id }); });
    if (!ok) return undefined;
    let updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item.id);
    await evaluateAlert(req.companyId, updated);
    updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item.id);
    res.json(withAlert(updated));
  });

  // Dedicated endpoint for the warehouse keeper's core action: updating current quantity.
  router.put('/:id/quantity', requireAdminRole, async (req, res) => {
    const item = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(req.params.id, req.companyId);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const { current_quantity } = req.body;
    if (current_quantity === undefined) return res.status(400).json({ error: 'current_quantity_required' });
    const ok = withStock(req, res, () => db.prepare(`UPDATE ${table} SET current_quantity = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`).run(
      Number(current_quantity),
      item.id,
      req.companyId
    ), () => pooled(req, item.product_id, current_quantity, { sourceId: item.id }));
    if (!ok) return undefined;
    let updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item.id);
    await evaluateAlert(req.companyId, updated);
    updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(item.id);
    res.json(withAlert(updated));
  });

  router.delete('/:id', requireAdminRole, (req, res) => {
    const item = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(req.params.id, req.companyId);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const ok = withStock(req, res, () => db.prepare(`DELETE FROM ${table} WHERE id = ? AND company_id = ?`).run(item.id, req.companyId), () => pooled(req, item.product_id, 0, { sourceId: item.id }));
    if (!ok) return undefined;
    res.status(204).end();
  });

  // Bulk add-or-edit-threshold from an Excel file (item name + min quantity
  // only — current_quantity is never touched here, that's the weekly manual
  // count's job). Two-step preview/commit, same pattern as shop import.
  router.post('/import/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    let dataRows;
    let indices;
    try {
      const { header, dataRows: parsed } = await readSheetRows(req.file.path);
      if (header.length === 0) return res.status(400).json({ error: 'empty_file' });
      indices = matchColumns(header);
      dataRows = parsed;
    } catch (err) {
      return res.status(500).json({ error: 'parse_failed', detail: err.message });
    } finally {
      fs.unlink(req.file.path, () => {});
    }

    const missing = [];
    if (indices.item_name === null) missing.push('اسم الصنف');
    if (indices.min_quantity === null) missing.push('الحد الأدنى');
    if (missing.length) return res.status(400).json({ error: 'missing_columns', columns: missing });

    const existingNames = new Set(
      db.prepare(`SELECT item_name FROM ${table} WHERE company_id = ?`).all(req.companyId).map((r) => r.item_name.toLowerCase())
    );
    const seenNames = new Set();
    const rows = dataRows.map((r) =>
      validateRow(
        { item_name: r[indices.item_name], min_quantity: r[indices.min_quantity] },
        existingNames,
        seenNames
      )
    );

    res.json({ rows, rowCount: rows.length });
  });

  router.post('/import/commit', requireAdminRole, (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const existingNames = new Set(
      db.prepare(`SELECT item_name FROM ${table} WHERE company_id = ?`).all(req.companyId).map((r) => r.item_name.toLowerCase())
    );
    const seenNames = new Set();

    const results = rows.map((row) => {
      const revalidated = validateRow(row, existingNames, seenNames);
      if (revalidated.status !== 'ok') {
        return { ...revalidated, outcome: 'skipped' };
      }
      try {
        if (revalidated.action === 'update') {
          db.prepare(
            `UPDATE ${table} SET min_quantity = ?, updated_at = datetime('now') WHERE company_id = ? AND item_name = ? COLLATE NOCASE`
          ).run(revalidated.min_quantity, req.companyId, revalidated.item_name);
        } else {
          db.prepare(`INSERT INTO ${table} (company_id, item_name, current_quantity, min_quantity) VALUES (?, ?, 0, ?)`).run(
            req.companyId,
            revalidated.item_name,
            revalidated.min_quantity
          );
          existingNames.add(revalidated.item_name.toLowerCase());
        }
        const item = db
          .prepare(`SELECT * FROM ${table} WHERE company_id = ? AND item_name = ? COLLATE NOCASE`)
          .get(req.companyId, revalidated.item_name);
        return { ...revalidated, outcome: revalidated.action === 'update' ? 'updated' : 'created', item };
      } catch (err) {
        return { ...revalidated, outcome: 'skipped', reasons: [...revalidated.reasons, 'تعذر الحفظ'] };
      }
    });

    // Threshold changes (new or edited) can newly cross the low-stock line,
    // so re-check alerts for everything this commit touched.
    Promise.all(
      results.filter((r) => r.outcome === 'created' || r.outcome === 'updated').map((r) => evaluateAlert(req.companyId, r.item))
    ).finally(() => {
      const createdCount = results.filter((r) => r.outcome === 'created').length;
      const updatedCount = results.filter((r) => r.outcome === 'updated').length;
      res.json({
        results,
        createdCount,
        updatedCount,
        skippedCount: results.length - createdCount - updatedCount,
      });
    });
  });

  // ---- Physical stock count (جرد المستودع) ----
  // Two-step preview/confirm, same shape as the threshold import above, but
  // comparing an uploaded physical count against the system's current
  // quantity per item instead of editing minimums. Nothing in car_inventory/
  // factory_inventory changes until /count/confirm.
  const warehouseKey = table === 'car_inventory' ? 'car' : 'factory';

  router.post('/count/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    let dataRows;
    let indices;
    try {
      const { header, dataRows: parsed } = await readSheetRows(req.file.path);
      if (header.length === 0) return res.status(400).json({ error: 'empty_file' });
      indices = matchCountColumns(header);
      dataRows = parsed;
    } catch (err) {
      return res.status(500).json({ error: 'parse_failed', detail: err.message });
    } finally {
      fs.unlink(req.file.path, () => {});
    }

    const missing = [];
    if (indices.item_name === null) missing.push('اسم المادة');
    if (indices.counted_quantity === null) missing.push('الكمية المجرودة فعليًا');
    if (missing.length) return res.status(400).json({ error: 'missing_columns', columns: missing });

    const existingItems = db.prepare(`SELECT id, item_name, current_quantity FROM ${table} WHERE company_id = ?`).all(req.companyId);

    const rows = dataRows.map((r) => {
      const rawName = (r[indices.item_name] || '').toString().trim();
      const countedRaw = r[indices.counted_quantity];
      const countedQuantity = countedRaw === null || countedRaw === undefined || countedRaw === '' ? null : Number(countedRaw);

      if (!rawName) {
        return { itemName: rawName, matchedItemId: null, matchScore: null, expectedQuantity: null, countedQuantity: null, variance: null, variancePct: null, classification: 'unmatched', reason: null, error: 'اسم المادة مفقود' };
      }
      if (countedQuantity === null || !Number.isFinite(countedQuantity) || countedQuantity < 0) {
        return { itemName: rawName, matchedItemId: null, matchScore: null, expectedQuantity: null, countedQuantity: null, variance: null, variancePct: null, classification: 'unmatched', reason: null, error: 'الكمية المجرودة مفقودة أو غير صحيحة' };
      }

      const match = matchItemName(rawName, existingItems);
      if (!match) {
        return { itemName: rawName, matchedItemId: null, matchScore: null, expectedQuantity: null, countedQuantity, variance: null, variancePct: null, classification: 'unmatched', reason: null, error: null };
      }
      const { variance, variancePct, classification } = classifyVariance(match.item.current_quantity, countedQuantity);
      return {
        itemName: match.item.item_name,
        matchedItemId: match.item.id,
        matchScore: Math.round(match.score * 100) / 100,
        expectedQuantity: match.item.current_quantity,
        countedQuantity,
        variance,
        variancePct: variancePct === null ? null : Math.round(variancePct * 10) / 10,
        classification,
        reason: null,
      };
    });

    res.json({
      rows,
      minorVariancePct: MINOR_VARIANCE_PCT,
      summary: {
        matched: rows.filter((r) => r.classification === 'matched').length,
        minor: rows.filter((r) => r.classification === 'minor').length,
        major: rows.filter((r) => r.classification === 'major').length,
        unmatched: rows.filter((r) => r.classification === 'unmatched').length,
      },
    });
  });

  router.post('/count/confirm', requireAdminRole, async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const filename = req.body.filename || 'جرد يدوي';
    // Every matched row's item must actually belong to this company — a
    // spoofed matchedItemId from another company's inventory is rejected
    // outright rather than silently ignored, so a crafted request can't be
    // used to probe or overwrite another tenant's stock.
    const companyItemIds = new Set(
      db.prepare(`SELECT id FROM ${table} WHERE company_id = ?`).all(req.companyId).map((r) => r.id)
    );
    const applicable = rows.filter(
      (r) => r.matchedItemId && companyItemIds.has(r.matchedItemId) && r.countedQuantity !== null && r.countedQuantity !== undefined
    );
    if (!applicable.length) return res.status(400).json({ error: 'no_matched_rows' });
    // An invalid classification used to throw inside this async handler
    // (CHECK constraint) -> unhandled rejection -> the request never
    // answered. Refuse it up front instead.
    const CLASSES = ['matched', 'minor', 'major', 'unmatched'];
    const bad = applicable.find((r) => !CLASSES.includes(r.classification));
    if (bad) return res.status(400).json({ error: 'invalid_classification', item: bad.itemName ?? null, allowed: CLASSES });

    const insertCount = db.prepare(
      `INSERT INTO inventory_counts (company_id, warehouse, filename, item_count, variance_count, created_by_id, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertRow = db.prepare(
      `INSERT INTO inventory_count_rows (count_id, item_name, matched_item_id, expected_quantity, counted_quantity, variance, variance_pct, classification, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const varianceCount = applicable.filter((r) => r.classification === 'minor' || r.classification === 'major').length;
    const { lastInsertRowid: countId } = insertCount.run(
      req.companyId,
      warehouseKey,
      filename,
      applicable.length,
      varianceCount,
      req.user?.id || null,
      req.user?.name || null
    );

    const updatedItems = [];
    const stockOn = stock.isActive(req.companyId);
    const applyRows = (stockOn ? (fn) => (list) => require('./ledger').transaction(() => fn(list)) : db.transaction)((list) => {
      for (const r of list) {
        db.prepare(`UPDATE ${table} SET current_quantity = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`).run(
          r.countedQuantity,
          r.matchedItemId,
          req.companyId
        );
        if (stockOn) {
          const pid = db.prepare(`SELECT product_id FROM ${table} WHERE id = ?`).get(r.matchedItemId)?.product_id;
          pooled(req, pid, r.countedQuantity, { moveType: 'count', reasonCode: r.reason || r.classification, sourceType: 'inventory_count', sourceId: Number(countId) });
        }
        insertRow.run(
          countId,
          r.itemName,
          r.matchedItemId,
          r.expectedQuantity ?? null,
          r.countedQuantity,
          r.variance ?? null,
          r.variancePct ?? null,
          r.classification,
          r.reason || null
        );
        updatedItems.push(r.matchedItemId);
      }
    });
    try {
      applyRows(applicable);
    } catch (err) {
      // Stock-ledger refusal (e.g. no open period): the rows were rolled
      // back, so drop the count header too and answer instead of hanging.
      db.prepare('DELETE FROM inventory_counts WHERE id = ?').run(countId);
      if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
      return res.status(500).json({ error: 'server_error', detail: err.message });
    }

    for (const itemId of updatedItems) {
      const item = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(itemId, req.companyId);
      if (item) await evaluateAlert(req.companyId, item);
    }

    const record = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(countId);
    res.status(201).json({ count: record, updatedCount: applicable.length });
  });

  router.get('/count/history', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM inventory_counts WHERE company_id = ? AND warehouse = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.companyId, warehouseKey);
    res.json(rows);
  });

  return router;
}

module.exports = { buildInventoryRouter, evaluateInventoryAlert };
