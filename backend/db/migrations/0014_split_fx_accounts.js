// backend/db/migrations/0014_split_fx_accounts.js
//
// fx_gain_loss is split into fx_realized (receipt settlements) and
// fx_unrealized (period-end revaluation). Existing companies: the old
// fx_gain_loss account keeps its id and history and becomes fx_realized
// (renamed only if it still has the template name); a new fx_unrealized
// account is added next to it (code 6810, or the next free code). Entries
// already posted are never touched — revaluations posted before the split
// stay on the realized account; the FX report classifies them by source.

const reportClasses = require('../../lib/reportClass');

module.exports.up = function up(db) {
  const olds = db.prepare("SELECT * FROM accounts WHERE system_key = 'fx_gain_loss'").all();
  for (const a of olds) {
    db.prepare("UPDATE accounts SET system_key = 'fx_realized', updated_at = datetime('now') WHERE id = ?").run(a.id);
    if (a.name_ar === 'أرباح وخسائر فروقات الصرف') {
      db.prepare("UPDATE accounts SET name_ar = 'أرباح وخسائر فروقات الصرف المحققة', name_en = 'Realized FX gain/loss' WHERE id = ?").run(a.id);
    }
    if (db.prepare("SELECT 1 FROM accounts WHERE company_id = ? AND system_key = 'fx_unrealized'").get(a.company_id)) continue;
    let n = 6810;
    while (db.prepare('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?').get(a.company_id, String(n))) n += 1;
    db.prepare(
      `INSERT INTO accounts (company_id, code, name_ar, name_en, parent_id, type, normal_balance, is_postable, is_active, is_system, system_key, report_class)
       VALUES (?, ?, 'أرباح وخسائر فروقات الصرف غير المحققة (إعادة التقييم)', 'Unrealized FX gain/loss (revaluation)', ?, 'expense', 'debit', 1, 1, 1, 'fx_unrealized', ?)`
    ).run(a.company_id, String(n), a.parent_id, a.report_class || reportClasses.DEFAULT_BY_TYPE.expense);
  }
};
