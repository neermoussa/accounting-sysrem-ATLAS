// backend/lib/ledger.js
//
// The ONE posting service for the double-entry ledger. Nothing else in the
// codebase may INSERT/UPDATE/DELETE journal_entries or journal_lines — other
// modules call postEntry()/reverseEntry() here. db/ledgerSchema.js adds
// triggers that enforce the immutability rules at the SQL level as well.
//
// Rules enforced here:
//  1. postEntry runs in one SQLite transaction; debits must equal credits in
//     BASE currency minor units, or nothing is written.
//  2. Only postable (leaf), active accounts; the line currency must be the
//     account's currency when the account has one.
//  3. The entry date must fall inside an OPEN fiscal period. Closed/locked
//     periods reject posting, reversing into them, and draft edits.
//  4. Posted entries are never edited or deleted — only reversed, once.
//  5. Drafts can be edited/deleted; posting turns a draft into a posted entry.
//  6. System entries need source_type + source_id; the same source cannot
//     post twice unless the earlier entry was reversed.
//  7. Every action is audit-logged; ledgerIntegrityCheck() verifies the books.

const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const { logAudit } = require('./auditLog');
const documentNumbering = require('./documentNumbering');
const tenantRefs = require('./tenantRefs');
const reportClasses = require('./reportClass');
const fx = require('./fxRate');
const customerLedger = require('./customerLedger');
const { ensureCurrencies, toMinor, fromMinor, rateToPpm, convertToBaseMinor } = require('./ledgerCurrencies');

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const DEFAULT_NORMAL = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit' };
const SYSTEM_KEYS = [
  'ar_control', 'ap_control', 'cash_default', 'inventory', 'cogs',
  'sales_revenue', 'fx_realized', 'fx_unrealized', 'grni', 'input_tax', 'purchase_price_variance', 'retained_earnings', 'opening_balance_equity', 'rounding_difference',
  'bank_in_transit', 'sales_returns', 'output_tax', 'cheques_in_portfolio',
  'rep_cash_custody', 'cheques_payable', 'cash_over_short', 'bank_charges',
  'inventory_custody', 'inventory_adjustments', 'inventory_wastage',
  'wip', 'production_labour', 'production_overhead', 'production_energy',
];
const TEMPLATE_DIR = path.join(__dirname, 'coaTemplates');
const BRANCH_NAMES_SQL = `SELECT trim(CASE WHEN j.type = 'text' THEN j.value ELSE json_extract(j.value, '$.name') END) AS n
  FROM companies c, json_each(CASE WHEN json_valid(c.branches_json) THEN c.branches_json ELSE '[]' END) j WHERE c.id = ?`;

class LedgerError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function fail(code, message, status = 400, extra) {
  throw new LedgerError(code, message, status, extra);
}

// Every client-supplied id goes through lib/tenantRefs.js (the one shared
// ownership check); its error is re-thrown as a LedgerError with the same
// code so routes report it uniformly. `prefix` adds the line number.
function owned(companyId, kind, id, opts, prefix = '') {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, prefix + err.message);
    throw err;
  }
}

function ownedParty(companyId, partyType, partyId, prefix = '') {
  try {
    return tenantRefs.requireParty(companyId, partyType, partyId);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, prefix + err.message);
    throw err;
  }
}

// Outermost call: BEGIN IMMEDIATE (write lock up front — see
// db/sqliteConfig.js); nested inside a caller's transaction: a savepoint,
// so ledger calls run inside other modules' transactions or standalone.
let spCounter = 0;
function tx(fn) {
  if (!db.isTransaction) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  const name = `ledger_sp_${++spCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}

function actorOf(actor) {
  return actor ? { id: actor.id, name: actor.name } : null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---------------------------------------------------------------------
// Setup helpers: currencies, branches
// ---------------------------------------------------------------------

function ensureLedgerSetup(companyId) {
  ensureCurrencies(db, companyId);
  syncBranches(companyId);
}

function listCurrencies(companyId) {
  ensureCurrencies(db, companyId);
  return db.prepare('SELECT * FROM currencies WHERE company_id = ? ORDER BY is_base DESC, code').all(companyId);
}

function getCurrency(companyId, code) {
  return db.prepare('SELECT * FROM currencies WHERE company_id = ? AND code = ?').get(companyId, code);
}

function getBaseCurrency(companyId) {
  ensureCurrencies(db, companyId);
  return db.prepare('SELECT * FROM currencies WHERE company_id = ? AND is_base = 1').get(companyId);
}

// branches_ref mirrors companies.branches_json. The triggers in
// db/ledgerSchema.js keep it in sync on every write to that column; this is
// the same rule in JS for companies created before the triggers existed.
// A branch removed from (or renamed in) branches_json is deactivated, never
// deleted, so entries that reference it keep a valid branch_id.
function syncBranches(companyId) {
  db.prepare(`INSERT OR IGNORE INTO branches_ref (company_id, name) SELECT ?, n FROM (${BRANCH_NAMES_SQL}) WHERE n IS NOT NULL AND n <> ''`)
    .run(companyId, companyId);
  db.prepare(`UPDATE branches_ref SET is_active = CASE WHEN name IN (${BRANCH_NAMES_SQL}) THEN 1 ELSE 0 END WHERE company_id = ?`)
    .run(companyId, companyId);
}

function listBranches(companyId) {
  syncBranches(companyId);
  return db.prepare('SELECT * FROM branches_ref WHERE company_id = ? ORDER BY name').all(companyId);
}

// ---------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------

function getAccount(companyId, id) {
  return db.prepare('SELECT * FROM accounts WHERE company_id = ? AND id = ?').get(companyId, id);
}

function getAccountBySystemKey(companyId, key) {
  return db.prepare('SELECT * FROM accounts WHERE company_id = ? AND system_key = ?').get(companyId, key);
}

function accountHasLines(accountId) {
  return !!db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(accountId);
}

function listAccounts(companyId, { includeInactive = true } = {}) {
  const rows = db
    .prepare(
      `SELECT a.*,
         COALESCE((SELECT SUM(l.debit_minor) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                   WHERE l.account_id = a.id AND e.status IN ('posted','reversed')), 0) AS debit_total_minor,
         COALESCE((SELECT SUM(l.credit_minor) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                   WHERE l.account_id = a.id AND e.status IN ('posted','reversed')), 0) AS credit_total_minor,
         EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = a.id) AS is_used
       FROM accounts a WHERE a.company_id = ? ${includeInactive ? '' : 'AND a.is_active = 1'}
       ORDER BY a.code`
    )
    .all(companyId);
  return rows.map((r) => ({ ...r, is_used: !!r.is_used }));
}

function normalizeAccountInput(companyId, input, existing) {
  const out = {};
  if (input.code !== undefined || !existing) {
    const code = String(input.code ?? '').trim();
    if (!code) fail('code_required', 'رمز الحساب مطلوب');
    if (!/^[0-9A-Za-z.\-]{1,20}$/.test(code)) fail('invalid_code', 'رمز الحساب غير صالح');
    out.code = code;
  }
  if (input.nameAr !== undefined || !existing) {
    const nameAr = String(input.nameAr ?? '').trim();
    if (!nameAr) fail('name_required', 'اسم الحساب بالعربية مطلوب');
    out.name_ar = nameAr;
  }
  if (input.nameEn !== undefined) out.name_en = input.nameEn ? String(input.nameEn).trim() : null;
  if (input.currencyCode !== undefined) {
    const cc = input.currencyCode ? String(input.currencyCode).toUpperCase() : null;
    if (cc && !getCurrency(companyId, cc)) fail('invalid_currency', 'العملة غير معرّفة');
    out.currency_code = cc;
  }
  return out;
}

function createAccount(companyId, input, actor) {
  ensureLedgerSetup(companyId);
  return tx(() => {
    const fields = normalizeAccountInput(companyId, input, null);
    let parent = null;
    if (input.parentId) {
      parent = owned(companyId, 'account', input.parentId);
    }
    const type = input.type || parent?.type;
    if (!ACCOUNT_TYPES.includes(type)) fail('invalid_type', 'نوع الحساب غير صالح');
    if (parent && parent.type !== type) fail('parent_type_mismatch', 'يجب أن يكون نوع الحساب مطابقًا لنوع الحساب الأب');
    const normal = input.normalBalance || DEFAULT_NORMAL[type];
    if (!['debit', 'credit'].includes(normal)) fail('invalid_normal_balance', 'طبيعة الرصيد غير صالحة');
    // Report class: given; else contra_asset for a credit-normal asset; else
    // the parent's; else the type default.
    let reportClass = input.reportClass || (type === 'asset' && normal === 'credit' ? 'contra_asset' : null);
    if (!reportClass && parent && reportClasses.isValidFor(type, parent.report_class) && parent.report_class !== 'contra_asset') reportClass = parent.report_class;
    if (!reportClass) reportClass = reportClasses.DEFAULT_BY_TYPE[type];
    if (!reportClasses.isValidFor(type, reportClass)) fail('invalid_report_class', 'تصنيف التقارير لا يناسب نوع الحساب');
    if (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(companyId, fields.code)) {
      fail('duplicate_code', 'رمز الحساب مستخدم مسبقًا', 409);
    }
    if (parent) {
      // The parent becomes a header account: only leaves accept postings.
      if (accountHasLines(parent.id)) fail('parent_has_entries', 'لا يمكن إضافة حساب فرعي تحت حساب عليه قيود');
      if (parent.is_postable) db.prepare("UPDATE accounts SET is_postable = 0, updated_at = datetime('now') WHERE id = ?").run(parent.id);
    }
    const info = db
      .prepare(
        `INSERT INTO accounts (company_id, code, name_ar, name_en, parent_id, type, normal_balance, is_postable, is_active, currency_code, report_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
      )
      .run(companyId, fields.code, fields.name_ar, fields.name_en ?? null, parent?.id ?? null, type, normal, fields.currency_code ?? null, reportClass);
    const created = getAccount(companyId, Number(info.lastInsertRowid));
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.account.create', entityType: 'account', entityId: created.id, before: null, after: created });
    return created;
  });
}

function updateAccount(companyId, id, input, actor) {
  return tx(() => {
    const before = getAccount(companyId, id);
    if (!before) fail('not_found', 'الحساب غير موجود', 404);
    const fields = normalizeAccountInput(companyId, input, before);
    if (fields.code && fields.code !== before.code) {
      if (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ? AND id <> ?').get(companyId, fields.code, id)) {
        fail('duplicate_code', 'رمز الحساب مستخدم مسبقًا', 409);
      }
    }
    if (input.type !== undefined && input.type !== before.type) fail('type_locked', 'لا يمكن تغيير نوع الحساب');
    if (input.reportClass !== undefined && input.reportClass !== before.report_class) {
      // Editable at any time: it only changes where reports SHOW the account.
      if (!reportClasses.isValidFor(before.type, input.reportClass)) fail('invalid_report_class', 'تصنيف التقارير لا يناسب نوع الحساب');
      fields.report_class = input.reportClass;
    }
    if (input.isActive !== undefined) {
      const active = input.isActive ? 1 : 0;
      if (!active && before.is_system) fail('system_account', 'لا يمكن تعطيل حساب نظامي');
      fields.is_active = active;
    }
    if (fields.currency_code !== undefined && fields.currency_code !== before.currency_code && accountHasLines(id)) {
      fail('currency_locked', 'لا يمكن تغيير عملة حساب عليه قيود');
    }
    const keys = Object.keys(fields);
    if (keys.length) {
      db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`).run(
        ...keys.map((k) => fields[k]),
        id,
        companyId
      );
    }
    const after = getAccount(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.account.update', entityType: 'account', entityId: id, before, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Chart-of-accounts templates
// ---------------------------------------------------------------------

function listCoaTemplates() {
  return fs
    .readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const t = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, f), 'utf8'));
      return { key: t.key, nameAr: t.name_ar, nameEn: t.name_en, accountCount: t.accounts.length };
    });
}

function loadCoaTemplate(key) {
  if (!/^[a-z_]+$/.test(String(key || ''))) fail('invalid_template', 'القالب غير موجود', 404);
  const file = path.join(TEMPLATE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) fail('invalid_template', 'القالب غير موجود', 404);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hasPostedEntries(companyId) {
  return !!db.prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND status IN ('posted','reversed') LIMIT 1").get(companyId);
}

// Upserts the template's accounts by code. Accounts not in the template are
// deactivated (never deleted). Refuses once the company has posted entries.
function applyCoaTemplate(companyId, templateKey, actor) {
  const template = loadCoaTemplate(templateKey);
  ensureLedgerSetup(companyId);
  return tx(() => {
    if (hasPostedEntries(companyId)) fail('has_posted_entries', 'لا يمكن تطبيق قالب دليل الحسابات بعد ترحيل قيود', 409);
    const before = db.prepare('SELECT code, name_ar, system_key, is_active FROM accounts WHERE company_id = ? ORDER BY code').all(companyId);
    const parentCodes = new Set(template.accounts.map((a) => a.parent).filter(Boolean));
    const templateCodes = new Set(template.accounts.map((a) => a.code));

    db.prepare('UPDATE accounts SET system_key = NULL, is_system = 0 WHERE company_id = ?').run(companyId);
    const upsert = db.prepare(
      `INSERT INTO accounts (company_id, code, name_ar, name_en, type, normal_balance, is_postable, is_active, is_system, system_key, report_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(company_id, code) DO UPDATE SET name_ar = excluded.name_ar, name_en = excluded.name_en, type = excluded.type,
         normal_balance = excluded.normal_balance, is_postable = excluded.is_postable, is_active = 1,
         is_system = excluded.is_system, system_key = excluded.system_key, report_class = excluded.report_class, updated_at = datetime('now')`
    );
    for (const a of template.accounts) {
      if (!ACCOUNT_TYPES.includes(a.type)) fail('invalid_template', `نوع غير صالح في القالب: ${a.code}`);
      if (a.report_class && !reportClasses.isValidFor(a.type, a.report_class)) fail('invalid_template', `تصنيف تقارير غير صالح في القالب: ${a.code}`);
      upsert.run(
        companyId, a.code, a.name_ar, a.name_en ?? null, a.type, a.normal_balance || DEFAULT_NORMAL[a.type],
        parentCodes.has(a.code) ? 0 : 1, a.system_key ? 1 : 0, a.system_key ?? null, a.report_class || reportClasses.DEFAULT_BY_TYPE[a.type]
      );
    }
    const idByCode = new Map(db.prepare('SELECT id, code FROM accounts WHERE company_id = ?').all(companyId).map((r) => [r.code, r.id]));
    const setParent = db.prepare('UPDATE accounts SET parent_id = ? WHERE id = ?');
    for (const a of template.accounts) setParent.run(a.parent ? idByCode.get(a.parent) : null, idByCode.get(a.code));
    const deactivate = db.prepare("UPDATE accounts SET is_active = 0, updated_at = datetime('now') WHERE id = ?");
    for (const [code, id] of idByCode) if (!templateCodes.has(code)) deactivate.run(id);

    const missing = SYSTEM_KEYS.filter((k) => !getAccountBySystemKey(companyId, k));
    if (missing.length) fail('invalid_template', `القالب ينقصه حسابات نظامية: ${missing.join(', ')}`);
    db.prepare(
      `INSERT INTO settings (company_id, key, value) VALUES (?, 'coa_template', ?)
       ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
    ).run(companyId, template.key);
    logAudit({
      companyId, actor: actorOf(actor), action: 'ledger.coa_template.apply', entityType: 'coa_template', entityId: null,
      before: { accounts: before.length }, after: { template: template.key, accounts: template.accounts.length },
    });
    return { template: template.key, accounts: listAccounts(companyId) };
  });
}

// ---------------------------------------------------------------------
// Fiscal years & periods
// ---------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function createFiscalYear(companyId, { year, startMonth = 1 }, actor) {
  const y = Number(year);
  const sm = Number(startMonth);
  if (!Number.isInteger(y) || y < 1990 || y > 2200) fail('invalid_year', 'السنة المالية غير صالحة');
  if (!Number.isInteger(sm) || sm < 1 || sm > 12) fail('invalid_start_month', 'شهر البداية غير صالح');
  return tx(() => {
    if (db.prepare('SELECT 1 FROM fiscal_years WHERE company_id = ? AND year = ?').get(companyId, y)) {
      fail('duplicate_year', 'السنة المالية موجودة مسبقًا', 409);
    }
    const periods = [];
    for (let i = 0; i < 12; i++) {
      const m0 = sm - 1 + i;
      const py = y + Math.floor(m0 / 12);
      const pm = (m0 % 12) + 1;
      periods.push({ number: i + 1, start: `${py}-${pad2(pm)}-01`, end: `${py}-${pad2(pm)}-${pad2(lastDayOfMonth(py, pm))}` });
    }
    const start = periods[0].start;
    const end = periods[11].end;
    const overlap = db
      .prepare('SELECT 1 FROM fiscal_years WHERE company_id = ? AND NOT (end_date < ? OR start_date > ?)')
      .get(companyId, start, end);
    if (overlap) fail('overlapping_year', 'السنة المالية تتداخل مع سنة موجودة', 409);
    const info = db
      .prepare('INSERT INTO fiscal_years (company_id, year, start_date, end_date) VALUES (?, ?, ?, ?)')
      .run(companyId, y, start, end);
    const fyId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO fiscal_periods (company_id, fiscal_year_id, year, number, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const p of periods) ins.run(companyId, fyId, y, p.number, p.start, p.end);
    const fy = db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(fyId);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.fiscal_year.create', entityType: 'fiscal_year', entityId: fyId, before: null, after: fy });
    return { ...fy, periods: listPeriods(companyId, { fiscalYearId: fyId }) };
  });
}

function listFiscalYears(companyId) {
  return db.prepare('SELECT * FROM fiscal_years WHERE company_id = ? ORDER BY start_date DESC').all(companyId);
}

function listPeriods(companyId, { fiscalYearId } = {}) {
  const where = ['p.company_id = ?'];
  const params = [companyId];
  if (fiscalYearId) {
    where.push('p.fiscal_year_id = ?');
    params.push(Number(fiscalYearId));
  }
  return db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM journal_entries e WHERE e.period_id = p.id AND e.status IN ('posted','reversed')) AS posted_count,
              (SELECT COUNT(*) FROM journal_entries e WHERE e.company_id = p.company_id AND e.status = 'draft'
                 AND e.entry_date BETWEEN p.start_date AND p.end_date) AS draft_count
       FROM fiscal_periods p WHERE ${where.join(' AND ')} ORDER BY p.start_date`
    )
    .all(...params);
}

function getPeriod(companyId, id) {
  return db.prepare('SELECT * FROM fiscal_periods WHERE company_id = ? AND id = ?').get(companyId, id);
}

function findPeriodForDate(companyId, date) {
  return db
    .prepare('SELECT * FROM fiscal_periods WHERE company_id = ? AND start_date <= ? AND end_date >= ?')
    .get(companyId, date, date);
}

function requireOpenPeriod(companyId, date) {
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  const period = findPeriodForDate(companyId, date);
  if (!period) fail('no_period', 'لا توجد فترة مالية تغطي هذا التاريخ');
  if (period.status !== 'open') {
    fail(period.status === 'locked' ? 'period_locked' : 'period_closed', period.status === 'locked' ? 'الفترة المالية مقفلة نهائيًا' : 'الفترة المالية مغلقة', 409);
  }
  return period;
}

// action: 'close' | 'reopen' | 'lock'. Permission checks live in the route
// (reopen/close need manage_fiscal_periods; lock needs lock_fiscal_periods).
function setPeriodStatus(companyId, periodId, action, actor) {
  return tx(() => {
    const before = getPeriod(companyId, periodId);
    if (!before) fail('not_found', 'الفترة غير موجودة', 404);
    if (before.status === 'locked') fail('period_locked', 'الفترة المالية مقفلة نهائيًا ولا يمكن تعديلها', 409);
    let sql;
    if (action === 'close') {
      if (before.status !== 'open') fail('invalid_transition', 'الفترة ليست مفتوحة', 409);
      sql = "UPDATE fiscal_periods SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ?";
    } else if (action === 'reopen') {
      if (before.status !== 'closed') fail('invalid_transition', 'الفترة ليست مغلقة', 409);
      sql = "UPDATE fiscal_periods SET status = 'open', closed_at = NULL, closed_by = ? WHERE id = ?";
    } else if (action === 'lock') {
      // Closing stays advisory (month-end checklist); LOCKING is final, so it
      // is refused while the period has draft entries or the receivables
      // control account disagreed with the customer sub-ledgers at the
      // period end.
      const drafts = db
        .prepare("SELECT COUNT(*) c FROM journal_entries WHERE company_id = ? AND status = 'draft' AND entry_date BETWEEN ? AND ?")
        .get(companyId, before.start_date, before.end_date).c;
      if (drafts) fail('lock_blocked_drafts', `لا يمكن قفل الفترة نهائيًا: فيها ${drafts} قيد مسودة — رحّلها أو احذفها أولًا`, 409, { drafts });
      // As of the period end: differences created later do not block it.
      const recon = require('./receivables').reconciliationCheck(companyId, { asOf: before.end_date });
      if (recon.difference_minor) {
        fail('lock_blocked_ar_reconciliation', 'لا يمكن قفل الفترة نهائيًا: حساب الذمم المدينة لا يطابق مجموع حسابات الزبائن — راجع تقرير المطابقة', 409, { difference_minor: recon.difference_minor });
      }
      sql = "UPDATE fiscal_periods SET status = 'locked', locked_at = datetime('now'), locked_by = ? WHERE id = ?";
    } else {
      fail('invalid_action', 'إجراء غير صالح');
    }
    db.prepare(sql).run(actor?.id ?? null, periodId);
    const after = getPeriod(companyId, periodId);
    logAudit({ companyId, actor: actorOf(actor), action: `ledger.period.${action}`, entityType: 'fiscal_period', entityId: periodId, before, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Dimensions: cost centers, projects
// ---------------------------------------------------------------------

const DIMENSION_TABLES = { cost_center: 'cost_centers', project: 'projects' };

function listDimension(companyId, kind) {
  return db.prepare(`SELECT * FROM ${DIMENSION_TABLES[kind]} WHERE company_id = ? ORDER BY code`).all(companyId);
}

function saveDimension(companyId, kind, id, input, actor) {
  const table = DIMENSION_TABLES[kind];
  return tx(() => {
    const before = id ? db.prepare(`SELECT * FROM ${table} WHERE company_id = ? AND id = ?`).get(companyId, id) : null;
    if (id && !before) fail('not_found', 'العنصر غير موجود', 404);
    const code = input.code !== undefined ? String(input.code).trim() : before?.code;
    const name = input.name !== undefined ? String(input.name).trim() : before?.name;
    if (!code || !name) fail('code_name_required', 'الرمز والاسم مطلوبان');
    const dup = db.prepare(`SELECT id FROM ${table} WHERE company_id = ? AND code = ?`).get(companyId, code);
    if (dup && dup.id !== id) fail('duplicate_code', 'الرمز مستخدم مسبقًا', 409);
    const active = input.isActive === undefined ? (before ? before.is_active : 1) : input.isActive ? 1 : 0;
    let rowId = id;
    if (before) {
      db.prepare(`UPDATE ${table} SET code = ?, name = ?, is_active = ? WHERE id = ?`).run(code, name, active, id);
    } else {
      rowId = Number(db.prepare(`INSERT INTO ${table} (company_id, code, name, is_active) VALUES (?, ?, ?, ?)`).run(companyId, code, name, active).lastInsertRowid);
    }
    const after = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId);
    logAudit({ companyId, actor: actorOf(actor), action: `ledger.${kind}.${before ? 'update' : 'create'}`, entityType: kind, entityId: rowId, before, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Line validation
// ---------------------------------------------------------------------

// Accepts API lines ({accountId, debit, credit} as decimal strings in the
// LINE currency, optional currencyCode/exchangeRate) or internal lines
// ({accountId, debitMinor, creditMinor} already in base minor units).
// Returns lines ready to insert, with base-currency debit_minor/credit_minor.
function normalizeLines(companyId, lines, { forPosting }) {
  if (!Array.isArray(lines)) fail('invalid_lines', 'بنود القيد غير صالحة');
  const base = getBaseCurrency(companyId);
  const out = [];
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const lineFail = (code, msg) => fail(code, `السطر ${n}: ${msg}`, 400, { line: n });
    const account = owned(companyId, 'account', raw.accountId, {}, `السطر ${n}: `);
    if (forPosting || raw.accountId) {
      if (!account.is_active) lineFail('inactive_account', `الحساب ${account.code} غير فعّال`);
      if (!account.is_postable) lineFail('non_postable_account', `الحساب ${account.code} حساب رئيسي لا يقبل الترحيل`);
    }
    const currencyCode = String(raw.currencyCode || raw.currency_code || base.code).toUpperCase();
    const currency = getCurrency(companyId, currencyCode);
    if (!currency || !currency.is_active) lineFail('invalid_currency', 'العملة غير معرّفة');
    if (account.currency_code && account.currency_code !== currencyCode) {
      lineFail('currency_not_allowed', `الحساب ${account.code} لا يقبل إلا ${account.currency_code}`);
    }

    let debitMinor;
    let creditMinor;
    let originalMinor;
    let rateE8 = Number(fx.SCALE);
    let rateQuote = 'base_per_foreign';
    const internal = raw.debitMinor !== undefined || raw.creditMinor !== undefined;
    const fxFail = (err) => {
      if (err instanceof fx.FxError) lineFail(err.code, err.message);
      throw err;
    };
    if (internal) {
      debitMinor = Number(raw.debitMinor || 0);
      creditMinor = Number(raw.creditMinor || 0);
      if (!Number.isSafeInteger(debitMinor) || !Number.isSafeInteger(creditMinor) || debitMinor < 0 || creditMinor < 0) {
        lineFail('invalid_amount', 'مبلغ غير صالح');
      }
      if (currencyCode === base.code) {
        originalMinor = debitMinor || creditMinor;
      } else {
        originalMinor = Number(raw.amountOriginalMinor);
        // Internal callers pass the exact rate (rateE8 + rateQuote); the
        // legacy ppm form (base per foreign x1e6) is still accepted.
        if (raw.rateE8 !== undefined && raw.rateE8 !== null) {
          rateE8 = Number(raw.rateE8);
          rateQuote = raw.rateQuote || 'base_per_foreign';
        } else {
          rateE8 = Number(raw.exchangeRatePpm) * 100;
          rateQuote = 'base_per_foreign';
        }
        if (!Number.isSafeInteger(originalMinor) || originalMinor <= 0 || !Number.isSafeInteger(rateE8) || rateE8 <= 0 || !fx.QUOTES.includes(rateQuote)) {
          lineFail('rate_required', 'المبلغ الأصلي وسعر الصرف مطلوبان للعملة الأجنبية');
        }
      }
    } else {
      const d = toMinor(raw.debit, currency.minor_unit_digits);
      const c = toMinor(raw.credit, currency.minor_unit_digits);
      if (d < 0 || c < 0) lineFail('negative_amount', 'لا يُسمح بالمبالغ السالبة');
      if ((d > 0) === (c > 0)) lineFail('one_side_required', 'يجب إدخال مدين أو دائن (أحدهما فقط)');
      originalMinor = d || c;
      let baseMinor = originalMinor;
      if (currencyCode !== base.code) {
        if (raw.exchangeRate === undefined || raw.exchangeRate === null || raw.exchangeRate === '') {
          lineFail('rate_required', 'سعر الصرف مطلوب للعملة الأجنبية');
        }
        try {
          ({ rateE8, quote: rateQuote } = fx.parseRate(raw.exchangeRate, raw.rateQuote || 'base_per_foreign', { foreign: currencyCode, base: base.code }));
          baseMinor = fx.toBaseMinor(originalMinor, rateE8, rateQuote, currency.minor_unit_digits, base.minor_unit_digits);
        } catch (err) {
          fxFail(err);
        }
      }
      if (baseMinor <= 0) lineFail('zero_amount', 'المبلغ بعد التحويل يساوي صفرًا');
      debitMinor = d > 0 ? baseMinor : 0;
      creditMinor = c > 0 ? baseMinor : 0;
    }
    if ((debitMinor > 0) === (creditMinor > 0)) lineFail('one_side_required', 'يجب إدخال مدين أو دائن (أحدهما فقط)');

    const costCenterId = raw.costCenterId ? owned(companyId, 'cost_center', raw.costCenterId, { active: true }, `السطر ${n}: `).id : null;
    const projectId = raw.projectId ? owned(companyId, 'project', raw.projectId, { active: true }, `السطر ${n}: `).id : null;
    const { partyType, partyId } = ownedParty(companyId, raw.partyType || null, raw.partyId, `السطر ${n}: `);

    out.push({
      line_no: n,
      account_id: account.id,
      debit_minor: debitMinor,
      credit_minor: creditMinor,
      currency_code: currencyCode,
      amount_original_minor: originalMinor,
      exchange_rate_ppm: fx.legacyPpm(rateE8, rateQuote),
      rate_e8: rateE8,
      rate_quote: rateQuote,
      cost_center_id: costCenterId,
      project_id: projectId,
      party_type: partyType,
      party_id: partyId,
      memo: raw.memo ? String(raw.memo).slice(0, 500) : null,
    });
  });
  return out;
}

function totals(lines) {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit_minor;
    credit += l.credit_minor;
  }
  return { debit, credit, difference: debit - credit };
}

// Foreign-currency lines are each rounded to the base minor unit once; the
// sum of those roundings (at most half a unit per converted line) is posted
// to rounding_difference so the entry balances exactly. Anything larger is a
// real imbalance and is left for assertBalanced to refuse.
function plugFxRounding(companyId, lines) {
  const base = getBaseCurrency(companyId);
  const converted = lines.filter((l) => l.currency_code !== base.code).length;
  if (!converted) return lines;
  const diff = totals(lines).difference;
  if (!diff || Math.abs(diff) * 2 > converted) return lines;
  const acc = getAccountBySystemKey(companyId, 'rounding_difference');
  if (!acc) fail('missing_system_account', 'حساب فروقات التقريب غير معرّف', 409);
  return [
    ...lines,
    {
      line_no: lines.length + 1, account_id: acc.id, debit_minor: diff < 0 ? -diff : 0, credit_minor: diff > 0 ? diff : 0,
      currency_code: base.code, amount_original_minor: Math.abs(diff), exchange_rate_ppm: 1000000, rate_e8: Number(fx.SCALE), rate_quote: 'base_per_foreign',
      cost_center_id: null, project_id: null, party_type: null, party_id: null, memo: 'فرق تقريب تحويل العملات',
    },
  ];
}

function assertBalanced(lines) {
  if (lines.length < 2) fail('too_few_lines', 'يجب أن يحتوي القيد على سطرين على الأقل');
  const t = totals(lines);
  if (t.debit !== t.credit) fail('unbalanced', 'القيد غير متوازن: مجموع المدين لا يساوي مجموع الدائن', 400, { difference_minor: t.difference });
  if (t.debit === 0) fail('zero_entry', 'لا يمكن ترحيل قيد بقيمة صفر');
}

function validateBranch(companyId, branchId) {
  if (!branchId) return null;
  syncBranches(companyId);
  return owned(companyId, 'branch', branchId, { active: true }).id;
}

// ---------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------

const insertLineSql = `INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, debit_minor, credit_minor, currency_code,
  amount_original_minor, exchange_rate_ppm, rate_e8, rate_quote, cost_center_id, project_id, party_type, party_id, memo)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// The exact rate of a stored line (older lines only have the ppm column).
function lineRate(l) {
  return l.rate_e8 ? { rateE8: l.rate_e8, rateQuote: l.rate_quote || 'base_per_foreign' } : { rateE8: l.exchange_rate_ppm * 100, rateQuote: 'base_per_foreign' };
}

function insertLines(companyId, entryId, lines) {
  const ins = db.prepare(insertLineSql);
  for (const l of lines) {
    ins.run(entryId, companyId, l.line_no, l.account_id, l.debit_minor, l.credit_minor, l.currency_code,
      l.amount_original_minor, l.exchange_rate_ppm, l.rate_e8, l.rate_quote, l.cost_center_id, l.project_id, l.party_type, l.party_id, l.memo);
  }
}

function getEntryRow(companyId, id) {
  return db.prepare('SELECT * FROM journal_entries WHERE company_id = ? AND id = ?').get(companyId, id);
}

function getLines(entryId) {
  return db
    .prepare(
      `SELECT l.*, a.code AS account_code, a.name_ar AS account_name_ar, a.name_en AS account_name_en,
              cc.name AS cost_center_name, p.name AS project_name
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
       LEFT JOIN projects p ON p.id = l.project_id
       WHERE l.entry_id = ? ORDER BY l.line_no`
    )
    .all(entryId);
}

function getEntry(companyId, id) {
  const entry = getEntryRow(companyId, id);
  if (!entry) return null;
  const base = getBaseCurrency(companyId);
  const lines = getLines(id).map((l) => {
    const cur = getCurrency(companyId, l.currency_code);
    return {
      ...l,
      debit: fromMinor(l.debit_minor, base.minor_unit_digits),
      credit: fromMinor(l.credit_minor, base.minor_unit_digits),
      amount_original: fromMinor(l.amount_original_minor, cur ? cur.minor_unit_digits : base.minor_unit_digits),
      exchange_rate: fx.formatRate(lineRate(l).rateE8),
      rate_quote: lineRate(l).rateQuote,
    };
  });
  const t = totals(lines);
  const link = (otherId) => (otherId ? db.prepare('SELECT id, entry_number FROM journal_entries WHERE id = ?').get(otherId) : null);
  return {
    ...entry,
    base_currency: base.code,
    lines,
    total_debit_minor: t.debit,
    total_credit_minor: t.credit,
    total_debit: fromMinor(t.debit, base.minor_unit_digits),
    total_credit: fromMinor(t.credit, base.minor_unit_digits),
    is_balanced: t.debit === t.credit && t.debit > 0,
    reverses: link(entry.reverses_entry_id),
    reversed_by: link(entry.reversed_by_entry_id),
    branch: entry.branch_id ? db.prepare('SELECT id, name FROM branches_ref WHERE id = ?').get(entry.branch_id) : null,
    attachments: db.prepare('SELECT id, original_name, created_at FROM journal_attachments WHERE entry_id = ? ORDER BY id').all(id),
    created_by_name: entry.created_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(entry.created_by)?.name : null,
    posted_by_name: entry.posted_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(entry.posted_by)?.name : null,
  };
}

function listEntries(companyId, filters = {}) {
  const where = ['e.company_id = ?'];
  const params = [companyId];
  if (filters.status) {
    where.push('e.status = ?');
    params.push(String(filters.status));
  }
  if (filters.from) {
    where.push('e.entry_date >= ?');
    params.push(String(filters.from));
  }
  if (filters.to) {
    where.push('e.entry_date <= ?');
    params.push(String(filters.to));
  }
  if (filters.sourceType) {
    where.push('e.source_type = ?');
    params.push(String(filters.sourceType));
  }
  if (filters.accountId) {
    where.push('EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND l.account_id = ?)');
    params.push(Number(filters.accountId));
  }
  if (filters.q) {
    where.push('(e.entry_number LIKE ? OR e.description LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const base = getBaseCurrency(companyId);
  const total = db.prepare(`SELECT COUNT(*) c FROM journal_entries e WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT e.*,
         COALESCE((SELECT SUM(debit_minor) FROM journal_lines WHERE entry_id = e.id), 0) AS total_debit_minor,
         COALESCE((SELECT SUM(credit_minor) FROM journal_lines WHERE entry_id = e.id), 0) AS total_credit_minor
       FROM journal_entries e WHERE ${where.join(' AND ')}
       ORDER BY e.entry_date DESC, e.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
    .map((r) => ({
      ...r,
      total_debit: fromMinor(r.total_debit_minor, base.minor_unit_digits),
      total_credit: fromMinor(r.total_credit_minor, base.minor_unit_digits),
    }));
  return { total, entries: rows, base_currency: base.code };
}

function normalizeHeader(companyId, input, existing) {
  const date = input.date ?? input.entryDate ?? existing?.entry_date;
  if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
  const sourceType = input.sourceType ? String(input.sourceType) : existing?.source_type || 'manual';
  const sourceId = input.sourceId !== undefined && input.sourceId !== null ? Number(input.sourceId) : existing?.source_id ?? null;
  if (sourceType !== 'manual' && !Number.isInteger(sourceId)) fail('source_required', 'القيود الآلية تتطلب نوع ومعرّف المستند المصدر');
  return {
    date,
    description: input.description !== undefined ? String(input.description || '').slice(0, 1000) : existing?.description ?? null,
    branchId: input.branchId !== undefined ? validateBranch(companyId, input.branchId) : existing?.branch_id ?? null,
    sourceType,
    sourceId,
  };
}

function createDraft(companyId, input, actor) {
  ensureLedgerSetup(companyId);
  return tx(() => {
    const h = normalizeHeader(companyId, input, null);
    const period = requireOpenPeriod(companyId, h.date);
    const lines = normalizeLines(companyId, input.lines || [], { forPosting: false });
    const info = db
      .prepare(
        `INSERT INTO journal_entries (company_id, entry_date, period_id, branch_id, description, source_type, source_id, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(companyId, h.date, period.id, h.branchId, h.description, h.sourceType, h.sourceId, actor?.id ?? null);
    const id = Number(info.lastInsertRowid);
    insertLines(companyId, id, lines);
    const after = getEntry(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.entry.create_draft', entityType: 'journal_entry', entityId: id, before: null, after });
    return after;
  });
}

function requireDraft(companyId, id) {
  const entry = getEntryRow(companyId, id);
  if (!entry) fail('not_found', 'القيد غير موجود', 404);
  if (entry.status !== 'draft') fail('entry_not_draft', 'القيد المرحّل لا يمكن تعديله أو حذفه — استخدم العكس', 409);
  return entry;
}

function updateDraft(companyId, id, input, actor) {
  return tx(() => {
    const existing = requireDraft(companyId, id);
    const before = getEntry(companyId, id);
    requireOpenPeriod(companyId, existing.entry_date); // edits in closed periods are rejected
    const h = normalizeHeader(companyId, input, existing);
    const period = requireOpenPeriod(companyId, h.date);
    db.prepare(
      `UPDATE journal_entries SET entry_date = ?, period_id = ?, branch_id = ?, description = ?, source_type = ?, source_id = ?, updated_at = datetime('now')
       WHERE id = ? AND company_id = ?`
    ).run(h.date, period.id, h.branchId, h.description, h.sourceType, h.sourceId, id, companyId);
    if (input.lines !== undefined) {
      const lines = normalizeLines(companyId, input.lines, { forPosting: false });
      db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(id);
      insertLines(companyId, id, lines);
    }
    const after = getEntry(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.entry.update_draft', entityType: 'journal_entry', entityId: id, before, after });
    return after;
  });
}

function deleteDraft(companyId, id, actor) {
  return tx(() => {
    requireDraft(companyId, id);
    const before = getEntry(companyId, id);
    db.prepare('DELETE FROM journal_attachments WHERE entry_id = ?').run(id);
    db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(id);
    db.prepare('DELETE FROM journal_entries WHERE id = ? AND company_id = ?').run(id, companyId);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.entry.delete_draft', entityType: 'journal_entry', entityId: id, before, after: null });
    return { ok: true };
  });
}

// JE numbers come from the shared documentNumbering sequence. A company
// that never configured the 'JE' type gets the 'JE-' prefix by default; an
// existing configuration is never overwritten.
function issueEntryNumber(companyId) {
  if (!db.prepare("SELECT 1 FROM document_number_sequences WHERE company_id = ? AND document_type = 'JE'").get(companyId)) {
    documentNumbering.setConfig(companyId, 'JE', { prefix: 'JE-' });
  }
  return documentNumbering.issueNext(companyId, 'JE');
}

function assertSourceFree(companyId, sourceType, sourceId, exceptId) {
  if (sourceId === null || sourceId === undefined) return;
  const clash = db
    .prepare("SELECT id, entry_number FROM journal_entries WHERE company_id = ? AND source_type = ? AND source_id = ? AND status = 'posted' AND id <> ?")
    .get(companyId, sourceType, sourceId, exceptId ?? 0);
  if (clash) fail('source_already_posted', `هذا المستند مرحّل مسبقًا بالقيد ${clash.entry_number}`, 409, { entry_id: clash.id });
}

// Turns a draft into a posted entry. Re-validates every line against the
// current account/currency state and requires an exact base-currency balance.
function postDraft(companyId, id, actor) {
  return tx(() => {
    const entry = requireDraft(companyId, id);
    const period = requireOpenPeriod(companyId, entry.entry_date);
    const stored = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(id);
    let lines = normalizeLines(
      companyId,
      stored.map((l) => ({
        accountId: l.account_id, debitMinor: l.debit_minor, creditMinor: l.credit_minor, currencyCode: l.currency_code,
        amountOriginalMinor: l.amount_original_minor, ...lineRate(l), costCenterId: l.cost_center_id,
        projectId: l.project_id, partyType: l.party_type, partyId: l.party_id, memo: l.memo,
      })),
      { forPosting: true }
    );
    const plugged = plugFxRounding(companyId, lines);
    if (plugged.length > lines.length) {
      // The draft keeps its lines; the rounding line is added while it is
      // still a draft, then the entry is posted.
      const extra = plugged[plugged.length - 1];
      extra.line_no = Math.max(...stored.map((l) => l.line_no)) + 1;
      insertLines(companyId, id, [extra]);
    }
    lines = plugged;
    assertBalanced(lines);
    assertSourceFree(companyId, entry.source_type, entry.source_id, id);
    const number = issueEntryNumber(companyId);
    db.prepare(
      `UPDATE journal_entries SET status = 'posted', entry_number = ?, period_id = ?, posted_by = ?, posted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND company_id = ? AND status = 'draft'`
    ).run(number, period.id, actor?.id ?? null, id, companyId);
    const after = getEntry(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.entry.post', entityType: 'journal_entry', entityId: id, before: { status: 'draft' }, after });
    // Live companies: customer balances are derived from the ledger.
    customerLedger.afterEntryPosted(companyId, id);
    return after;
  });
}

// One-shot create-and-post. This is the API every other module uses.
// { date, description, sourceType, sourceId, branchId, idempotencyKey, lines }
function postEntry(companyId, input, actor) {
  ensureLedgerSetup(companyId);
  return tx(() => {
    const key = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 200) : null;
    if (key) {
      const existing = db.prepare('SELECT id, status FROM journal_entries WHERE company_id = ? AND idempotency_key = ?').get(companyId, key);
      if (existing) {
        if (existing.status === 'draft') fail('idempotency_conflict', 'مفتاح التكرار مستخدم لقيد مسودة', 409);
        return { ...getEntry(companyId, existing.id), idempotent_replay: true };
      }
    }
    const h = normalizeHeader(companyId, input, null);
    const period = requireOpenPeriod(companyId, h.date);
    const lines = plugFxRounding(companyId, normalizeLines(companyId, input.lines || [], { forPosting: true }));
    assertBalanced(lines);
    assertSourceFree(companyId, h.sourceType, h.sourceId);
    const info = db
      .prepare(
        `INSERT INTO journal_entries (company_id, entry_date, period_id, branch_id, description, source_type, source_id, status,
           reverses_entry_id, reversal_reason, idempotency_key, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
      )
      .run(companyId, h.date, period.id, h.branchId, h.description, h.sourceType, h.sourceId,
        input.reversesEntryId ?? null, input.reversalReason ?? null, key, actor?.id ?? null);
    const id = Number(info.lastInsertRowid);
    insertLines(companyId, id, lines);
    const number = issueEntryNumber(companyId);
    db.prepare(
      `UPDATE journal_entries SET status = 'posted', entry_number = ?, posted_by = ?, posted_at = datetime('now') WHERE id = ?`
    ).run(number, actor?.id ?? null, id);
    const after = getEntry(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'ledger.entry.post', entityType: 'journal_entry', entityId: id, before: null, after });
    customerLedger.afterEntryPosted(companyId, id);
    return after;
  });
}

// Entries created by a document can only be reversed through that
// document's own action, which also updates the document's status. The
// message names the action to use.
const SOURCE_REVERSE_ACTIONS = {
  collection: 'اعكس التحصيل من شاشة التحصيل (زر "عكس التحصيل") — يُعاد فتح الفواتير ويصبح التحصيل معكوسًا',
  customer_receipt: 'اعكس سند القبض من شاشة سندات القبض، أو سجّل "ارتداد الشيك" إن كان السند لشيك',
  sales_invoice: 'ألغِ الفاتورة من شاشة فواتير المبيعات ("إلغاء الفاتورة" يصدر إشعار دائن)',
  sales_credit_note: 'إشعار الدائن لا يُعكس — أصدر فاتورة مبيعات جديدة بالقيمة نفسها',
  opening_balance: 'اعكس الأرصدة الافتتاحية من شاشة الأرصدة الافتتاحية',
  customer_opening: 'قيود التحول إلى دفتر الأستاذ لا تُعكس — التراجع باستعادة النسخة الاحتياطية (docs/go-live-rollback.md)',
  customer_open_item: 'قيود التحول إلى دفتر الأستاذ لا تُعكس — التراجع باستعادة النسخة الاحتياطية (docs/go-live-rollback.md)',
  fx_realized: 'فرق الصرف المحقق يُلغى بإلغاء تخصيص سند القبض أو عكس السند',
  fx_revaluation: 'إعادة التقييم تُعكس تلقائيًا في أول يوم من الفترة التالية',
  goods_receipt: 'سند الاستلام لا يُعكس من شاشة القيود — أعد البضاعة بإشعار مدين بعد فاتورة المورد',
  supplier_invoice: 'فاتورة المورد لا تُعكس — أصدر إشعار مدين من شاشة فواتير الموردين',
  supplier_payment: 'اعكس دفعة المورد من شاشة دفعات الموردين ("عكس الدفعة")',
  supplier_debit_note: 'إشعار المدين لا يُعكس — سجّل فاتورة مورد جديدة بالقيمة نفسها',
  fx_realized_ap: 'فرق الصرف المحقق يُلغى بإلغاء تخصيص دفعة المورد أو عكسها',
  year_end_close: 'ألغِ إقفال السنة من شاشة إقفال السنة المالية ("إلغاء الإقفال") — مسموح فقط قبل أول قيد في السنة التالية',
  cheque_clear: 'تحصيل الشيك لا يُعكس من هنا — يُعالج في مطابقة البنوك',
  treasury_voucher: 'اعكس السند من شاشة الخزينة ("عكس السند")',
  stock_move: 'حركة المخزون لا تُعكس من شاشة القيود — سجّل حركة معاكسة (تسوية، تحويل عكسي، أو إلغاء المستند الأصلي)',
  inventory_opening: 'الرصيد الافتتاحي للمخزون لا يُعكس — صحّح بتسوية مخزون',
  cheque_issued_clear: 'صرف الشيك الصادر لا يُعكس من هنا — سجّل ارتداد الشيك من شاشة الشيكات الصادرة',
  cheque_issued: 'ألغِ الشيك الصادر أو سجّل ارتداده من شاشة الشيكات الصادرة',
  rep_cash_handover: 'اعكس تسليم النقدية من شاشة تسليم نقدية المندوبين',
  fixed_asset: 'قيد اقتناء الأصل لا يُعكس من هنا — استبعد الأصل من سجل الأصول الثابتة',
  fa_depreciation: 'قيود الإهلاك لا تُعكس من شاشة القيود — تُرحّل مرة واحدة لكل أصل ولكل شهر من شاشة الأصول الثابتة',
  fa_disposal: 'قيد استبعاد الأصل لا يُعكس من شاشة القيود',
  recurring_run: 'قيود القوالب الدورية لا تُعكس من شاشة القيود — أوقف القالب، وسجّل قيدًا يدويًا معاكسًا عند الحاجة',
  mfg_order: 'قيود أوامر الإنتاج لا تُعكس من شاشة القيود — أعد المواد غير المستخدمة إلى المخزون أو ارفض الدفعة من شاشة أمر الإنتاج',
};

function reverseEntry(companyId, entryId, { date, reason, fromSource = false } = {}, actor) {
  return tx(() => {
    const original = getEntryRow(companyId, entryId);
    if (!original) fail('not_found', 'القيد غير موجود', 404);
    if (!fromSource && original.source_type !== 'manual' && original.source_type !== 'reversal') {
      const action = SOURCE_REVERSE_ACTIONS[original.source_type] || 'هذا القيد صادر عن مستند — اعكسه من شاشة ذلك المستند';
      fail('reverse_via_source', `لا يمكن عكس هذا القيد من شاشة القيود: ${action}`, 409, { source_type: original.source_type, source_id: original.source_id });
    }
    if (original.status === 'reversed') fail('already_reversed', 'تم عكس هذا القيد مسبقًا', 409);
    if (original.status !== 'posted') fail('not_posted', 'لا يمكن عكس قيد غير مرحّل', 409);
    if (original.reverses_entry_id) fail('cannot_reverse_reversal', 'لا يمكن عكس قيد عكسي', 409);
    const reversalDate = date || today();
    const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(entryId);
    const reasonText = reason ? String(reason).slice(0, 500) : null;
    const reversal = postEntry(
      companyId,
      {
        date: reversalDate,
        description: `عكس القيد ${original.entry_number}${reasonText ? ` — ${reasonText}` : ''}`,
        sourceType: 'reversal',
        sourceId: original.id,
        branchId: original.branch_id,
        reversesEntryId: original.id,
        reversalReason: reasonText,
        lines: lines.map((l) => ({
          accountId: l.account_id,
          debitMinor: l.credit_minor,
          creditMinor: l.debit_minor,
          currencyCode: l.currency_code,
          amountOriginalMinor: l.amount_original_minor,
          ...lineRate(l),
          costCenterId: l.cost_center_id,
          projectId: l.project_id,
          partyType: l.party_type,
          partyId: l.party_id,
          memo: l.memo,
        })),
      },
      actor
    );
    db.prepare("UPDATE journal_entries SET status = 'reversed', reversed_by_entry_id = ? WHERE id = ? AND status = 'posted'").run(reversal.id, original.id);
    logAudit({
      companyId, actor: actorOf(actor), action: 'ledger.entry.reverse', entityType: 'journal_entry', entityId: original.id,
      before: { status: 'posted' }, after: { status: 'reversed', reversed_by_entry_id: reversal.id, reason: reasonText },
    });
    // Documents that depend on this entry follow it (a reversed receipt
    // frees its invoice allocations). Same transaction.
    require('./receivables').onEntryReversed(companyId, original, reversal, actor);
    return { original: getEntry(companyId, original.id), reversal: getEntry(companyId, reversal.id) };
  });
}

// ---------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------

function addAttachment(companyId, entryId, file, actor) {
  const entry = getEntryRow(companyId, entryId);
  if (!entry) fail('not_found', 'القيد غير موجود', 404);
  const info = db
    .prepare('INSERT INTO journal_attachments (company_id, entry_id, file_path, original_name, uploaded_by) VALUES (?, ?, ?, ?, ?)')
    .run(companyId, entryId, file.path, file.originalname, actor?.id ?? null);
  const row = db.prepare('SELECT id, entry_id, original_name, created_at FROM journal_attachments WHERE id = ?').get(Number(info.lastInsertRowid));
  logAudit({ companyId, actor: actorOf(actor), action: 'ledger.entry.attach', entityType: 'journal_entry', entityId: entryId, before: null, after: row });
  return row;
}

function getAttachment(companyId, attachmentId) {
  return db.prepare('SELECT * FROM journal_attachments WHERE company_id = ? AND id = ?').get(companyId, attachmentId);
}

// ---------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------

// Resolves rows ({accountId | accountCode, debit, credit}) in base currency
// and reports per-row errors instead of throwing, so the Excel review step
// can show every problem at once.
function previewOpeningBalances(companyId, rows) {
  ensureLedgerSetup(companyId);
  const base = getBaseCurrency(companyId);
  const obe = getAccountBySystemKey(companyId, 'opening_balance_equity');
  const out = [];
  let debit = 0;
  let credit = 0;
  (rows || []).forEach((r, i) => {
    const row = { row: i + 1, accountCode: r.accountCode ?? null, accountId: r.accountId ?? null, debit: r.debit ?? '', credit: r.credit ?? '', errors: [] };
    let account;
    try {
      account = r.accountId ? tenantRefs.requireOwned(companyId, 'account', r.accountId) : null;
    } catch (err) {
      if (!(err instanceof tenantRefs.ForeignRefError)) throw err;
      account = null;
    }
    account = r.accountId
      ? account
      : db.prepare('SELECT * FROM accounts WHERE company_id = ? AND code = ?').get(companyId, String(r.accountCode ?? '').trim());
    if (!account) row.errors.push('الحساب غير موجود');
    else {
      row.accountId = account.id;
      row.accountCode = account.code;
      row.accountName = account.name_ar;
      if (!account.is_active) row.errors.push('الحساب غير فعّال');
      if (!account.is_postable) row.errors.push('حساب رئيسي لا يقبل الترحيل');
      if (account.currency_code && account.currency_code !== base.code) row.errors.push('الحساب بعملة أجنبية');
    }
    let d = 0;
    let c = 0;
    try {
      d = toMinor(r.debit, base.minor_unit_digits);
      c = toMinor(r.credit, base.minor_unit_digits);
      if (d < 0 || c < 0) row.errors.push('لا يُسمح بالمبالغ السالبة');
      else if (d > 0 && c > 0) row.errors.push('أدخل مدينًا أو دائنًا فقط');
    } catch (err) {
      row.errors.push(err.message);
    }
    row.debitMinor = d;
    row.creditMinor = c;
    if (!row.errors.length) {
      debit += d;
      credit += c;
    }
    if (d === 0 && c === 0 && !row.errors.length) row.skipped = true;
    out.push(row);
  });
  return {
    base_currency: base.code,
    rows: out,
    error_count: out.filter((r) => r.errors.length).length,
    total_debit_minor: debit,
    total_credit_minor: credit,
    difference_minor: debit - credit,
    total_debit: fromMinor(debit, base.minor_unit_digits),
    total_credit: fromMinor(credit, base.minor_unit_digits),
    difference: fromMinor(debit - credit, base.minor_unit_digits),
    opening_equity_account: obe ? { id: obe.id, code: obe.code, name_ar: obe.name_ar } : null,
  };
}

// ONE posted entry per fiscal year, dated at the year's start. If the rows
// do not balance on their own the caller must explicitly ask to post the
// difference to opening_balance_equity (plugToOpeningEquity: true).
function postOpeningBalances(companyId, { fiscalYearId, rows, plugToOpeningEquity }, actor) {
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE company_id = ? AND id = ?').get(companyId, Number(fiscalYearId));
  if (!fy) fail('not_found', 'السنة المالية غير موجودة', 404);
  const preview = previewOpeningBalances(companyId, rows);
  if (preview.error_count) fail('invalid_rows', 'توجد أخطاء في الأسطر', 400, { preview });
  const lines = preview.rows
    .filter((r) => !r.skipped)
    .map((r) => ({ accountId: r.accountId, debitMinor: r.debitMinor, creditMinor: r.creditMinor }));
  if (!lines.length) fail('empty', 'لا توجد أرصدة لترحيلها');
  if (preview.difference_minor !== 0) {
    if (!plugToOpeningEquity) {
      fail('opening_unbalanced', 'الأرصدة الافتتاحية غير متوازنة', 400, { difference_minor: preview.difference_minor, difference: preview.difference });
    }
    const obe = getAccountBySystemKey(companyId, 'opening_balance_equity');
    if (!obe) fail('missing_system_account', 'حساب الأرصدة الافتتاحية غير معرّف — طبّق قالب دليل الحسابات أولًا');
    const diff = preview.difference_minor;
    lines.push({ accountId: obe.id, debitMinor: diff < 0 ? -diff : 0, creditMinor: diff > 0 ? diff : 0, memo: 'فرق الأرصدة الافتتاحية' });
  }
  return postEntry(
    companyId,
    { date: fy.start_date, description: `الأرصدة الافتتاحية للسنة ${fy.year}`, sourceType: 'opening_balance', sourceId: fy.id, lines },
    actor
  );
}

// ---------------------------------------------------------------------
// Integrity check
// ---------------------------------------------------------------------

function ledgerIntegrityCheck(companyId) {
  const violations = [];
  const push = (type, row, message) => violations.push({ type, entry_id: row.id ?? row.entry_id ?? null, entry_number: row.entry_number ?? null, message });

  for (const r of db
    .prepare(
      `SELECT e.id, e.entry_number, COALESCE(SUM(l.debit_minor),0) d, COALESCE(SUM(l.credit_minor),0) c, COUNT(l.id) n
       FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') GROUP BY e.id`
    )
    .all(companyId)) {
    if (r.n < 2) push('too_few_lines', r, 'قيد مرحّل بأقل من سطرين');
    if (r.d !== r.c) push('unbalanced', r, `قيد غير متوازن (مدين ${r.d} ≠ دائن ${r.c})`);
  }
  for (const r of db
    .prepare(
      `SELECT l.entry_id, e.entry_number, l.line_no FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN accounts a ON a.id = l.account_id AND a.company_id = e.company_id
       WHERE e.company_id = ? AND a.id IS NULL`
    )
    .all(companyId)) {
    push('invalid_account', r, `السطر ${r.line_no} يشير إلى حساب غير صالح`);
  }
  for (const r of db
    .prepare(
      `SELECT l.entry_id, e.entry_number, l.line_no FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND (l.company_id <> e.company_id OR (l.debit_minor > 0) = (l.credit_minor > 0))`
    )
    .all(companyId)) {
    push('invalid_line', r, `السطر ${r.line_no} غير صالح`);
  }
  for (const r of db
    .prepare(
      `SELECT e.id, e.entry_number FROM journal_entries e LEFT JOIN fiscal_periods p ON p.id = e.period_id AND p.company_id = e.company_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed')
         AND (p.id IS NULL OR e.entry_date < p.start_date OR e.entry_date > p.end_date)`
    )
    .all(companyId)) {
    push('invalid_period', r, 'قيد مرحّل في فترة محذوفة أو خارج حدود فترته');
  }
  for (const r of db
    .prepare(
      `SELECT e.id, e.entry_number FROM journal_entries e
       LEFT JOIN journal_entries r ON r.id = e.reversed_by_entry_id
       WHERE e.company_id = ? AND e.status = 'reversed' AND (r.id IS NULL OR r.reverses_entry_id <> e.id OR r.status <> 'posted')`
    )
    .all(companyId)) {
    push('broken_reversal', r, 'قيد معكوس بلا قيد عكسي صالح');
  }
  for (const r of db
    .prepare("SELECT id, entry_number FROM journal_entries WHERE company_id = ? AND status IN ('posted','reversed') AND entry_number IS NULL")
    .all(companyId)) {
    push('missing_number', r, 'قيد مرحّل بلا رقم');
  }
  const t = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor),0) d, COALESCE(SUM(l.credit_minor),0) c FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted','reversed')`
    )
    .get(companyId);
  if (t.d !== t.c) violations.push({ type: 'trial_balance', entry_id: null, entry_number: null, message: 'ميزان المراجعة غير متوازن' });
  return { ok: violations.length === 0, checked_at: new Date().toISOString(), violations, total_debit_minor: t.d, total_credit_minor: t.c };
}

module.exports = {
  lineRate,
  LedgerError,
  transaction: tx,
  SYSTEM_KEYS,
  ensureLedgerSetup,
  listCurrencies,
  getBaseCurrency,
  getCurrency,
  listBranches,
  listAccounts,
  getAccount,
  getAccountBySystemKey,
  createAccount,
  updateAccount,
  listCoaTemplates,
  applyCoaTemplate,
  createFiscalYear,
  listFiscalYears,
  listPeriods,
  setPeriodStatus,
  listDimension,
  saveDimension,
  listEntries,
  getEntry,
  createDraft,
  updateDraft,
  deleteDraft,
  postDraft,
  postEntry,
  reverseEntry,
  addAttachment,
  getAttachment,
  previewOpeningBalances,
  postOpeningBalances,
  ledgerIntegrityCheck,
  ledger_integrity_check: ledgerIntegrityCheck,
};
