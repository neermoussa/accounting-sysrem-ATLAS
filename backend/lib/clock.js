// backend/lib/clock.js
//
// One clock for the app. Production: the real system time.
// Tests only (NODE_ENV=test and ATLAS_TEST_NOW=<ISO date or datetime>):
// the clock is shifted so "now" starts at that instant and keeps running
// (global Date is replaced by a subclass with a fixed offset, so every
// `new Date()` / `Date.now()` in the app and in the tests follows it).
// SQL that needs "now" takes it as a parameter (nowSql()) instead of
// SQLite's datetime('now'), which cannot be shifted.
// Outside NODE_ENV=test ATLAS_TEST_NOW is ignored.

const RealDate = global.__ATLAS_REAL_DATE__ || Date;
let offsetMs = 0;

const parseTarget = (target) => {
  const t = RealDate.parse(/T/.test(target) ? target : `${target}T09:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`ATLAS_TEST_NOW is not a date: ${target}`);
  return t;
};
function install() {
  const target = process.env.ATLAS_TEST_NOW;
  if (process.env.NODE_ENV !== 'test' || !target || global.__ATLAS_REAL_DATE__) return;
  offsetMs = parseTarget(target) - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offsetMs;
    }
  }
  global.__ATLAS_REAL_DATE__ = RealDate;
  global.Date = ShiftedDate;
}
install();

const now = () => new Date();
const today = () => now().toISOString().slice(0, 10);
// SQLite text format, UTC: 'YYYY-MM-DD HH:MM:SS'.
const nowSql = (deltaMs = 0) => new Date(Date.now() + deltaMs).toISOString().replace('T', ' ').slice(0, 19);

// Test-only: make SQLite's 'now' (datetime('now'), DEFAULT (datetime('now'))
// ...) follow the shifted clock on this connection. Each built-in date
// function is overridden by one that swaps 'now' for the clock's instant
// and evaluates the original on a private in-memory connection.
function attachSqlite(db) {
  if (!offsetMs) return db;
  const { DatabaseSync } = require('node:sqlite');
  const inner = new DatabaseSync(':memory:');
  const stmts = new Map();
  for (const fn of ['datetime', 'date', 'time', 'julianday', 'unixepoch', 'strftime']) {
    const timeArg = fn === 'strftime' ? 1 : 0;
    db.function(fn, { varargs: true, deterministic: false }, (...args) => {
      const a = args.length > timeArg ? args.slice() : [...args, 'now'];
      if (typeof a[timeArg] === 'string' && a[timeArg].toLowerCase() === 'now') a[timeArg] = nowSql();
      const key = `${fn}/${a.length}`;
      if (!stmts.has(key)) stmts.set(key, inner.prepare(`SELECT ${fn}(${a.map(() => '?').join(', ')}) AS v`));
      return stmts.get(key).get(...a).v;
    });
  }
  return db;
}

// Tests only: move the shifted clock to another instant inside the same
// process (e.g. across 31 Dec -> 1 Jan). Requires the override installed.
function setNow(target) {
  if (process.env.NODE_ENV !== 'test' || !global.__ATLAS_REAL_DATE__) throw new Error('clock.setNow is only available with ATLAS_TEST_NOW under NODE_ENV=test');
  offsetMs = parseTarget(target) - RealDate.now();
}

module.exports = { install, now, today, nowSql, attachSqlite, setNow, isShifted: () => offsetMs !== 0 };
