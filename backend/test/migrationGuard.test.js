// backend/test/migrationGuard.test.js
//
// Pending-migrations guard + scripts/deploy.sh:
//  - a brand-new database (init.js) has every migration stamped: 0 pending;
//  - with a migration pending, every request except /api/health is 503
//    migrations_pending and /api/health reports schema version + pending;
//    `node server.js` logs a refusal; nothing auto-migrates;
//  - scripts/deploy.sh --no-start: VACUUM INTO backup (integrity-checked,
//    still pending in the backup) -> migrate -> the running app unblocks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const backend = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-migguard-'));
const dbPath = path.join(scratch, 'data.sqlite');
const LAST = fs.readdirSync(path.join(backend, 'db', 'migrations')).filter((f) => f.endsWith('.js')).sort().pop();
const env = (extra = {}) => ({ ...process.env, NODE_ENV: 'test', ATLAS_DB_PATH: dbPath, ...extra });

// Build a fresh DB in a child process, then un-apply the last migration.
execFileSync(process.execPath, ['-e', "require('./db/init')"], { cwd: backend, env: env(), stdio: 'ignore' });
{
  const raw = require('../lib/clock').attachSqlite(new DatabaseSync(dbPath));
  const n = raw.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  assert.equal(n, fs.readdirSync(path.join(backend, 'db', 'migrations')).filter((f) => f.endsWith('.js')).length, 'fresh DB: every migration stamped');
  raw.prepare('DELETE FROM schema_migrations WHERE filename = ?').run(LAST);
  raw.close();
}

process.env.ATLAS_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';
const app = require('../server');
const db = require('../db/init');

let listener;
let base;
test.before(() => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('pending migration: every request 503 except /api/health, which reports version + pending; no auto-migrate', async () => {
  const h = await fetch(`${base}/api/health`);
  assert.equal(h.status, 503);
  const hb = await h.json();
  assert.equal(hb.ok, false);
  assert.equal(hb.pending_migrations, 1);
  assert.deepEqual(hb.pending, [LAST]);
  assert.ok(hb.schema_version && hb.schema_version < LAST);
  for (const p of ['/api/auth/me', '/api/stock/meta', '/api/companies/signup']) {
    const r = await fetch(`${base}${p}`, { method: p.includes('signup') ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: p.includes('signup') ? '{}' : undefined });
    assert.equal(r.status, 503, p);
    const b = await r.json();
    assert.equal(b.error, 'migrations_pending');
    assert.ok(b.message.includes(LAST));
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE filename = ?').get(LAST).c, 0, 'not auto-migrated');
});

test('node server.js with a pending migration logs a refusal and serves 503', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], { cwd: backend, env: env({ PORT: String(port), NODE_ENV: 'production' }) });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    let r;
    for (let i = 0; i < 50; i += 1) {
      try { r = await fetch(`http://localhost:${port}/api/health`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); }
    }
    assert.equal(r.status, 503);
    assert.equal((await fetch(`http://localhost:${port}/api/auth/me`)).status, 503);
    assert.match(log, /REFUSING TO SERVE/);
    assert.ok(log.includes(LAST));
  } finally {
    child.kill();
  }
});

test('scripts/deploy.sh --no-start: VACUUM INTO backup, then migrate; the app unblocks', async () => {
  const backups = path.join(scratch, 'backups');
  const out = execFileSync('bash', ['scripts/deploy.sh', '--no-start'], { cwd: backend, env: env({ ATLAS_BACKUP_DIR: backups }), encoding: 'utf8' });
  assert.match(out, /backup ok/);
  assert.match(out, new RegExp(`applied ${LAST.replace('.', '\\.')}`));
  const files = fs.readdirSync(backups);
  assert.equal(files.length, 1);
  // The backup is the PRE-migration state.
  const bk = new DatabaseSync(path.join(backups, files[0]), { readOnly: true });
  assert.equal(bk.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE filename = ?').get(LAST).c, 0);
  bk.close();
  const h = await fetch(`${base}/api/health`);
  assert.equal(h.status, 200);
  const hb = await h.json();
  assert.deepEqual([hb.ok, hb.pending_migrations, hb.schema_version], [true, 0, LAST]);
  assert.notEqual((await fetch(`${base}/api/auth/me`)).status, 503);
  // Second deploy: nothing pending, a new backup, no error.
  const again = execFileSync('bash', ['scripts/deploy.sh', '--no-start'], { cwd: backend, env: env({ ATLAS_BACKUP_DIR: backups }), encoding: 'utf8' });
  assert.match(again, /up to date/);
});
