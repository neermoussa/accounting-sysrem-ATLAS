// backend/lib/payroll.js
//
// Prompt 11-lite — payroll ACCOUNTING only. The HR program (separate) does
// attendance, leave, shifts and the calculation; here we import its result
// per period and post it.
//
// Import (manage_payroll_intake): per period, per department / cost
// center / currency: gross, deductions, employer contributions, net
// (net = gross - deductions, exactly). Idempotent by (company, period,
// external id): the same content again is a replay; different content is
// refused unless the period was reopened with a reason.
//
// Posting (approve_payroll_posting, not the importer — separation of
// duties with the owner's break-glass): ONE entry per period, source
// payroll_period, on the posting date (default: the period's last day),
// each currency at its rate on that date:
//   Dr payroll expense (gross, per cost center)
//   Dr employer contributions expense (per cost center)
//   Cr salaries payable (net)                          [per currency]
//   Cr deductions payable (deductions - advance recoveries + employer
//      contributions)                                  [per currency]
//   Cr employee advances (recoveries, at the advances' own base value)
//   Dr / Cr fx_realized (recoveries: rate difference vs the advance)
// Corrections are reversal-only: reopening a posted period (with a reason)
// reverses its entry; a re-import then replaces the figures and it posts
// again. Locked / closed periods are refused before anything is written.
//
// Payment: a treasury payment voucher on salaries payable from a box in
// the period's currency (payroll_payments links it to the period). It is
// approved in treasury (approve_vouchers, its own separation of duties);
// for a foreign currency the payable is relieved at its accrual value and
// the rate difference goes to fx_realized (lib/treasury.js asks
// voucherCounter()). Advances are paid the same way (employee_advances)
// and recovered through the import's advance-recovery lines.
//
// Labour cost rates per cost center / product line, effective-dated, are
// kept here for Prompt 16; production orders read them (laborRateFor).

const crypto = require('crypto');
const db = require('../db/init');
const ledger = require('./ledger');
const P = require('./purchasing');
const tenantRefs = require('./tenantRefs');
const { logAudit } = require('./auditLog');
const { toMinor, fromMinor } = require('./ledgerCurrencies');
const { checkpoint } = require('./faultInjection');
const { requirePostable } = require('./periodGuard');

class PayrollError extends ledger.LedgerError {}
const fail = (code, message, status = 400, extra) => {
  throw new PayrollError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const isPeriod = (p) => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
const lastDay = (p) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

function owned(companyId, kind, id, opts) {
  try {
    return tenantRefs.requireOwned(companyId, kind, id, opts);
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, err.message, 400);
    throw err;
  }
}
function ownedRow(companyId, table, id, code, label) {
  const n = Number(id);
  const r = Number.isInteger(n) && n > 0 ? db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(n, companyId) : null;
  if (!r) fail(code, `${label} غير موجود أو لا يتبع لهذه الشركة`, 400);
  return r;
}
const baseOf = (companyId) => P.base(companyId);
const currencyOf = (companyId, code) => {
  try {
    return P.currencyOf(companyId, code);
  } catch (err) {
    fail('invalid_currency', `العملة ${code} غير معرّفة`);
  }
  return null;
};
// Amount of a field: '<name>Minor' (integer) or '<name>' (decimal string in the currency).
function amount(input, name, digits, label) {
  const raw = input[`${name}Minor`] !== undefined ? Number(input[`${name}Minor`]) : input[name] === undefined || input[name] === null || input[name] === '' ? 0 : toMinor(input[name], digits);
  if (!Number.isSafeInteger(raw) || raw < 0) fail('invalid_amount', `${label}: مبلغ غير صالح`);
  return raw;
}

// ---------------------------------------------------------------------
// Settings: the accounts payroll posts to
// ---------------------------------------------------------------------

const SETTING_FIELDS = [
  ['expenseAccountId', 'expense_account_id', ['expense'], 'حساب مصروف الرواتب'],
  ['employerExpenseAccountId', 'employer_expense_account_id', ['expense'], 'حساب مصروف مساهمات صاحب العمل'],
  ['salariesPayableAccountId', 'salaries_payable_account_id', ['liability'], 'حساب الرواتب المستحقة'],
  ['deductionsPayableAccountId', 'deductions_payable_account_id', ['liability'], 'حساب الاستقطاعات المستحقة'],
  ['advancesAccountId', 'advances_account_id', ['asset'], 'حساب سلف الموظفين'],
];
function getSettings(companyId) {
  return db.prepare('SELECT * FROM payroll_settings WHERE company_id = ?').get(companyId) || null;
}
function requireSettings(companyId) {
  const s = getSettings(companyId);
  if (!s) fail('payroll_accounts_not_set', 'حدّد حسابات الرواتب أولًا (إعدادات الرواتب)', 409);
  return s;
}
function saveSettings(companyId, input = {}, actor) {
  return ledger.transaction(() => {
    const before = getSettings(companyId);
    const vals = {};
    for (const [key, col, types, label] of SETTING_FIELDS) {
      const a = owned(companyId, 'account', input[key] ?? before?.[col], { active: true });
      if (!a.is_postable) fail('account_not_postable', `${label}: اختر حسابًا فرعيًا`);
      if (!types.includes(a.type)) fail('invalid_account_type', `${label}: نوع الحساب غير مناسب`);
      if (db.prepare('SELECT 1 FROM cash_boxes WHERE company_id = ? AND account_id = ?').get(companyId, a.id)) fail('invalid_account_type', `${label}: لا يمكن أن يكون صندوقًا أو بنكًا`);
      vals[col] = a.id;
    }
    if (vals.salaries_payable_account_id === vals.deductions_payable_account_id) fail('same_accounts', 'حساب الرواتب المستحقة وحساب الاستقطاعات يجب أن يختلفا');
    db.prepare(`INSERT INTO payroll_settings (company_id, expense_account_id, employer_expense_account_id, salaries_payable_account_id, deductions_payable_account_id, advances_account_id, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET expense_account_id = excluded.expense_account_id, employer_expense_account_id = excluded.employer_expense_account_id,
      salaries_payable_account_id = excluded.salaries_payable_account_id, deductions_payable_account_id = excluded.deductions_payable_account_id, advances_account_id = excluded.advances_account_id,
      updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(companyId, vals.expense_account_id, vals.employer_expense_account_id, vals.salaries_payable_account_id, vals.deductions_payable_account_id, vals.advances_account_id, actor?.id ?? null);
    // The default deduction type follows the deductions-payable account.
    db.prepare("INSERT INTO payroll_deduction_types (company_id, code, name, account_id, is_default) VALUES (?, 'default', 'استقطاعات عامة', ?, 1) ON CONFLICT(company_id, code) DO UPDATE SET account_id = excluded.account_id").run(companyId, vals.deductions_payable_account_id);
    const after = getSettings(companyId);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.settings.update', entityType: 'payroll_settings', entityId: companyId, before, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Deduction types (each with its own payable account)
// ---------------------------------------------------------------------

const listDeductionTypes = (companyId) => db.prepare('SELECT t.*, a.code account_code, a.name_ar account_name FROM payroll_deduction_types t JOIN accounts a ON a.id = t.account_id WHERE t.company_id = ? ORDER BY t.is_default DESC, t.code').all(companyId);
function defaultType(companyId) {
  const t = db.prepare('SELECT * FROM payroll_deduction_types WHERE company_id = ? AND is_default = 1').get(companyId);
  if (!t) fail('payroll_accounts_not_set', 'حدّد حسابات الرواتب أولًا (إعدادات الرواتب)', 409);
  return t;
}
function saveDeductionType(companyId, id, input = {}, actor) {
  return ledger.transaction(() => {
    requireSettings(companyId);
    const ex = id ? ownedRow(companyId, 'payroll_deduction_types', id, 'invalid_deduction_type', 'نوع الاستقطاع') : null;
    const code = ex ? ex.code : String(input.code || '').trim();
    if (!/^[a-z0-9_]{2,40}$/.test(code)) fail('invalid_code', 'رمز النوع: أحرف لاتينية صغيرة وأرقام و _ فقط');
    if (code === 'advance_recovery') fail('invalid_code', 'هذا الرمز محجوز');
    const name = String(input.name ?? ex?.name ?? '').trim();
    if (!name) fail('name_required', 'اسم النوع مطلوب');
    const a = owned(companyId, 'account', input.accountId ?? ex?.account_id, { active: true });
    if (!a.is_postable || a.type !== 'liability') fail('invalid_account_type', 'حساب النوع يجب أن يكون حساب خصوم فرعيًا');
    if (a.id === getSettings(companyId).salaries_payable_account_id) fail('same_accounts', 'لا يمكن استخدام حساب الرواتب المستحقة');
    const active = input.active === undefined ? ex?.active ?? 1 : input.active ? 1 : 0;
    if (ex?.is_default && !active) fail('default_type', 'لا يمكن إيقاف النوع الافتراضي');
    if (!ex && db.prepare('SELECT 1 FROM payroll_deduction_types WHERE company_id = ? AND code = ?').get(companyId, code)) fail('code_exists', 'الرمز مستخدم', 409);
    let tid = ex?.id;
    if (ex) {
      db.prepare('UPDATE payroll_deduction_types SET name = ?, account_id = ?, active = ? WHERE id = ?').run(name, a.id, active, ex.id);
      if (ex.is_default) db.prepare('UPDATE payroll_settings SET deductions_payable_account_id = ? WHERE company_id = ?').run(a.id, companyId);
    } else tid = Number(db.prepare('INSERT INTO payroll_deduction_types (company_id, code, name, account_id, active) VALUES (?, ?, ?, ?, ?)').run(companyId, code, name, a.id, active).lastInsertRowid);
    const after = db.prepare('SELECT * FROM payroll_deduction_types WHERE id = ?').get(tid);
    logAudit({ companyId, actor: actorOf(actor), action: ex ? 'payroll.deduction_type.update' : 'payroll.deduction_type.create', entityType: 'payroll_deduction_type', entityId: tid, before: ex, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Employee advances (outstanding per employee and currency)
// ---------------------------------------------------------------------

// Posted advances and posted recoveries (original and base).
function advanceBalance(companyId, employeeRef, currency) {
  const adv = db.prepare(`SELECT COALESCE(SUM(a.amount_minor), 0) o, COALESCE(SUM(v.amount_base_minor), 0) b FROM employee_advances a JOIN treasury_vouchers v ON v.id = a.voucher_id
    WHERE a.company_id = ? AND a.employee_ref = ? AND a.currency_code = ? AND v.status = 'posted'`).get(companyId, employeeRef, currency);
  const rec = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) o, COALESCE(SUM(base_minor), 0) b FROM payroll_advance_recoveries
    WHERE company_id = ? AND employee_ref = ? AND currency_code = ? AND posted = 1`).get(companyId, employeeRef, currency);
  return { advanced: adv.o, advanced_base: adv.b, recovered: rec.o, recovered_base: rec.b, outstanding: adv.o - rec.o, outstanding_base: adv.b - rec.b };
}

function recordAdvance(companyId, input = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const s = requireSettings(companyId);
    const ref = String(input.employeeRef || '').trim();
    if (!ref) fail('employee_ref_required', 'رقم الموظف (من برنامج الموارد البشرية) مطلوب');
    const T = require('./treasury');
    const box = owned(companyId, 'cash_box', input.cashBoxId, { active: true });
    const cur = currencyOf(companyId, input.currencyCode || box.currency_code);
    if (box.currency_code !== cur.code) fail('currency_mismatch', `الصندوق بعملة ${box.currency_code} والسلفة بعملة ${cur.code}`);
    const amt = amount(input, 'amount', cur.minor_unit_digits, 'مبلغ السلفة');
    if (!amt) fail('invalid_amount', 'مبلغ السلفة يجب أن يكون أكبر من صفر');
    const date = input.date || today();
    if (!isValidDate(date)) fail('invalid_date', 'التاريخ غير صالح');
    const name = input.employeeName ? String(input.employeeName).trim() : null;
    // The voucher carries no employee identity (treasury users and the
    // ledger see 'employee advance'; who it is lives in payroll only).
    const v = T.createVoucher(companyId, { type: 'payment', cashBoxId: box.id, amountMinor: amt, counterAccountId: s.advances_account_id, date, payee: 'سلفة موظف', reference: 'ADV', description: 'سلفة موظف' }, actor);
    const id = Number(db.prepare('INSERT INTO employee_advances (company_id, employee_ref, employee_name, currency_code, amount_minor, advance_date, voucher_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, ref, name, cur.code, amt, date, v.id, input.notes || null, actor?.id ?? null).lastInsertRowid);
    const after = { ...db.prepare('SELECT * FROM employee_advances WHERE id = ?').get(id), voucher: v };
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.advance.create', entityType: 'employee_advance', entityId: id, after });
    return after;
  });
}

function advancesReport(companyId) {
  const rows = db.prepare(`SELECT employee_ref, MAX(employee_name) employee_name, currency_code FROM employee_advances WHERE company_id = ? GROUP BY employee_ref, currency_code ORDER BY employee_ref, currency_code`).all(companyId);
  const out = rows.map((r) => {
    const b = advanceBalance(companyId, r.employee_ref, r.currency_code);
    const pending = db.prepare(`SELECT COALESCE(SUM(a.amount_minor), 0) s FROM employee_advances a JOIN treasury_vouchers v ON v.id = a.voucher_id WHERE a.company_id = ? AND a.employee_ref = ? AND a.currency_code = ? AND v.status = 'draft'`).get(companyId, r.employee_ref, r.currency_code).s;
    return { ...r, ...b, pending_vouchers_minor: pending };
  });
  return { rows: out, outstanding_base_minor: out.reduce((t, r) => t + r.outstanding_base, 0) };
}

// ---------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------

function normalizeImport(companyId, input) {
  const period = input.period;
  if (!isPeriod(period)) fail('invalid_period', 'الفترة يجب أن تكون بصيغة YYYY-MM');
  const externalId = String(input.externalId || '').trim();
  if (!externalId) fail('external_id_required', 'المعرّف الخارجي للدفعة (من برنامج الموارد البشرية) مطلوب');
  const postingDate = input.postingDate || lastDay(period);
  if (!isValidDate(postingDate)) fail('invalid_date', 'تاريخ الترحيل غير صالح');
  if (!Array.isArray(input.lines) || !input.lines.length) fail('lines_required', 'لا توجد سطور رواتب');
  // The whole file is validated first: every bad row is reported (row
  // number, field error) and the file is rejected entirely — nothing is
  // written unless every row is valid.
  const errors = [];
  const collect = (section, i, row, fn) => {
    try {
      return fn();
    } catch (err) {
      // Money parsing (ledgerCurrencies.toMinor) throws a plain 400 error.
      if (!(err instanceof ledger.LedgerError || err instanceof tenantRefs.ForeignRefError || err.status === 400)) throw err;
      errors.push({ section, row: row ?? i + 1, error: err.code || 'invalid_amount', message: err.message });
      return null;
    }
  };
  const lines = input.lines.map((l, i) => collect('lines', i, l?._row, () => {
    const n = l?._row ?? i + 1;
    const department = String(l.department || '').trim();
    if (!department) fail('department_required', `السطر ${n}: القسم مطلوب`);
    const cur = currencyOf(companyId, l.currencyCode || l.currency);
    const d = cur.minor_unit_digits;
    const gross = amount(l, 'gross', d, `السطر ${n} (الإجمالي)`);
    const deductions = amount(l, 'deductions', d, `السطر ${n} (الاستقطاعات)`);
    const contrib = amount(l, 'employerContributions', d, `السطر ${n} (مساهمات صاحب العمل)`);
    const net = amount(l, 'net', d, `السطر ${n} (الصافي)`);
    if (net !== gross - deductions) fail('net_mismatch', `السطر ${n}: الصافي (${fromMinor(net, d)}) لا يساوي الإجمالي ناقص الاستقطاعات (${fromMinor(gross - deductions, d)})`);
    const cc = l.costCenterId ? owned(companyId, 'cost_center', l.costCenterId, { active: true }).id : null;
    const hc = l.headcount === undefined || l.headcount === null || l.headcount === '' ? null : Number(l.headcount);
    if (hc !== null && !(Number.isInteger(hc) && hc >= 0)) fail('invalid_headcount', `السطر ${n}: عدد الموظفين غير صالح`);
    const out = { line_no: n, department, cost_center_id: cc, currency_code: cur.code, gross_minor: gross, deductions_minor: deductions, employer_contrib_minor: contrib, net_minor: net, headcount: hc };
    // Optional split by deduction type (must add up exactly); the type
    // 'advance_recovery' marks the part that recovers advances.
    const split = (list, total, label) => {
      if (list === undefined || list === null) return null;
      if (!Array.isArray(list)) fail('invalid_breakdown', `السطر ${n}: ${label} يجب أن يكون قائمة`);
      const parts = list.map((x, k) => {
        const code = String(x.type || '').trim();
        const amt = amount(x, 'amount', d, `السطر ${n}، ${label} ${k + 1}`);
        if (code === 'advance_recovery' && label === 'الاستقطاعات') return { code, amount: amt };
        const t = db.prepare('SELECT * FROM payroll_deduction_types WHERE company_id = ? AND code = ? AND active = 1').get(companyId, code);
        if (!t) fail('invalid_deduction_type', `السطر ${n}: نوع الاستقطاع ${code || '؟'} غير معرّف`);
        return { code, amount: amt };
      });
      const sum = parts.reduce((t, x) => t + x.amount, 0);
      if (sum !== total) fail('breakdown_mismatch', `السطر ${n}: مجموع ${label} حسب النوع (${fromMinor(sum, d)}) لا يساوي ${fromMinor(total, d)}`);
      return parts;
    };
    const dBy = split(l.deductionsByType, deductions, 'الاستقطاعات');
    const eBy = split(l.employerContributionsByType, contrib, 'مساهمات صاحب العمل');
    // Only lines that carry a split change the content (old imports keep their hash).
    if (dBy) out.deductions_by_type = dBy;
    if (eBy) out.employer_by_type = eBy;
    return out;
  }));
  const recoveries = (input.advanceRecoveries || []).map((r, i) => collect('advanceRecoveries', i, r?._row, () => {
    const ref = String(r.employeeRef || '').trim();
    if (!ref) fail('employee_ref_required', `استرداد السلفة ${i + 1}: رقم الموظف مطلوب`);
    const cur = currencyOf(companyId, r.currencyCode || r.currency);
    const amt = amount(r, 'amount', cur.minor_unit_digits, `استرداد السلفة ${i + 1}`);
    if (!amt) fail('invalid_amount', `استرداد السلفة ${i + 1}: المبلغ يجب أن يكون أكبر من صفر`);
    return { employee_ref: ref, currency_code: cur.code, amount_minor: amt };
  }));
  if (errors.length) fail('import_invalid', `الملف مرفوض بالكامل: ${errors.length} سطر غير صالح — صحّحها وأعد الاستيراد`, 400, { errors });
  // Recoveries are part of the deductions of the same currency.
  for (const cur of new Set(recoveries.map((r) => r.currency_code))) {
    const rec = recoveries.filter((r) => r.currency_code === cur).reduce((t, r) => t + r.amount_minor, 0);
    const ded = lines.filter((l) => l.currency_code === cur).reduce((t, l) => t + l.deductions_minor, 0);
    if (rec > ded) fail('recoveries_exceed_deductions', `استرداد السلف بعملة ${cur} أكبر من الاستقطاعات`);
    // With splits, recoveries come out of 'advance_recovery' parts and the
    // default type's share of the deductions.
    const avail = lines.filter((l) => l.currency_code === cur).reduce((t, l) => t + (l.deductions_by_type ? l.deductions_by_type.filter((x) => x.code === 'advance_recovery' || x.code === 'default').reduce((u, x) => u + x.amount, 0) : l.deductions_minor), 0);
    if (rec > avail) fail('recoveries_exceed_deductions', `استرداد السلف بعملة ${cur} أكبر من الاستقطاعات المخصصة له (النوع الافتراضي أو advance_recovery)`);
  }
  const content = { period, externalId, postingDate, lines, recoveries };
  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { ...content, hash };
}

function getPeriod(companyId, id) {
  const p = ownedRow(companyId, 'payroll_periods', id, 'invalid_payroll_period', 'فترة الرواتب');
  const lines = db.prepare('SELECT l.*, cc.code cost_center_code, cc.name cost_center_name FROM payroll_lines l LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id WHERE l.period_id = ? ORDER BY l.line_no').all(p.id);
  const recoveries = db.prepare('SELECT * FROM payroll_advance_recoveries WHERE period_id = ? ORDER BY id').all(p.id);
  const payments = db.prepare('SELECT pp.*, v.status voucher_status, v.voucher_number FROM payroll_payments pp JOIN treasury_vouchers v ON v.id = pp.voucher_id WHERE pp.period_id = ? ORDER BY pp.id').all(p.id);
  const entry = p.journal_entry_id ? db.prepare('SELECT id, entry_number, status FROM journal_entries WHERE id = ?').get(p.journal_entry_id) : null;
  const totals = {};
  for (const l of lines) {
    const t = totals[l.currency_code] || { gross_minor: 0, deductions_minor: 0, employer_contrib_minor: 0, net_minor: 0, paid_minor: 0 };
    t.gross_minor += l.gross_minor;
    t.deductions_minor += l.deductions_minor;
    t.employer_contrib_minor += l.employer_contrib_minor;
    t.net_minor += l.net_minor;
    totals[l.currency_code] = t;
  }
  for (const pay of payments) if (pay.voucher_status === 'posted' && totals[pay.currency_code]) totals[pay.currency_code].paid_minor += pay.amount_minor;
  return { ...p, rates: p.rates_json ? JSON.parse(p.rates_json) : null, lines, recoveries, payments, journal_entry: entry, totals };
}
function listPeriods(companyId, { period, status } = {}) {
  const w = ['company_id = ?'];
  const a = [companyId];
  if (period) { w.push('period = ?'); a.push(period); }
  if (status) { w.push('status = ?'); a.push(status); }
  return db.prepare(`SELECT * FROM payroll_periods WHERE ${w.join(' AND ')} ORDER BY period DESC, id DESC`).all(...a).map((p) => getPeriod(companyId, p.id));
}

function writeContent(companyId, periodId, c) {
  db.prepare('DELETE FROM payroll_line_deductions WHERE line_id IN (SELECT id FROM payroll_lines WHERE period_id = ?)').run(periodId);
  db.prepare('DELETE FROM payroll_lines WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM payroll_advance_recoveries WHERE period_id = ?').run(periodId);
  const ins = db.prepare('INSERT INTO payroll_lines (company_id, period_id, line_no, department, cost_center_id, currency_code, gross_minor, deductions_minor, employer_contrib_minor, net_minor, headcount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.prepare('DELETE FROM payroll_line_deductions WHERE line_id IN (SELECT id FROM payroll_lines WHERE period_id = ?)').run(periodId);
  const insSplit = db.prepare('INSERT INTO payroll_line_deductions (company_id, line_id, type_id, deduction_minor, employer_minor) VALUES (?, ?, ?, ?, ?)');
  for (const l of c.lines) {
    const lid = Number(ins.run(companyId, periodId, l.line_no, l.department, l.cost_center_id, l.currency_code, l.gross_minor, l.deductions_minor, l.employer_contrib_minor, l.net_minor, l.headcount).lastInsertRowid);
    const byType = new Map();
    const add = (code, k, v) => { if (!v) return; const e = byType.get(code) || { d: 0, e: 0 }; e[k] += v; byType.set(code, e); };
    for (const x of l.deductions_by_type || []) add(x.code, 'd', x.amount);
    for (const x of l.employer_by_type || []) add(x.code, 'e', x.amount);
    for (const [code, v] of byType) {
      // advance_recovery is not a payable: it is kept under the default type
      // row and taken out at posting together with the recoveries.
      const t = db.prepare('SELECT id FROM payroll_deduction_types WHERE company_id = ? AND code = ?').get(companyId, code === 'advance_recovery' ? 'default' : code);
      if (t) insSplit.run(companyId, lid, t.id, v.d, v.e);
    }
  }
  const rec = db.prepare('INSERT INTO payroll_advance_recoveries (company_id, period_id, employee_ref, currency_code, amount_minor) VALUES (?, ?, ?, ?, ?)');
  for (const r of c.recoveries) rec.run(companyId, periodId, r.employee_ref, r.currency_code, r.amount_minor);
}

// CSV import: same rules; parse errors and validation errors are reported
// together, by CSV row, and the whole file is rejected if any row is bad.
function importCsv(companyId, { period, externalId, postingDate, csv } = {}, actor) {
  const parsed = require('./payrollCsv').csvToImport(companyId, csv);
  const input = { period, externalId, postingDate, lines: parsed.lines || [], advanceRecoveries: parsed.advanceRecoveries || [] };
  if (parsed.errors.length) {
    let more = [];
    try {
      normalizeImport(companyId, input);
    } catch (err) {
      more = err.errors || [];
    }
    const all = [...parsed.errors, ...more].sort((a, b) => a.row - b.row);
    fail('import_invalid', `الملف مرفوض بالكامل: ${all.length} خطأ — صحّحها وأعد الاستيراد`, 400, { errors: all });
  }
  return importPeriod(companyId, input, actor);
}

function importPeriod(companyId, input = {}, actor) {
  return ledger.transaction(() => {
    const c = normalizeImport(companyId, input);
    const existing = db.prepare('SELECT * FROM payroll_periods WHERE company_id = ? AND period = ? AND external_id = ?').get(companyId, c.period, c.externalId);
    if (existing) {
      if (existing.content_hash === c.hash) return { ...getPeriod(companyId, existing.id), replay: true };
      if (existing.status !== 'reopened') {
        fail('payroll_changed_reimport', `الدفعة ${c.externalId} للفترة ${c.period} مستوردة سابقًا بأرقام مختلفة — أعد فتح الفترة مع ذكر السبب قبل إعادة الاستيراد`, 409, { period_id: existing.id, period_status: existing.status });
      }
      const before = getPeriod(companyId, existing.id);
      writeContent(companyId, existing.id, c);
      db.prepare("UPDATE payroll_periods SET status = 'imported', content_hash = ?, import_count = import_count + 1, posting_date = ?, imported_by = ?, imported_at = datetime('now') WHERE id = ?").run(c.hash, c.postingDate, actor?.id ?? null, existing.id);
      const after = getPeriod(companyId, existing.id);
      logAudit({ companyId, actor: actorOf(actor), action: 'payroll.period.reimport', entityType: 'payroll_period', entityId: existing.id, before, after });
      return after;
    }
    const id = Number(db.prepare('INSERT INTO payroll_periods (company_id, period, external_id, content_hash, posting_date, imported_by) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, c.period, c.externalId, c.hash, c.postingDate, actor?.id ?? null).lastInsertRowid);
    writeContent(companyId, id, c);
    const after = getPeriod(companyId, id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.period.import', entityType: 'payroll_period', entityId: id, after });
    return after;
  });
}

// ---------------------------------------------------------------------
// Posting (accrual) and reopening (reversal)
// ---------------------------------------------------------------------

function fxFields(companyId, cur, original, rate) {
  if (cur === baseOf(companyId).code) return {};
  return { currencyCode: cur, amountOriginalMinor: original, rateE8: rate.rateE8, rateQuote: rate.quote };
}

function postPeriod(companyId, id, { breakGlassReason, exchangeRates } = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const p = ownedRow(companyId, 'payroll_periods', id, 'invalid_payroll_period', 'فترة الرواتب');
    if (p.status !== 'imported') fail('payroll_not_importable_state', p.status === 'posted' ? 'الفترة مرحّلة مسبقًا' : 'أعد استيراد الفترة بعد إعادة فتحها قبل الترحيل', 409);
    if (actor?.id && p.imported_by === actor.id) {
      P.sodGuard(companyId, 'payroll', actor, breakGlassReason, { code: 'sod_payroll_importer', message: 'فصل المهام: لا يمكنك ترحيل رواتب استوردتها بنفسك. يجب أن يرحّلها مستخدم آخر.', entityType: 'payroll_period', entityId: p.id });
    }
    requirePostable(companyId, p.posting_date, `رواتب ${p.period} (${p.external_id})`);
    const s = requireSettings(companyId);
    const lines = db.prepare('SELECT * FROM payroll_lines WHERE period_id = ? ORDER BY line_no').all(p.id);
    const recoveries = db.prepare('SELECT * FROM payroll_advance_recoveries WHERE period_id = ? ORDER BY id').all(p.id);
    const baseCode = baseOf(companyId).code;
    const rates = {};
    const rateOf = (cur) => {
      if (!rates[cur]) {
        const o = (exchangeRates || {})[cur] || {};
        rates[cur] = cur === baseCode ? { rateE8: null, quote: null } : P.docRate(companyId, cur, p.posting_date, { exchangeRate: o.rate, rateQuote: o.rateQuote }, actor);
      }
      return rates[cur];
    };
    const toBase = (cur, m) => (cur === baseCode ? m : P.toBase(companyId, cur, m, rateOf(cur)));
    const jl = [];
    const memo = `رواتب ${p.period}`;
    for (const l of lines) {
      const cc = l.cost_center_id ? { costCenterId: l.cost_center_id } : {};
      if (l.gross_minor) jl.push({ accountId: s.expense_account_id, debitMinor: toBase(l.currency_code, l.gross_minor), ...fxFields(companyId, l.currency_code, l.gross_minor, rateOf(l.currency_code)), ...cc, memo });
      if (l.employer_contrib_minor) jl.push({ accountId: s.employer_expense_account_id, debitMinor: toBase(l.currency_code, l.employer_contrib_minor), ...fxFields(companyId, l.currency_code, l.employer_contrib_minor, rateOf(l.currency_code)), ...cc, memo: `مساهمات صاحب العمل ${p.period}` });
    }
    // Advance recoveries: credit the advances at their own (historical) base
    // value; the difference to today's rate is realized FX.
    const recByCur = {};
    let fxTotal = 0;
    for (const r of recoveries) {
      const bal = advanceBalance(companyId, r.employee_ref, r.currency_code);
      if (r.amount_minor > bal.outstanding) fail('recovery_exceeds_advance', `استرداد ${fromMinor(r.amount_minor, currencyOf(companyId, r.currency_code).minor_unit_digits)} ${r.currency_code} للموظف ${r.employee_ref} أكبر من رصيد سلفه (${fromMinor(bal.outstanding, currencyOf(companyId, r.currency_code).minor_unit_digits)})`, 409, { employee_ref: r.employee_ref });
      const histBase = r.amount_minor === bal.outstanding ? bal.outstanding_base : Math.round((bal.outstanding_base * r.amount_minor) / bal.outstanding);
      const nowBase = toBase(r.currency_code, r.amount_minor);
      fxTotal += nowBase - histBase;
      jl.push({ accountId: s.advances_account_id, creditMinor: histBase, ...fxFields(companyId, r.currency_code, r.amount_minor, rateOf(r.currency_code)), memo: 'استرداد سلف موظفين' });
      db.prepare('UPDATE payroll_advance_recoveries SET base_minor = ?, posted = 1 WHERE id = ?').run(histBase, r.id);
      recByCur[r.currency_code] = (recByCur[r.currency_code] || 0) + r.amount_minor;
    }
    const dflt = defaultType(companyId);
    const perType = [];
    for (const cur of [...new Set(lines.map((l) => l.currency_code))]) {
      const ls = lines.filter((l) => l.currency_code === cur);
      const net = ls.reduce((t, l) => t + l.net_minor, 0);
      if (net) jl.push({ accountId: s.salaries_payable_account_id, creditMinor: toBase(cur, net), ...fxFields(companyId, cur, net, rateOf(cur)), memo: `رواتب مستحقة ${p.period} (${cur})` });
      // Deductions + employer contributions per type; lines without a split
      // go to the default type; advance recoveries come out of the default.
      const byType = new Map([[dflt.id, 0]]);
      for (const l of ls) {
        const split = db.prepare('SELECT * FROM payroll_line_deductions WHERE line_id = ?').all(l.id);
        const sd = split.reduce((t, x) => t + x.deduction_minor, 0);
        const se = split.reduce((t, x) => t + x.employer_minor, 0);
        for (const x of split) byType.set(x.type_id, (byType.get(x.type_id) || 0) + x.deduction_minor + x.employer_minor);
        byType.set(dflt.id, byType.get(dflt.id) + (l.deductions_minor - sd) + (l.employer_contrib_minor - se));
      }
      byType.set(dflt.id, byType.get(dflt.id) - (recByCur[cur] || 0));
      if (byType.get(dflt.id) < 0) fail('recoveries_exceed_deductions', `استرداد السلف بعملة ${cur} أكبر من الاستقطاعات الافتراضية`, 409);
      for (const [typeId, amt] of byType) {
        if (!amt) continue;
        const t = db.prepare('SELECT * FROM payroll_deduction_types WHERE id = ?').get(typeId);
        const b = toBase(cur, amt);
        jl.push({ accountId: t.account_id, creditMinor: b, ...fxFields(companyId, cur, amt, rateOf(cur)), memo: `${t.name} ${p.period} (${cur})` });
        perType.push({ typeId, cur, amt, b });
      }
    }
    if (fxTotal) jl.push({ accountId: P.systemAccount(companyId, 'fx_realized'), debitMinor: fxTotal < 0 ? -fxTotal : 0, creditMinor: fxTotal > 0 ? fxTotal : 0, memo: 'فرق صرف استرداد السلف' });
    // Per-line conversion residue -> rounding_difference (as other documents).
    const diff = jl.reduce((t, l) => t + (l.debitMinor || 0) - (l.creditMinor || 0), 0);
    if (diff) jl.push({ accountId: P.systemAccount(companyId, 'rounding_difference'), debitMinor: diff < 0 ? -diff : 0, creditMinor: diff > 0 ? diff : 0, memo: 'فرق تقريب تحويل العملات' });
    const entry = ledger.postEntry(companyId, { date: p.posting_date, description: `استحقاق رواتب ${p.period} — ${p.external_id}`, sourceType: 'payroll_period', sourceId: p.id, lines: jl.filter((l) => l.debitMinor || l.creditMinor) }, actor);
    checkpoint('payroll.post.after_entry');
    const ratesJson = JSON.stringify(Object.fromEntries(Object.entries(rates).filter(([k]) => k !== baseCode).map(([k, r]) => [k, { rate_e8: r.rateE8, quote: r.quote }])));
    db.prepare("UPDATE payroll_periods SET status = 'posted', journal_entry_id = ?, rates_json = ?, posted_by = ?, posted_at = datetime('now') WHERE id = ?").run(entry.id, ratesJson, actor?.id ?? null, p.id);
    db.prepare('DELETE FROM payroll_period_deductions WHERE period_id = ?').run(p.id);
    for (const x of perType) db.prepare('INSERT INTO payroll_period_deductions (company_id, period_id, type_id, currency_code, amount_minor, base_minor) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, p.id, x.typeId, x.cur, x.amt, x.b);
    const after = getPeriod(companyId, p.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.period.post', entityType: 'payroll_period', entityId: p.id, before: { status: 'imported' }, after: { status: 'posted', journal_entry_id: entry.id } });
    return after;
  });
}

// Reopen with a reason: a posted period's entry is reversed (reversal-only
// correction) and its advance recoveries are released; an imported period
// just becomes re-importable.
function reopenPeriod(companyId, id, { reason, date } = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const p = ownedRow(companyId, 'payroll_periods', id, 'invalid_payroll_period', 'فترة الرواتب');
    const why = String(reason || '').trim();
    if (why.length < 5) fail('reason_required', 'سبب إعادة الفتح مطلوب');
    if (p.status === 'reopened') fail('already_reopened', 'الفترة مفتوحة مسبقًا لإعادة الاستيراد', 409);
    let reversal = null;
    if (p.status === 'posted') {
      const live = db.prepare("SELECT COUNT(*) c FROM payroll_payments pp JOIN treasury_vouchers v ON v.id = pp.voucher_id WHERE pp.period_id = ? AND v.status IN ('draft', 'posted')").get(p.id).c;
      if (live) fail('payroll_has_payments', 'للفترة دفعات رواتب — اعكس سندات الدفع أو ارفضها أولًا', 409, { payments: live });
      const rd = date || p.posting_date;
      requirePostable(companyId, rd, `عكس رواتب ${p.period}`);
      reversal = ledger.reverseEntry(companyId, p.journal_entry_id, { date: rd, reason: `إعادة فتح الرواتب: ${why}`, fromSource: true }, actor).reversal;
      checkpoint('payroll.reopen.after_reversal');
      db.prepare('UPDATE payroll_advance_recoveries SET posted = 0, base_minor = NULL WHERE period_id = ?').run(p.id);
      db.prepare('DELETE FROM payroll_period_deductions WHERE period_id = ?').run(p.id);
    }
    db.prepare("UPDATE payroll_periods SET status = 'reopened', reopen_reason = ?, reopened_by = ?, reopened_at = datetime('now') WHERE id = ?").run(why, actor?.id ?? null, p.id);
    const after = getPeriod(companyId, p.id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.period.reopen', entityType: 'payroll_period', entityId: p.id, before: { status: p.status }, after: { status: 'reopened', reason: why, reversal_entry_id: reversal?.id ?? null } });
    return after;
  });
}

// ---------------------------------------------------------------------
// Payments through treasury
// ---------------------------------------------------------------------

function netAndPaid(companyId, periodId, cur) {
  const net = db.prepare('SELECT COALESCE(SUM(net_minor), 0) s FROM payroll_lines WHERE period_id = ? AND currency_code = ?').get(periodId, cur).s;
  const open = db.prepare("SELECT COALESCE(SUM(pp.amount_minor), 0) s FROM payroll_payments pp JOIN treasury_vouchers v ON v.id = pp.voucher_id WHERE pp.period_id = ? AND pp.currency_code = ? AND v.status IN ('draft', 'posted')").get(periodId, cur).s;
  return { net, committed: open, available: net - open };
}

function createPayment(companyId, periodId, input = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const p = ownedRow(companyId, 'payroll_periods', periodId, 'invalid_payroll_period', 'فترة الرواتب');
    if (p.status !== 'posted') fail('payroll_not_posted', 'رحّل استحقاق الرواتب قبل الدفع', 409);
    const s = requireSettings(companyId);
    const box = owned(companyId, 'cash_box', input.cashBoxId, { active: true });
    const cur = currencyOf(companyId, input.currencyCode || box.currency_code);
    if (box.currency_code !== cur.code) fail('currency_mismatch', `الصندوق بعملة ${box.currency_code} والدفعة بعملة ${cur.code}`);
    const np = netAndPaid(companyId, p.id, cur.code);
    if (!np.net) fail('no_net_in_currency', `لا توجد رواتب بعملة ${cur.code} في هذه الفترة`, 409);
    const amt = input.amount === undefined && input.amountMinor === undefined ? np.available : amount(input, 'amount', cur.minor_unit_digits, 'مبلغ الدفعة');
    if (amt <= 0) fail('nothing_to_pay', 'لا يوجد صافي رواتب متبقٍ للدفع', 409);
    if (amt > np.available) fail('payment_exceeds_net', `المبلغ أكبر من الصافي المتبقي (${fromMinor(np.available, cur.minor_unit_digits)} ${cur.code})`, 409);
    const date = input.date || today();
    const v = require('./treasury').createVoucher(companyId, { type: 'payment', cashBoxId: box.id, amountMinor: amt, counterAccountId: s.salaries_payable_account_id, date, payee: input.payee || 'رواتب', reference: `PAYROLL ${p.period} ${p.external_id}`, description: `دفع رواتب ${p.period} (${cur.code})` }, actor);
    const id = Number(db.prepare('INSERT INTO payroll_payments (company_id, period_id, currency_code, amount_minor, voucher_id, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, p.id, cur.code, amt, v.id, actor?.id ?? null).lastInsertRowid);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.payment.create', entityType: 'payroll_payment', entityId: id, after: { period_id: p.id, currency: cur.code, amount_minor: amt, voucher_id: v.id } });
    return { ...db.prepare('SELECT * FROM payroll_payments WHERE id = ?').get(id), voucher: v };
  });
}

// ---------------------------------------------------------------------
// Deduction payments (to the authority / fund), per type and currency
// ---------------------------------------------------------------------

function deductionBalance(companyId, typeId, cur) {
  const acc = db.prepare("SELECT COALESCE(SUM(d.amount_minor), 0) o, COALESCE(SUM(d.base_minor), 0) b FROM payroll_period_deductions d JOIN payroll_periods p ON p.id = d.period_id WHERE d.type_id = ? AND d.currency_code = ? AND p.status = 'posted'").get(typeId, cur);
  const paid = db.prepare("SELECT COALESCE(SUM(x.amount_minor), 0) o, COALESCE(SUM(x.payable_base_minor), 0) b FROM payroll_deduction_payments x JOIN treasury_vouchers v ON v.id = x.voucher_id WHERE x.type_id = ? AND x.currency_code = ? AND v.status = 'posted'").get(typeId, cur);
  const committed = db.prepare("SELECT COALESCE(SUM(x.amount_minor), 0) o FROM payroll_deduction_payments x JOIN treasury_vouchers v ON v.id = x.voucher_id WHERE x.type_id = ? AND x.currency_code = ? AND v.status IN ('draft', 'posted')").get(typeId, cur).o;
  return { accrued: acc.o, accrued_base: acc.b, paid: paid.o, paid_base: paid.b, outstanding: acc.o - paid.o, outstanding_base: acc.b - paid.b, available: acc.o - committed };
}

function createDeductionPayment(companyId, input = {}, actor) {
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    requireSettings(companyId);
    const t = db.prepare('SELECT * FROM payroll_deduction_types WHERE company_id = ? AND code = ?').get(companyId, String(input.typeCode || ''));
    if (!t) fail('invalid_deduction_type', 'نوع الاستقطاع غير معرّف');
    const box = owned(companyId, 'cash_box', input.cashBoxId, { active: true });
    const cur = currencyOf(companyId, input.currencyCode || box.currency_code);
    if (box.currency_code !== cur.code) fail('currency_mismatch', `الصندوق بعملة ${box.currency_code} والدفعة بعملة ${cur.code}`);
    const b = deductionBalance(companyId, t.id, cur.code);
    const amt = input.amount === undefined && input.amountMinor === undefined ? b.available : amount(input, 'amount', cur.minor_unit_digits, 'مبلغ الدفعة');
    if (amt <= 0) fail('nothing_to_pay', 'لا يوجد رصيد مستحق لهذا النوع بهذه العملة', 409);
    if (amt > b.available) fail('payment_exceeds_balance', `المبلغ أكبر من الرصيد المستحق (${fromMinor(b.available, cur.minor_unit_digits)} ${cur.code})`, 409);
    const v = require('./treasury').createVoucher(companyId, { type: 'payment', cashBoxId: box.id, amountMinor: amt, counterAccountId: t.account_id, date: input.date || today(), payee: input.payee || t.name, reference: `DED ${t.code}`, description: `سداد ${t.name} (${cur.code})` }, actor);
    const id = Number(db.prepare('INSERT INTO payroll_deduction_payments (company_id, type_id, currency_code, amount_minor, voucher_id, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(companyId, t.id, cur.code, amt, v.id, actor?.id ?? null).lastInsertRowid);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.deduction_payment.create', entityType: 'payroll_deduction_payment', entityId: id, after: { type: t.code, currency: cur.code, amount_minor: amt, voucher_id: v.id } });
    return { ...db.prepare('SELECT * FROM payroll_deduction_payments WHERE id = ?').get(id), voucher: v };
  });
}

function deductionsReport(companyId) {
  const rows = [];
  for (const t of listDeductionTypes(companyId)) {
    const curs = new Set([...db.prepare('SELECT DISTINCT currency_code c FROM payroll_period_deductions WHERE type_id = ?').all(t.id), ...db.prepare('SELECT DISTINCT currency_code c FROM payroll_deduction_payments WHERE type_id = ?').all(t.id)].map((r) => r.c));
    for (const cur of curs) rows.push({ type_id: t.id, code: t.code, name: t.name, account_code: t.account_code, currency: cur, ...deductionBalance(companyId, t.id, cur) });
  }
  const ledgerBal = (aid) => db.prepare("SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND l.account_id = ?").get(companyId, aid).b;
  const accounts = [...new Set(listDeductionTypes(companyId).map((t) => t.account_id))].map((aid) => ({ account_id: aid, code: db.prepare('SELECT code FROM accounts WHERE id = ?').get(aid).code, ledger_minor: ledgerBal(aid) }));
  return { rows, accounts, digits: baseOf(companyId).minor_unit_digits };
}

// Called by lib/treasury.js while approving a payment voucher: for a
// payroll payment in a foreign currency, the salaries payable is relieved
// at the value it was accrued at (pro rata, the last payment takes the
// rest) and the rate difference is realized FX. null = not a payroll
// payment in a foreign currency (the voucher posts as usual).
function voucherCounter(companyId, v) {
  const dp = db.prepare('SELECT * FROM payroll_deduction_payments WHERE voucher_id = ? AND company_id = ?').get(v.id, companyId);
  if (dp) {
    if (dp.currency_code === baseOf(companyId).code) return null;
    const b = deductionBalance(companyId, dp.type_id, dp.currency_code);
    const base = dp.amount_minor >= b.outstanding ? b.outstanding_base : Math.round((b.outstanding_base * dp.amount_minor) / b.outstanding);
    db.prepare('UPDATE payroll_deduction_payments SET payable_base_minor = ? WHERE id = ?').run(base, dp.id);
    return { counterBase: base };
  }
  const pay = db.prepare('SELECT * FROM payroll_payments WHERE voucher_id = ? AND company_id = ?').get(v.id, companyId);
  if (!pay || pay.currency_code === baseOf(companyId).code) return null;
  const s = requireSettings(companyId);
  const p = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(pay.period_id);
  const accrued = db.prepare('SELECT COALESCE(SUM(credit_minor - debit_minor), 0) b, COALESCE(SUM(CASE WHEN credit_minor > 0 THEN amount_original_minor ELSE -amount_original_minor END), 0) o FROM journal_lines WHERE entry_id = ? AND account_id = ? AND currency_code = ?')
    .get(p.journal_entry_id, s.salaries_payable_account_id, pay.currency_code);
  const paid = db.prepare("SELECT COALESCE(SUM(pp.amount_minor), 0) o, COALESCE(SUM(pp.payable_base_minor), 0) b FROM payroll_payments pp JOIN treasury_vouchers tv ON tv.id = pp.voucher_id WHERE pp.period_id = ? AND pp.currency_code = ? AND tv.status = 'posted' AND pp.id <> ?").get(p.id, pay.currency_code, pay.id);
  const remO = accrued.o - paid.o;
  const remB = accrued.b - paid.b;
  const base = pay.amount_minor >= remO ? remB : Math.round((remB * pay.amount_minor) / remO);
  db.prepare('UPDATE payroll_payments SET payable_base_minor = ? WHERE id = ?').run(base, pay.id);
  return { counterBase: base };
}

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------

function costReport(companyId, { from, to } = {}) {
  if (from && !isPeriod(from)) fail('invalid_period', 'الفترة غير صالحة');
  if (to && !isPeriod(to)) fail('invalid_period', 'الفترة غير صالحة');
  const periods = db.prepare(`SELECT * FROM payroll_periods WHERE company_id = ? AND status = 'posted' ${from ? 'AND period >= ?' : ''} ${to ? 'AND period <= ?' : ''} ORDER BY period`).all(companyId, ...[from, to].filter(Boolean));
  const rows = new Map();
  const baseCode = baseOf(companyId).code;
  for (const p of periods) {
    // Base = the same conversion the accrual used (rate stored on the period).
    const rates = p.rates_json ? JSON.parse(p.rates_json) : {};
    const toBase = (cur, m) => (cur === baseCode || !m ? m : P.toBase(companyId, cur, m, { rateE8: rates[cur].rate_e8, quote: rates[cur].quote }));
    for (const l of db.prepare('SELECT * FROM payroll_lines WHERE period_id = ? ORDER BY line_no').all(p.id)) {
      const key = `${p.period}|${l.department}|${l.currency_code}`;
      const r = rows.get(key) || { period: p.period, department: l.department, currency: l.currency_code, gross_minor: 0, employer_contrib_minor: 0, net_minor: 0, cost_base_minor: 0, headcount: 0 };
      r.gross_minor += l.gross_minor;
      r.employer_contrib_minor += l.employer_contrib_minor;
      r.net_minor += l.net_minor;
      r.headcount += l.headcount || 0;
      r.cost_base_minor += toBase(l.currency_code, l.gross_minor) + toBase(l.currency_code, l.employer_contrib_minor);
      rows.set(key, r);
    }
  }
  const out = [...rows.values()];
  return { from: from || null, to: to || null, rows: out, total_cost_base_minor: out.reduce((t, r) => t + r.cost_base_minor, 0), digits: baseOf(companyId).minor_unit_digits };
}

function payablesReport(companyId) {
  const s = getSettings(companyId);
  const periods = db.prepare("SELECT * FROM payroll_periods WHERE company_id = ? AND status = 'posted' ORDER BY period").all(companyId);
  const rows = [];
  for (const p of periods) {
    for (const cur of db.prepare('SELECT DISTINCT currency_code c FROM payroll_lines WHERE period_id = ?').all(p.id).map((r) => r.c)) {
      const np = netAndPaid(companyId, p.id, cur);
      const paid = db.prepare("SELECT COALESCE(SUM(pp.amount_minor), 0) s FROM payroll_payments pp JOIN treasury_vouchers v ON v.id = pp.voucher_id WHERE pp.period_id = ? AND pp.currency_code = ? AND v.status = 'posted'").get(p.id, cur).s;
      rows.push({ period_id: p.id, period: p.period, external_id: p.external_id, currency: cur, net_minor: np.net, paid_minor: paid, in_payment_minor: np.committed - paid, outstanding_minor: np.net - paid });
    }
  }
  const bal = (aid) => (aid ? db.prepare("SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ? AND e.status IN ('posted', 'reversed') AND l.account_id = ?").get(companyId, aid).b : 0);
  return { rows, salaries_payable_ledger_minor: bal(s?.salaries_payable_account_id), deductions_payable_ledger_minor: bal(s?.deductions_payable_account_id), digits: baseOf(companyId).minor_unit_digits };
}

// ---------------------------------------------------------------------
// Labour cost rates (Prompt 16 input; production orders read them)
// ---------------------------------------------------------------------

function addLaborRate(companyId, input = {}, actor) {
  return ledger.transaction(() => {
    const cc = input.costCenterId ? owned(companyId, 'cost_center', input.costCenterId, { active: true }).id : null;
    const line = input.productLine ? String(input.productLine).trim() : null;
    const d = baseOf(companyId).minor_unit_digits;
    const rate = amount(input, 'ratePerHour', d, 'تكلفة الساعة');
    if (!isValidDate(input.effectiveFrom)) fail('invalid_date', 'تاريخ السريان مطلوب');
    if (db.prepare('SELECT 1 FROM labor_cost_rates WHERE company_id = ? AND COALESCE(cost_center_id, 0) = ? AND COALESCE(product_line, \'\') = ? AND effective_from = ?').get(companyId, cc ?? 0, line ?? '', input.effectiveFrom)) {
      fail('rate_exists', 'يوجد سعر بنفس تاريخ السريان — أضف سعرًا بتاريخ آخر', 409);
    }
    const id = Number(db.prepare('INSERT INTO labor_cost_rates (company_id, cost_center_id, product_line, rate_per_hour_minor, effective_from, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(companyId, cc, line, rate, input.effectiveFrom, input.notes || null, actor?.id ?? null).lastInsertRowid);
    const after = db.prepare('SELECT * FROM labor_cost_rates WHERE id = ?').get(id);
    logAudit({ companyId, actor: actorOf(actor), action: 'payroll.labor_rate.create', entityType: 'labor_cost_rate', entityId: id, after });
    return after;
  });
}
const listLaborRates = (companyId) => db.prepare('SELECT r.*, cc.code cost_center_code, cc.name cost_center_name FROM labor_cost_rates r LEFT JOIN cost_centers cc ON cc.id = r.cost_center_id WHERE r.company_id = ? ORDER BY r.effective_from DESC, r.id DESC').all(companyId);

// The rate in effect on `date`, most specific first: cost center + product
// line, cost center, product line, company-wide.
function laborRateFor(companyId, { costCenterId = null, productLine = null, date } = {}) {
  const d = date || today();
  const pick = (cc, line) => db.prepare(`SELECT * FROM labor_cost_rates WHERE company_id = ? AND ${cc === null ? 'cost_center_id IS NULL' : 'cost_center_id = ?'} AND ${line === null ? 'product_line IS NULL' : 'product_line = ?'} AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1`)
    .get(...[companyId, ...(cc === null ? [] : [cc]), ...(line === null ? [] : [line]), d]);
  const tries = [];
  if (costCenterId && productLine) tries.push(['cost_center_and_product_line', costCenterId, productLine]);
  if (costCenterId) tries.push(['cost_center', costCenterId, null]);
  if (productLine) tries.push(['product_line', null, productLine]);
  tries.push(['company', null, null]);
  for (const [matched, cc, line] of tries) {
    const r = pick(cc, line);
    if (r) return { ...r, matched, date: d };
  }
  return null;
}

const usesPayroll = (companyId) => Boolean(db.prepare('SELECT 1 FROM payroll_periods WHERE company_id = ? LIMIT 1').get(companyId));

module.exports = {
  listDeductionTypes, saveDeductionType, createDeductionPayment, deductionsReport, deductionBalance,
  PayrollError, getSettings, saveSettings,
  importPeriod, importCsv, getPeriod, listPeriods, postPeriod, reopenPeriod,
  createPayment, voucherCounter, recordAdvance, advanceBalance, advancesReport,
  costReport, payablesReport, addLaborRate, listLaborRates, laborRateFor, usesPayroll,
};
