// backend/lib/payrollCsv.js
//
// CSV form of the payroll import (docs/payroll-import-format.md,
// docs/payroll-import-template.csv). Turns the file into the same JSON the
// import takes, keeping each record's CSV row number (_row) so that every
// error is reported against the row the user sees. Header / row problems
// found here are returned as row errors too; lib/payroll.js validates the
// rest and rejects the whole file if any row is bad.

const db = require('../db/init');

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const KNOWN = new Set(['record_type', 'department', 'cost_center_code', 'currency', 'gross', 'deductions', 'employer_contributions', 'net', 'headcount', 'employee_ref', 'amount']);

function csvToImport(companyId, csv) {
  const rows = parseCsvText(csv);
  const errors = [];
  if (!rows.length) return { errors: [{ section: 'file', row: 1, error: 'empty_file', message: 'الملف فارغ' }] };
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  for (const h of header) {
    if (!KNOWN.has(h) && !/^(ded|emp):[a-z0-9_]+$/.test(h)) errors.push({ section: 'file', row: 1, error: 'unknown_column', message: `عمود غير معروف: ${h}` });
  }
  for (const req of ['currency']) if (!header.includes(req)) errors.push({ section: 'file', row: 1, error: 'missing_column', message: `العمود ${req} مطلوب` });
  const lines = [];
  const advanceRecoveries = [];
  rows.slice(1).forEach((cells, k) => {
    const rowNo = k + 2;
    const v = Object.fromEntries(header.map((h, i) => [h, cells[i] === undefined ? '' : String(cells[i]).trim()]));
    const type = (v.record_type || 'line').toLowerCase();
    if (type === 'recovery') {
      advanceRecoveries.push({ _row: rowNo, employeeRef: v.employee_ref, currencyCode: v.currency, amount: v.amount });
      return;
    }
    if (type !== 'line') { errors.push({ section: 'lines', row: rowNo, error: 'invalid_record_type', message: `نوع السجل ${type} غير صالح (line أو recovery)` }); return; }
    let costCenterId = null;
    if (v.cost_center_code) {
      const cc = db.prepare('SELECT id FROM cost_centers WHERE company_id = ? AND code = ? AND is_active = 1').get(companyId, v.cost_center_code);
      if (!cc) { errors.push({ section: 'lines', row: rowNo, error: 'invalid_cost_center', message: `مركز التكلفة ${v.cost_center_code} غير موجود` }); return; }
      costCenterId = cc.id;
    }
    const split = (prefix) => {
      const parts = header.filter((h) => h.startsWith(`${prefix}:`) && v[h] !== '').map((h) => ({ type: h.slice(prefix.length + 1), amount: v[h] }));
      return parts.length ? parts : undefined;
    };
    lines.push({
      _row: rowNo, department: v.department, costCenterId, currencyCode: v.currency, gross: v.gross, deductions: v.deductions,
      employerContributions: v.employer_contributions, net: v.net, headcount: v.headcount === '' ? undefined : v.headcount,
      deductionsByType: split('ded'), employerContributionsByType: split('emp'),
    });
  });
  return { lines, advanceRecoveries, errors };
}

module.exports = { parseCsvText, csvToImport };
