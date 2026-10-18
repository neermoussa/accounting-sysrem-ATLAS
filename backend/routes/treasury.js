// /api/treasury — cash boxes and bank accounts, vouchers (RV/PV/EV/TR/BF),
// cheques issued, rep cash handovers, daily cash report, bank statement
// import + reconciliation (Prompt 7). Business rules: lib/treasury.js.
// Every id from the client is resolved through lib/tenantRefs.js there.

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { requirePermission, requireAnyPermission } = require('../middleware/auth');
const T = require('../lib/treasury');
const P = require('../lib/purchasing');
const ledger = require('../lib/ledger');
const tenantRefs = require('../lib/tenantRefs');
const { readSheetRows } = require('../lib/excelParse');
const { fromMinor } = require('../lib/ledgerCurrencies');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const { logAudit } = require('../lib/auditLog');
const db = require('../db/init');

const router = express.Router();
const VIEW = ['view_treasury', 'manage_cash_boxes', 'create_vouchers', 'approve_vouchers', 'manage_cheques', 'reconcile_bank'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `bankstmt-${Date.now()}-${path.basename(file.originalname).replace(/[^\w.\-]/g, '_')}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|csv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن يكون الملف بصيغة Excel (.xlsx) أو CSV'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

function handle(fn) {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof P.PurchasingError || err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError) {
        const { code, status, message, ...extra } = err;
        return res.status(status || 400).json({ error: code, message, ...extra });
      }
      next(err);
    }
  };
}
const created = (res, v) => {
  res.status(201);
  return v;
};
const id = (req) => req.params.id;

// ---- meta + settings ----
function settings(companyId) {
  return {
    rep_cash_handover: T.repCashEnabled(companyId),
    cheque_due_alert_days: Number(P.getSetting(companyId, 'cheque_due_alert_days', '3')),
    enforce_separation: P.separationEnforced(companyId),
  };
}
router.get('/meta', requireAnyPermission(...VIEW), handle((req) => {
  ledger.ensureLedgerSetup(req.companyId);
  return {
    base_currency: ledger.getBaseCurrency(req.companyId),
    currencies: ledger.listCurrencies(req.companyId).filter((c) => c.is_active),
    boxes: T.listBoxes(req.companyId, req.user),
    accounts: db.prepare("SELECT id, code, name_ar, type, system_key, currency_code FROM accounts WHERE company_id = ? AND is_active = 1 AND is_postable = 1 AND id NOT IN (SELECT account_id FROM cash_boxes WHERE company_id = ?) ORDER BY code").all(req.companyId, req.companyId),
    users: db.prepare("SELECT id, name FROM users WHERE company_id = ? AND status = 'approved' ORDER BY name").all(req.companyId),
    suppliers: db.prepare('SELECT id, name, currency_code FROM suppliers WHERE company_id = ? AND is_active = 1 ORDER BY name').all(req.companyId),
    settings: settings(req.companyId),
  };
}));
router.get('/settings', requireAnyPermission(...VIEW), handle((req) => settings(req.companyId)));
router.put('/settings', requirePermission('manage_cash_boxes'), handle((req) => {
  const before = settings(req.companyId);
  const b = req.body || {};
  if (b.repCashHandover !== undefined) {
    // Rep custody needs the ledger: stays OFF until go-live (which turns it on).
    if (b.repCashHandover && !require('../lib/customerLedger').isLedgerLive(req.companyId)) throw new P.PurchasingError('not_ledger_live', 'تسليم نقدية المندوبين يُفعَّل مع التحول إلى دفتر الأستاذ', 409);
    P.setSetting(req.companyId, 'rep_cash_handover', b.repCashHandover ? '1' : '0');
  }
  if (b.chequeDueAlertDays !== undefined) {
    const n = Number(b.chequeDueAlertDays);
    if (!Number.isInteger(n) || n < 0 || n > 60) throw new P.PurchasingError('invalid_days', 'عدد أيام التنبيه غير صالح (0–60)');
    P.setSetting(req.companyId, 'cheque_due_alert_days', n);
  }
  const after = settings(req.companyId);
  logAudit({ companyId: req.companyId, actor: req.user, action: 'treasury.settings.update', entityType: 'settings', entityId: null, before, after });
  return after;
}));

// ---- cash boxes ----
router.get('/boxes', requireAnyPermission(...VIEW), handle((req) => T.listBoxes(req.companyId, req.user, { includeInactive: req.query.all === '1' })));
router.get('/boxes/:id', requireAnyPermission(...VIEW), handle((req) => T.getBox(req.companyId, id(req), req.user)));
router.post('/boxes', requirePermission('manage_cash_boxes'), handle((req, res) => created(res, T.createBox(req.companyId, req.body || {}, req.user))));
router.put('/boxes/:id', requirePermission('manage_cash_boxes'), handle((req) => T.updateBox(req.companyId, id(req), req.body || {}, req.user)));

// ---- vouchers ----
router.get('/vouchers', requireAnyPermission(...VIEW), handle((req) => T.listVouchers(req.companyId, req.user, req.query)));
router.get('/vouchers/:id', requireAnyPermission(...VIEW), handle((req) => T.getVoucher(req.companyId, id(req))));
router.post('/vouchers', requirePermission('create_vouchers'), handle((req, res) => created(res, T.createVoucher(req.companyId, req.body || {}, req.user))));
router.put('/vouchers/:id', requirePermission('create_vouchers'), handle((req) => T.updateVoucher(req.companyId, id(req), req.body || {}, req.user)));
router.delete('/vouchers/:id', requirePermission('create_vouchers'), handle((req) => T.deleteVoucher(req.companyId, id(req), req.user)));
router.post('/vouchers/:id/approve', requirePermission('approve_vouchers'), handle((req) => require('../lib/postingQueue').guard(req.companyId, { kind: 'treasury_voucher.approve', sourceId: id(req), label: `سند خزينة #${id(req)}`, payload: { exchangeRate: req.body?.exchangeRate, rateQuote: req.body?.rateQuote } }, () => T.approveVoucher(req.companyId, id(req), req.body || {}, req.user), req.user)));
router.post('/vouchers/:id/reject', requirePermission('approve_vouchers'), handle((req) => T.rejectVoucher(req.companyId, id(req), req.body || {}, req.user)));
router.post('/vouchers/:id/reverse', requirePermission('approve_vouchers'), handle((req) => T.reverseVoucher(req.companyId, id(req), req.body || {}, req.user)));

// ---- cheques issued ----
router.get('/cheques', requireAnyPermission(...VIEW), handle((req) => T.listIssuedCheques(req.companyId, req.user, req.query)));
router.get('/cheques/:id', requireAnyPermission(...VIEW), handle((req) => T.getIssuedCheque(req.companyId, id(req))));
router.post('/cheques', requirePermission('manage_cheques'), handle((req, res) => created(res, T.issueCheque(req.companyId, req.body || {}, req.user))));
router.post('/cheques/:id/hand-over', requirePermission('manage_cheques'), handle((req) => T.handOverCheque(req.companyId, id(req), req.user)));
router.post('/cheques/:id/clear', requirePermission('manage_cheques'), handle((req) => T.clearIssuedCheque(req.companyId, id(req), req.body || {}, req.user)));
router.post('/cheques/:id/bounce', requirePermission('manage_cheques'), handle((req) => T.bounceIssuedCheque(req.companyId, id(req), req.body || {}, req.user)));
router.post('/cheques/:id/cancel', requirePermission('manage_cheques'), handle((req) => T.cancelIssuedCheque(req.companyId, id(req), req.body || {}, req.user)));

// ---- rep cash ----
router.get('/rep-cash', requireAnyPermission(...VIEW), handle((req) => ({ enabled: T.repCashEnabled(req.companyId), summary: T.repCashSummary(req.companyId) })));
router.get('/rep-cash/items', requireAnyPermission(...VIEW), handle((req) => T.repCashItems(req.companyId, tenantRefs.requireOwned(req.companyId, 'user', req.query.repId).id, req.query.currencyCode)));
router.get('/handovers', requireAnyPermission(...VIEW), handle((req) => T.listHandovers(req.companyId)));
router.get('/handovers/:id', requireAnyPermission(...VIEW), handle((req) => T.getHandover(req.companyId, id(req))));
router.post('/handovers', requirePermission('approve_vouchers'), handle((req, res) => created(res, T.createHandover(req.companyId, req.body || {}, req.user))));
router.post('/handovers/:id/reverse', requirePermission('approve_vouchers'), handle((req) => T.reverseHandover(req.companyId, id(req), req.body || {}, req.user)));

// ---- reports ----
router.get('/reports/daily-cash', requireAnyPermission(...VIEW), handle(async (req, res) => {
  const r = T.dailyCashReport(req.companyId, req.query.cashBoxId, req.query, req.user);
  if (req.query.format !== 'xlsx') return r;
  const lang = langFromQuery(req);
  const d = r.box.digits;
  const f = (m) => Number(fromMinor(m, d));
  const rows = [];
  for (const day of r.days) {
    rows.push({ date: day.date, entry: '', description: lang === 'en' ? 'Opening' : 'رصيد أول اليوم', in: '', out: '', balance: f(day.opening_minor) });
    let bal = day.opening_minor;
    for (const l of day.lines) {
      bal += l.in_minor - l.out_minor;
      rows.push({ date: day.date, entry: l.entry_number, description: l.memo || l.description, in: l.in_minor ? f(l.in_minor) : '', out: l.out_minor ? f(l.out_minor) : '', balance: f(bal) });
    }
  }
  const wb = new (require('exceljs').Workbook)();
  addSheet(wb, `${r.box.name}`.slice(0, 28), [
    { header: lang === 'en' ? 'Date' : 'التاريخ', key: 'date', width: 12 }, { header: lang === 'en' ? 'Entry' : 'القيد', key: 'entry', width: 14 },
    { header: lang === 'en' ? 'Description' : 'البيان', key: 'description', width: 40 }, { header: lang === 'en' ? 'In' : 'وارد', key: 'in', width: 14 },
    { header: lang === 'en' ? 'Out' : 'صادر', key: 'out', width: 14 }, { header: lang === 'en' ? 'Balance' : 'الرصيد', key: 'balance', width: 14 },
  ], rows, { lang });
  return sendWorkbook(res, wb, `daily-cash-${r.from}-${r.to}.xlsx`);
}));

// ---- bank statements + reconciliation ----
router.post('/bank/preview', requirePermission('reconcile_bank'), upload.single('file'), handle(async (req) => {
  let parsed;
  try {
    if (req.file) {
      parsed = /\.xlsx$/i.test(req.file.originalname) ? await readSheetRows(req.file.path) : T.parseCsv(fs.readFileSync(req.file.path, 'utf8'));
    } else {
      parsed = T.parseCsv(req.body?.csv || '');
    }
  } finally {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
  }
  const rows = parsed.dataRows.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c)));
  if (!rows.length) throw new P.PurchasingError('empty_file', 'الملف فارغ أو لا يحتوي أسطرًا');
  return { file_name: req.file?.originalname || null, header: parsed.header, rows, mapping: T.guessMapping(parsed.header) };
}));
router.post('/bank/statements', requirePermission('reconcile_bank'), handle((req, res) => created(res, T.importStatement(req.companyId, req.body || {}, req.user))));
router.get('/bank/statements', requireAnyPermission(...VIEW), handle((req) => T.listStatements(req.companyId, req.user, req.query)));
router.get('/bank/statements/:id', requireAnyPermission(...VIEW), handle((req) => T.getStatement(req.companyId, id(req), req.user)));
router.post('/bank/statements/:id/auto-match', requirePermission('reconcile_bank'), handle((req) => {
  const st = tenantRefs.requireOwned(req.companyId, 'bank_statement', id(req));
  T.usableBox(req.companyId, st.cash_box_id, req.user);
  const r = T.autoMatch(req.companyId, st.id);
  logAudit({ companyId: req.companyId, actor: req.user, action: 'treasury.bank.auto_match', entityType: 'bank_statement', entityId: st.id, before: null, after: r });
  return { ...r, statement: T.getStatement(req.companyId, st.id, req.user) };
}));
router.get('/bank/lines/:id/candidates', requireAnyPermission('reconcile_bank'), handle((req) => T.matchCandidates(req.companyId, id(req), req.user)));
router.post('/bank/lines/:id/review', requirePermission('reconcile_bank'), handle((req) => T.reviewLine(req.companyId, id(req), req.body || {}, req.user)));
router.get('/bank/reconciliation', requireAnyPermission(...VIEW), handle((req) => T.reconciliationReport(req.companyId, req.query.cashBoxId, req.query, req.user)));

module.exports = router;
