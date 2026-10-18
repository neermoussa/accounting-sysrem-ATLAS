// backend/lib/analytics/runner.js
//
// Prompt 12a — heavy report queries never run on the main thread. Each
// report runs in a worker thread with its own READ-ONLY connection to the
// same database file, a timeout (the worker is terminated -> 504
// report_timeout) and a row cap (rows beyond it are dropped, truncated:
// true). The main thread's clock is passed in as params.now, so the worker
// needs no clock of its own.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ReportError } = require('./reports');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', '..', 'db', 'data.sqlite');
const DEFAULTS = { timeoutMs: Number(process.env.ATLAS_REPORT_TIMEOUT_MS) || 30000, rowCap: Number(process.env.ATLAS_REPORT_ROW_CAP) || 5000 };

function runReport(companyId, key, params = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const rowCap = opts.rowCap ?? DEFAULTS.rowCap;
  // Tests only: make the worker slow on purpose to prove the timeout.
  const testDelayMs = process.env.NODE_ENV === 'test' ? Number(opts.testDelayMs) || 0 : 0;
  const now = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'reportWorker.js'), { workerData: { dbPath: DB_PATH, companyId, key, params: { ...params, now }, rowCap, testDelayMs } });
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { worker.terminate(); finish(reject, new ReportError('report_timeout', 'تجاوز التقرير المهلة المسموحة — ضيّق الفترة أو الفلاتر', 504)); }, timeoutMs);
    worker.once('message', (m) => {
      if (m.ok) finish(resolve, m.result);
      else finish(reject, new ReportError(m.error.code, m.error.message, m.error.status));
    });
    worker.once('error', (err) => finish(reject, new ReportError('report_failed', err.message, 500)));
    worker.once('exit', (code) => { if (code !== 0) finish(reject, new ReportError('report_failed', 'توقف التقرير', 500)); });
  });
}

module.exports = { runReport, DB_PATH, DEFAULTS };
