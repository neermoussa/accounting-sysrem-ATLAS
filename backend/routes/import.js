const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/init');
const { normalizePhone } = require('../lib/phone');
const { findShopByPhone } = require('../lib/shopLookup');
const { readSheetRows } = require('../lib/excelParse');
const { requirePermission } = require('../middleware/auth');
const { logAudit } = require('../lib/auditLog');
const { createNotification } = require('../lib/notify');
const { reconcileShopDay } = require('../lib/reconciliation');

const { isLedgerLive, recordExternalSnapshot } = require('../lib/customerLedger');

const router = express.Router();
router.use(requirePermission('import_amin'));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

function getSavedMapping(companyId) {
  return db.prepare('SELECT * FROM import_mapping WHERE company_id = ?').get(companyId) || null;
}

// Step 1: upload the file, return columns + sample rows + saved mapping (if any)
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  try {
    const { header, dataRows } = await readSheetRows(req.file.path);
    if (header.length === 0) {
      return res.status(400).json({ error: 'empty_file' });
    }
    const reportDate = req.body.report_date || new Date().toISOString().slice(0, 10);

    const info = db
      .prepare(
        `INSERT INTO import_batches (company_id, filename, report_date, status, uploaded_by_id, uploaded_by_name)
         VALUES (?, ?, ?, 'awaiting_mapping', ?, ?)`
      )
      .run(req.companyId, req.file.originalname, reportDate, req.user.id, req.user.name);

    // stash file path against the batch row via a side file so /stage can re-read it
    const stashPath = path.join(UPLOAD_DIR, `batch-${info.lastInsertRowid}.json`);
    fs.writeFileSync(stashPath, JSON.stringify({ filePath: req.file.path, header, dataRows }));

    res.json({
      batchId: info.lastInsertRowid,
      filename: req.file.originalname,
      reportDate,
      columns: header,
      sampleRows: dataRows.slice(0, 5),
      rowCount: dataRows.length,
      savedMapping: getSavedMapping(req.companyId),
    });
  } catch (err) {
    res.status(500).json({ error: 'parse_failed', detail: err.message });
  }
});

router.get('/mapping', (req, res) => {
  res.json(getSavedMapping(req.companyId));
});

router.put('/mapping', (req, res) => {
  const { phone_column, balance_column } = req.body;
  if (!phone_column || !balance_column) {
    return res.status(400).json({ error: 'phone_column_and_balance_column_required' });
  }
  db.prepare(
    `INSERT INTO import_mapping (company_id, phone_column, balance_column, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET phone_column = excluded.phone_column,
       balance_column = excluded.balance_column, updated_at = datetime('now')`
  ).run(req.companyId, phone_column, balance_column);
  res.json(getSavedMapping(req.companyId));
});

// Step 2: apply a column mapping to a batch, stage rows for review
router.post('/batches/:id/stage', (req, res) => {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });

  const { phone_column, balance_column, save_as_default } = req.body;
  if (!phone_column || !balance_column) {
    return res.status(400).json({ error: 'phone_column_and_balance_column_required' });
  }

  const stashPath = path.join(UPLOAD_DIR, `batch-${batch.id}.json`);
  if (!fs.existsSync(stashPath)) {
    return res.status(410).json({ error: 'upload_expired' });
  }
  const { filePath, header, dataRows } = JSON.parse(fs.readFileSync(stashPath, 'utf8'));

  const phoneIdx = header.indexOf(phone_column);
  const balanceIdx = header.indexOf(balance_column);
  if (phoneIdx === -1 || balanceIdx === -1) {
    return res.status(400).json({ error: 'column_not_found_in_file' });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM import_batch_rows WHERE batch_id = ?').run(batch.id);
    const insertRow = db.prepare(
      `INSERT INTO import_batch_rows (batch_id, phone_raw, balance_raw, matched_shop_id, status)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const row of dataRows) {
      const phoneRaw = row[phoneIdx];
      const balanceRaw = row[balanceIdx];
      const normalized = normalizePhone(phoneRaw);
      const balanceNum = Number(balanceRaw);
      const matchedShop = findShopByPhone(req.companyId, normalized);
      insertRow.run(
        batch.id,
        phoneRaw === null || phoneRaw === undefined ? '' : String(phoneRaw),
        Number.isFinite(balanceNum) ? balanceNum : 0,
        matchedShop ? matchedShop.id : null,
        matchedShop ? 'matched' : 'unmatched'
      );
    }
    db.prepare("UPDATE import_batches SET status = 'staged' WHERE id = ?").run(batch.id);

    if (save_as_default) {
      db.prepare(
        `INSERT INTO import_mapping (company_id, phone_column, balance_column, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(company_id) DO UPDATE SET phone_column = excluded.phone_column,
           balance_column = excluded.balance_column, updated_at = datetime('now')`
      ).run(req.companyId, phone_column, balance_column);
    }
  });
  tx();

  // clean up temp file + stash now that data lives in the DB
  try {
    fs.unlinkSync(filePath);
    fs.unlinkSync(stashPath);
  } catch (e) {
    /* best-effort cleanup */
  }

  res.json(getBatchReview(batch.id));
});

function getBatchReview(batchId) {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  const rows = db
    .prepare(
      `SELECT r.*, s.name as shop_name, s.phone as shop_phone
       FROM import_batch_rows r LEFT JOIN shops s ON s.id = r.matched_shop_id
       WHERE r.batch_id = ? ORDER BY r.id`
    )
    .all(batchId);
  const matchedCount = rows.filter((r) => r.status === 'matched' || r.status === 'linked').length;
  const unmatchedCount = rows.filter((r) => r.status === 'unmatched').length;
  const ignoredCount = rows.filter((r) => r.status === 'ignored').length;
  return { batch, rows, matchedCount, unmatchedCount, ignoredCount };
}

router.get('/batches', (req, res) => {
  const batches = db.prepare('SELECT * FROM import_batches WHERE company_id = ? ORDER BY id DESC LIMIT 20').all(req.companyId);
  res.json(batches);
});

router.get('/batches/:id', (req, res) => {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  res.json(getBatchReview(batch.id));
});

router.post('/batches/:id/rows/:rowId/link', (req, res) => {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  const row = db.prepare('SELECT * FROM import_batch_rows WHERE id = ? AND batch_id = ?').get(
    req.params.rowId,
    batch.id
  );
  if (!row) return res.status(404).json({ error: 'row_not_found' });
  const { shop_id, remember_alias } = req.body;
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(shop_id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });

  db.prepare(`UPDATE import_batch_rows SET matched_shop_id = ?, status = 'linked' WHERE id = ?`).run(
    shop.id,
    row.id
  );

  if (remember_alias) {
    const normalized = normalizePhone(row.phone_raw);
    if (normalized) {
      db.prepare(
        `INSERT INTO shop_phone_aliases (shop_id, phone) VALUES (?, ?)
         ON CONFLICT(phone) DO UPDATE SET shop_id = excluded.shop_id`
      ).run(shop.id, normalized);
    }
  }

  res.json(getBatchReview(batch.id));
});

router.post('/batches/:id/rows/:rowId/ignore', (req, res) => {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  const row = db.prepare('SELECT * FROM import_batch_rows WHERE id = ? AND batch_id = ?').get(
    req.params.rowId,
    batch.id
  );
  if (!row) return res.status(404).json({ error: 'row_not_found' });
  db.prepare(`UPDATE import_batch_rows SET status = 'ignored' WHERE id = ?`).run(row.id);
  res.json(getBatchReview(batch.id));
});

router.post('/batches/:id/commit', requirePermission('approve_import'), (req, res) => {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  if (batch.status === 'committed') {
    return res.status(409).json({ error: 'batch_already_committed' });
  }

  const rows = db
    .prepare(`SELECT * FROM import_batch_rows WHERE batch_id = ? AND status IN ('matched','linked')`)
    .all(batch.id);

  const upsertBalance = db.prepare(
    `INSERT INTO balances (shop_id, report_date, balance, source_file)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, report_date) DO UPDATE SET balance = excluded.balance,
       source_file = excluded.source_file, imported_at = datetime('now')`
  );

  // After go-live the ledger owns customer balances: an Amin balance is an
  // external reference snapshot, compared on the reconciliation screen and
  // never written over the ledger-derived balance. Before go-live this is
  // the original behaviour.
  const live = isLedgerLive(req.companyId);
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (live) {
        recordExternalSnapshot(req.companyId, {
          shopId: row.matched_shop_id, reportDate: batch.report_date, balance: row.balance_raw, sourceFile: batch.filename, batchId: batch.id,
        });
      } else {
        upsertBalance.run(row.matched_shop_id, batch.report_date, row.balance_raw, batch.filename);
      }
    }
    db.prepare(`UPDATE import_batches SET status = 'committed' WHERE id = ?`).run(batch.id);
  });
  tx();

  // One summary entry for the whole batch rather than one per shop — a
  // daily Amin report can touch dozens of shops at once, and per-shop
  // entries would drown out everything else in the activity log for what
  // is, from an audit standpoint, a single reviewed-and-approved action.
  logAudit({
    companyId: req.companyId,
    actor: req.user,
    action: 'balance_import_commit',
    entityType: 'import_batch',
    entityId: batch.id,
    shopId: null,
    before: null,
    after: { filename: batch.filename, report_date: batch.report_date, updatedShops: rows.length },
  });

  createNotification({
    companyId: req.companyId,
    type: 'import',
    message_ar: `تم رفع تقرير أمين جديد — ${batch.filename} (${rows.length} محل)`,
    message_en: `New Amin report uploaded — ${batch.filename} (${rows.length} shops)`,
    link_path: '/uploads',
    entity_type: 'import_batch',
    entity_id: batch.id,
  });

  // Now that this date's balances are in, cross-check every touched shop's
  // already-confirmed invoices for the same date against the balance delta
  // (see lib/reconciliation.js — the other direction, invoice-confirmed-
  // before-the-report-arrives, is triggered from routes/invoices.js instead).
  for (const row of rows) {
    reconcileShopDay(row.matched_shop_id, batch.report_date).catch((err) =>
      console.error('[reconcile] failed:', err.message)
    );
  }

  res.json({ updatedShops: rows.length, ...getBatchReview(batch.id) });
});

module.exports = router;
