// backend/test/receivablesSweep.test.js
//
// Overdue-debt alerts reuse the existing payment_reminders sweep and the
// notification system: on a ledger-live company, a customer with an invoice
// overdue by more than overdue_invoice_reminder_days gets ONE pending
// reminder (reason overdue_invoices) and a notification; a non-live company
// is untouched. Runs the libs in-process on a throwaway database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sweep-'));
process.env.ATLAS_DB_PATH = path.join(dir, 'data.sqlite');
process.env.NODE_ENV = 'test';
const db = require('../db/init');
const ledger = require('../lib/ledger');
const sales = require('../lib/salesPosting');
const { sweepPaymentReminders } = require('../lib/collections');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function company(name, live) {
  const cid = Number(db.prepare("INSERT INTO companies (name, currency, modules_json) VALUES (?, 'USD', ?)").run(name, JSON.stringify(live ? { ledger_live: true } : {})).lastInsertRowid);
  ledger.applyCoaTemplate(cid, 'trading', null);
  ledger.createFiscalYear(cid, { year: Number(daysAgo(0).slice(0, 4)) }, null);
  if (Number(daysAgo(60).slice(0, 4)) !== Number(daysAgo(0).slice(0, 4))) ledger.createFiscalYear(cid, { year: Number(daysAgo(60).slice(0, 4)) }, null);
  const shop = Number(db.prepare("INSERT INTO shops (company_id, name, lat, lng) VALUES (?, ?, 33.5, 36.3)").run(cid, `زبون ${name}`).lastInsertRowid);
  const inv = sales.createInvoice(cid, { shopId: shop, invoiceDate: daysAgo(50), dueDate: daysAgo(45), lines: [{ description: 'x', qty: 1, unitPrice: '10' }] }, null);
  sales.postInvoice(cid, inv.id, null);
  return { cid, shop };
}

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live company: overdue invoice -> one pending reminder + notification; non-live untouched', async () => {
  const live = company('مفعّلة', true);
  const legacy = company('غير مفعّلة', false);
  await sweepPaymentReminders();
  await sweepPaymentReminders(); // idempotent
  const rem = db.prepare('SELECT * FROM payment_reminders WHERE company_id = ?').all(live.cid);
  assert.equal(rem.length, 1);
  assert.equal(rem[0].triggered_reason, 'overdue_invoices');
  assert.match(rem[0].suggested_message, /SI-00001/);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE company_id = ? AND type = 'payment_reminder_suggested'").get(live.cid));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payment_reminders WHERE company_id = ?').get(legacy.cid).c, 0);
});

test('threshold is configurable: 60 days -> no reminder for a 45-day-overdue invoice', async () => {
  const c = company('حد 60', true);
  db.prepare("INSERT INTO settings (company_id, key, value) VALUES (?, 'overdue_invoice_reminder_days', '60')").run(c.cid);
  await sweepPaymentReminders();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payment_reminders WHERE company_id = ?').get(c.cid).c, 0);
});

test('legacy debt triggers an overdue reminder by default, not with legacy_debt_policy=current', async () => {
  const mk = (name) => {
    const cid = Number(db.prepare("INSERT INTO companies (name, currency, modules_json) VALUES (?, 'USD', ?)").run(name, JSON.stringify({ ledger_live: true })).lastInsertRowid);
    ledger.applyCoaTemplate(cid, 'trading', null);
    ledger.createFiscalYear(cid, { year: Number(daysAgo(0).slice(0, 4)) }, null);
    const shop = Number(db.prepare("INSERT INTO shops (company_id, name, lat, lng) VALUES (?, 'زبون قديم', 33.5, 36.3)").run(cid).lastInsertRowid);
    const ar = ledger.getAccountBySystemKey(cid, 'ar_control').id;
    const obe = ledger.getAccountBySystemKey(cid, 'opening_balance_equity').id;
    ledger.postEntry(cid, { date: daysAgo(0), sourceType: 'customer_opening', sourceId: shop, lines: [
      { accountId: ar, debitMinor: 5000, creditMinor: 0, partyType: 'customer', partyId: shop },
      { accountId: obe, debitMinor: 0, creditMinor: 5000 },
    ] }, null);
    return cid;
  };
  const byDefault = mk('سياسة افتراضية');
  const current = mk('سياسة حالية');
  db.prepare("INSERT INTO settings (company_id, key, value) VALUES (?, 'legacy_debt_policy', 'current')").run(current);
  await sweepPaymentReminders();
  const r = db.prepare('SELECT * FROM payment_reminders WHERE company_id = ?').all(byDefault);
  assert.equal(r.length, 1);
  assert.equal(r[0].triggered_reason, 'overdue_invoices');
  assert.match(r[0].suggested_message, /رصيد سابق/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payment_reminders WHERE company_id = ?').get(current).c, 0);
});
