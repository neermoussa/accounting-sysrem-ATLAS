// /api/ledger — chart of accounts, fiscal periods, journal entries, opening
// balances and the integrity check. All business rules live in lib/ledger.js;
// this file only maps HTTP to it and enforces permissions.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requirePermission, requireAnyPermission, requireAllPermissions } = require('../middleware/auth');
const ledger = require('../lib/ledger');
const { readSheetRows } = require('../lib/excelParse');

const router = express.Router();

// Under uploads/ like other attachments, but deliberately NOT mounted with
// express.static in server.js — files are only served through the
// permission-checked download route below.
const ATTACH_DIR = path.join(__dirname, '..', 'uploads', 'journal-attachments');
const IMPORT_DIR = path.join(__dirname, '..', 'uploads', 'ledger-imports');
for (const dir of [ATTACH_DIR, IMPORT_DIR]) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const randomName = (file) => `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`;
const attachmentUpload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, ATTACH_DIR), filename: (req, file, cb) => cb(null, randomName(file)) }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|png|jpe?g|webp|xlsx|xls|docx?|csv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error('نوع الملف غير مسموح'), ok);
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});
const excelUpload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, IMPORT_DIR), filename: (req, file, cb) => cb(null, randomName(file)) }),
  fileFilter: (req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx)'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const VIEW = 'view_ledger';
const LEDGER_ANY = ['view_ledger', 'manage_accounts', 'post_journal_entries', 'reverse_journal_entries', 'manage_fiscal_periods', 'lock_fiscal_periods', 'manage_opening_balances'];

function handle(fn) {
  return async (req, res, next) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      if (err instanceof ledger.LedgerError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      if (/posted_entry_immutable|period_locked|period_has_entries/.test(err.message || '')) {
        return res.status(409).json({ error: err.message.match(/posted_entry_immutable|period_locked|period_has_entries/)[0], message: 'العملية مرفوضة: القيد المرحّل لا يُعدّل' });
      }
      next(err);
    }
  };
}

function id(req, name = 'id') {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new ledger.LedgerError('invalid_id', 'معرّف غير صالح', 400);
  return n;
}

// ---------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------

router.get('/meta', requireAnyPermission(...LEDGER_ANY), handle((req) => {
  ledger.ensureLedgerSetup(req.companyId);
  return {
    base_currency: ledger.getBaseCurrency(req.companyId),
    currencies: ledger.listCurrencies(req.companyId),
    branches: ledger.listBranches(req.companyId),
    cost_centers: ledger.listDimension(req.companyId, 'cost_center'),
    projects: ledger.listDimension(req.companyId, 'project'),
    templates: ledger.listCoaTemplates(),
    system_keys: ledger.SYSTEM_KEYS,
  };
}));

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

router.get('/accounts', requireAnyPermission(...LEDGER_ANY), handle((req) => ledger.listAccounts(req.companyId)));
router.post('/accounts', requirePermission('manage_accounts'), handle((req, res) => {
  res.status(201);
  return ledger.createAccount(req.companyId, req.body || {}, req.user);
}));
router.put('/accounts/:id', requirePermission('manage_accounts'), handle((req) => ledger.updateAccount(req.companyId, id(req), req.body || {}, req.user)));

router.get('/coa-templates', requireAnyPermission(...LEDGER_ANY), handle(() => ledger.listCoaTemplates()));
router.post('/coa-templates/:key/apply', requirePermission('manage_accounts'), handle((req) => ledger.applyCoaTemplate(req.companyId, req.params.key, req.user)));

// ---------------------------------------------------------------------
// Fiscal years & periods
// ---------------------------------------------------------------------

// Year rollover banner + failed-posting queue.
router.get('/year-status', requireAnyPermission(...LEDGER_ANY), handle((req) => require('../lib/yearRollover').yearStatus(req.companyId)));
router.get('/posting-failures', requireAnyPermission(...LEDGER_ANY), handle((req) => require('../lib/postingQueue').list(req.companyId, { status: req.query.status || 'open' })));
router.post('/posting-failures/:id/retry', requireAnyPermission('post_journal_entries', 'manage_fiscal_periods'), handle((req) => require('../lib/postingQueue').retry(req.companyId, req.params.id, req.user)));
router.get('/fiscal-years', requireAnyPermission(...LEDGER_ANY), handle((req) => ledger.listFiscalYears(req.companyId)));
router.post('/fiscal-years', requirePermission('manage_fiscal_periods'), handle((req, res) => {
  res.status(201);
  return ledger.createFiscalYear(req.companyId, req.body || {}, req.user);
}));
router.get('/periods', requireAnyPermission(...LEDGER_ANY), handle((req) => ledger.listPeriods(req.companyId, { fiscalYearId: req.query.fiscalYearId })));
router.post('/periods/:id/close', requirePermission('manage_fiscal_periods'), handle((req) => ledger.setPeriodStatus(req.companyId, id(req), 'close', req.user)));
router.post('/periods/:id/reopen', requirePermission('manage_fiscal_periods'), handle((req) => ledger.setPeriodStatus(req.companyId, id(req), 'reopen', req.user)));
router.post('/periods/:id/lock', requirePermission('lock_fiscal_periods'), handle((req) => ledger.setPeriodStatus(req.companyId, id(req), 'lock', req.user)));

// ---------------------------------------------------------------------
// Cost centers & projects
// ---------------------------------------------------------------------

for (const [route, kind] of [['cost-centers', 'cost_center'], ['projects', 'project']]) {
  router.get(`/${route}`, requireAnyPermission(...LEDGER_ANY), handle((req) => ledger.listDimension(req.companyId, kind)));
  router.post(`/${route}`, requirePermission('manage_accounts'), handle((req, res) => {
    res.status(201);
    return ledger.saveDimension(req.companyId, kind, null, req.body || {}, req.user);
  }));
  router.put(`/${route}/:id`, requirePermission('manage_accounts'), handle((req) => ledger.saveDimension(req.companyId, kind, id(req), req.body || {}, req.user)));
}

// ---------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------

router.get('/entries', requirePermission(VIEW), handle((req) => ledger.listEntries(req.companyId, req.query)));
router.get('/entries/:id', requirePermission(VIEW), handle((req) => {
  const entry = ledger.getEntry(req.companyId, id(req));
  if (!entry) throw new ledger.LedgerError('not_found', 'القيد غير موجود', 404);
  return entry;
}));

// body.post === true creates and posts in one step; otherwise saves a draft.
router.post('/entries', requirePermission('post_journal_entries'), handle((req, res) => {
  const body = req.body || {};
  // Manual entries from the API are always source_type 'manual'; system
  // sources are reserved for modules calling lib/ledger.js directly.
  const input = { ...body, sourceType: 'manual', sourceId: null };
  res.status(201);
  return body.post ? ledger.postEntry(req.companyId, input, req.user) : ledger.createDraft(req.companyId, input, req.user);
}));
router.put('/entries/:id', requirePermission('post_journal_entries'), handle((req) => {
  const { sourceType, sourceId, ...rest } = req.body || {};
  return ledger.updateDraft(req.companyId, id(req), rest, req.user);
}));
router.delete('/entries/:id', requirePermission('post_journal_entries'), handle((req) => ledger.deleteDraft(req.companyId, id(req), req.user)));
router.post('/entries/:id/post', requirePermission('post_journal_entries'), handle((req) => ledger.postDraft(req.companyId, id(req), req.user)));
router.post('/entries/:id/reverse', requirePermission('reverse_journal_entries'), handle((req) =>
  ledger.reverseEntry(req.companyId, id(req), { date: req.body?.date, reason: req.body?.reason }, req.user)
));

router.post('/entries/:id/attachments', requirePermission('post_journal_entries'), attachmentUpload.single('file'), handle((req, res) => {
  if (!req.file) throw new ledger.LedgerError('file_required', 'الملف مطلوب', 400);
  res.status(201);
  try {
    return ledger.addAttachment(req.companyId, id(req), req.file, req.user);
  } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    throw err;
  }
}));
router.get('/attachments/:id', requirePermission(VIEW), handle((req, res) => {
  const att = ledger.getAttachment(req.companyId, id(req));
  if (!att || !att.file_path.startsWith(ATTACH_DIR) || !fs.existsSync(att.file_path)) {
    throw new ledger.LedgerError('not_found', 'المرفق غير موجود', 404);
  }
  // Always send the RFC 5987 form so the frontend's downloadFile() picks up
  // the original name (it only reads filename*=UTF-8'').
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.original_name)}`);
  res.sendFile(att.file_path);
}));

// ---------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------

router.get('/opening-balances', requireAnyPermission(VIEW, 'manage_opening_balances'), handle((req) => {
  const list = ledger.listEntries(req.companyId, { sourceType: 'opening_balance', limit: 100 });
  return list.entries;
}));
router.post('/opening-balances/preview', requirePermission('manage_opening_balances'), handle((req) =>
  ledger.previewOpeningBalances(req.companyId, req.body?.rows || [])
));
// The only way to reverse an opening-balance entry (the generic journal
// reverse refuses entries that come from a document).
router.post('/opening-balances/:id/reverse', requireAllPermissions('manage_opening_balances', 'reverse_journal_entries'), handle((req) => {
  const entry = ledger.getEntry(req.companyId, id(req));
  if (!entry || entry.source_type !== 'opening_balance') throw new ledger.LedgerError('not_found', 'قيد الأرصدة الافتتاحية غير موجود', 404);
  return ledger.reverseEntry(req.companyId, entry.id, { date: req.body?.date, reason: req.body?.reason || 'عكس الأرصدة الافتتاحية', fromSource: true }, req.user);
}));
router.post('/opening-balances', requirePermission('manage_opening_balances'), handle((req, res) => {
  res.status(201);
  return ledger.postOpeningBalances(req.companyId, req.body || {}, req.user);
}));

// Trial-balance Excel: columns "code" (رمز الحساب), "debit" (مدين),
// "credit" (دائن). Returns the same preview the manual screen uses; the
// user reviews it and then posts with POST /opening-balances.
const HEADER_ALIASES = {
  code: ['code', 'account code', 'account', 'رمز الحساب', 'الرمز', 'رقم الحساب'],
  debit: ['debit', 'مدين'],
  credit: ['credit', 'دائن'],
};
router.post('/opening-balances/upload', requirePermission('manage_opening_balances'), excelUpload.single('file'), handle(async (req) => {
  if (!req.file) throw new ledger.LedgerError('file_required', 'الملف مطلوب', 400);
  try {
    const { header, dataRows } = await readSheetRows(req.file.path);
    const norm = header.map((h) => String(h || '').trim().toLowerCase());
    const col = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) col[key] = norm.findIndex((h) => aliases.includes(h));
    if (col.code < 0 || col.debit < 0 || col.credit < 0) {
      throw new ledger.LedgerError('invalid_headers', 'يجب أن يحتوي الملف على الأعمدة: رمز الحساب، مدين، دائن', 400);
    }
    const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v).trim());
    const rows = dataRows.map((r) => ({ accountCode: cell(r[col.code]), debit: cell(r[col.debit]), credit: cell(r[col.credit]) }));
    return ledger.previewOpeningBalances(req.companyId, rows);
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
}));

// ---------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------

router.get('/integrity-check', requirePermission(VIEW), handle((req) => ledger.ledgerIntegrityCheck(req.companyId)));

module.exports = router;
