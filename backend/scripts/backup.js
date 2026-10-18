#!/usr/bin/env node
// Safe daily backup. The live DB runs in WAL mode, so a raw `cp data.sqlite`
// can silently miss recent committed writes still sitting in data.sqlite-wal
// (that file, not the main one, often holds most of the actual data between
// checkpoints). SQLite's own `VACUUM INTO` reads the database at a consistent
// point in time including WAL content, so the copy it produces is always
// complete and restorable.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', 'db', 'data.sqlite');
const BACKUP_DIR = process.argv[2] || path.join(__dirname, '..', '..', 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const destPath = path.join(BACKUP_DIR, `backup-${stamp}.sqlite`);

const db = new DatabaseSync(DB_PATH, { readOnly: true, timeout: require('../db/sqliteConfig').BUSY_TIMEOUT_MS });
try {
  db.prepare('VACUUM INTO ?').run(destPath);
  console.log(`[backup] wrote ${destPath}`);
} catch (err) {
  console.error('[backup] failed:', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
