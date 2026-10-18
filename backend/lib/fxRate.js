// backend/lib/fxRate.js
//
// Exchange rates and conversion, exact.
//
// Storage: a rate is an INTEGER `rate_e8` (rate x 10^8) plus a `quote`:
//   'base_per_foreign'  -> 1 foreign unit = rate base units   (EUR line, SYP base: 14000.5)
//   'foreign_per_base'  -> 1 base unit    = rate foreign units (SYP line, USD base: 13500.25)
// The quote is chosen so the rate is >= 1: the direction with the most
// significant digits (SYP per 1 USD, never USD per 1 SYP = 0.0000740...).
// Rates below 1 are refused with a message naming the other direction.
//
// Conversion is done once, in BigInt: base = original x rate (or / rate),
// scaled for the two currencies' minor digits, rounded half away from zero
// at the very end. Results must stay JS-safe integers (node:sqlite reads
// INTEGER as Number).

const SCALE = 100000000n; // 1e8
const SCALE_DIGITS = 8;
const QUOTES = ['base_per_foreign', 'foreign_per_base'];
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

class FxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

// "13500.25" -> 1350025000000n (x1e8). Up to 8 decimals, no floats.
function parseRateE8(value) {
  const s = String(value ?? '').trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new FxError('invalid_rate', 'سعر صرف غير صالح');
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > SCALE_DIGITS) throw new FxError('invalid_rate', `سعر الصرف يقبل ${SCALE_DIGITS} منازل عشرية كحد أقصى`);
  const e8 = BigInt(m[1]) * SCALE + BigInt(frac.padEnd(SCALE_DIGITS, '0') || '0');
  if (e8 <= 0n) throw new FxError('invalid_rate', 'سعر صرف غير صالح');
  if (e8 > MAX_SAFE) throw new FxError('invalid_rate', 'سعر الصرف كبير جدًا');
  return e8;
}

// Validated { rateE8: Number, quote } from user input. Rejects rate < 1.
function parseRate(value, quote = 'base_per_foreign', { foreign, base } = {}) {
  if (!QUOTES.includes(quote)) throw new FxError('invalid_rate_quote', 'اتجاه سعر الصرف غير صالح');
  const e8 = parseRateE8(value);
  if (e8 < SCALE) {
    const other = quote === 'base_per_foreign'
      ? `${foreign || 'العملة الأجنبية'} لكل 1 ${base || 'عملة أساسية'}`
      : `${base || 'العملة الأساسية'} لكل 1 ${foreign || 'عملة أجنبية'}`;
    throw new FxError('rate_below_one', `سعر الصرف أقل من 1 — أدخله بالاتجاه الآخر (${other}) للحفاظ على الدقة`);
  }
  return { rateE8: Number(e8), quote };
}

function formatRate(rateE8) {
  const s = String(rateE8).padStart(SCALE_DIGITS + 1, '0');
  const int = s.slice(0, -SCALE_DIGITS);
  const frac = s.slice(-SCALE_DIGITS).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function roundDiv(num, den) {
  // half away from zero; num, den BigInt, den > 0
  const neg = num < 0n;
  const a = neg ? -num : num;
  let q = a / den;
  if ((a % den) * 2n >= den) q += 1n;
  return neg ? -q : q;
}

// original (line-currency minor units) -> base minor units.
function toBaseMinor(originalMinor, rateE8, quote, lineDigits, baseDigits) {
  let num = BigInt(originalMinor);
  let den = 1n;
  if (quote === 'foreign_per_base') {
    num *= SCALE;
    den *= BigInt(rateE8);
  } else {
    num *= BigInt(rateE8);
    den *= SCALE;
  }
  const diff = baseDigits - lineDigits;
  if (diff > 0) num *= 10n ** BigInt(diff);
  if (diff < 0) den *= 10n ** BigInt(-diff);
  const out = roundDiv(num, den);
  if (out > MAX_SAFE || out < -MAX_SAFE) throw new FxError('amount_too_large', 'المبلغ بعد التحويل كبير جدًا');
  return Number(out);
}

// base minor -> line-currency minor (for revaluation / settlement maths).
function fromBaseMinor(baseMinor, rateE8, quote, lineDigits, baseDigits) {
  return toBaseMinor(baseMinor, rateE8, quote === 'foreign_per_base' ? 'base_per_foreign' : 'foreign_per_base', baseDigits, lineDigits);
}

// The legacy ppm column (base per 1 foreign, x1e6) kept for old readers.
function legacyPpm(rateE8, quote) {
  const r = quote === 'base_per_foreign' ? roundDiv(BigInt(rateE8), 100n) : roundDiv(SCALE * 1000000n, BigInt(rateE8));
  return Number(r > 0n ? r : 1n);
}

module.exports = { SCALE, SCALE_DIGITS, QUOTES, FxError, parseRateE8, parseRate, formatRate, toBaseMinor, fromBaseMinor, legacyPpm, roundDiv };
