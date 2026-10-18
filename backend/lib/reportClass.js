// backend/lib/reportClass.js
//
// accounts.report_class decides where an account appears in the financial
// statements and the cash flow. Reports read ONLY this column (never code
// prefixes), so a chart with any numbering works.
//
//   asset      : cash | current_asset | fixed_asset | contra_asset
//   liability  : current_liability | long_term_liability
//   equity     : equity
//   revenue    : revenue | other
//   expense    : cogs | opex | other
//
// 'cash' = cash & bank accounts (the cash-flow statement's cash). 'other' =
// non-operating income / expense. 'contra_asset' (accumulated depreciation)
// is shown with fixed assets and is an operating add-back in the cash flow;
// a current allowance (doubtful debts) is classed current_asset.

const BY_TYPE = {
  asset: ['cash', 'current_asset', 'fixed_asset', 'contra_asset'],
  liability: ['current_liability', 'long_term_liability'],
  equity: ['equity'],
  revenue: ['revenue', 'other'],
  expense: ['cogs', 'opex', 'other'],
};
const DEFAULT_BY_TYPE = { asset: 'current_asset', liability: 'current_liability', equity: 'equity', revenue: 'revenue', expense: 'opex' };
const REPORT_CLASSES = [...new Set(Object.values(BY_TYPE).flat())];

function isValidFor(type, cls) {
  return (BY_TYPE[type] || []).includes(cls);
}

// The pre-report_class rules (Prompt 4), used ONCE to backfill existing
// accounts: second-level group 12 = fixed, 22 = long-term, root 5 = cost of
// sales, cash = cash_default / bank_in_transit / 1120 and below, credit-normal
// assets = contra. `chain` = codes from the account up to its root.
function legacyClass(a, chain, systemKeysInChain) {
  const root = chain[chain.length - 1];
  const group = chain.length >= 2 ? chain[chain.length - 2] : chain[0];
  if (a.type === 'asset') {
    if (a.normal_balance === 'credit') return 'contra_asset';
    if (systemKeysInChain.some((k) => k === 'cash_default' || k === 'bank_in_transit') || chain.includes('1120')) return 'cash';
    return group.startsWith('12') ? 'fixed_asset' : 'current_asset';
  }
  if (a.type === 'liability') return group.startsWith('22') ? 'long_term_liability' : 'current_liability';
  if (a.type === 'equity') return 'equity';
  if (a.type === 'revenue') return 'revenue';
  return root === '5' ? 'cogs' : 'opex';
}

// Backfills NULL report_class for every account (all companies).
function backfillReportClass(db) {
  const rows = db.prepare('SELECT id, company_id, code, type, normal_balance, parent_id, system_key, report_class FROM accounts').all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const upd = db.prepare('UPDATE accounts SET report_class = ? WHERE id = ?');
  let n = 0;
  for (const a of rows) {
    if (a.report_class) continue;
    const chain = [];
    const keys = [];
    const seen = new Set();
    for (let cur = a; cur && !seen.has(cur.id); cur = byId.get(cur.parent_id)) {
      seen.add(cur.id);
      chain.push(cur.code);
      if (cur.system_key) keys.push(cur.system_key);
    }
    upd.run(legacyClass(a, chain, keys), a.id);
    n += 1;
  }
  return n;
}

module.exports = { BY_TYPE, DEFAULT_BY_TYPE, REPORT_CLASSES, isValidFor, legacyClass, backfillReportClass };
