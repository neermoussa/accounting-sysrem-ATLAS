// backend/lib/customerLedger.js
//
// Customer sub-ledger (Prompt 2). A customer (shop) balance is the sum of
// its lines on the receivable control account (system key ar_control,
// party_type='customer', party_id=shop id) in posted or reversed entries.
//
// The `balances` table keeps its shape because shopData.js, the WhatsApp
// bot, statements and dashboards read it. Once a company is live
// (companies.modules_json.ledger_live === true) it is no longer written by
// collections/returns/imports: refreshShopBalance() rewrites today's row
// from the ledger after every posting that touches a customer, so two
// events on the same day both count. Before go-live nothing here runs and
// the old writers behave exactly as before.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db/init');
const { logAudit } = require('./auditLog');
const { fromMinor, roundToMinor } = require('./ledgerCurrencies');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isLedgerLive(companyId) {
  const row = db.prepare('SELECT modules_json FROM companies WHERE id = ?').get(companyId);
  try {
    return JSON.parse(row?.modules_json || '{}').ledger_live === true;
  } catch {
    return false;
  }
}

function baseDigits(companyId) {
  const company = db.prepare('SELECT currency FROM companies WHERE id = ?').get(companyId);
  const cur = db.prepare('SELECT minor_unit_digits FROM currencies WHERE company_id = ? AND code = ?').get(companyId, company?.currency);
  return cur ? cur.minor_unit_digits : 2;
}

function arAccountId(companyId) {
  return db.prepare("SELECT id FROM accounts WHERE company_id = ? AND system_key = 'ar_control'").get(companyId)?.id ?? null;
}

// Balance in base minor units, entries dated up to and including asOf.
function shopBalanceMinor(companyId, shopId, asOf = '9999-12-31') {
  const ar = arAccountId(companyId);
  if (!ar) return 0;
  return db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS b
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ?
         AND l.party_type = 'customer' AND l.party_id = ? AND e.entry_date <= ?`
    )
    .get(companyId, ar, shopId, asOf).b;
}

function writeBalanceRow(shopId, date, balance) {
  db.prepare(
    `INSERT INTO balances (shop_id, report_date, balance, source_file) VALUES (?, ?, ?, 'ledger')
     ON CONFLICT(shop_id, report_date) DO UPDATE SET balance = excluded.balance, source_file = 'ledger', imported_at = datetime('now')`
  ).run(shopId, date, balance);
}

// Re-derives today's balances row for one customer from the ledger. No-op
// before go-live. Runs inside the caller's (posting) transaction.
function refreshShopBalance(companyId, shopId) {
  if (!isLedgerLive(companyId) || !shopId) return null;
  const d = today();
  const minor = shopBalanceMinor(companyId, shopId, d);
  const balance = Number(fromMinor(minor, baseDigits(companyId)));
  writeBalanceRow(shopId, d, balance);
  return balance;
}

// Called by lib/ledger.js after an entry is posted (or reversed): refresh
// every customer the entry touches on the receivable account.
function afterEntryPosted(companyId, entryId) {
  if (!isLedgerLive(companyId)) return;
  const ar = arAccountId(companyId);
  const shops = db
    .prepare("SELECT DISTINCT party_id FROM journal_lines WHERE entry_id = ? AND account_id = ? AND party_type = 'customer' AND party_id IS NOT NULL")
    .all(entryId, ar)
    .map((r) => r.party_id);
  for (const shopId of shops) refreshShopBalance(companyId, shopId);
}

const SOURCE_DOCS = {
  sales_invoice: (id) => db.prepare('SELECT invoice_number AS number FROM sales_invoices WHERE id = ?').get(id)?.number,
  sales_credit_note: (id) => db.prepare('SELECT credit_note_number AS number FROM sales_credit_notes WHERE id = ?').get(id)?.number,
};

// Every receivable line of one customer, oldest first, with a running
// balance and links to the entry and its source document.
function customerLedgerLines(companyId, shopId) {
  const ar = arAccountId(companyId);
  const digits = baseDigits(companyId);
  if (!ar) return { lines: [], balance_minor: 0, balance: fromMinor(0, digits) };
  const rows = db
    .prepare(
      `SELECT l.id, l.debit_minor, l.credit_minor, l.memo, e.id AS entry_id, e.entry_number, e.entry_date, e.description,
              e.source_type, e.source_id, e.status AS entry_status
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.company_id = ? AND e.status IN ('posted','reversed') AND l.account_id = ?
         AND l.party_type = 'customer' AND l.party_id = ?
       ORDER BY e.entry_date, e.id, l.line_no`
    )
    .all(companyId, ar, shopId);
  let running = 0;
  const lines = rows.map((r) => {
    running += r.debit_minor - r.credit_minor;
    return {
      ...r,
      debit: fromMinor(r.debit_minor, digits),
      credit: fromMinor(r.credit_minor, digits),
      running_minor: running,
      running: fromMinor(running, digits),
      source_number: SOURCE_DOCS[r.source_type]?.(r.source_id) ?? null,
    };
  });
  return { lines, balance_minor: running, balance: fromMinor(running, digits) };
}

// Ledger balance vs the latest balance the external system (Amin) reported
// after go-live, per customer. Differences are shown, never applied.
function reconciliation(companyId) {
  const digits = baseDigits(companyId);
  const shops = db.prepare('SELECT id, name FROM shops WHERE company_id = ? ORDER BY name').all(companyId);
  const rows = shops.map((s) => {
    const ledgerMinor = shopBalanceMinor(companyId, s.id);
    const ext = db
      .prepare('SELECT report_date, balance FROM external_balance_snapshots WHERE company_id = ? AND shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1')
      .get(companyId, s.id);
    const extMinor = ext ? roundToMinor(ext.balance, digits) : null;
    return {
      shop_id: s.id,
      shop_name: s.name,
      ledger_minor: ledgerMinor,
      ledger: fromMinor(ledgerMinor, digits),
      external_minor: extMinor,
      external: extMinor === null ? null : fromMinor(extMinor, digits),
      external_date: ext?.report_date ?? null,
      difference_minor: extMinor === null ? null : ledgerMinor - extMinor,
    };
  });
  return {
    live: isLedgerLive(companyId),
    rows,
    mismatches: rows.filter((r) => r.difference_minor !== null && r.difference_minor !== 0).length,
  };
}

// Records an external (Amin) balance after go-live instead of overwriting.
function recordExternalSnapshot(companyId, { shopId, reportDate, balance, sourceFile, batchId }) {
  db.prepare(
    `INSERT INTO external_balance_snapshots (company_id, shop_id, report_date, balance, source_file, import_batch_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, shop_id, report_date) DO UPDATE SET balance = excluded.balance, source_file = excluded.source_file,
       import_batch_id = excluded.import_batch_id, imported_at = datetime('now')`
  ).run(companyId, shopId, reportDate, balance, sourceFile ?? null, batchId ?? null);
}

// ---------------------------------------------------------------------
// Go-live backfill
// ---------------------------------------------------------------------

class GoLiveError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// One opening entry per customer = latest `balances` snapshot minus whatever
// the ledger already holds for that customer, so after go-live the derived
// balance equals the snapshot exactly (to the minor unit).
// openItemsImportId: undefined = use the company's staged open-items import
// if there is one; null = none. With open items, a customer's opening is
// split into one line per open item (aged by its due date) + the legacy
// residual (snapshot - existing ledger - items).
function goLivePlan(companyId, { date, openItemsImportId } = {}) {
  const d = date || today();
  const digits = baseDigits(companyId);
  const problems = [];
  if (isLedgerLive(companyId)) problems.push({ code: 'already_live', message: 'الشركة تعمل على دفتر الأستاذ مسبقًا' });
  const ar = arAccountId(companyId);
  const obe = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND system_key = 'opening_balance_equity'").get(companyId);
  if (!ar || !obe) problems.push({ code: 'missing_system_account', message: 'طبّق قالب دليل الحسابات أولًا (حساب الذمم وحساب الأرصدة الافتتاحية)' });
  const period = db.prepare('SELECT status FROM fiscal_periods WHERE company_id = ? AND start_date <= ? AND end_date >= ?').get(companyId, d, d);
  if (!period) problems.push({ code: 'no_period', message: 'لا توجد فترة مالية تغطي تاريخ التفعيل' });
  else if (period.status !== 'open') problems.push({ code: 'period_closed', message: 'الفترة المالية لتاريخ التفعيل غير مفتوحة' });

  const openItems = require('./openItems');
  let importId = openItemsImportId === undefined ? openItems.stagedImport(companyId)?.id ?? null : openItemsImportId;
  if (importId) {
    const imp = db.prepare('SELECT * FROM open_item_imports WHERE id = ? AND company_id = ?').get(importId, companyId);
    if (!imp || imp.status !== 'staged') {
      problems.push({ code: 'open_items_not_staged', message: 'ملف البنود المفتوحة لم يعد صالحًا — أعد رفعه ونفّذ تجربة جديدة' });
      importId = null;
    }
  }
  const items = openItems.itemsByShop(companyId, importId);
  const shops = db.prepare('SELECT id, name FROM shops WHERE company_id = ? ORDER BY id').all(companyId);
  const rows = [];
  for (const s of shops) {
    const snap = db.prepare('SELECT report_date, balance FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(s.id);
    const snapshotMinor = snap ? roundToMinor(snap.balance, digits) : 0;
    const ledgerMinor = ar ? shopBalanceMinor(companyId, s.id) : 0;
    const openingMinor = snapshotMinor - ledgerMinor;
    const already = db
      .prepare("SELECT 1 FROM journal_entries WHERE company_id = ? AND source_type = 'customer_opening' AND source_id = ? AND status = 'posted'")
      .get(companyId, s.id);
    const shopItems = items.get(s.id) || [];
    if (already || (openingMinor === 0 && snapshotMinor === 0 && !shopItems.length)) continue;
    const itemsMinor = shopItems.reduce((t, i) => t + i.amount_minor, 0);
    rows.push({
      items: shopItems.map((i) => ({ id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date, due_date: i.due_date, amount_minor: i.amount_minor })),
      items_minor: itemsMinor,
      legacy_minor: openingMinor - itemsMinor,
      legacy: fromMinor(openingMinor - itemsMinor, digits),
      shop_id: s.id,
      shop_name: s.name,
      snapshot_date: snap?.report_date ?? null,
      snapshot_minor: snapshotMinor,
      existing_ledger_minor: ledgerMinor,
      opening_minor: openingMinor,
      opening: fromMinor(openingMinor, digits),
    });
  }
  const total = rows.reduce((t, r) => t + r.opening_minor, 0);
  const legacyTotal = rows.reduce((t, r) => t + r.legacy_minor, 0);
  // Settings that go-live switches (shown in the dry run). Rep cash
  // handover (Prompt 7): confirmed rep cash stays in the rep's custody
  // until handed over to a cash box — only meaningful with the ledger.
  const repCash = db.prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'rep_cash_handover'").get(companyId)?.value === '1';
  const settingsChanges = repCash ? [] : [{ key: 'rep_cash_handover', from: false, to: true, message: 'تفعيل تسليم نقدية المندوبين: التحصيل النقدي المؤكد يبقى في عهدة المندوب حتى يسلّمه إلى صندوق بسند تسليم' }];
  return {
    date: d, ok: problems.length === 0, problems, rows, customers: rows.length, total_minor: total, total: fromMinor(total, digits),
    open_items_import_id: importId, open_items_minor: total - legacyTotal, legacy_minor: legacyTotal,
    settings_changes: settingsChanges,
    // Which stock mode the company runs in (information only; go-live does
    // not change it): stock ledger = custody transfers take stock out of the
    // warehouse at cost; legacy = they do not.
    stock_mode: require('./stockLedger').isActive(companyId)
      ? { mode: 'stock_ledger', custody_transfer_decrements_warehouse: true, message: 'وضع دفتر المخزون: تحويل العهدة يُنقص رصيد المستودع ويُرحَّل بالتكلفة' }
      : { mode: 'legacy', custody_transfer_decrements_warehouse: false, message: 'الوضع القديم: تحويل العهدة لا يُنقص رصيد المستودع — فعّل دفتر المخزون من شاشة المخزون' },
  };
}

// The exact sentence the user must type to execute go-live.
const GO_LIVE_CONFIRMATION = 'Invoices will be created in Atlas from now on';
const DRY_RUN_MAX_AGE_HOURS = 24;

function planFingerprint(plan) {
  return JSON.stringify({
    date: plan.date,
    import: plan.open_items_import_id ?? null,
    rows: plan.rows.map((r) => [r.shop_id, r.opening_minor, (r.items || []).map((i) => [i.id, i.amount_minor])]),
  });
}

// Records a dry run (plan + who + when) and returns it with its id. Writes
// nothing to the ledger.
function recordDryRun(companyId, { date, openItemsImportId } = {}, actor) {
  const plan = goLivePlan(companyId, { date, openItemsImportId });
  const id = Number(
    db
      .prepare("INSERT INTO ledger_go_live_runs (company_id, kind, go_live_date, plan_json, created_by) VALUES (?, 'dry_run', ?, ?, ?)")
      .run(companyId, plan.date, JSON.stringify(plan), actor?.id ?? null).lastInsertRowid
  );
  logAudit({ companyId, actor, action: 'ledger.go_live.dry_run', entityType: 'go_live_run', entityId: id, before: null, after: { date: plan.date, customers: plan.customers, total_minor: plan.total_minor, ok: plan.ok } });
  return { dry_run: true, dry_run_id: id, ...plan };
}

function listRuns(companyId) {
  return db
    .prepare('SELECT id, kind, go_live_date, dry_run_id, backup_path, confirmation_text, created_by, created_at FROM ledger_go_live_runs WHERE company_id = ? ORDER BY id DESC LIMIT 50')
    .all(companyId);
}

function backupDir() {
  if (process.env.ATLAS_BACKUP_DIR) return process.env.ATLAS_BACKUP_DIR;
  const dbPath = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', 'db', 'data.sqlite');
  return path.join(path.dirname(dbPath), 'backups');
}

// Consistent online copy of the whole database (VACUUM INTO), verified by
// opening it and running quick_check. Must run outside any transaction.
function backupDatabase(companyId) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `atlas-before-go-live-company${companyId}-${ts}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copy = require('./clock').attachSqlite(new DatabaseSync(file, { readOnly: true, timeout: require('../db/sqliteConfig').BUSY_TIMEOUT_MS }));
  try {
    const check = copy.prepare('PRAGMA quick_check').get();
    if (Object.values(check)[0] !== 'ok') throw new GoLiveError('backup_failed', 'فشل التحقق من النسخة الاحتياطية — لم يتم التحول', 500);
  } finally {
    copy.close();
  }
  return file;
}

// Executes go-live. Requires: the exact confirmation sentence, a recorded
// dry run for this company from the last 24h whose plan still matches the
// current one, and a verified backup taken right before. Then ONE
// transaction: opening entries, ledger_live flag, balance refresh, and the
// 'executed' run record (with the dry-run report and the backup path).
function executeGoLive(companyId, { dryRunId, confirmText } = {}, actor) {
  if (confirmText !== GO_LIVE_CONFIRMATION) {
    throw new GoLiveError('confirmation_text_required', `اكتب عبارة التأكيد حرفيًا: "${GO_LIVE_CONFIRMATION}"`);
  }
  const dryRun = db
    .prepare(
      `SELECT * FROM ledger_go_live_runs WHERE id = ? AND company_id = ? AND kind = 'dry_run'
         AND created_at >= datetime('now', ?)`
    )
    .get(Number(dryRunId) || 0, companyId, `-${DRY_RUN_MAX_AGE_HOURS} hours`);
  if (!dryRun) throw new GoLiveError('dry_run_required', 'نفّذ تجربة بدون كتابة لهذه الشركة خلال آخر 24 ساعة أولًا', 409);
  const stored = JSON.parse(dryRun.plan_json);
  const plan = goLivePlan(companyId, { date: dryRun.go_live_date, openItemsImportId: stored.open_items_import_id ?? null });
  if (!plan.ok) throw new GoLiveError(plan.problems[0].code, plan.problems[0].message, 409);
  if (planFingerprint(plan) !== planFingerprint(stored)) {
    throw new GoLiveError('plan_changed', 'تغيّرت الأرصدة منذ التجربة — نفّذ تجربة جديدة وراجعها قبل التحول', 409);
  }

  const backupPath = backupDatabase(companyId);
  const ledger = require('./ledger');
  const ar = arAccountId(companyId);
  const obe = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND system_key = 'opening_balance_equity'").get(companyId).id;
  const run = db.transaction(() => {
    const entries = [];
    for (const r of plan.rows) {
      // One entry per imported open item: aged by its own due date.
      for (const it of r.items || []) {
        const e = ledger.postEntry(
          companyId,
          {
            date: plan.date,
            description: `فاتورة سابقة ${it.invoice_number} (${it.invoice_date}) للزبون ${r.shop_name} — رصيد افتتاحي`,
            sourceType: 'customer_open_item',
            sourceId: it.id,
            lines: [
              { accountId: ar, debitMinor: it.amount_minor, creditMinor: 0, partyType: 'customer', partyId: r.shop_id, memo: it.invoice_number },
              { accountId: obe, debitMinor: 0, creditMinor: it.amount_minor },
            ],
          },
          actor
        );
        entries.push(e.id);
      }
      // The rest of the customer's balance has no known age: legacy line.
      const legacy = r.items ? r.legacy_minor : r.opening_minor;
      if (legacy === 0) continue;
      const amt = Math.abs(legacy);
      const debitCustomer = legacy > 0;
      const e = ledger.postEntry(
        companyId,
        {
          date: plan.date,
          description: `رصيد افتتاحي للزبون ${r.shop_name} عند التحول إلى دفتر الأستاذ`,
          sourceType: 'customer_opening',
          sourceId: r.shop_id,
          lines: [
            { accountId: ar, debitMinor: debitCustomer ? amt : 0, creditMinor: debitCustomer ? 0 : amt, partyType: 'customer', partyId: r.shop_id },
            { accountId: obe, debitMinor: debitCustomer ? 0 : amt, creditMinor: debitCustomer ? amt : 0 },
          ],
        },
        actor
      );
      entries.push(e.id);
    }
    for (const c of plan.settings_changes || []) {
      db.prepare('INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value').run(companyId, c.key, c.to ? '1' : '0');
      logAudit({ companyId, actor, action: 'ledger.go_live.setting', entityType: 'settings', entityId: null, before: { [c.key]: c.from }, after: { [c.key]: c.to } });
    }
    const company = db.prepare('SELECT modules_json FROM companies WHERE id = ?').get(companyId);
    const modules = { ...JSON.parse(company.modules_json || '{}'), ledger_live: true };
    db.prepare("UPDATE companies SET modules_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(modules), companyId);
    for (const s of db.prepare('SELECT id FROM shops WHERE company_id = ?').all(companyId)) {
      const hasHistory = db.prepare('SELECT 1 FROM balances WHERE shop_id = ? LIMIT 1').get(s.id)
        || db.prepare("SELECT 1 FROM journal_lines WHERE company_id = ? AND party_type = 'customer' AND party_id = ? LIMIT 1").get(companyId, s.id);
      if (hasHistory) refreshShopBalance(companyId, s.id);
    }
    if (plan.open_items_import_id) {
      db.prepare("UPDATE open_item_imports SET status = 'used' WHERE id = ?").run(plan.open_items_import_id);
    }
    const runId = Number(
      db
        .prepare(
          `INSERT INTO ledger_go_live_runs (company_id, kind, go_live_date, plan_json, dry_run_id, backup_path, confirmation_text, created_by)
           VALUES (?, 'executed', ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, plan.date, dryRun.plan_json, dryRun.id, backupPath, confirmText, actor?.id ?? null).lastInsertRowid
    );
    if (plan.open_items_import_id) db.prepare('UPDATE open_item_imports SET used_run_id = ? WHERE id = ?').run(runId, plan.open_items_import_id);
    logAudit({
      companyId, actor, action: 'ledger.go_live', entityType: 'company', entityId: companyId,
      before: { ledger_live: false }, after: { ledger_live: true, date: plan.date, customers: entries.length, total_minor: plan.total_minor, backup_path: backupPath, dry_run_id: dryRun.id, run_id: runId },
    });
    return { entries, runId };
  });
  const { entries, runId } = run();
  return { dry_run: false, ...plan, entry_ids: entries, live: true, backup_path: backupPath, dry_run_id: dryRun.id, run_id: runId };
}

module.exports = {
  GoLiveError,
  isLedgerLive,
  shopBalanceMinor,
  refreshShopBalance,
  afterEntryPosted,
  customerLedgerLines,
  reconciliation,
  recordExternalSnapshot,
  goLivePlan,
  recordDryRun,
  executeGoLive,
  listRuns,
  backupDatabase,
  GO_LIVE_CONFIRMATION,
};
