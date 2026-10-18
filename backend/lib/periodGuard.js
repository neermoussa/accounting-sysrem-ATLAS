// backend/lib/periodGuard.js
//
// Automatic postings (depreciation and its catch-up, disposals, recurring
// templates, accrual reversals) check each target date's fiscal period
// BEFORE writing anything, and refuse with a message naming the item and
// the period. The callers run in one BEGIN IMMEDIATE transaction, so a
// refusal anywhere in a run posts nothing at all.

const db = require('../db/init');
const ledger = require('./ledger');

const fail = (code, message, status, extra) => {
  throw new ledger.LedgerError(code, message, status, extra);
};

function requirePostable(companyId, date, what) {
  const p = db.prepare('SELECT * FROM fiscal_periods WHERE company_id = ? AND start_date <= ? AND end_date >= ?').get(companyId, date, date);
  if (!p) fail('no_period', `${what}: لا توجد فترة مالية تغطي ${date} — لم يُرحَّل شيء`, 409, { date });
  if (p.status === 'open') return p;
  const locked = p.status === 'locked';
  fail(locked ? 'period_locked' : 'period_closed', `${what}: الفترة ${p.start_date} — ${p.end_date} ${locked ? 'مقفلة نهائيًا' : 'مغلقة'} — لم يُرحَّل شيء من هذه العملية`, 409, { date, period_id: p.id, period_status: p.status });
  return null;
}

module.exports = { requirePostable };
