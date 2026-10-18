// Additive ledger demo data for the demo company created by
// seed-demo-company.js (manager@demo.atlas). Everything goes through
// lib/ledger.js — the same posting service the app uses — so the integrity
// check stays clean. Safe to run more than once: it skips anything that
// already exists (posted entries can never be wiped; see note below).
//
//   node seed-ledger-demo.js            # demo company
//   node seed-ledger-demo.js <companyId>
//
// NOTE: posted journal entries are immutable by design (DB triggers), so
// once this has run, `node seed-demo-company.js` can no longer wipe and
// rebuild that company. Delete db/data.sqlite* (dev only) to start over.

const db = require('./db/init');
const ledger = require('./lib/ledger');

const argId = Number(process.argv[2]);
const company = argId
  ? db.prepare('SELECT id, name, currency FROM companies WHERE id = ?').get(argId)
  : db.prepare("SELECT c.id, c.name, c.currency FROM companies c JOIN users u ON u.company_id = c.id WHERE u.contact = 'manager@demo.atlas'").get();
if (!company) {
  console.error('Company not found. Run `node seed-demo-company.js` first, or pass a company id.');
  process.exit(1);
}
const actor = db.prepare("SELECT id, name FROM users WHERE company_id = ? AND role IN ('manager','admin') ORDER BY id LIMIT 1").get(company.id);
const cid = company.id;
const year = new Date().getFullYear();
console.log(`\n=== Seeding ledger demo for ${company.name} (id ${cid}, base ${company.currency}) ===`);

ledger.ensureLedgerSetup(cid);
const hasPosted = db.prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND status <> 'draft' LIMIT 1").get(cid);
if (!hasPosted) {
  ledger.applyCoaTemplate(cid, 'food_manufacturing', actor);
  console.log('Chart of accounts: food_manufacturing template applied.');
}

let fy = db.prepare('SELECT * FROM fiscal_years WHERE company_id = ? AND year = ?').get(cid, year);
if (!fy) {
  fy = ledger.createFiscalYear(cid, { year }, actor);
  console.log(`Fiscal year ${year} created with 12 periods.`);
}

const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(cid, code).id;

for (const [kind, code, name] of [['cost_center', 'CC-PROD', 'الإنتاج'], ['cost_center', 'CC-SALES', 'المبيعات'], ['project', 'PRJ-LINE2', 'خط الإنتاج الثاني']]) {
  const table = kind === 'project' ? 'projects' : 'cost_centers';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE company_id = ? AND code = ?`).get(cid, code)) ledger.saveDimension(cid, kind, null, { code, name }, actor);
}
const cc = (code) => db.prepare('SELECT id FROM cost_centers WHERE company_id = ? AND code = ?').get(cid, code).id;

if (!db.prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND source_type = 'opening_balance' AND status = 'posted'").get(cid)) {
  const e = ledger.postOpeningBalances(cid, {
    fiscalYearId: fy.id,
    plugToOpeningEquity: true,
    rows: [
      { accountCode: '1110', debit: '5000' },
      { accountCode: '1120', debit: '18000' },
      { accountCode: '1151', debit: '7500' },
      { accountCode: '1153', debit: '4200' },
      { accountCode: '1225', debit: '30000' },
      { accountCode: '2110', credit: '6200' },
      { accountCode: '3100', credit: '50000' },
    ],
  }, actor);
  console.log(`Opening balances posted: ${e.entry_number}`);
}

const month = String(new Date().getMonth() + 1).padStart(2, '0');
const d = (day) => `${year}-${month}-${String(day).padStart(2, '0')}`;
const seedEntries = [
  { key: 'demo-sale-1', date: d(1), description: 'مبيعات نقدية', lines: [{ accountId: acc('1110'), debit: '1250' }, { accountId: acc('4110'), credit: '1250' }] },
  { key: 'demo-rent-1', date: d(1), description: 'إيجار المعمل', lines: [{ accountId: acc('6200'), debit: '900', costCenterId: cc('CC-PROD') }, { accountId: acc('1120'), credit: '900' }] },
  { key: 'demo-fuel-1', date: d(2), description: 'محروقات سيارات التوزيع', lines: [{ accountId: acc('6300'), debit: '140', costCenterId: cc('CC-SALES') }, { accountId: acc('1110'), credit: '140' }] },
  { key: 'demo-wrong-1', date: d(2), description: 'قيد خاطئ (سيُعكس)', lines: [{ accountId: acc('6500'), debit: '75' }, { accountId: acc('1110'), credit: '75' }] },
];
for (const s of seedEntries) {
  const e = ledger.postEntry(cid, { date: s.date, description: s.description, idempotencyKey: s.key, lines: s.lines }, actor);
  if (!e.idempotent_replay) console.log(`Posted ${e.entry_number}: ${s.description}`);
}
const wrong = db.prepare("SELECT id, status FROM journal_entries WHERE company_id = ? AND idempotency_key = 'demo-wrong-1'").get(cid);
if (wrong.status === 'posted') {
  const r = ledger.reverseEntry(cid, wrong.id, { date: d(2), reason: 'إدخال مكرر' }, actor);
  console.log(`Reversed with ${r.reversal.entry_number}`);
}
if (!db.prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND status = 'draft'").get(cid)) {
  ledger.createDraft(cid, { date: d(3), description: 'مسودة: صيانة آلات', lines: [{ accountId: acc('5400'), debit: '320' }, { accountId: acc('1120'), credit: '320' }] }, actor);
  console.log('Draft entry created.');
}

// Prompt 2: one posted sales invoice and a partial credit note for the
// first customer (the company is NOT switched to ledger_live here — do that
// from Customer Ledger > Go live, dry run first).
const sales = require('./lib/salesPosting');
const shop = db.prepare('SELECT id, name FROM shops WHERE company_id = ? AND active = 1 ORDER BY id LIMIT 1').get(cid);
if (shop && !db.prepare("SELECT 1 FROM sales_invoices WHERE company_id = ? AND notes = 'demo-seed'").get(cid)) {
  const inv = sales.createInvoice(cid, {
    shopId: shop.id, invoiceDate: d(4), notes: 'demo-seed',
    lines: [{ description: 'كاجو محمص 1كغ', qty: 4, unitPrice: '14.75' }, { description: 'لوز 500غ', qty: 2.5, unitPrice: '6.33', taxRate: '5' }],
  }, actor);
  const posted = sales.postInvoice(cid, inv.id, actor);
  console.log(`Sales invoice ${posted.invoice_number} posted for ${shop.name}: ${posted.total}`);
  const cn = sales.createCreditNote(cid, { invoiceId: inv.id, reason: 'تالف', lines: [{ invoiceLineId: posted.lines[0].id, qty: 1 }] }, actor);
  console.log(`Credit note ${cn.credit_note_number}: ${cn.total}`);
}

const check = ledger.ledgerIntegrityCheck(cid);
console.log(`Integrity check: ${check.ok ? 'clean' : `${check.violations.length} violation(s)`}`);
if (!check.ok) {
  console.log(check.violations);
  process.exit(1);
}
console.log('=== Done ===\n');
