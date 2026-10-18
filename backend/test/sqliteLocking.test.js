// backend/test/sqliteLocking.test.js
//
// SQLite concurrency settings (after CI run #16):
//  - the server DB runs in WAL mode with the shared busy timeout;
//  - both transaction helpers (db.transaction shim, lib/ledger.js tx) take
//    the write lock UP FRONT (BEGIN IMMEDIATE) — before their first write,
//    another connection already cannot write — so no transaction ever
//    upgrades from a read to a write (SQLITE_BUSY_SNAPSHOT in WAL);
//  - a user request whose write meets another process's write lock (held
//    ~1 s) waits and succeeds;
//  - scripts/deploy.sh (backup + migrate) waits for a held lock the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lock-'));
const dbPath = path.join(scratch, 'data.sqlite');
process.env.ATLAS_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';

const app = require('../server');
const db = require('../db/init');
const ledger = require('../lib/ledger');
const { BUSY_TIMEOUT_MS } = require('../db/sqliteConfig');
const h = require('./salesHelpers');

const backend = path.join(__dirname, '..');
let listener;
let base;
test.before(() => {
  db.exec('CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)'); // test-only table
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// Another process takes the write lock, signals, holds it for `ms`, commits.
function holdWriteLock(file, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(${JSON.stringify(file)}, { timeout: 5000 });
      d.exec('BEGIN IMMEDIATE');
      d.exec('INSERT INTO lock_probe (x) VALUES (1)');
      process.stdout.write('locked\\n');
      setTimeout(() => { d.exec('COMMIT'); process.stdout.write('released\\n'); }, ${ms});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const done = new Promise((ok) => child.on('exit', ok));
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('locked')) resolve({ done, released: () => out.includes('released') });
    });
    child.on('exit', (code) => { if (!out.includes('locked')) reject(new Error(`lock holder failed: ${err}`)); });
  });
}

test('server DB: WAL journal mode and the shared busy timeout', () => {
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, BUSY_TIMEOUT_MS);
  assert.equal(BUSY_TIMEOUT_MS, 5000);
});

test('both transaction helpers hold the write lock before their first write (BEGIN IMMEDIATE, no read-to-write upgrade)', () => {
  const other = require('../lib/clock').attachSqlite(new DatabaseSync(dbPath)); // timeout 0: fails at once if locked
  const probeWrite = () => {
    try {
      other.prepare('INSERT INTO lock_probe (x) VALUES (2)').run();
      return 'wrote';
    } catch (e) {
      return e.message;
    }
  };
  assert.equal(probeWrite(), 'wrote', 'free before');
  // Only a READ inside each helper, then the probe: the lock is already held.
  ledger.transaction(() => {
    db.prepare('SELECT COUNT(*) c FROM companies').get();
    assert.equal(probeWrite(), 'database is locked', 'ledger.transaction holds the write lock from the start');
    // Nested call = savepoint inside the same transaction.
    ledger.transaction(() => assert.equal(db.isTransaction, true));
  });
  assert.equal(db.isTransaction, false);
  db.transaction(() => {
    db.prepare('SELECT COUNT(*) c FROM companies').get();
    assert.equal(probeWrite(), 'database is locked', 'db.transaction holds the write lock from the start');
  })();
  // Rollback path leaves no transaction open.
  assert.throws(() => ledger.transaction(() => { throw new Error('boom'); }), /boom/);
  assert.equal(db.isTransaction, false);
  assert.equal(probeWrite(), 'wrote', 'free after');
  other.close();
});

test('a user request that meets another process holding the write lock for ~1 s waits and succeeds', async () => {
  const co = await h.createUsdCompany(base, 'شركة القفل');
  const m = co.manager;
  await h.setupLedger(m);
  const acc = (key) => db.prepare('SELECT id FROM accounts WHERE company_id = ? AND system_key = ?').get(co.companyId, key).id;
  const lock = await holdWriteLock(dbPath, 1000);
  const t0 = Date.now();
  const r = await m.post('/api/ledger/entries', { date: h.TODAY, post: true, description: 'قيد أثناء القفل', lines: [{ accountId: acc('cash_default'), debit: '10' }, { accountId: acc('opening_balance_equity'), credit: '10' }] });
  const waited = Date.now() - t0;
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(waited >= 800, `the request waited for the lock (${waited} ms)`);
  assert.ok(lock.released(), 'it went through only after the other process committed');
  await lock.done;
  assert.equal(db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE company_id = ? AND description = ?').get(co.companyId, 'قيد أثناء القفل').c, 1);
});

test('scripts/deploy.sh (backup + migrate) waits for a held write lock with the same timeout', async () => {
  // Make one migration pending, then hold the lock while deploying.
  const last = fs.readdirSync(path.join(backend, 'db', 'migrations')).filter((f) => f.endsWith('.js')).sort().pop();
  db.prepare('DELETE FROM schema_migrations WHERE filename = ?').run(last);
  const lock = await holdWriteLock(dbPath, 1200);
  const t0 = Date.now();
  const out = await new Promise((ok, ko) => execFile('bash', ['scripts/deploy.sh', '--no-start'], { cwd: backend, env: { ...process.env, ATLAS_DB_PATH: dbPath, ATLAS_BACKUP_DIR: path.join(scratch, 'backups') } }, (e, so, se) => (e ? ko(new Error(`${e.message}\n${so}\n${se}`)) : ok(so))));
  const waited = Date.now() - t0;
  await lock.done;
  assert.match(out, /backup ok/);
  assert.match(out, new RegExp(`applied ${last.replace('.', '\\.')}`));
  assert.ok(waited >= 1000, `deploy waited for the lock (${waited} ms)`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE filename = ?').get(last).c, 1);
});
