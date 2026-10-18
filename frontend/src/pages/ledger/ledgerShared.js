// Helpers shared by the ledger screens. Money stays in integer minor units
// (BigInt maths, no floats) — the same rules as backend/lib/ledgerCurrencies.js;
// the server re-validates everything, these only drive the live totals.

export function toMinorOrNull(value, digits) {
  const s = String(value ?? '').trim().replace(/,/g, '');
  if (s === '') return 0;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > digits) return null;
  return Number(BigInt((m[1] || '0') + frac.padEnd(digits, '0')));
}

// Rates: x1e8 integers in their most-significant direction (rate >= 1),
// quote 'base_per_foreign' | 'foreign_per_base' — backend/lib/fxRate.js.
export function rateE8OrNull(value) {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(String(value ?? '').trim().replace(/,/g, ''));
  if (!m) return null;
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > 8) return null;
  const e8 = BigInt(m[1]) * 100000000n + BigInt(frac.padEnd(8, '0') || '0');
  return e8 >= 100000000n ? e8 : null; // < 1: enter it in the other direction
}

export function convertToBaseMinor(originalMinor, rateE8, quote, lineDigits, baseDigits) {
  let num = BigInt(originalMinor);
  let den = 1n;
  if (quote === 'foreign_per_base') { num *= 100000000n; den *= BigInt(rateE8); } else { num *= BigInt(rateE8); den *= 100000000n; }
  const diff = baseDigits - lineDigits;
  if (diff > 0) num *= 10n ** BigInt(diff);
  if (diff < 0) den *= 10n ** BigInt(-diff);
  const q = num / den;
  return Number((num % den) * 2n >= den ? q + 1n : q);
}

export function formatMinor(minor, digits = 2) {
  const n = Number(minor || 0);
  const neg = n < 0;
  const abs = String(Math.abs(n)).padStart(digits + 1, '0');
  const intPart = digits ? abs.slice(0, -digits) : abs;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = digits ? `${grouped}.${abs.slice(-digits)}` : grouped;
  return neg ? `-${out}` : out;
}

export function ledgerError(err, t) {
  if (!err) return null;
  const code = err?.detail?.error;
  const key = `ledger.error.${code}`;
  if (code && t(key) !== key) return t(key);
  return err?.detail?.message || code || t('ledger.error.generic');
}

export function accountLabel(a) {
  return a ? `${a.code} — ${a.name_ar}` : '';
}

// Separation of duties (purchasing / payments / treasury): when the server
// refuses because the same person did both steps and offers the owner a
// break-glass, ask for the written reason and retry once with it.
export async function withBreakGlass(t, call) {
  try {
    return await call({});
  } catch (err) {
    if (err?.detail?.break_glass_available) {
      const reason = window.prompt(`${err.detail.message}\n\n${t('sod.breakGlassPrompt')}`);
      if (reason && reason.trim()) return call({ breakGlassReason: reason.trim() });
    }
    throw err;
  }
}
