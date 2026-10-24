// backend/lib/analytics/runner.js
//
// Prompt 12a — heavy report queries never run on the main thread. Each
// report runs in a worker thread with its own READ-ONLY connection to the
// same database file, a timeout (the worker is terminated -> 504
// report_timeout) and a row cap (rows beyond it are dropped, truncated:
// true). The main thread's clock is passed in as params.now, so the worker
// needs no clock of its own.
//
// Concurrency (NEXT ACTION item 2): at most `maxWorkers` reports run at once
// (ATLAS_REPORT_WORKERS, default 2); the next `maxQueue` wait in order
// (ATLAS_REPORT_QUEUE, default 8). Beyond that a report is refused with
// 503 reports_busy and a Retry-After (seconds, ATLAS_REPORT_RETRY_AFTER_S,
// default 5). The timeout counts from the moment the report starts running.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ReportError } = require('./reports');

const DB_PATH = process.env.ATLAS_DB_PATH || path.join(__dirname, '..', '..', 'db', 'data.sqlite');
const positive = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
const nonNegative = (v, d) => (v !== undefined && v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const DEFAULTS = {
  timeoutMs: Number(process.env.ATLAS_REPORT_TIMEOUT_MS) || 30000,
  rowCap: Number(process.env.ATLAS_REPORT_ROW_CAP) || 5000,
  maxWorkers: positive(process.env.ATLAS_REPORT_WORKERS, 2),
  maxQueue: nonNegative(process.env.ATLAS_REPORT_QUEUE, 8),
  retryAfterS: positive(process.env.ATLAS_REPORT_RETRY_AFTER_S, 5),
};
const pool = { maxWorkers: DEFAULTS.maxWorkers, maxQueue: DEFAULTS.maxQueue, retryAfterS: DEFAULTS.retryAfterS, running: 0, peak: 0, queue: [] };

class BusyError extends ReportError {
  constructor(retryAfterS) {
    super('reports_busy', 'التقارير مشغولة الآن — أعد المحاولة بعد قليل', 503);
    this.retryAfter = retryAfterS;
  }
}

function startWorker(job) {
  const { companyId, key, params, timeoutMs, rowCap, testDelayMs, resolve, reject } = job;
  pool.running += 1;
  pool.peak = Math.max(pool.peak, pool.running);
  const now = new Date().toISOString();
  let worker;
  try {
    worker = new Worker(path.join(__dirname, 'reportWorker.js'), { workerData: { dbPath: DB_PATH, companyId, key, params: { ...params, now }, rowCap, testDelayMs } });
  } catch (err) {
    pool.running -= 1;
    next();
    return reject(new ReportError('report_failed', err.message, 500));
  }
  let done = false;
  const finish = (fn, v) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pool.running -= 1;
    next();
    fn(v);
  };
  const timer = setTimeout(() => { worker.terminate(); finish(reject, new ReportError('report_timeout', 'تجاوز التقرير المهلة المسموحة — ضيّق الفترة أو الفلاتر', 504)); }, timeoutMs);
  worker.once('message', (m) => {
    if (m.ok) finish(resolve, m.result);
    else finish(reject, new ReportError(m.error.code, m.error.message, m.error.status));
  });
  worker.once('error', (err) => finish(reject, new ReportError('report_failed', err.message, 500)));
  worker.once('exit', (code) => { if (code !== 0) finish(reject, new ReportError('report_failed', 'توقف التقرير', 500)); });
}
function next() {
  while (pool.running < pool.maxWorkers && pool.queue.length) startWorker(pool.queue.shift());
}

function runReport(companyId, key, params = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const rowCap = opts.rowCap ?? DEFAULTS.rowCap;
  // Tests only: make the worker slow on purpose to prove the timeout.
  const testDelayMs = process.env.NODE_ENV === 'test' ? Number(opts.testDelayMs) || 0 : 0;
  return new Promise((resolve, reject) => {
    const job = { companyId, key, params, timeoutMs, rowCap, testDelayMs, resolve, reject };
    if (pool.running < pool.maxWorkers) return startWorker(job);
    if (pool.queue.length >= pool.maxQueue) return reject(new BusyError(pool.retryAfterS));
    pool.queue.push(job);
  });
}

const stats = () => ({ running: pool.running, queued: pool.queue.length, peak: pool.peak, maxWorkers: pool.maxWorkers, maxQueue: pool.maxQueue });
// Tests only: change the limits at run time (and reset the peak counter).
function configure({ maxWorkers, maxQueue, retryAfterS } = {}) {
  if (process.env.NODE_ENV !== 'test') throw new Error('runner.configure is test-only');
  if (maxWorkers !== undefined) pool.maxWorkers = positive(maxWorkers, pool.maxWorkers);
  if (maxQueue !== undefined) pool.maxQueue = nonNegative(maxQueue, pool.maxQueue);
  if (retryAfterS !== undefined) pool.retryAfterS = positive(retryAfterS, pool.retryAfterS);
  pool.peak = pool.running;
  next();
}

module.exports = { runReport, DB_PATH, DEFAULTS, BusyError, stats, configure };
