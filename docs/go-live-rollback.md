# Ledger go-live: procedure and rollback

Going live (`modules_json.ledger_live = true`) makes the ledger the source of
truth for customer balances. Posted journal entries are immutable (database
triggers) and the flag has no "off" switch, so **the only rollback is
restoring the backup taken just before go-live.**

## Going live

1. Prerequisites: chart of accounts applied, fiscal year with an **open**
   period covering the go-live date, latest Amin balances imported.
2. **Dry run** — Customer Ledger → "التحول إلى الدفتر" → "تجربة بدون كتابة",
   or `node scripts/ledger-go-live.js --company <id> [--date YYYY-MM-DD]`.
   It records the report (`ledger_go_live_runs`, kind `dry_run`) and writes
   no entries. Review every customer's opening amount.
3. **Execute** within 24 hours of that dry run, typing exactly:
   `Invoices will be created in Atlas from now on`
   (screen, or `--execute <dryRunId> --confirm-text "..."`).
   Execution is refused if the dry run is older than 24h, belongs to another
   company, or the balances changed since it (`plan_changed` → dry-run again).
4. Before writing anything, Atlas makes a consistent copy of the whole
   database with `VACUUM INTO`, verifies it (`PRAGMA quick_check`) and shows
   its path. If the backup fails, nothing happens.
   Location: `backend/db/backups/atlas-before-go-live-company<id>-<UTC timestamp>.sqlite`
   (or `$ATLAS_BACKUP_DIR`). The path is also stored on the `executed` run
   record and in the audit log (`ledger.go_live`).
5. One transaction then posts the opening entries, sets the flag and
   re-derives every customer balance.

Copy the backup file somewhere off the server as well — it is the rollback.

## Rollback (restore the pre-go-live backup)

The backup is the **whole database** (all companies) at that moment.
Restoring it also discards everything every company did after it. Do it as
soon as possible after a bad go-live, and tell users what will be lost.

1. Announce downtime; stop the backend (`start-backend` window / process).
2. Keep the current state for investigation:
   ```
   cd backend/db
   mkdir -p rollback-<date>
   mv data.sqlite data.sqlite-wal data.sqlite-shm rollback-<date>/ 2>/dev/null
   ```
   (Windows: move the same three files in Explorer.)
3. Restore the backup as the live database:
   ```
   cp backups/atlas-before-go-live-company<id>-<timestamp>.sqlite data.sqlite
   ```
   No `-wal`/`-shm` files must remain next to the restored `data.sqlite`.
4. Check it before starting:
   ```
   cd backend
   node -e "const d=require('./db/init');console.log(d.prepare('PRAGMA quick_check').get(), JSON.parse(d.prepare('SELECT modules_json FROM companies WHERE id=?').get(<id>).modules_json||'{}').ledger_live)"
   ```
   Expect `{ quick_check: 'ok' }` and `undefined`/`false` for ledger_live.
5. `node db/migrate.js` (no-op if the code didn't change), start the backend.
6. Re-enter anything that happened after the backup (collections confirmed,
   returns approved, invoices) from the kept copy in `rollback-<date>/` or
   from paper. Re-import the latest Amin file if needed.

## Why there is no "un-go-live" button

Undoing in place would mean deleting posted entries (blocked by design) or
posting reversals while the old snapshot writers start again — two sources of
truth for the same balance. Restoring the verified backup is the only state
known to be consistent.
