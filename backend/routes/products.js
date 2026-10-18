const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bwipjs = require('bwip-js');
const QRCode = require('qrcode');
const db = require('../db/init');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const { readSheetRows } = require('../lib/excelParse');
const { matchColumns, validateRow } = require('../lib/productImportValidation');
const { computeMaterialStats } = require('../lib/materialStats');
const { computeMaterialDetail } = require('../lib/materialDetail');
const productUnits = require('../lib/productUnits');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `productimport-${Date.now()}-${file.originalname}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

const PRODUCT_IMAGE_DIR = path.join(__dirname, '..', 'uploads', 'product-images');
if (!fs.existsSync(PRODUCT_IMAGE_DIR)) fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PRODUCT_IMAGE_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن تكون الصورة بصيغة PNG أو JPG أو WEBP'), ok);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Also readable by anyone who can see either warehouse (not just view_app
// holders) — the inventory pages need this list (box weights in
// particular) to render at all, and a warehouse-keeper role legitimately
// has manage_factory_inventory without view_app.
router.get(
  '/',
  requireAnyPermission('view_app', 'manage_car_inventory', 'manage_factory_inventory', 'manage_products'),
  (req, res) => {
    const activeOnly = req.query.all !== '1';
    const rows = activeOnly
      ? db.prepare('SELECT * FROM products WHERE company_id = ? AND active = 1 ORDER BY sort_order, name COLLATE NOCASE').all(req.companyId)
      : db.prepare('SELECT * FROM products WHERE company_id = ? ORDER BY sort_order, name COLLATE NOCASE').all(req.companyId);
    res.json(rows);
  }
);

// Backs the inventory pages' summary cards + detail drill-down — open to
// anyone who can view either warehouse, not just view_statistics holders,
// since it's presented as part of the inventory screen itself.
router.get(
  '/material-stats',
  requireAnyPermission('manage_car_inventory', 'manage_factory_inventory', 'view_statistics'),
  (req, res) => {
    const period = ['week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'month';
    res.json(computeMaterialStats(req.companyId, period));
  }
);

// Backs the unified-search "material" result in Statistics — monthly/yearly
// quantity sold + top shops for one specific product.
router.get('/:id/detail-stats', requirePermission('view_statistics'), (req, res) => {
  const detail = computeMaterialDetail(req.companyId, req.params.id);
  if (!detail) return res.status(404).json({ error: 'product_not_found' });
  res.json(detail);
});

router.post('/', requirePermission('manage_products'), (req, res) => {
  const { name, unit, amin_code, box_weight_grams, sku, barcode, category, brand, description, image_url, cost_price, base_price } = req.body;
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM products WHERE company_id = ?').get(req.companyId).m || 0;
    const info = db
      .prepare(
        `INSERT INTO products (company_id, name, unit, amin_code, box_weight_grams, sort_order, sku, barcode, category, brand, description, image_url, cost_price, base_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.companyId,
        name,
        unit || null,
        amin_code || null,
        box_weight_grams || null,
        maxOrder + 1,
        sku || null,
        barcode || null,
        category || null,
        brand || null,
        description || null,
        image_url || null,
        cost_price ?? null,
        base_price ?? null
      );
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(info.lastInsertRowid, req.companyId));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'product_already_exists' });
    }
    res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

router.put('/:id', requirePermission('manage_products'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  const { name, unit, active, amin_code, box_weight_grams, sku, barcode, category, brand, description, image_url, cost_price, base_price } = req.body;
  try {
    db.prepare(
      `UPDATE products SET name = ?, unit = ?, active = ?, amin_code = ?, box_weight_grams = ?,
       sku = ?, barcode = ?, category = ?, brand = ?, description = ?, image_url = ?, cost_price = ?, base_price = ?
       WHERE id = ? AND company_id = ?`
    ).run(
      name ?? product.name,
      unit ?? product.unit,
      active === undefined ? product.active : active ? 1 : 0,
      amin_code === undefined ? product.amin_code : amin_code || null,
      box_weight_grams === undefined ? product.box_weight_grams : box_weight_grams || null,
      sku === undefined ? product.sku : sku || null,
      barcode === undefined ? product.barcode : barcode || null,
      category === undefined ? product.category : category || null,
      brand === undefined ? product.brand : brand || null,
      description === undefined ? product.description : description || null,
      image_url === undefined ? product.image_url : image_url || null,
      cost_price === undefined ? product.cost_price : cost_price,
      base_price === undefined ? product.base_price : base_price,
      product.id,
      req.companyId
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'sku_or_barcode_already_exists' });
    }
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
  // Keep car/factory inventory's denormalized item_name in sync so a rename
  // here doesn't leave the inventory screens showing a stale label.
  if (name && name !== product.name) {
    db.prepare("UPDATE car_inventory SET item_name = ? WHERE product_id = ? AND company_id = ?").run(name, product.id, req.companyId);
    db.prepare("UPDATE factory_inventory SET item_name = ? WHERE product_id = ? AND company_id = ?").run(name, product.id, req.companyId);
  }
  res.json(updated);
});

router.delete('/:id', requirePermission('manage_products'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  db.prepare('DELETE FROM products WHERE id = ? AND company_id = ?').run(product.id, req.companyId);
  res.status(204).end();
});

// Product master sync: name / Amin code / box weight only — a separate,
// infrequent-use flow (new material onboarding or a definition correction),
// distinct from the inventory pages' own weekly quantity/threshold import.
router.post('/import/preview', requirePermission('manage_products'), upload.single('file'), async (req, res) => {
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

  if (indices.name === null) {
    return res.status(400).json({ error: 'missing_columns', columns: ['اسم المادة'] });
  }

  const existingByName = new Map(
    db.prepare('SELECT id, name FROM products WHERE company_id = ?').all(req.companyId).map((p) => [p.name.toLowerCase(), p])
  );
  const seenNames = new Set();
  const rows = dataRows.map((r) =>
    validateRow(
      {
        name: indices.name !== null ? r[indices.name] : '',
        amin_code: indices.amin_code !== null ? r[indices.amin_code] : '',
        box_weight_grams: indices.box_weight_grams !== null ? r[indices.box_weight_grams] : '',
      },
      existingByName,
      seenNames
    )
  );

  res.json({ rows, rowCount: rows.length });
});

router.post('/import/commit', requirePermission('manage_products'), (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const existingByName = new Map(
    db.prepare('SELECT id, name FROM products WHERE company_id = ?').all(req.companyId).map((p) => [p.name.toLowerCase(), p])
  );
  const seenNames = new Set();
  const maxOrderRow = db.prepare('SELECT MAX(sort_order) as m FROM products WHERE company_id = ?').get(req.companyId);
  let nextOrder = (maxOrderRow.m || 0) + 1;

  const results = rows.map((row) => {
    const revalidated = validateRow(row, existingByName, seenNames);
    if (revalidated.status !== 'ok') {
      return { ...revalidated, outcome: 'skipped' };
    }
    try {
      if (revalidated.action === 'update') {
        const existing = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(revalidated.productId, req.companyId);
        db.prepare('UPDATE products SET amin_code = ?, box_weight_grams = ? WHERE id = ? AND company_id = ?').run(
          revalidated.amin_code ?? existing.amin_code,
          revalidated.box_weight_grams ?? existing.box_weight_grams,
          existing.id,
          req.companyId
        );
      } else {
        const info = db
          .prepare('INSERT INTO products (company_id, name, amin_code, box_weight_grams, sort_order) VALUES (?, ?, ?, ?, ?)')
          .run(req.companyId, revalidated.name, revalidated.amin_code, revalidated.box_weight_grams, nextOrder++);
        existingByName.set(revalidated.name.toLowerCase(), { id: info.lastInsertRowid, name: revalidated.name });
      }
      const product = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE AND company_id = ?').get(revalidated.name, req.companyId);
      return { ...revalidated, outcome: revalidated.action === 'update' ? 'updated' : 'created', product };
    } catch (err) {
      return { ...revalidated, outcome: 'skipped', reasons: [...revalidated.reasons, 'تعذر الحفظ'] };
    }
  });

  const createdCount = results.filter((r) => r.outcome === 'created').length;
  const updatedCount = results.filter((r) => r.outcome === 'updated').length;
  res.json({ results, createdCount, updatedCount, skippedCount: results.length - createdCount - updatedCount });
});

router.post('/:id/image', requirePermission('manage_products'), imageUpload.single('file'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const url = `/uploads/product-images/${req.file.filename}`;
  if (product.image_url?.startsWith('/uploads/product-images/')) {
    fs.unlink(path.join(__dirname, '..', product.image_url), () => {});
  }
  db.prepare('UPDATE products SET image_url = ? WHERE id = ? AND company_id = ?').run(url, product.id, req.companyId);
  res.json({ image_url: url });
});

// ---------------------------------------------------------------------
// Units of measure + conversion
// ---------------------------------------------------------------------

router.get('/:id/units', requireAnyPermission('view_app', 'manage_products'), (req, res) => {
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  res.json(productUnits.getUnits(product.id));
});

router.post('/:id/units', requirePermission('manage_products'), (req, res) => {
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  try {
    const units = productUnits.addUnit(req.companyId, product.id, req.body || {});
    res.status(201).json(units);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

router.delete('/:id/units/:unitId', requirePermission('manage_products'), (req, res) => {
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  productUnits.removeUnit(product.id, req.params.unitId);
  res.status(204).end();
});

router.get('/:id/convert', requireAnyPermission('view_app', 'manage_products'), (req, res) => {
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  const { qty, from, to } = req.query;
  try {
    const result = productUnits.convert(product.id, qty, from, to);
    res.json({ qty: result, from, to });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'server_error' });
  }
});

// ---------------------------------------------------------------------
// Barcode / QR generation + camera-scan lookup
// ---------------------------------------------------------------------

router.get('/:id/barcode', requireAnyPermission('view_app', 'manage_products'), async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  const code = product.barcode || product.sku || String(product.id);
  try {
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 12, includetext: true, textxalign: 'center' });
    res.json({ code, dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  } catch (err) {
    res.status(400).json({ error: 'barcode_generation_failed', detail: err.message });
  }
});

router.get('/:id/qrcode', requireAnyPermission('view_app', 'manage_products'), async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  const payload = JSON.stringify({ t: 'product', id: product.id, sku: product.sku || null });
  const dataUrl = await QRCode.toDataURL(payload);
  res.json({ payload, dataUrl });
});

// Camera/external-reader scan lookup: matches barcode first, then SKU, so
// the same "scan" action works for either a printed barcode label or a QR
// code encoding the SKU.
router.get('/scan/:code', requireAnyPermission('view_app', 'manage_products'), (req, res) => {
  const code = req.params.code;
  let product = db.prepare('SELECT * FROM products WHERE company_id = ? AND barcode = ?').get(req.companyId, code);
  if (!product) product = db.prepare('SELECT * FROM products WHERE company_id = ? AND sku = ?').get(req.companyId, code);
  if (!product) {
    try {
      const parsed = JSON.parse(code);
      if (parsed?.t === 'product' && parsed.id) {
        product = db.prepare('SELECT * FROM products WHERE company_id = ? AND id = ?').get(req.companyId, parsed.id);
      }
    } catch {
      // not JSON — not a QR payload, just an unmatched code
    }
  }
  if (!product) return res.status(404).json({ error: 'product_not_found' });
  res.json(product);
});

module.exports = router;
