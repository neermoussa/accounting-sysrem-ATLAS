// backend/test/ledgerSource.test.js
//
// Source idempotency at the posting-service level: the path every later
// module (sales invoices, collections, returns ...) uses. Calls
// lib/ledger.js directly against a throwaway database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ledger-src-'));
process.env.ATLAS_DB_PATH = path.join(dir, 'data.sqlite');
const db = require('../db/init');
const ledger = require('../lib/ledger');

let cid;
let lines;
test.before(() => {
  cid = Number(db.prepare("INSERT INTO companies (name, currency) VALUES ('مصدر', 'USD')").run().lastInsertRowid);
  ledger.applyCoaTemplate(cid, 'trading', null);
  ledger.createFiscalYear(cid, { year: 2026 }, null);
  const acc = (code) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND code = ?').get(cid, code).id;
  lines = [{ accountId: acc('1110'), debit: '10' }, { accountId: acc('4100'), credit: '10' }];
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the same source cannot post twice (system source type)', () => {
  const first = ledger.postEntry(cid, { date: '2026-03-01', sourceType: 'collection', sourceId: 42, lines }, null);
  assert.equal(first.status, 'posted');
  assert.throws(
    () => ledger.postEntry(cid, { date: '2026-03-02', sourceType: 'collection', sourceId: 42, lines }, null),
    (err) => err.code === 'source_already_posted'
  );
  // A different source id, or a different source type with the same id, is fine.
  assert.equal(ledger.postEntry(cid, { date: '2026-03-02', sourceType: 'collection', sourceId: 43, lines }, null).status, 'posted');
  assert.equal(ledger.postEntry(cid, { date: '2026-03-02', sourceType: 'return_request', sourceId: 42, lines }, null).status, 'posted');
  // After the original is reversed, the source may post again.
  assert.throws(() => ledger.reverseEntry(cid, first.id, { date: '2026-03-03' }, null), (err) => err.code === 'reverse_via_source');
  ledger.reverseEntry(cid, first.id, { date: '2026-03-03', fromSource: true }, null);
  assert.equal(ledger.postEntry(cid, { date: '2026-03-03', sourceType: 'collection', sourceId: 42, lines }, null).status, 'posted');
  assert.throws(
    () => ledger.postEntry(cid, { date: '2026-03-04', sourceType: 'collection', sourceId: 42, lines }, null),
    (err) => err.code === 'source_already_posted'
  );
});

test('system entries require source_type + source_id', () => {
  assert.throws(() => ledger.postEntry(cid, { date: '2026-03-01', sourceType: 'collection', lines }, null), (err) => err.code === 'source_required');
});

test('a failed post writes nothing (single transaction)', () => {
  const before = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
  assert.throws(() => ledger.postEntry(cid, { date: '2026-03-01', sourceType: 'collection', sourceId: 99, lines: [lines[0], { ...lines[1], credit: '9' }] }, null));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c, before);
});
