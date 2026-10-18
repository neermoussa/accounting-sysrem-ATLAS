// backend/lib/recurringEntries.js
//
// Prompt 10 — recurring journal templates and adjusting entries.
//   recurring : the same balanced lines on every scheduled date (rent,
//               subscriptions)
//   accrual   : the lines on every scheduled date (normally month end),
//               reversed automatically on the first day of the next month
//   prepayment: total_minor amortised over `occurrences` dates
//               (Dr debit_account [expense] / Cr credit_account [prepaid]);
//               cumulative rounding, the last date takes the remainder
//
// Schedule: start_date, then every 1 / 3 / 12 months on day_of_month
// (clamped to the month's last day; default = the start date's day), until
// end_date or `occurrences` dates. One recurring_runs row per template per
// date (UNIQUE): a date is posted once whatever the number of runs.
// Runs: runDue (on demand / month-end) and the background sweep.

const db = require('../db/init');
const ledger = require('./ledger');
const tenantRefs = require('./tenantRefs');
const { logAudit } = require('./auditLog');
const { checkpoint } = require('./faultInjection');
const { requirePostable } = require('./periodGuard');

class RecurringError extends ledger.LedgerError {}
const fail = (code, message, status = 400, extra) => {
  throw new RecurringError(code, message, status, extra);
};
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const today = () => new Date().toISOString().slice(0, 10);
const KINDS = ['recurring', 'accrual', 'prepayment'];
const STEP = { monthly: 1, quarterly: 3, yearly: 12 };
const MAX_DATES = 600;

function postable(companyId, id, label) {
  let a;
  try {
    a = tenantRefs.requireOwned(companyId, 'account', id, { active: true });
  } catch (err) {
    if (err instanceof tenantRefs.ForeignRefError) fail(err.code, `${label}: ${err.message}`, 400);
    throw err;
  }
  if (!a.is_postable) fail('account_not_postable', `${label}: اختر حسابًا فرعيًا`);
  return a;
}
function ownedTemplate(companyId, id) {
  const n = Number(id);
  const t = Number.isInteger(n) && n > 0 ? db.prepare('SELECT * FROM recurring_templates WHERE id = ? AND company_id = ?').get(n, companyId) : null;
  if (!t) fail('invalid_template', 'القالب غير موجود أو لا يتبع لهذه الشركة', 400);
  return t;
}

// k-th scheduled date (0-based).
function dateAt(t, k) {
  const y = Number(t.start_date.slice(0, 4));
  const m = Number(t.start_date.slice(5, 7)) - 1 + k * STEP[t.frequency];
  const dom = t.day_of_month || Number(t.start_date.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(dom, last))).toISOString().slice(0, 10);
}
// Scheduled dates up to asOf (inclusive), within end_date / occurrences.
function datesUpTo(t, asOf) {
  const out = [];
  for (let k = 0; k < MAX_DATES; k += 1) {
    if (t.occurrences && k >= t.occurrences) break;
    const d = dateAt(t, k);
    if (k === 0 && d < t.start_date) continue;
    if (d > asOf || (t.end_date && d > t.end_date)) break;
    out.push({ k, date: d });
  }
  return out;
}
const firstOfNextMonth = (d) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1)).toISOString().slice(0, 10);

function normLines(companyId, raw) {
  if (!Array.isArray(raw) || raw.length < 2) fail('lines_required', 'القالب يحتاج سطرين على الأقل');
  const lines = raw.map((l, i) => {
    const acc = postable(companyId, l.accountId, `السطر ${i + 1}`);
    const d = Number(l.debitMinor || 0);
    const c = Number(l.creditMinor || 0);
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) fail('invalid_line', `السطر ${i + 1}: مدين أو دائن فقط بمبلغ موجب`);
    return { accountId: acc.id, debitMinor: d, creditMinor: c, memo: l.memo ? String(l.memo).slice(0, 200) : null };
  });
  const dr = lines.reduce((s, l) => s + l.debitMinor, 0);
  if (dr !== lines.reduce((s, l) => s + l.creditMinor, 0)) fail('unbalanced', 'القالب غير متوازن');
  return { lines, total: dr };
}

function saveTemplate(companyId, id, input = {}, actor) {
  return ledger.transaction(() => {
    const ex = id ? ownedTemplate(companyId, id) : null;
    const kind = input.kind ?? ex?.kind ?? 'recurring';
    if (!KINDS.includes(kind)) fail('invalid_kind', 'نوع القالب غير صالح');
    const name = String(input.name ?? ex?.name ?? '').trim();
    if (!name) fail('name_required', 'اسم القالب مطلوب');
    const frequency = input.frequency ?? ex?.frequency ?? 'monthly';
    if (!STEP[frequency]) fail('invalid_frequency', 'التكرار غير صالح');
    const start = input.startDate ?? ex?.start_date;
    if (!isValidDate(start)) fail('invalid_date', 'تاريخ البداية غير صالح');
    const end = input.endDate !== undefined ? input.endDate || null : ex?.end_date ?? null;
    if (end && (!isValidDate(end) || end < start)) fail('invalid_date', 'تاريخ النهاية غير صالح');
    const dom = input.dayOfMonth !== undefined ? (input.dayOfMonth === '' || input.dayOfMonth === null ? null : Number(input.dayOfMonth)) : ex?.day_of_month ?? null;
    if (dom !== null && !(Number.isInteger(dom) && dom >= 1 && dom <= 31)) fail('invalid_day', 'يوم الشهر غير صالح');
    const occ = input.occurrences !== undefined ? (input.occurrences === '' || input.occurrences === null ? null : Number(input.occurrences)) : ex?.occurrences ?? null;
    if (occ !== null && !(Number.isInteger(occ) && occ > 0 && occ <= MAX_DATES)) fail('invalid_occurrences', 'عدد المرات غير صالح');
    let linesJson = null;
    let total = null;
    let dr = null;
    let cr = null;
    if (kind === 'prepayment') {
      total = Number(input.totalMinor ?? ex?.total_minor);
      if (!Number.isInteger(total) || total <= 0) fail('invalid_amount', 'المبلغ المدفوع مقدمًا غير صالح');
      if (!occ) fail('occurrences_required', 'حدد عدد فترات الإطفاء');
      dr = postable(companyId, input.debitAccountId ?? ex?.debit_account_id, 'حساب المصروف').id;
      cr = postable(companyId, input.creditAccountId ?? ex?.credit_account_id, 'حساب المصروف المدفوع مقدمًا').id;
      if (dr === cr) fail('same_accounts', 'الحسابان يجب أن يختلفا');
    } else {
      const n = normLines(companyId, input.lines ?? (ex?.lines_json ? JSON.parse(ex.lines_json) : null));
      linesJson = JSON.stringify(n.lines);
      total = n.total;
    }
    if (ex) {
      // Already-posted dates are history; a change that would move them is refused.
      const runs = db.prepare('SELECT run_date FROM recurring_runs WHERE template_id = ?').all(ex.id).map((r) => r.run_date);
      const probe = { ...ex, start_date: start, frequency, day_of_month: dom, occurrences: occ, end_date: end };
      const sched = new Set(datesUpTo(probe, '9999-12-31').map((x) => x.date));
      if (runs.some((d) => !sched.has(d)) || (kind !== ex.kind && runs.length)) fail('template_has_runs', 'لا يمكن تغيير جدول قالب له قيود مرحّلة بهذا الشكل — أوقفه وأنشئ قالبًا جديدًا', 409);
      if (kind === 'prepayment' && runs.length && (total !== ex.total_minor || occ !== ex.occurrences)) fail('template_has_runs', 'لا يمكن تغيير مبلغ أو مدة إطفاء بدأ — أوقفه وأنشئ قالبًا جديدًا', 409);
    }
    const vals = [name, kind, frequency, dom, start, end, occ, linesJson, total, dr, cr, input.description !== undefined ? input.description || null : ex?.description ?? null, input.active === undefined ? ex?.active ?? 1 : input.active ? 1 : 0];
    let tid = ex?.id;
    if (ex) db.prepare("UPDATE recurring_templates SET name = ?, kind = ?, frequency = ?, day_of_month = ?, start_date = ?, end_date = ?, occurrences = ?, lines_json = ?, total_minor = ?, debit_account_id = ?, credit_account_id = ?, description = ?, active = ?, updated_at = datetime('now') WHERE id = ?").run(...vals, tid);
    else tid = Number(db.prepare('INSERT INTO recurring_templates (company_id, name, kind, frequency, day_of_month, start_date, end_date, occurrences, lines_json, total_minor, debit_account_id, credit_account_id, description, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(companyId, ...vals, actor?.id ?? null).lastInsertRowid);
    const after = getTemplate(companyId, tid);
    logAudit({ companyId, actor: actorOf(actor), action: ex ? 'recurring.template.update' : 'recurring.template.create', entityType: 'recurring_template', entityId: tid, before: ex, after });
    return after;
  });
}

function getTemplate(companyId, id) {
  const t = ownedTemplate(companyId, id);
  return {
    ...t,
    lines: t.lines_json ? JSON.parse(t.lines_json) : null,
    runs: db.prepare('SELECT r.*, e.entry_number, v.entry_number reversal_number FROM recurring_runs r LEFT JOIN journal_entries e ON e.id = r.journal_entry_id LEFT JOIN journal_entries v ON v.id = r.reversal_entry_id WHERE r.template_id = ? ORDER BY r.run_date').all(t.id),
    next_date: nextDate(t),
  };
}
function nextDate(t) {
  const done = new Set(db.prepare('SELECT run_date FROM recurring_runs WHERE template_id = ?').all(t.id).map((r) => r.run_date));
  return datesUpTo(t, '9999-12-31').find((x) => !done.has(x.date))?.date ?? null;
}
function listTemplates(companyId) {
  return db.prepare('SELECT * FROM recurring_templates WHERE company_id = ? ORDER BY id').all(companyId)
    .map((t) => ({ ...t, lines: t.lines_json ? JSON.parse(t.lines_json) : null, runs_count: db.prepare('SELECT COUNT(*) c FROM recurring_runs WHERE template_id = ?').get(t.id).c, next_date: t.active ? nextDate(t) : null }));
}

function linesFor(t, k) {
  if (t.kind !== 'prepayment') return JSON.parse(t.lines_json);
  const n = t.occurrences;
  const cum = (i) => Number((BigInt(t.total_minor) * BigInt(i) * 2n + BigInt(n)) / (BigInt(n) * 2n));
  const amt = cum(k + 1) - cum(k);
  return [
    { accountId: t.debit_account_id, debitMinor: amt, creditMinor: 0, memo: `إطفاء ${k + 1}/${n}` },
    { accountId: t.credit_account_id, debitMinor: 0, creditMinor: amt, memo: `إطفاء ${k + 1}/${n}` },
  ];
}

const LABEL = { recurring: 'قيد دوري', accrual: 'استحقاق', prepayment: 'إطفاء مدفوع مقدمًا' };

// Post every scheduled date up to asOf that has no run yet, and every due
// accrual reversal. Re-running posts nothing new.
function runDue(companyId, { asOf = today(), templateId } = {}, actor) {
  if (!isValidDate(asOf)) fail('invalid_date', 'التاريخ غير صالح');
  ledger.ensureLedgerSetup(companyId);
  return ledger.transaction(() => {
    const ts = db.prepare(`SELECT * FROM recurring_templates WHERE company_id = ? AND active = 1 ${templateId ? 'AND id = ?' : ''} ORDER BY id`).all(...(templateId ? [companyId, Number(templateId)] : [companyId]));
    const posted = [];
    const reversed = [];
    for (const t of ts) {
      const done = new Set(db.prepare('SELECT run_date FROM recurring_runs WHERE template_id = ?').all(t.id).map((r) => r.run_date));
      for (const { k, date } of datesUpTo(t, asOf)) {
        if (done.has(date)) continue;
        requirePostable(companyId, date, `${LABEL[t.kind]} «${t.name}» بتاريخ ${date}`);
        const lines = linesFor(t, k).filter((l) => l.debitMinor || l.creditMinor);
        const amount = lines.reduce((s, l) => s + l.debitMinor, 0);
        const rid = Number(db.prepare('INSERT INTO recurring_runs (company_id, template_id, run_date, seq, amount_minor) VALUES (?, ?, ?, ?, ?)').run(companyId, t.id, date, k + 1, amount).lastInsertRowid);
        if (!amount) continue;
        const e = ledger.postEntry(companyId, { date, description: `${LABEL[t.kind]}: ${t.name} (${k + 1})`, sourceType: 'recurring_run', sourceId: rid, lines }, actor);
        checkpoint('recurring.run.after_entry');
        db.prepare('UPDATE recurring_runs SET journal_entry_id = ? WHERE id = ?').run(e.id, rid);
        posted.push({ template_id: t.id, run_date: date, amount_minor: amount, journal_entry_id: e.id });
      }
    }
    // Accrual reversals due by asOf (first day of the month after the run).
    const pend = db.prepare(`SELECT r.* FROM recurring_runs r JOIN recurring_templates t ON t.id = r.template_id
      WHERE r.company_id = ? AND t.kind = 'accrual' AND r.journal_entry_id IS NOT NULL AND r.reversal_entry_id IS NULL ${templateId ? 'AND t.id = ?' : ''} ORDER BY r.run_date`).all(...(templateId ? [companyId, Number(templateId)] : [companyId]));
    for (const r of pend) {
      const rd = firstOfNextMonth(r.run_date);
      if (rd > asOf) continue;
      requirePostable(companyId, rd, `عكس الاستحقاق بتاريخ ${rd}`);
      const rev = ledger.reverseEntry(companyId, r.journal_entry_id, { date: rd, reason: 'عكس استحقاق تلقائي', fromSource: true }, actor);
      checkpoint('recurring.reversal.after_entry');
      db.prepare('UPDATE recurring_runs SET reversal_entry_id = ? WHERE id = ?').run(rev.reversal.id, r.id);
      reversed.push({ run_id: r.id, date: rd, journal_entry_id: rev.reversal.id });
    }
    if (posted.length || reversed.length) logAudit({ companyId, actor: actorOf(actor), action: 'recurring.run', entityType: 'recurring_run', entityId: null, after: { as_of: asOf, posted: posted.length, reversed: reversed.length } });
    return { as_of: asOf, posted, reversed };
  });
}

function sweep(asOf = today()) {
  const out = [];
  for (const { company_id: cid } of db.prepare('SELECT DISTINCT company_id FROM recurring_templates WHERE active = 1').all()) {
    try {
      out.push({ company_id: cid, ...require('./postingQueue').guard(cid, { kind: 'recurring.run', sourceId: 'sweep', label: 'القيود الدورية المستحقة', postingDate: asOf, payload: { asOf } }, () => runDue(cid, { asOf }, null), null) });
    } catch (err) {
      out.push({ company_id: cid, error: err.code || err.message });
    }
  }
  return out;
}

// For the month-end checklist: scheduled dates / reversals due by `to` and not posted.
function dueCount(companyId, to) {
  let n = 0;
  for (const t of db.prepare('SELECT * FROM recurring_templates WHERE company_id = ? AND active = 1').all(companyId)) {
    const done = new Set(db.prepare('SELECT run_date FROM recurring_runs WHERE template_id = ?').all(t.id).map((r) => r.run_date));
    n += datesUpTo(t, to).filter((x) => !done.has(x.date)).length;
  }
  n += db.prepare(`SELECT r.run_date FROM recurring_runs r JOIN recurring_templates t ON t.id = r.template_id WHERE r.company_id = ? AND t.kind = 'accrual' AND r.journal_entry_id IS NOT NULL AND r.reversal_entry_id IS NULL`).all(companyId)
    .filter((r) => firstOfNextMonth(r.run_date) <= to).length;
  return n;
}
const usesRecurring = (companyId) => Boolean(db.prepare('SELECT 1 FROM recurring_templates WHERE company_id = ? LIMIT 1').get(companyId));

module.exports = { RecurringError, KINDS, saveTemplate, getTemplate, listTemplates, runDue, sweep, dueCount, usesRecurring, dateAt, datesUpTo };
