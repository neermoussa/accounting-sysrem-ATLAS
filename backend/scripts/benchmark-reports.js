// Prompt 4 benchmark: seeds a throwaway database with >= 200,000 journal
// lines (through lib/ledger.js postEntry, like the app) and times every
// financial report. Each must finish in under 2 seconds.
//
//   node scripts/benchmark-reports.js            # 200k lines (50k entries x 4)
//   node scripts/benchmark-reports.js 400000     # more lines
//
// Uses its own temporary database (never db/data.sqlite). Exit code 1 when a
// report is over the limit. BENCH_LIMIT_MS overrides the 2000 ms limit.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bench-'));
process.env.ATLAS_DB_PATH = path.join(dir, 'bench.sqlite');

const db = require('../db/init');
const ledger = require('../lib/ledger');
const fr = require('../lib/financialReports');

const TARGET_LINES = Number(process.argv[2]) || 200000;
const LIMIT_MS = Number(process.env.BENCH_LIMIT_MS) || 2000;
const YEAR = 2025;

function run() {
  const cid = Number(db.prepare("INSERT INTO companies (name, currency) VALUES ('شركة القياس', 'USD')").run().lastInsertRowid);
  const actor = { id: Number(db.prepare("INSERT INTO users (company_id, name, contact, password_hash, role, status) VALUES (?, 'bench', 'bench@x', 'x', 'manager', 'approved')").run(cid).lastInsertRowid), name: 'bench' };
  ledger.ensureLedgerSetup(cid);
  ledger.applyCoaTemplate(cid, 'trading', actor);
  ledger.createFiscalYear(cid, { year: YEAR }, actor);
  ledger.createFiscalYear(cid, { year: YEAR + 1 }, actor);
  const code = (c) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(cid, c).id;
  const cc = [1, 2, 3, 4].map((i) => ledger.saveDimension(cid, 'cost_center', null, { code: `CC${i}`, name: `مركز ${i}` }, actor).id);
  const cash = code('1110');
  const bank = code('1120');
  const revenue = [code('4100'), code('4900')];
  const expenses = ['6100', '6200', '6300', '6400', '6500', '5100'].map(code);
  const entries = Math.ceil(TARGET_LINES / 4);

  const t0 = Date.now();
  ledger.postEntry(cid, { date: `${YEAR}-01-01`, description: 'رأس المال', lines: [{ accountId: cash, debitMinor: 1e12 }, { accountId: code('3100'), creditMinor: 1e12 }] }, actor);
  const batch = 2000;
  for (let start = 0; start < entries; start += batch) {
    db.transaction(() => {
      for (let i = start; i < Math.min(entries, start + batch); i += 1) {
        const day = (i * 7) % 700; // spread over two years
        const date = new Date(Date.UTC(YEAR, 0, 1 + day)).toISOString().slice(0, 10);
        const amt = 1000 + ((i * 7919) % 500000);
        const isSale = i % 2 === 0;
        const lines = isSale
          ? [
              { accountId: cash, debitMinor: amt },
              { accountId: bank, debitMinor: amt },
              { accountId: revenue[i % 2 === 0 ? (i >> 1) % 2 : 0], creditMinor: amt },
              { accountId: revenue[0], creditMinor: amt },
            ]
          : [
              { accountId: expenses[i % expenses.length], debitMinor: amt, costCenterId: cc[i % cc.length] },
              { accountId: expenses[(i + 1) % expenses.length], debitMinor: amt, costCenterId: cc[(i + 1) % cc.length] },
              { accountId: cash, creditMinor: amt },
              { accountId: bank, creditMinor: amt },
            ];
        ledger.postEntry(cid, { date, description: `قيد ${i}`, lines }, actor);
      }
    })();
  }
  const lines = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE company_id = ?').get(cid).c;
  console.log(`seeded ${lines.toLocaleString()} journal lines (${entries.toLocaleString()} entries) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  db.exec('ANALYZE');

  const fy = db.prepare('SELECT id FROM fiscal_years WHERE company_id = ? AND year = ?').get(cid, YEAR).id;
  const budget = fr.createBudget(cid, { fiscalYearId: fy, name: 'قياس' }, actor);
  const periods = db.prepare('SELECT id FROM fiscal_periods WHERE fiscal_year_id = ?').all(fy);
  fr.setBudgetLines(cid, budget.id, expenses.flatMap((a) => periods.map((p) => ({ accountId: a, periodId: p.id, amount: '1000' }))), actor);

  const from = `${YEAR}-01-01`;
  const to = `${YEAR + 1}-12-31`;
  const cases = [
    ['trial balance (2 years)', () => fr.trialBalance(cid, { from, to })],
    ['trial balance (by cost center)', () => fr.trialBalance(cid, { from, to, costCenterId: cc[0] })],
    ['general ledger (cash, 1000 lines)', () => fr.generalLedger(cid, { accountId: cash, from: `${YEAR + 1}-06-01`, to })],
    ['income statement (monthly, 24 cols)', () => fr.incomeStatement(cid, { from, to, monthly: '1' })],
    ['income statement (vs prev year)', () => fr.incomeStatement(cid, { from: `${YEAR + 1}-01-01`, to, compare: 'prev_year' })],
    ['balance sheet (vs prev year)', () => fr.balanceSheet(cid, { asOf: to, compare: 'prev_year' })],
    ['cash flow (direct + indirect)', () => fr.cashFlow(cid, { from, to })],
    ['expense analysis (cost center)', () => fr.expenseAnalysis(cid, { from, to, by: 'cost_center' })],
    ['budget vs actual', () => fr.budgetVsActual(cid, budget.id)],
  ];
  let failed = 0;
  const results = [];
  for (const [name, fn] of cases) {
    fn(); // warm the statement cache once, as a running server would be
    const s = process.hrtime.bigint();
    const out = fn();
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    const ok = ms < LIMIT_MS;
    if (!ok) failed += 1;
    results.push({ name, ms: Math.round(ms), ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(Math.round(ms)).padStart(6)} ms  ${name}`);
    if (name.startsWith('trial balance (2') && !out.balanced) throw new Error('trial balance not balanced');
    if (name.startsWith('balance sheet') && !out.balanced.every(Boolean)) throw new Error('balance sheet not balanced');
    if (name.startsWith('cash flow') && !out.reconciles) throw new Error('cash flow does not reconcile');
  }
  const integrity = ledger.ledgerIntegrityCheck(cid);
  console.log(`integrity violations: ${integrity.violations.length}`);
  return { lines, results, failed: failed + integrity.violations.length };
}

let code = 0;
try {
  const r = run();
  if (r.lines < TARGET_LINES) throw new Error(`only ${r.lines} lines seeded`);
  code = r.failed ? 1 : 0;
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
