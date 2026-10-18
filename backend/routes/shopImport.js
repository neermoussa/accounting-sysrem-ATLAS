const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/init');
const { requirePermission } = require('../middleware/auth');
const { readSheetRows } = require('../lib/excelParse');
const { matchColumns, validateRow } = require('../lib/shopImportValidation');

const router = express.Router();
router.use(requirePermission('manage_shops'));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `shopimport-${Date.now()}-${file.originalname}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Only these two columns must actually exist in the file's header row —
// lat/lng are optional (see the comment on validateRow in
// lib/shopImportValidation.js), so their presence is never enforced here.
const REQUIRED_FIELDS = { name: 'اسم المحل', phone: 'رقم الهاتف' };

router.post('/preview', upload.single('file'), async (req, res) => {
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

  const missing = Object.entries(REQUIRED_FIELDS)
    .filter(([field]) => indices[field] === null)
    .map(([, label]) => label);
  if (missing.length) {
    return res.status(400).json({ error: 'missing_columns', columns: missing });
  }

  const seenPhones = new Set();
  const rows = dataRows.map((r) =>
    validateRow(
      {
        name: indices.name !== null ? r[indices.name] : '',
        phone: indices.phone !== null ? r[indices.phone] : '',
        lat: indices.lat !== null ? r[indices.lat] : null,
        lng: indices.lng !== null ? r[indices.lng] : null,
        address: indices.address !== null ? r[indices.address] : '',
        notes: indices.notes !== null ? r[indices.notes] : '',
      },
      seenPhones
    )
  );

  const batchInfo = db
    .prepare(
      `INSERT INTO shop_import_batches (company_id, filename, row_count, status, uploaded_by_id, uploaded_by_name)
       VALUES (?, ?, ?, 'previewed', ?, ?)`
    )
    .run(req.companyId, req.file.originalname, rows.length, req.user.id, req.user.name);

  res.json({ rows, rowCount: rows.length, batchId: batchInfo.lastInsertRowid });
});

router.get('/batches', (req, res) => {
  const batches = db.prepare('SELECT * FROM shop_import_batches WHERE company_id = ? ORDER BY id DESC LIMIT 20').all(req.companyId);
  res.json(batches);
});

router.post('/commit', (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const batchId = req.body.batch_id;
  const seenPhones = new Set();
  const insert = db.prepare(
    `INSERT INTO shops (company_id, name, phone, address, lat, lng, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const results = rows.map((row) => {
    // Re-validate server-side — never trust the client's status for edited
    // rows, since a "fix" the user typed could still be wrong or newly
    // collide with another row in the same batch.
    const revalidated = validateRow(row, seenPhones);
    if (revalidated.status !== 'ok') {
      return { ...revalidated, outcome: 'skipped' };
    }
    try {
      const info = insert.run(
        req.companyId,
        revalidated.name,
        revalidated.phone,
        revalidated.address,
        revalidated.lat,
        revalidated.lng,
        revalidated.notes
      );
      return { ...revalidated, outcome: 'created', shopId: info.lastInsertRowid };
    } catch (err) {
      return { ...revalidated, outcome: 'skipped', reasons: [...revalidated.reasons, 'تعذر الحفظ'] };
    }
  });

  const createdCount = results.filter((r) => r.outcome === 'created').length;
  const skippedCount = results.length - createdCount;

  if (batchId) {
    db.prepare(
      `UPDATE shop_import_batches SET created_count = ?, skipped_count = ?, status = 'committed' WHERE id = ? AND company_id = ?`
    ).run(createdCount, skippedCount, batchId, req.companyId);
  }

  res.json({ results, createdCount, skippedCount });
});

module.exports = router;
