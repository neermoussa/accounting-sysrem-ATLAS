// backend/lib/reportBuilder.js
//
// Prompt 12b — saved, scheduled, exported and sent Report Builder reports.
// The query itself (spec validation, permissions, execution in a worker) is
// lib/analytics/query.js through routes/reportBuilder.js runSpec().
//
// Saved reports: private to the owner, or shared (needs share_reports). A
//   shared report is visible to users who hold view_financial_reports AND
//   what the spec needs (view_costs / payroll). Only the owner edits; the
//   owner or a share_reports holder deletes (soft delete, schedules stop).
// Runs: a run produces ONE file (xlsx / pdf / csv) under
//   uploads/report-runs/<company>/ (not publicly served; downloaded through a
//   permission-checked endpoint). Manual runs use the caller's permissions;
//   scheduled runs the schedule owner's CURRENT permissions.
// Schedules: daily / weekly / monthly at a local time (fixed UTC offset,
//   default +180 min). The sweep claims a due slot in one BEGIN IMMEDIATE
//   transaction (UNIQUE schedule_id + scheduled_for), runs it once for the
//   LATEST due slot (missed slots are counted, not replayed), and moves
//   next_run_at past now. A period preset is resolved on the slot's local
//   date, so a 1 January run of "last month" reports December.
// Sends: a request names explicit recipients and waits; nothing leaves
//   until another send_reports holder approves (adaptive separation of
//   duties, owner break-glass). Recipients are checked when requested and
//   again when approved: data that needs view_costs / payroll goes only to
//   company users holding that permission (no outside address).

const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const clock = require('./clock');
const Q = require('./analytics/query');
const { logAudit } = require('./auditLog');
const { getUserPermissions } = require('./permissions');
const tenantRefs = require('./tenantRefs');

class BuilderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status) => { throw new BuilderError(code, message, status); };
const actorOf = (u) => (u ? { id: u.id, name: u.name } : null);
const RUNS_DIR = process.env.ATLAS_REPORT_RUNS_DIR || path.join(__dirname, '..', 'uploads', 'report-runs');
const has = (user, p) => (user.permissions || []).includes(p);

// The spec as stored: what the user asked for (presets stay presets).
function storedSpec(n) {
  const out = { source: n.source, measures: n.measures, dimensions: n.dimensions, filters: n.filters, period: n.period };
  if (n.calcs.length) out.calcs = n.calcs;
  if (n.compare) out.compare = n.compare;
  if (n.sort) out.sort = n.sort;
  if (n.limit !== 1000) out.limit = n.limit;
  if (n.includeClosing) out.includeClosing = true;
  return out;
}
const needsOf = (row) => (row.needs ? row.needs.split(',').filter(Boolean) : []);
const NEED_PERMS = { costs: [Q.COSTS_PERM], payroll: Q.PAYROLL_PERMS };
const holdsNeed = (perms, need) => NEED_PERMS[need].some((p) => perms.includes(p));
function canSee(row, user) {
  if (row.deleted_at) return false;
  if (row.owner_id === user.id) return true;
  return row.visibility === 'shared' && has(user, Q.REPORTS_PERM) && needsOf(row).every((n) => holdsNeed(user.permissions || [], n));
}
const toApi = (row, user) => ({
  id: row.id, name: row.name, description: row.description, visibility: row.visibility, owner_id: row.owner_id,
  owner_name: db.prepare('SELECT name FROM users WHERE id = ?').get(row.owner_id)?.name ?? null,
  spec: JSON.parse(row.spec_json), needs: needsOf(row), created_at: row.created_at, updated_at: row.updated_at,
  can_edit: row.owner_id === user.id, can_delete: row.owner_id === user.id || (row.visibility === 'shared' && has(user, 'share_reports')),
});

// ---------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------
function rowOf(companyId, id) {
  const row = db.prepare('SELECT * FROM saved_reports WHERE id = ? AND company_id = ?').get(Number(id), companyId);
  if (!row || row.deleted_at) fail('report_not_found', 'التقرير غير موجود', 404);
  return row;
}
function visibleRow(companyId, id, user) {
  const row = rowOf(companyId, id);
  if (!canSee(row, user)) fail('report_not_found', 'التقرير غير موجود', 404);
  return row;
}
function listSaved(companyId, user) {
  return db.prepare('SELECT * FROM saved_reports WHERE company_id = ? AND deleted_at IS NULL ORDER BY name').all(companyId).filter((r) => canSee(r, user)).map((r) => toApi(r, user));
}
function getSaved(companyId, id, user) {
  return toApi(visibleRow(companyId, id, user), user);
}
function checkFields({ name, description, visibility }, user) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 100) fail('invalid_name', 'اسم التقرير مطلوب (حتى 100 حرف)');
  if (description !== undefined && description !== null && String(description).length > 500) fail('invalid_description', 'الوصف حتى 500 حرف');
  const v = visibility || 'private';
  if (!['private', 'shared'].includes(v)) fail('invalid_visibility', 'الظهور: private أو shared');
  if (v === 'shared' && !has(user, 'share_reports')) fail('forbidden_share', 'مشاركة التقارير تحتاج صلاحية مشاركة التقارير', 403);
  return { name: n, description: description ? String(description) : null, visibility: v };
}
function createSaved(companyId, user, input = {}) {
  const f = checkFields(input, user);
  const n = Q.validate(input.spec, { companyId, permissions: user.permissions, now: clock.today() });
  if (db.prepare('SELECT 1 FROM saved_reports WHERE company_id = ? AND owner_id = ? AND name = ? AND deleted_at IS NULL').get(companyId, user.id, f.name)) fail('name_exists', 'لديك تقرير محفوظ بهذا الاسم', 409);
  const spec = storedSpec(n);
  const id = db.prepare('INSERT INTO saved_reports (company_id, owner_id, name, description, spec_json, needs, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(companyId, user.id, f.name, f.description, JSON.stringify(spec), n.needs.join(','), f.visibility, clock.nowSql(), clock.nowSql()).lastInsertRowid;
  logAudit({ companyId, actor: actorOf(user), action: 'report.saved.create', entityType: 'saved_report', entityId: Number(id), before: null, after: { name: f.name, visibility: f.visibility, spec, needs: n.needs } });
  return getSaved(companyId, id, user);
}
function updateSaved(companyId, id, user, input = {}) {
  const row = visibleRow(companyId, id, user);
  if (row.owner_id !== user.id) fail('not_owner', 'يعدّل التقرير صاحبه فقط', 403);
  const f = checkFields({ name: input.name ?? row.name, description: input.description !== undefined ? input.description : row.description, visibility: input.visibility ?? row.visibility }, user);
  if (row.visibility === 'shared' && f.visibility === 'private' && !has(user, 'share_reports')) fail('forbidden_share', 'تحتاج صلاحية مشاركة التقارير', 403);
  const n = Q.validate(input.spec !== undefined ? input.spec : JSON.parse(row.spec_json), { companyId, permissions: user.permissions, now: clock.today() });
  if (f.name !== row.name && db.prepare('SELECT 1 FROM saved_reports WHERE company_id = ? AND owner_id = ? AND name = ? AND deleted_at IS NULL AND id <> ?').get(companyId, user.id, f.name, row.id)) fail('name_exists', 'لديك تقرير محفوظ بهذا الاسم', 409);
  const spec = storedSpec(n);
  db.prepare('UPDATE saved_reports SET name = ?, description = ?, spec_json = ?, needs = ?, visibility = ?, updated_at = ? WHERE id = ?').run(f.name, f.description, JSON.stringify(spec), n.needs.join(','), f.visibility, clock.nowSql(), row.id);
  logAudit({ companyId, actor: actorOf(user), action: 'report.saved.update', entityType: 'saved_report', entityId: row.id, before: { name: row.name, visibility: row.visibility, spec: JSON.parse(row.spec_json) }, after: { name: f.name, visibility: f.visibility, spec } });
  return getSaved(companyId, row.id, user);
}
function deleteSaved(companyId, id, user) {
  const row = visibleRow(companyId, id, user);
  if (!(row.owner_id === user.id || (row.visibility === 'shared' && has(user, 'share_reports')))) fail('not_owner', 'يحذف التقرير صاحبه أو من يملك صلاحية مشاركة التقارير', 403);
  const stopped = db.prepare('SELECT id FROM report_schedules WHERE report_id = ? AND is_active = 1').all(row.id).map((s) => s.id);
  db.prepare('UPDATE saved_reports SET deleted_at = ?, updated_at = ? WHERE id = ?').run(clock.nowSql(), clock.nowSql(), row.id);
  db.prepare('UPDATE report_schedules SET is_active = 0, updated_at = ? WHERE report_id = ?').run(clock.nowSql(), row.id);
  logAudit({ companyId, actor: actorOf(user), action: 'report.saved.delete', entityType: 'saved_report', entityId: row.id, before: { name: row.name, visibility: row.visibility }, after: { deleted: true, schedules_stopped: stopped } });
  return { ok: true, schedules_stopped: stopped };
}

// ---------------------------------------------------------------------
// Files (export path: lib/xlsxExport.js, lib/pdfExport.js; CSV here)
// ---------------------------------------------------------------------
const fmtMoney = (companyId, v) => (v === null || v === undefined ? '' : require('./financialReports').fmt(companyId, v));
function cellValue(companyId, col, v) {
  if (v === null || v === undefined) return '';
  if (col.type === 'money') return fmtMoney(companyId, v);
  if (col.type === 'percent') return `${v}%`;
  return v;
}
function flatTable(companyId, result, lang) {
  const columns = result.columns.map((c) => ({ key: c.key, header: c.label_ar, headerEn: c.label_en, width: c.role === 'dimension' ? 28 : 18, type: c.type, role: c.role }));
  const rows = result.rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, cellValue(companyId, c, r[c.key])])));
  // No dimension: the single row IS the total.
  if (!columns.some((c) => c.role === 'dimension')) return { columns, rows };
  const totals = Object.fromEntries(columns.map((c) => [c.key, c.role === 'dimension' ? '' : cellValue(companyId, c, result.totals[c.key])]));
  totals[columns[0].key] = lang === 'en' ? 'Total' : 'الإجمالي';
  return { columns, rows: [...rows, totals] };
}
// RFC 4180, UTF-8 with BOM (Excel opens Arabic correctly). A TEXT cell that
// starts with = + - @ is prefixed with ' so a spreadsheet does not run it
// as a formula (CSV injection); numbers are written as numbers.
function toCsv(columns, rows, lang) {
  const esc = (v, isText) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(lang === 'en' ? c.headerEn || c.header : c.header, true)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key], c.role === 'dimension' || typeof r[c.key] === 'string' && c.type === 'text')).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8' };
async function renderFile(companyId, result, { format, lang, title }) {
  if (!MIME[format]) fail('invalid_format', 'الصيغة: xlsx أو pdf أو csv');
  const { columns, rows } = flatTable(companyId, result, lang);
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId)?.name;
  const period = `${result.period.from} → ${result.period.to}${result.compare_period ? ` / ${result.compare_period.from} → ${result.compare_period.to}` : ''}`;
  let buffer;
  if (format === 'csv') buffer = Buffer.from(toCsv(columns, rows, lang), 'utf8');
  else if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const { addSheet } = require('./xlsxExport');
    const wb = new ExcelJS.Workbook();
    addSheet(wb, title, columns, rows, { title, companyName: company, dateRange: result.period, filterLabel: result.truncated ? (lang === 'en' ? `First ${result.rows.length} of ${result.row_count} rows` : `أول ${result.rows.length} من ${result.row_count} صفًا`) : undefined, lang });
    buffer = Buffer.from(await wb.xlsx.writeBuffer());
  } else {
    buffer = await require('./pdfExport').renderTablePdf({ title, subtitle: period, columns, rows, meta: [company].filter(Boolean), lang });
  }
  return { buffer, mime: MIME[format], ext: format };
}
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 80).trim() || 'report';

// ---------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------
function userFor(companyId, userId) {
  const u = db.prepare("SELECT id, name, company_id, status FROM users WHERE id = ? AND company_id = ? AND status = 'approved'").get(userId, companyId);
  return u ? { id: u.id, name: u.name, permissions: getUserPermissions(u.id) } : null;
}
const runToApi = (r) => ({ ...r, truncated: !!r.truncated, needs: r.needs ? r.needs.split(',').filter(Boolean) : [], spec: r.spec_json ? JSON.parse(r.spec_json) : null, spec_json: undefined, file_path: undefined, has_file: !!r.file_path });
function getRun(companyId, id) {
  const r = db.prepare('SELECT * FROM report_runs WHERE id = ? AND company_id = ?').get(Number(id), companyId);
  if (!r) fail('run_not_found', 'التشغيل غير موجود', 404);
  return r;
}
// Produce the file of a claimed run (status 'running'). Never throws: a
// failure is recorded on the run.
async function executeRun(runId, { runSpec, user, now }) {
  const run = db.prepare('SELECT * FROM report_runs WHERE id = ?').get(runId);
  const report = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(run.report_id);
  const finish = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE report_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, finished_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), clock.nowSql(), runId);
  };
  try {
    if (!user) fail('run_user_inactive', 'صاحب الجدولة لم يعد مستخدمًا فعّالًا', 403);
    if (!report || report.deleted_at) fail('report_not_found', 'التقرير محذوف', 404);
    if (!canSee(report, user)) fail('report_not_visible', 'التقرير لم يعد متاحًا لصاحب الجدولة', 403);
    const result = await runSpec(run.company_id, user.permissions, JSON.parse(report.spec_json), now);
    const file = await renderFile(run.company_id, result, { format: run.format, lang: run.lang, title: report.name });
    const dir = path.join(RUNS_DIR, String(run.company_id));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${runId}.${file.ext}`);
    fs.writeFileSync(filePath, file.buffer);
    finish({ status: 'done', file_path: filePath, file_name: `${safeName(report.name)}-${result.period.to}.${file.ext}`, row_count: result.row_count, truncated: result.truncated ? 1 : 0, spec_json: JSON.stringify(result.spec), needs: result.spec.needs.join(','), period_from: result.period.from, period_to: result.period.to });
  } catch (err) {
    finish({ status: 'failed', error_code: err.code || 'run_failed', error_message: String(err.message || err).slice(0, 500) });
  }
  const done = db.prepare('SELECT * FROM report_runs WHERE id = ?').get(runId);
  logAudit({ companyId: run.company_id, actor: actorOf(user), action: run.run_kind === 'schedule' ? 'report.run.scheduled' : 'report.run', entityType: 'report_run', entityId: runId, before: null, after: { report_id: run.report_id, schedule_id: run.schedule_id, scheduled_for: run.scheduled_for, missed_slots: run.missed_slots, status: done.status, format: done.format, rows: done.row_count, needs: done.needs, error: done.error_code } });
  return done;
}
async function runNow(companyId, reportId, user, { format = 'xlsx', lang = 'ar' } = {}, runSpec) {
  const report = visibleRow(companyId, reportId, user);
  if (!MIME[format]) fail('invalid_format', 'الصيغة: xlsx أو pdf أو csv');
  if (!['ar', 'en'].includes(lang)) fail('invalid_lang', 'اللغة: ar أو en');
  const id = db.prepare("INSERT INTO report_runs (company_id, report_id, run_kind, run_by, format, lang, created_at) VALUES (?, ?, 'manual', ?, ?, ?, ?)").run(companyId, report.id, user.id, format, lang, clock.nowSql()).lastInsertRowid;
  return runToApi(await executeRun(Number(id), { runSpec, user, now: clock.today() }));
}
// Who may see / download a run: the report is visible to them and they
// hold what the produced file needs.
function runFor(companyId, id, user) {
  const r = getRun(companyId, id);
  const report = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(r.report_id);
  if (!report || !canSee(report, user)) fail('run_not_found', 'التشغيل غير موجود', 404);
  const needs = r.needs ? r.needs.split(',').filter(Boolean) : [];
  if (!needs.every((n) => holdsNeed(user.permissions || [], n))) fail('run_not_found', 'التشغيل غير موجود', 404);
  return r;
}
// The approver of a send reviews the DATA being sent, not the saved report
// (which may be private to the requester): they need the report permission
// and what the run's file needs.
function runForApprover(companyId, id, user) {
  const r = getRun(companyId, id);
  const needs = r.needs ? r.needs.split(',').filter(Boolean) : [];
  if (!has(user, Q.REPORTS_PERM) || !needs.every((n) => holdsNeed(user.permissions || [], n))) fail('run_not_found', 'لا تملك صلاحية بيانات هذا التقرير', 403);
  return r;
}
function sendFile(companyId, sendId, user) {
  const s = db.prepare('SELECT * FROM report_sends WHERE id = ? AND company_id = ?').get(Number(sendId), companyId);
  if (!s) fail('send_not_found', 'طلب الإرسال غير موجود', 404);
  const r = runForApprover(companyId, s.run_id, user);
  if (!r.file_path || !fs.existsSync(r.file_path)) fail('file_missing', 'ملف التقرير غير موجود', 404);
  logAudit({ companyId, actor: actorOf(user), action: 'report.send.review', entityType: 'report_send', entityId: s.id, before: null, after: { run_id: r.id, file: r.file_name } });
  return { path: r.file_path, name: r.file_name, mime: MIME[r.format] };
}
function listRuns(companyId, reportId, user) {
  visibleRow(companyId, reportId, user);
  return db.prepare('SELECT * FROM report_runs WHERE company_id = ? AND report_id = ? ORDER BY id DESC LIMIT 100').all(companyId, Number(reportId))
    .filter((r) => (r.needs ? r.needs.split(',').filter(Boolean) : []).every((n) => holdsNeed(user.permissions || [], n))).map(runToApi);
}
function runFile(companyId, id, user) {
  const r = runFor(companyId, id, user);
  if (r.status !== 'done' || !r.file_path || !fs.existsSync(r.file_path)) fail('file_missing', 'لا يوجد ملف لهذا التشغيل', 404);
  logAudit({ companyId, actor: actorOf(user), action: 'report.run.download', entityType: 'report_run', entityId: r.id, before: null, after: { file: r.file_name } });
  return { path: r.file_path, name: r.file_name, mime: MIME[r.format] };
}

// ---------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const toSql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const fromSql = (s) => Date.parse(`${s.replace(' ', 'T')}Z`);
function matches(s, local) {
  if (s.frequency === 'daily') return true;
  if (s.frequency === 'weekly') return local.getUTCDay() === s.weekday;
  const last = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  return local.getUTCDate() === Math.min(s.day_of_month, last);
}
function slotOn(s, localDay) {
  const [hh, mm] = s.time_of_day.split(':').map(Number);
  return Date.UTC(localDay.getUTCFullYear(), localDay.getUTCMonth(), localDay.getUTCDate(), hh, mm) - s.utc_offset_minutes * 60000;
}
// First slot strictly after `afterMs` (UTC ms).
function nextSlot(s, afterMs) {
  const local = new Date(afterMs + s.utc_offset_minutes * 60000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  for (let k = 0; k < 400; k++) {
    const d = new Date(day.getTime() + k * 86400000);
    if (matches(s, d) && slotOn(s, d) > afterMs) return slotOn(s, d);
  }
  fail('schedule_invalid', 'لا يوجد موعد قادم لهذه الجدولة', 500);
}
// Latest slot at or before `atMs`.
function lastSlot(s, atMs) {
  const local = new Date(atMs + s.utc_offset_minutes * 60000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  for (let k = 0; k < 400; k++) {
    const d = new Date(day.getTime() - k * 86400000);
    if (matches(s, d) && slotOn(s, d) <= atMs) return slotOn(s, d);
  }
  return null;
}
const localDate = (s, ms) => new Date(ms + s.utc_offset_minutes * 60000).toISOString().slice(0, 10);
function checkSchedule(input) {
  const s = {
    frequency: input.frequency, time_of_day: String(input.time ?? input.timeOfDay ?? ''),
    weekday: input.weekday === undefined || input.weekday === null ? null : Number(input.weekday),
    day_of_month: input.dayOfMonth === undefined || input.dayOfMonth === null ? null : Number(input.dayOfMonth),
    utc_offset_minutes: input.utcOffsetMinutes === undefined ? 180 : Number(input.utcOffsetMinutes),
    format: input.format || 'xlsx', lang: input.lang || 'ar',
  };
  if (!['daily', 'weekly', 'monthly'].includes(s.frequency)) fail('invalid_frequency', 'التكرار: daily أو weekly أو monthly');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time_of_day)) fail('invalid_time', 'الوقت بصيغة HH:MM');
  if (s.frequency === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6)) fail('invalid_weekday', 'يوم الأسبوع من 0 (الأحد) إلى 6');
  if (s.frequency === 'monthly' && !(Number.isInteger(s.day_of_month) && s.day_of_month >= 1 && s.day_of_month <= 31)) fail('invalid_day', 'يوم الشهر من 1 إلى 31 (31 = آخر يوم)');
  if (s.frequency !== 'weekly') s.weekday = null;
  if (s.frequency !== 'monthly') s.day_of_month = null;
  if (!Number.isInteger(s.utc_offset_minutes) || s.utc_offset_minutes < -720 || s.utc_offset_minutes > 840) fail('invalid_offset', 'فرق التوقيت بالدقائق غير صالح');
  if (!MIME[s.format]) fail('invalid_format', 'الصيغة: xlsx أو pdf أو csv');
  if (!['ar', 'en'].includes(s.lang)) fail('invalid_lang', 'اللغة: ar أو en');
  return s;
}
const schedToApi = (s) => ({ ...s, is_active: !!s.is_active });
function listSchedules(companyId, reportId, user) {
  visibleRow(companyId, reportId, user);
  return db.prepare('SELECT * FROM report_schedules WHERE company_id = ? AND report_id = ? ORDER BY id').all(companyId, Number(reportId)).map(schedToApi);
}
function createSchedule(companyId, reportId, user, input = {}) {
  const report = visibleRow(companyId, reportId, user);
  const s = checkSchedule(input);
  const next = toSql(nextSlot(s, clock.now().getTime()));
  const id = db.prepare('INSERT INTO report_schedules (company_id, report_id, owner_id, frequency, time_of_day, weekday, day_of_month, utc_offset_minutes, format, lang, is_active, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .run(companyId, report.id, user.id, s.frequency, s.time_of_day, s.weekday, s.day_of_month, s.utc_offset_minutes, s.format, s.lang, next, clock.nowSql(), clock.nowSql()).lastInsertRowid;
  logAudit({ companyId, actor: actorOf(user), action: 'report.schedule.create', entityType: 'report_schedule', entityId: Number(id), before: null, after: { report_id: report.id, ...s, next_run_at: next } });
  return schedToApi(db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id));
}
function schedRow(companyId, id, user) {
  const s = db.prepare('SELECT * FROM report_schedules WHERE id = ? AND company_id = ?').get(Number(id), companyId);
  if (!s) fail('schedule_not_found', 'الجدولة غير موجودة', 404);
  if (s.owner_id !== user.id && !user.permissions.includes('manage_permissions')) fail('not_owner', 'يعدّل الجدولة صاحبها فقط', 403);
  return s;
}
function updateSchedule(companyId, id, user, input = {}) {
  const old = schedRow(companyId, id, user);
  const s = checkSchedule({ frequency: old.frequency, time: old.time_of_day, weekday: old.weekday, dayOfMonth: old.day_of_month, utcOffsetMinutes: old.utc_offset_minutes, format: old.format, lang: old.lang, ...input });
  const active = input.isActive === undefined ? old.is_active : input.isActive ? 1 : 0;
  if (active) visibleRow(companyId, old.report_id, user);
  const next = toSql(nextSlot(s, clock.now().getTime()));
  db.prepare('UPDATE report_schedules SET frequency = ?, time_of_day = ?, weekday = ?, day_of_month = ?, utc_offset_minutes = ?, format = ?, lang = ?, is_active = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(s.frequency, s.time_of_day, s.weekday, s.day_of_month, s.utc_offset_minutes, s.format, s.lang, active, next, clock.nowSql(), old.id);
  const now = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(old.id);
  logAudit({ companyId, actor: actorOf(user), action: 'report.schedule.update', entityType: 'report_schedule', entityId: old.id, before: schedToApi(old), after: schedToApi(now) });
  return schedToApi(now);
}
function deleteSchedule(companyId, id, user) {
  const old = schedRow(companyId, id, user);
  db.prepare('UPDATE report_schedules SET is_active = 0, updated_at = ? WHERE id = ?').run(clock.nowSql(), old.id);
  logAudit({ companyId, actor: actorOf(user), action: 'report.schedule.stop', entityType: 'report_schedule', entityId: old.id, before: schedToApi(old), after: { is_active: false } });
  return { ok: true };
}

// Claim every due schedule (one transaction each), then produce the files.
// Idempotent per (schedule, slot); missed slots run ONCE (the latest).
let sweeping = false;
async function sweepSchedules({ runSpec, now = clock.now() } = {}) {
  if (sweeping) return [];
  sweeping = true;
  try {
    const nowMs = now.getTime();
    // A run left 'running' by a crash or restart is closed as failed.
    db.prepare("UPDATE report_runs SET status = 'failed', error_code = 'interrupted', error_message = 'توقف التشغيل قبل اكتماله', finished_at = ? WHERE status = 'running' AND created_at < ?").run(toSql(nowMs), toSql(nowMs - 30 * 60000));
    const due = db.prepare('SELECT id FROM report_schedules WHERE is_active = 1 AND next_run_at <= ? ORDER BY next_run_at, id').all(toSql(nowMs));
    const claimed = [];
    for (const { id } of due) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const s = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id);
        if (!s.is_active || s.next_run_at > toSql(nowMs)) { db.exec('COMMIT'); continue; }
        const slot = lastSlot(s, nowMs);
        let missed = 0;
        for (let t = fromSql(s.next_run_at); t < slot && missed < 10000; t = nextSlot(s, t)) missed += 1;
        const ins = db.prepare("INSERT OR IGNORE INTO report_runs (company_id, report_id, schedule_id, scheduled_for, missed_slots, run_kind, run_by, format, lang, created_at) VALUES (?, ?, ?, ?, ?, 'schedule', ?, ?, ?, ?)")
          .run(s.company_id, s.report_id, s.id, toSql(slot), missed, s.owner_id, s.format, s.lang, toSql(nowMs));
        db.prepare('UPDATE report_schedules SET next_run_at = ?, last_slot_at = ?, updated_at = ? WHERE id = ?').run(toSql(nextSlot(s, nowMs)), toSql(slot), toSql(nowMs), s.id);
        db.exec('COMMIT');
        if (ins.changes) claimed.push({ runId: Number(ins.lastInsertRowid), schedule: s, slot });
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        console.error('[report-builder] schedule claim failed:', err.message);
      }
    }
    const out = [];
    for (const c of claimed) {
      out.push(await executeRun(c.runId, { runSpec, user: userFor(c.schedule.company_id, c.schedule.owner_id), now: localDate(c.schedule, c.slot) }));
    }
    return out;
  } finally {
    sweeping = false;
  }
}

// ---------------------------------------------------------------------
// Sends (human-approved)
// ---------------------------------------------------------------------
const transports = {
  // WhatsApp: the existing per-company session (lib/whatsapp.js).
  async whatsapp({ companyId, address, filePath, caption }) {
    const W = require('./whatsapp');
    const ok = await W.sendFileToNumber(companyId, address, filePath, caption);
    return ok ? { ok: true } : { ok: false, error: 'whatsapp_not_connected' };
  },
  // E-mail: Atlas has no mail transport yet (open decision: provider /
  // SMTP). The approved send is recorded as failed, never silently dropped.
  async email() {
    return { ok: false, error: 'email_not_configured' };
  },
};
function setTransportForTests(channel, fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setTransportForTests is test-only');
  transports[channel] = fn;
}
const PHONE = /^\+?[\d\s-]{8,20}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
// Recipients with their address; refuses anything the run's data may not reach.
function resolveRecipients(companyId, channel, list, needs) {
  if (!Array.isArray(list) || !list.length || list.length > 20) fail('invalid_recipients', 'حدد من 1 إلى 20 مستلمًا بالاسم');
  const seen = new Set();
  return list.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail('invalid_recipients', 'مستلم غير صالح');
    const keys = Object.keys(r).filter((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');
    if (keys.length !== 1 || !['userId', 'phone', 'email'].includes(keys[0])) fail('invalid_recipients', 'كل مستلم: userId أو phone أو email (واحد فقط)');
    let out;
    if (keys[0] === 'userId') {
      tenantRefs.requireOwned(companyId, 'user', Number(r.userId), { active: true });
      const u = db.prepare('SELECT id, name, contact FROM users WHERE id = ?').get(Number(r.userId));
      const perms = getUserPermissions(u.id);
      for (const n of needs) if (!holdsNeed(perms, n)) fail('recipient_lacks_permission', `المستلم ${u.name} لا يملك صلاحية ${n === 'payroll' ? 'الرواتب' : 'عرض التكاليف'} — هذا التقرير يحتوي هذه البيانات`, 403);
      const contact = String(u.contact || '');
      const address = channel === 'email' ? (EMAIL.test(contact) ? contact : null) : (PHONE.test(contact) ? contact : null);
      if (!address) fail('recipient_no_address', `لا يوجد ${channel === 'email' ? 'بريد' : 'رقم'} صالح للمستخدم ${u.name}`);
      out = { userId: u.id, name: u.name, address };
    } else {
      if (needs.length) fail('recipient_lacks_permission', 'هذا التقرير يحتوي بيانات رواتب أو تكاليف: يرسل لمستخدمي الشركة أصحاب الصلاحية فقط، لا لعناوين خارجية', 403);
      const v = String(r[keys[0]]).trim();
      if (keys[0] === 'phone' && (channel !== 'whatsapp' || !PHONE.test(v))) fail('invalid_recipients', 'رقم واتساب غير صالح');
      if (keys[0] === 'email' && (channel !== 'email' || !EMAIL.test(v))) fail('invalid_recipients', 'بريد غير صالح');
      out = { [keys[0]]: v, address: v };
    }
    if (seen.has(out.address)) fail('invalid_recipients', 'مستلم مكرر');
    seen.add(out.address);
    return out;
  });
}
const sendToApi = (s) => ({ ...s, recipients: JSON.parse(s.recipients_json), recipients_json: undefined, results: s.results_json ? JSON.parse(s.results_json) : null, results_json: undefined });
function requestSend(companyId, runId, user, { channel, recipients, message } = {}) {
  if (!['email', 'whatsapp'].includes(channel)) fail('invalid_channel', 'القناة: email أو whatsapp');
  const run = runFor(companyId, runId, user);
  if (run.status !== 'done') fail('run_not_done', 'لا يمكن إرسال تشغيل لم يكتمل', 409);
  if (message !== undefined && message !== null && String(message).length > 500) fail('invalid_message', 'الرسالة حتى 500 حرف');
  const needs = run.needs ? run.needs.split(',').filter(Boolean) : [];
  const list = resolveRecipients(companyId, channel, recipients, needs);
  const id = db.prepare("INSERT INTO report_sends (company_id, run_id, channel, recipients_json, message, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
    .run(companyId, run.id, channel, JSON.stringify(list), message ? String(message) : null, user.id, clock.nowSql()).lastInsertRowid;
  logAudit({ companyId, actor: actorOf(user), action: 'report.send.request', entityType: 'report_send', entityId: Number(id), before: null, after: { run_id: run.id, channel, recipients: list, needs } });
  require('./notify').createNotification({ companyId, type: 'report_send_pending', message_ar: `طلب إرسال تقرير بانتظار الاعتماد (${list.length} مستلم)`, message_en: `Report send awaiting approval (${list.length} recipients)`, link_path: '/reports/builder?tab=sends', entity_type: 'report_send', entity_id: Number(id) });
  return sendToApi(db.prepare('SELECT * FROM report_sends WHERE id = ?').get(id));
}
function listSends(companyId, { status } = {}) {
  return db.prepare(`SELECT s.*, r.report_id, sr.name report_name, u.name requested_by_name FROM report_sends s JOIN report_runs r ON r.id = s.run_id JOIN saved_reports sr ON sr.id = r.report_id LEFT JOIN users u ON u.id = s.requested_by
    WHERE s.company_id = ? ${status ? 'AND s.status = ?' : ''} ORDER BY s.id DESC LIMIT 200`).all(...[companyId, ...(status ? [status] : [])]).map(sendToApi);
}
function sendRow(companyId, id) {
  const s = db.prepare('SELECT * FROM report_sends WHERE id = ? AND company_id = ?').get(Number(id), companyId);
  if (!s) fail('send_not_found', 'طلب الإرسال غير موجود', 404);
  if (s.status !== 'pending') fail('send_not_pending', 'طلب الإرسال ليس بانتظار الاعتماد', 409);
  return s;
}
function rejectSend(companyId, id, user, { reason } = {}) {
  const s = sendRow(companyId, id);
  const why = String(reason || '').trim();
  if (why.length < 3) fail('reason_required', 'سبب الرفض مطلوب');
  db.prepare("UPDATE report_sends SET status = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ? AND status = 'pending'").run(user.id, clock.nowSql(), why, s.id);
  logAudit({ companyId, actor: actorOf(user), action: 'report.send.reject', entityType: 'report_send', entityId: s.id, before: { status: 'pending' }, after: { status: 'rejected', reason: why } });
  return sendToApi(db.prepare('SELECT * FROM report_sends WHERE id = ?').get(s.id));
}
// Approval = delivery. The approver must be able to see the run, recipients
// are re-checked (permissions may have changed), then each one is sent.
async function approveSend(companyId, id, user, { breakGlassReason } = {}) {
  const s = sendRow(companyId, id);
  if (s.requested_by === user.id) {
    require('./purchasing').sodGuard(companyId, 'report_send', user, breakGlassReason, { code: 'sod_report_send_requester', message: 'فصل المهام: لا يمكنك اعتماد إرسال طلبته بنفسك. يجب أن يعتمده مستخدم آخر يملك صلاحية إرسال التقارير.', entityType: 'report_send', entityId: s.id });
  }
  const run = runForApprover(companyId, s.run_id, user);
  if (!run.file_path || !fs.existsSync(run.file_path)) fail('file_missing', 'ملف التقرير غير موجود', 409);
  const needs = run.needs ? run.needs.split(',').filter(Boolean) : [];
  const list = resolveRecipients(companyId, s.channel, JSON.parse(s.recipients_json).map((r) => (r.userId ? { userId: r.userId } : r.phone ? { phone: r.phone } : { email: r.email })), needs);
  // Claim it first so a double click cannot send twice.
  const claimed = db.prepare("UPDATE report_sends SET status = 'sent', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(user.id, clock.nowSql(), s.id);
  if (!claimed.changes) fail('send_not_pending', 'طلب الإرسال ليس بانتظار الاعتماد', 409);
  const report = db.prepare('SELECT name FROM saved_reports WHERE id = ?').get(run.report_id);
  const caption = [`${report.name} (${run.period_from} → ${run.period_to})`, s.message].filter(Boolean).join('\n');
  const results = [];
  for (const r of list) {
    let res;
    try { res = await transports[s.channel]({ companyId, address: r.address, filePath: run.file_path, fileName: run.file_name, caption, recipient: r }); } catch (err) { res = { ok: false, error: err.message }; }
    results.push({ address: r.address, userId: r.userId ?? null, ok: !!res.ok, error: res.ok ? null : res.error || 'send_failed' });
  }
  const okCount = results.filter((x) => x.ok).length;
  const status = okCount === results.length ? 'sent' : okCount ? 'partially_sent' : 'failed';
  db.prepare('UPDATE report_sends SET status = ?, results_json = ? WHERE id = ?').run(status, JSON.stringify(results), s.id);
  logAudit({ companyId, actor: actorOf(user), action: 'report.send.approve', entityType: 'report_send', entityId: s.id, before: { status: 'pending', requested_by: s.requested_by }, after: { status, channel: s.channel, results, needs } });
  return sendToApi(db.prepare('SELECT * FROM report_sends WHERE id = ?').get(s.id));
}

module.exports = {
  BuilderError, storedSpec, canSee,
  listSaved, getSaved, createSaved, updateSaved, deleteSaved,
  renderFile, toCsv, flatTable, MIME,
  runNow, executeRun, listRuns, runFile, getRun,
  nextSlot, lastSlot, listSchedules, createSchedule, updateSchedule, deleteSchedule, sweepSchedules,
  requestSend, approveSend, rejectSend, listSends, sendFile, setTransportForTests, resolveRecipients,
};
