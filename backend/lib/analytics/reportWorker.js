// backend/lib/analytics/reportWorker.js — runs ONE ready report on a
// read-only second connection, off the main thread (lib/analytics/runner.js).
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const reports = require('./reports');

const { dbPath, companyId, key, params, rowCap, testDelayMs } = workerData;
let dbh;
try {
  dbh = new DatabaseSync(dbPath, { readOnly: true });
  dbh.exec('PRAGMA busy_timeout = 5000');
  if (testDelayMs) { const end = Date.now() + testDelayMs; while (Date.now() < end) { /* simulated heavy query */ } }
  const out = reports.run(dbh, companyId, key, params);
  const total = out.rows.length;
  const truncated = total > rowCap;
  parentPort.postMessage({ ok: true, result: { ...out, rows: truncated ? out.rows.slice(0, rowCap) : out.rows, row_count: total, truncated, row_cap: rowCap } });
} catch (err) {
  parentPort.postMessage({ ok: false, error: { code: err.code || 'report_failed', message: err.message, status: err.status || 500 } });
} finally {
  try { dbh?.close(); } catch { /* ignore */ }
}
