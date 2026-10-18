// Fuzzy name matching for the physical stock count (jard) feature — the
// uploaded sheet's material names are handwritten/typed independently of
// the app's own product-master spelling, so exact string equality would
// reject perfectly valid rows over one missing space or an alef/hamza
// variant. Normalizes common Arabic spelling variation, then falls back to
// a Levenshtein-distance similarity score for anything not already exact.
const ARABIC_DIACRITICS = /[ً-ْٰـ]/g;

function normalizeArabic(str) {
  return String(str || '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[n];
}

function similarity(a, b) {
  const na = normalizeArabic(a);
  const nb = normalizeArabic(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

// Below this score, the row is left unmatched for a human to resolve rather
// than silently attached to the wrong item.
const MATCH_THRESHOLD = 0.72;

function matchItemName(name, existingItems) {
  let best = null;
  let bestScore = 0;
  for (const item of existingItems) {
    const score = similarity(name, item.item_name);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (best && bestScore >= MATCH_THRESHOLD) return { item: best, score: bestScore };
  return null;
}

// Default "minor vs. major" variance boundary, as a percentage of the
// expected (system) quantity. Kept as one constant rather than a setting
// for now — easy to promote to a per-warehouse setting later.
const MINOR_VARIANCE_PCT = 5;

function classifyVariance(expectedQuantity, countedQuantity) {
  if (expectedQuantity === null || expectedQuantity === undefined) {
    return { variance: null, variancePct: null, classification: 'unmatched' };
  }
  const variance = countedQuantity - expectedQuantity;
  const variancePct =
    expectedQuantity === 0 ? (countedQuantity === 0 ? 0 : 100) : (Math.abs(variance) / expectedQuantity) * 100;
  let classification;
  if (Math.abs(variance) < 0.005) classification = 'matched';
  else if (variancePct < MINOR_VARIANCE_PCT) classification = 'minor';
  else classification = 'major';
  return { variance, variancePct, classification };
}

module.exports = { normalizeArabic, similarity, matchItemName, classifyVariance, MATCH_THRESHOLD, MINOR_VARIANCE_PCT };
