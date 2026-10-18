const db = require('../db/init');
const { createNotification } = require('./notify');
const { sendToCustomer } = require('./whatsapp');
const { isLedgerLive } = require('./customerLedger');
const { checkpoint } = require('./faultInjection');

// Duplicated from lib/shopData.js's identical query rather than imported
// from it — shopData.js needs to import THIS module (to merge the
// payment-overdue color signal into enrichShop), so importing shopData.js
// here would create a require cycle.
function getLatestBalance(shopId) {
  return db.prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shopId);
}

function logChange(companyId, collectionId, { action, field, before, after, user }) {
  db.prepare(
    `INSERT INTO collection_changes (company_id, collection_id, action, field, before_value, after_value, changed_by_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId,
    collectionId,
    action,
    field || null,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    user?.id ?? null,
    user?.name ?? null
  );
}

function getSetting(companyId, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key)?.value ?? fallback;
}

function getCollection(companyId, id) {
  return db.prepare('SELECT * FROM collections WHERE id = ? AND company_id = ?').get(id, companyId);
}

// Cash starts here — the rep says they physically received it, but it's
// only ever a claim until the accountant separately confirms actually
// having the money in hand. A transfer starts equally unconfirmed
// ('pending_verification') for the employee responsible for checking bank/
// wallet statements.
// Prompt 7: currencyCode (ledger-live companies only) records a collection
// in a foreign currency. `amount` is then in that currency; the collection
// row keeps the base estimate at today's rate (locked at confirmation) and
// the currency side lives in collection_fx, so base collections are
// byte-identical to before.
function currencyError(err) {
  if (err && err.code && err.status) return Object.assign(new Error(err.code), { status: err.status, detail: err.message });
  return err;
}
function createCollection(companyId, { shopId, method, amount, transferReference, notes, currencyCode }, user) {
  if (!['cash', 'transfer'].includes(method)) throw Object.assign(new Error('invalid_method'), { status: 400 });
  if (!(Number(amount) > 0)) throw Object.assign(new Error('amount_must_be_positive'), { status: 400 });
  const ledger = require('./ledger');
  const baseCur = currencyCode ? ledger.getBaseCurrency(companyId) : null;
  const foreign = currencyCode && String(currencyCode).toUpperCase() !== baseCur.code ? String(currencyCode).toUpperCase() : null;
  let fx = null;
  let rowAmount = Number(amount);
  if (foreign) {
    if (!isLedgerLive(companyId)) throw Object.assign(new Error('foreign_collection_requires_ledger'), { status: 409, detail: 'التحصيل بعملة أجنبية يتطلب تفعيل دفتر الأستاذ' });
    const c = ledger.getCurrency(companyId, foreign);
    if (!c || !c.is_active) throw Object.assign(new Error('invalid_currency'), { status: 400 });
    const { toMinor, fromMinor } = require('./ledgerCurrencies');
    const original = toMinor(amount, c.minor_unit_digits);
    if (!(original > 0)) throw Object.assign(new Error('amount_must_be_positive'), { status: 400 });
    let rate;
    let baseMinor;
    try {
      rate = require('./currency').documentRate(companyId, foreign, new Date().toISOString().slice(0, 10), {});
      baseMinor = require('./currency').toBase(companyId, foreign, original, rate);
    } catch (err) {
      throw currencyError(err);
    }
    fx = { currency_code: foreign, amount_original_minor: original, rate_e8: rate.rateE8, rate_quote: rate.quote, estimated_base_minor: baseMinor };
    rowAmount = Number(fromMinor(baseMinor, baseCur.minor_unit_digits));
  }
  const initialStatus = method === 'cash' ? 'pending_accountant_confirmation' : 'pending_verification';
  const insert = () => {
    const info = db
      .prepare(
        `INSERT INTO collections (company_id, shop_id, rep_id, method, amount, status, transfer_reference, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, shopId, user.id, method, rowAmount, initialStatus, transferReference || null, notes || null);
    if (fx) {
      db.prepare('INSERT INTO collection_fx (collection_id, company_id, currency_code, amount_original_minor, rate_e8, rate_quote) VALUES (?, ?, ?, ?, ?, ?)')
        .run(info.lastInsertRowid, companyId, fx.currency_code, fx.amount_original_minor, fx.rate_e8, fx.rate_quote);
    }
    return info.lastInsertRowid;
  };
  const id = fx ? ledger.transaction(insert) : insert();
  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  logChange(companyId, collection.id, { action: 'record', field: 'status', after: initialStatus, user });
  const shown = fx ? `${amount} ${fx.currency_code}` : `${amount}$`;

  createNotification({
    companyId,
    type: method === 'cash' ? 'cash_collection_pending' : 'transfer_collection_pending',
    message_ar:
      method === 'cash'
        ? `المندوب ${user.name} سجّل قبض ${shown} نقدًا — بانتظار تأكيد المحاسب.`
        : `حوالة بقيمة ${shown} مسجّلة من ${user.name} — بانتظار تحقق الموظف المسؤول.`,
    message_en:
      method === 'cash'
        ? `Rep ${user.name} logged a ${fx ? shown : amount} cash collection — awaiting accountant confirmation.`
        : `A ${fx ? shown : amount} transfer was logged by ${user.name} — awaiting verification.`,
    link_path: `/shops/${shopId}`,
    entity_type: 'collection',
    entity_id: collection.id,
  });

  return fx ? { ...collection, fx: { ...fx, locked: false } } : collection;
}

// The one place a collection actually reduces the customer's balance —
// same dated-snapshot-ledger approach as lib/returns.js's credit. Never
// runs twice for the same collection (status check below prevents it).
function applyToBalance(companyId, collection) {
  const latest = getLatestBalance(collection.shop_id);
  const newBalance = (latest ? latest.balance : 0) - collection.amount;
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO balances (shop_id, report_date, balance, source_file)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, report_date) DO UPDATE SET balance = excluded.balance`
  ).run(collection.shop_id, today, newBalance, `collection:${collection.id}`);
}

function confirmCollection(companyId, collectionId, user, { exchangeRate, rateQuote } = {}) {
  const collection = getCollection(companyId, collectionId);
  if (!collection) throw Object.assign(new Error('not_found'), { status: 404 });
  if (!['pending_accountant_confirmation', 'pending_verification'].includes(collection.status)) {
    throw Object.assign(new Error('not_pending'), { status: 409, currentStatus: collection.status });
  }
  // Ledger-live companies: the status change and the journal entry happen
  // in ONE transaction, and the balance is re-derived from the ledger
  // (lib/customerLedger.js). Otherwise this is exactly the original flow.
  const live = isLedgerLive(companyId);
  const fxRow = db.prepare('SELECT * FROM collection_fx WHERE collection_id = ?').get(collection.id);
  if (fxRow && !live) throw Object.assign(new Error('foreign_collection_requires_ledger'), { status: 409, detail: 'التحصيل بعملة أجنبية يتطلب تفعيل دفتر الأستاذ' });
  const apply = () => {
    if (fxRow) {
      // Lock the rate now: the confirmation date's rate (or a typed
      // override with override_exchange_rate).
      const C = require('./currency');
      const day = new Date().toISOString().slice(0, 10);
      let rate;
      let baseMinor;
      try {
        rate = C.documentRate(companyId, fxRow.currency_code, day, { override: { rate: exchangeRate, rateQuote }, actor: user });
        baseMinor = C.toBase(companyId, fxRow.currency_code, fxRow.amount_original_minor, rate);
      } catch (err) {
        throw currencyError(err);
      }
      if (!(baseMinor > 0)) throw Object.assign(new Error('zero_amount'), { status: 400 });
      const { fromMinor } = require('./ledgerCurrencies');
      db.prepare("UPDATE collection_fx SET rate_e8 = ?, rate_quote = ?, base_minor = ?, locked_at = datetime('now'), locked_by = ? WHERE collection_id = ?").run(rate.rateE8, rate.quote, baseMinor, user?.id ?? null, collection.id);
      db.prepare('UPDATE collections SET amount = ? WHERE id = ?').run(Number(fromMinor(baseMinor, require('./ledger').getBaseCurrency(companyId).minor_unit_digits)), collection.id);
      collection.amount = Number(fromMinor(baseMinor, require('./ledger').getBaseCurrency(companyId).minor_unit_digits));
    }
    db.prepare(
      "UPDATE collections SET status = 'confirmed', confirmed_by_id = ?, confirmed_by_name = ?, confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(user.id, user.name, collection.id);
    logChange(companyId, collection.id, { action: 'confirm', field: 'status', before: collection.status, after: 'confirmed', user });
    checkpoint('collections.confirm.after_status');

    if (live) require('./salesPosting').postCollection(companyId, collection, user);
    else applyToBalance(companyId, collection);
    checkpoint('collections.confirm.after_balance');
  };
  // One transaction in BOTH modes: the status change and the balance write
  // (snapshot or journal entry) commit together or not at all. Savepoint
  // based, so it also works if a caller already opened a transaction.
  try {
    require('./ledger').transaction(apply);
  } catch (err) {
    // Ledger errors (no open period, missing account ...) surface with
    // their code as `error`, like every other error from this route.
    if (live && err.code && err.status) throw Object.assign(new Error(err.code), { status: err.status, detail: err.message });
    throw err;
  }

  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(collection.shop_id);
  const sendStatementUpdate = getSetting(companyId, 'send_statement_on_collection_confirmed', '1') === '1';
  if (sendStatementUpdate && shop) {
    const latest = getLatestBalance(shop.id);
    sendToCustomer(
      companyId,
      shop,
      `مرحبًا ${shop.name}،\nتم تأكيد استلام دفعة بقيمة ${collection.amount.toLocaleString('ar')}$ (${collection.method === 'cash' ? 'نقدًا' : 'حوالة'}).\nرصيدكم الحالي: ${latest ? Math.round(latest.balance).toLocaleString('ar') : 0}$`
    ).catch(() => {});
  }

  return db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id);
}

// Reverses a CONFIRMED collection on a ledger-live company: reverses its
// journal entry (the receipt's allocations are freed by the ledger hook) and
// marks the collection 'reversed' — one transaction. Non-live companies have
// no entry to reverse; their balances are Amin snapshots.
function reverseCollection(companyId, collectionId, { reason, date } = {}, user) {
  const ledger = require('./ledger');
  return ledger.transaction(() => {
    const collection = getCollection(companyId, collectionId);
    if (!collection) throw Object.assign(new Error('not_found'), { status: 404 });
    if (collection.status === 'reversed') throw Object.assign(new Error('already_reversed'), { status: 409 });
    if (collection.status !== 'confirmed') throw Object.assign(new Error('not_confirmed'), { status: 409, currentStatus: collection.status });
    if (!isLedgerLive(companyId)) throw Object.assign(new Error('not_ledger_live'), { status: 409 });
    if (!String(reason || '').trim()) throw Object.assign(new Error('reason_required'), { status: 400 });
    if (db.prepare("SELECT 1 FROM rep_cash_handover_items hi JOIN rep_cash_handovers h ON h.id = hi.handover_id WHERE hi.collection_id = ? AND h.status = 'posted'").get(collection.id)) {
      throw Object.assign(new Error('collection_handed_over'), { status: 409, detail: 'النقدية سُلّمت إلى الصندوق — اعكس سند التسليم أولًا' });
    }
    const entry = db
      .prepare("SELECT id FROM journal_entries WHERE company_id = ? AND source_type = 'collection' AND source_id = ? AND status = 'posted'")
      .get(companyId, collection.id);
    if (!entry) throw Object.assign(new Error('no_posted_entry'), { status: 409 });
    try {
      ledger.reverseEntry(companyId, entry.id, { reason: `عكس التحصيل رقم ${collection.id} — ${reason}`, date, fromSource: true }, user);
    } catch (err) {
      if (err.code && err.status) throw Object.assign(new Error(err.code), { status: err.status, detail: err.message });
      throw err;
    }
    checkpoint('collections.reverse.after_entry');
    db.prepare("UPDATE collections SET status = 'reversed', updated_at = datetime('now') WHERE id = ?").run(collection.id);
    logChange(companyId, collection.id, { action: 'reverse', field: 'status', before: 'confirmed', after: { status: 'reversed', reason: String(reason).trim() }, user });
    require('./auditLog').logAudit({
      companyId, actor: user ? { id: user.id, name: user.name } : null, action: 'collections.reverse', entityType: 'collection', entityId: collection.id, shopId: collection.shop_id,
      before: { status: 'confirmed' }, after: { status: 'reversed', reason: String(reason).trim() },
    });
    return db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id);
  });
}

function rejectCollection(companyId, collectionId, reason, user) {
  const collection = getCollection(companyId, collectionId);
  if (!collection) throw Object.assign(new Error('not_found'), { status: 404 });
  if (!['pending_accountant_confirmation', 'pending_verification'].includes(collection.status)) {
    throw Object.assign(new Error('not_pending'), { status: 409, currentStatus: collection.status });
  }
  db.prepare("UPDATE collections SET status = 'rejected', rejected_reason = ?, updated_at = datetime('now') WHERE id = ?").run(
    reason || null,
    collection.id
  );
  logChange(companyId, collection.id, { action: 'reject', field: 'status', before: collection.status, after: 'rejected', user });
  return db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id);
}

// ---------------------------------------------------------------------
// Payment-overdue color signal — a second, independent input into a
// shop's red/yellow/green status alongside the existing debt-threshold/
// order-cycle one in lib/status.js. Off by default (payment_overdue_color_enabled).
// ---------------------------------------------------------------------

function getLastConfirmedPaymentDate(shopId) {
  return db.prepare("SELECT MAX(confirmed_at) d FROM collections WHERE shop_id = ? AND status = 'confirmed'").get(shopId)?.d ?? null;
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

// Returns null when the feature is off (nothing to merge into the shop's
// status); otherwise { isPaymentOverdue, daysSincePayment, paymentOverdueDays }.
function computePaymentOverdueStatus(companyId, shop, globalSettings) {
  if (globalSettings.payment_overdue_color_enabled !== '1') return null;
  const overdueDays = Number(globalSettings.payment_overdue_days || 30);
  const lastPaymentDate = getLastConfirmedPaymentDate(shop.id);
  // No payment on record at all: age it off the shop's own creation date
  // rather than treating "never paid" as automatically fine.
  const anchor = lastPaymentDate || shop.created_at;
  const daysSincePayment = daysSince(anchor);
  return {
    isPaymentOverdue: daysSincePayment != null && daysSincePayment > overdueDays,
    daysSincePayment,
    paymentOverdueDays: overdueDays,
  };
}

const COLOR_RANK = { green: 0, yellow: 1, red: 2 };

// Never downgrades a color the existing debt/order-cycle check already
// raised — a payment-overdue signal can only push a shop to yellow (if it
// was green) or leave it at red, never make a red shop look better.
function mergeWorstColor(baseStatus, paymentOverdue) {
  if (!paymentOverdue?.isPaymentOverdue) return baseStatus;
  const upgraded = COLOR_RANK[baseStatus] < COLOR_RANK.yellow ? 'yellow' : baseStatus;
  return upgraded;
}

// Suggests a reminder for every shop currently over its debt threshold or
// payment-overdue — never sends anything itself (item 8: an employee has
// to review and explicitly send or approve each one). Skips a shop that
// already has an unreviewed suggestion outstanding, so re-running this
// sweep repeatedly doesn't pile up duplicates.
async function sweepPaymentReminders() {
  const { getAllEnrichedShops } = require('./shopData');
  const companyIds = db.prepare('SELECT id FROM companies').all().map((r) => r.id);

  for (const companyId of companyIds) {
    let shops;
    try {
      shops = getAllEnrichedShops(companyId);
    } catch (err) {
      console.error(`[collections] sweep failed to load shops for company ${companyId}:`, err.message);
      continue;
    }

    for (const shop of shops) {
      let reason = shop.isOverDebt ? 'credit_limit_exceeded' : shop.isPaymentOverdue ? 'payment_overdue' : null;
      // Ledger-live companies (Prompt 3): also remind on invoices overdue by
      // more than overdue_invoice_reminder_days (default 30).
      let overdueText = null;
      if (!reason && isLedgerLive(companyId)) {
        const days = Number(getSetting(companyId, 'overdue_invoice_reminder_days', '30')) || 30;
        // Legacy/undated debt counts as overdue unless legacy_debt_policy = 'current'.
        const overdue = require('./receivables').overdueItems(companyId, shop.id, { minDays: days });
        if (overdue.length) {
          reason = 'overdue_invoices';
          overdueText = overdue.map((it) => (it.bucket === 'legacy' ? 'رصيد سابق' : it.number)).filter(Boolean).slice(0, 5).join('، ');
        }
      }
      if (!reason) continue;

      const existing = db
        .prepare("SELECT 1 FROM payment_reminders WHERE company_id = ? AND shop_id = ? AND status = 'pending_review'")
        .get(companyId, shop.id);
      if (existing) continue;

      const message = reason === 'overdue_invoices'
        ? `مرحبًا ${shop.name}،\nنود تذكيركم بوجود فواتير متأخرة السداد: ${overdueText}. نرجو التكرم بالتسديد في أقرب وقت.`
        : reason === 'credit_limit_exceeded'
          ? `مرحبًا ${shop.name}،\nنود تذكيركم بأن رصيدكم الحالي (${Math.round(shop.balance || 0).toLocaleString('ar')}$) تجاوز الحد المسموح. نرجو التكرم بالتسديد في أقرب وقت.`
          : `مرحبًا ${shop.name}،\nنود تذكيركم بأنه مضى ${shop.daysSincePayment} يومًا منذ آخر دفعة مؤكدة. نرجو التكرم بالتسديد في أقرب وقت.`;

      db.prepare(
        'INSERT INTO payment_reminders (company_id, shop_id, triggered_reason, suggested_message) VALUES (?, ?, ?, ?)'
      ).run(companyId, shop.id, reason, message);
      createNotification({
        companyId,
        type: 'payment_reminder_suggested',
        message_ar: `تذكير دفع مقترح لمحل ${shop.name} (${reason === 'credit_limit_exceeded' ? 'تجاوز الحد الائتماني' : reason === 'overdue_invoices' ? 'فواتير متأخرة' : 'تأخر بالدفع'}) — بانتظار مراجعتك.`,
        message_en: `Suggested payment reminder for ${shop.name} (${reason}) — awaiting your review.`,
        link_path: `/shops/${shop.id}`,
        entity_type: 'shop',
        entity_id: shop.id,
      });
    }
  }
}

module.exports = {
  createCollection,
  confirmCollection,
  rejectCollection,
  reverseCollection,
  getCollection,
  logChange,
  getSetting,
  computePaymentOverdueStatus,
  mergeWorstColor,
  sweepPaymentReminders,
};
