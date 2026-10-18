#!/usr/bin/env bash
# Atlas deploy: backup -> migrate -> start. Stops at the first failure, so a
# failed backup never migrates and a failed migration never starts the
# server (which would refuse to serve anyway: migrations pending).
#
#   scripts/deploy.sh              backup, migrate, then exec the server
#   scripts/deploy.sh --no-start   backup and migrate only
#
# Env: ATLAS_DB_PATH (default backend/db/data.sqlite), ATLAS_BACKUP_DIR
# (default <repo>/backups).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${ATLAS_DB_PATH:-$PWD/db/data.sqlite}"
BACKUP_DIR="${ATLAS_BACKUP_DIR:-$PWD/../backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_DIR/pre-deploy-$STAMP-$$.sqlite"

if [ -f "$DB" ]; then
  echo "[deploy] backup: VACUUM INTO $BACKUP"
  DB="$DB" BACKUP="$BACKUP" node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.DB, { readOnly: true, timeout: require('./db/sqliteConfig').BUSY_TIMEOUT_MS });
    db.prepare('VACUUM INTO ?').run(process.env.BACKUP);
    const c = new DatabaseSync(process.env.BACKUP, { readOnly: true });
    const r = c.prepare('PRAGMA integrity_check').get();
    if (Object.values(r)[0] !== 'ok') { console.error('[deploy] backup integrity check failed'); process.exit(1); }
  " 2> >(grep -v ExperimentalWarning >&2)
  echo "[deploy] backup ok"
else
  echo "[deploy] no database at $DB yet — nothing to back up"
fi

echo "[deploy] migrate"
ATLAS_DB_PATH="$DB" node db/migrate.js

if [ "${1:-}" = "--no-start" ]; then
  echo "[deploy] done (not starting the server)"
  exit 0
fi
echo "[deploy] start"
ATLAS_DB_PATH="$DB" exec node server.js
