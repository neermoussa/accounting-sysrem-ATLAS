// Currency catalog + exact money conversion for the ledger.
//
// Amounts are stored as INTEGER minor units. The API speaks decimal strings
// in major units ("1234.50"); toMinor/fromMinor are the only places that
// convert, and they never go through floating point.

const DEFAULT_CURRENCIES = [
  { code: 'USD', name: 'دولار أمريكي', digits: 2 },
  { code: 'SYP', name: 'ليرة سورية', digits: 0 },
  { code: 'EUR', name: 'يورو', digits: 2 },
];

// Idempotent: inserts any missing default currency (plus the company's own
// base currency if it is something else) and marks companies.currency as
// the single base currency.
function ensureCurrencies(db, companyId) {
  const company = db.prepare('SELECT currency FROM companies WHERE id = ?').get(companyId);
  if (!company) return;
  const base = String(company.currency || 'USD').toUpperCase();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO currencies (company_id, code, name, minor_unit_digits, is_base, is_active) VALUES (?, ?, ?, ?, 0, 1)'
  );
  for (const c of DEFAULT_CURRENCIES) insert.run(companyId, c.code, c.name, c.digits);
  if (!DEFAULT_CURRENCIES.some((c) => c.code === base)) insert.run(companyId, base, base, 2);
  const current = db.prepare('SELECT code FROM currencies WHERE company_id = ? AND is_base = 1').all(companyId);
  if (current.length !== 1 || current[0].code !== base) {
    db.prepare('UPDATE currencies SET is_base = CASE WHEN code = ? THEN 1 ELSE 0 END WHERE company_id = ?').run(base, companyId);
  }
}

function moneyError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// "1234.5" (digits=2) -> 123450. Accepts numbers or strings; rejects more
// decimals than the currency allows instead of silently rounding.
function toMinor(value, digits) {
  if (value === null || value === undefined || value === '') return 0;
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  s = s.replace(/,/g, '');
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw moneyError('مبلغ غير صالح');
    s = n.toFixed(Math.min(20, digits + 2));
  }
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) throw moneyError('مبلغ غير صالح');
  const neg = m[1] === '-';
  const intPart = m[2] || '0';
  let frac = (m[3] || '').replace(/0+$/, '');
  if (frac.length > digits) throw moneyError(`عدد المنازل العشرية أكبر من المسموح (${digits})`);
  frac = frac.padEnd(digits, '0');
  const minor = BigInt(intPart + frac);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw moneyError('المبلغ كبير جدًا');
  return Number(neg ? -minor : minor);
}

function fromMinor(minor, digits) {
  const neg = minor < 0;
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  const out = digits === 0 ? abs : `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  return neg ? `-${out}` : out;
}

// "13500.25" -> 13500250000 parts per million. Exact, no floats.
function rateToPpm(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m) throw moneyError('سعر صرف غير صالح');
  const ppm = Number(BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0')));
  if (ppm <= 0) throw moneyError('سعر صرف غير صالح');
  return ppm;
}

// Converts an amount in the line currency's minor units into base minor
// units: original * rate_ppm / 1e6 * 10^(baseDigits - lineDigits), rounded
// half away from zero, computed in BigInt.
function convertToBaseMinor(originalMinor, ratePpm, lineDigits, baseDigits) {
  let num = BigInt(originalMinor) * BigInt(ratePpm);
  let den = 1000000n;
  const diff = baseDigits - lineDigits;
  if (diff > 0) num *= 10n ** BigInt(diff);
  if (diff < 0) den *= 10n ** BigInt(-diff);
  const q = num / den;
  const r = num % den;
  return Number(r * 2n >= den ? q + 1n : q);
}

// Rounds a JS number (an existing REAL column, or qty * unit price) to
// integer minor units, half away from zero. The number is first read back
// at 15 significant digits — the precision a double actually carries — so
// binary noise such as 2.675 -> 2.67499999... does not flip the rounding.
function roundToMinor(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw moneyError('مبلغ غير صالح');
  let s = Math.abs(n).toPrecision(15);
  if (/e/.test(s)) s = Math.abs(n).toFixed(Math.min(digits + 6, 20));
  const [i, f = ''] = s.split('.');
  let minor = BigInt(i + f.slice(0, digits).padEnd(digits, '0'));
  if (f.length > digits && Number(f[digits]) >= 5) minor += 1n;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw moneyError('المبلغ كبير جدًا');
  return n < 0 ? -Number(minor) : Number(minor);
}

module.exports = { roundToMinor, DEFAULT_CURRENCIES, ensureCurrencies, toMinor, fromMinor, rateToPpm, convertToBaseMinor };
