// backend/db/migrations/0028_payroll_deduction_types.js
//
// Payroll deduction types (each with its own payable account), the per-line
// split, what each posted period credited per type, and deduction payments
// (db/payrollSchema.js). Existing single-account setups migrate to ONE
// default type ('default') on their current deductions-payable account, so
// they keep posting exactly as before.

const { applyPayrollSchema } = require('../payrollSchema');

module.exports.up = function up(db) {
  applyPayrollSchema(db);
  for (const s of db.prepare('SELECT company_id, deductions_payable_account_id FROM payroll_settings').all()) {
    db.prepare("INSERT OR IGNORE INTO payroll_deduction_types (company_id, code, name, account_id, is_default) VALUES (?, 'default', 'استقطاعات عامة', ?, 1)").run(s.company_id, s.deductions_payable_account_id);
  }
  // Periods already posted: their whole deductions line went to that
  // account — record it per currency so balances per type are complete.
  for (const p of db.prepare("SELECT p.id, p.company_id, p.journal_entry_id FROM payroll_periods p WHERE p.status = 'posted' AND NOT EXISTS (SELECT 1 FROM payroll_period_deductions d WHERE d.period_id = p.id)").all()) {
    const t = db.prepare("SELECT t.id, t.account_id FROM payroll_deduction_types t WHERE t.company_id = ? AND t.is_default = 1").get(p.company_id);
    if (!t) continue;
    for (const l of db.prepare("SELECT currency_code, SUM(CASE WHEN credit_minor > 0 THEN amount_original_minor ELSE -amount_original_minor END) o, SUM(credit_minor - debit_minor) b FROM journal_lines WHERE entry_id = ? AND account_id = ? GROUP BY currency_code").all(p.journal_entry_id, t.account_id)) {
      db.prepare('INSERT INTO payroll_period_deductions (company_id, period_id, type_id, currency_code, amount_minor, base_minor) VALUES (?, ?, ?, ?, ?, ?)').run(p.company_id, p.id, t.id, l.currency_code, l.o, l.b);
    }
  }
};
