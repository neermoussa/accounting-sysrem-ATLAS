// backend/lib/postingQueue.js
//
// Failed-posting queue. A posting refused because NO fiscal period covers
// its date (code no_period — typically a date in a year not created yet) is
// recorded here with what is needed to try again: it is never lost and
// never silently dropped. The original refusal is still returned / thrown
// unchanged (the caller's behaviour does not change); the queue only keeps
// a visible, retryable record. A later successful posting of the same
// document (by retry or by hand) resolves it.
//
// Kinds and their retry (registered by the modules that own them):
//   sales_invoice.post, supplier_invoice.post, treasury_voucher.approve,
//   payroll_period.post, depreciation.run, recurring.run

const db = require('../db/init');
const ledger = require('./ledger');
const { logAudit } = require('./auditLog');

const RETRY = {
  'sales_invoice.post': (cid, id, p, actor) => require('./salesPosting').postInvoice(cid, Number(id), actor, p || {}),
  'supplier_invoice.post': (cid, id, p, actor) => require('./payables').postInvoice(cid, Number(id), p || {}, actor),
  'treasury_voucher.approve': (cid, id, p, actor) => require('./treasury').approveVoucher(cid, Number(id), p || {}, actor),
  'payroll_period.post': (cid, id, p, actor) => require('./payroll').postPeriod(cid, Number(id), p || {}, actor),
  'depreciation.run': (cid, id, p, actor) => require('./fixedAssets').runDepreciation(cid, { period: id }, actor),
  // One open entry per company; a retry posts everything due up to today.
  'recurring.run': (cid, id, p, actor) => {
    const t = new Date().toISOString().slice(0, 10);
    return require('./recurringEntries').runDue(cid, { asOf: p?.asOf && p.asOf > t ? p.asOf : t }, actor);
  },
};
const QUEUED_CODES = new Set(['no_period']);
const actorOf = (a) => (a ? { id: a.id ?? null, name: a.name ?? null } : null);

function record(companyId, { kind, sourceId, label, postingDate, payload }, err, actor) {
  const sid = String(sourceId);
  const open = db.prepare("SELECT id FROM posting_failures WHERE company_id = ? AND kind = ? AND source_id = ? AND status = 'open'").get(companyId, kind, sid);
  if (open) {
    db.prepare("UPDATE posting_failures SET attempts = attempts + 1, last_failed_at = datetime('now'), error_code = ?, message = ? WHERE id = ?").run(err.code, err.message, open.id);
    return open.id;
  }
  const id = Number(db.prepare('INSERT INTO posting_failures (company_id, kind, source_id, label, posting_date, error_code, message, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(companyId, kind, sid, label || null, postingDate || err.date || null, err.code, err.message, payload ? JSON.stringify(payload) : null, actor?.id ?? null).lastInsertRowid);
  logAudit({ companyId, actor: actorOf(actor), action: 'posting.failure.queued', entityType: 'posting_failure', entityId: id, after: { kind, source_id: sid, error: err.code } });
  return id;
}
function resolve(companyId, kind, sourceId, actor) {
  const r = db.prepare("UPDATE posting_failures SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ? WHERE company_id = ? AND kind = ? AND source_id = ? AND status = 'open'").run(actor?.id ?? null, companyId, kind, String(sourceId));
  if (r.changes) logAudit({ companyId, actor: actorOf(actor), action: 'posting.failure.resolved', entityType: 'posting_failure', entityId: null, after: { kind, source_id: String(sourceId) } });
}

// Run a posting; a no_period refusal is queued (after the failed
// transaction rolled back) and rethrown unchanged.
function guard(companyId, meta, fn, actor) {
  try {
    const out = fn();
    if (db.prepare("SELECT 1 FROM posting_failures WHERE company_id = ? AND kind = ? AND source_id = ? AND status = 'open'").get(companyId, meta.kind, String(meta.sourceId))) {
      resolve(companyId, meta.kind, meta.sourceId, actor);
    }
    return out;
  } catch (err) {
    if (err instanceof ledger.LedgerError && QUEUED_CODES.has(err.code) && !db.isTransaction) record(companyId, meta, err, actor);
    throw err;
  }
}

function list(companyId, { status = 'open' } = {}) {
  return db.prepare(`SELECT * FROM posting_failures WHERE company_id = ? ${status === 'all' ? '' : 'AND status = ?'} ORDER BY id DESC`).all(...(status === 'all' ? [companyId] : [companyId, status]));
}
const openCount = (companyId) => db.prepare("SELECT COUNT(*) c FROM posting_failures WHERE company_id = ? AND status = 'open'").get(companyId).c;

function retry(companyId, id, actor) {
  const n = Number(id);
  const f = Number.isInteger(n) && n > 0 ? db.prepare('SELECT * FROM posting_failures WHERE id = ? AND company_id = ?').get(n, companyId) : null;
  if (!f) throw new ledger.LedgerError('invalid_posting_failure', 'العنصر غير موجود في قائمة الترحيل المتعثر', 404);
  if (f.status !== 'open') throw new ledger.LedgerError('already_resolved', 'تم ترحيل هذا العنصر مسبقًا', 409);
  const fn = RETRY[f.kind];
  const result = guard(companyId, { kind: f.kind, sourceId: f.source_id, label: f.label }, () => fn(companyId, f.source_id, f.payload_json ? JSON.parse(f.payload_json) : null, actor), actor);
  return { resolved: true, failure_id: f.id, result };
}

module.exports = { guard, record, resolve, list, openCount, retry, KINDS: Object.keys(RETRY) };
