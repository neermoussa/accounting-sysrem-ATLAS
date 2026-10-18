const db = require('../db/init');
const { normalizePhone } = require('./phone');

// Same normalize-then-Levenshtein-similarity approach as
// lib/inventoryCountMatch.js's material-name matching, applied here to shop
// names instead — duplicate customer records are usually the same
// spelling/typo problem (extra space, alef/hamza variant) rather than two
// genuinely different names.
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

function nameSimilarity(a, b) {
  const na = normalizeArabic(a);
  const nb = normalizeArabic(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

const NAME_MATCH_THRESHOLD = 0.72;

// A pair counts as a likely duplicate when either their phones normalize to
// the same digits, or their names are similar enough — phone match alone is
// strong evidence even with an unrelated name (e.g. a re-typed shop name),
// and name match alone is strong evidence even with no phone at all.
function findDuplicateGroups(companyId) {
  if (!companyId) throw new Error('findDuplicateGroups requires a companyId');
  const shops = db.prepare('SELECT * FROM shops WHERE company_id = ? AND active = 1').all(companyId);
  const allPhonesByShop = new Map();
  const phoneRows = db
    .prepare(
      `SELECT sp.shop_id, sp.phone FROM shop_phones sp
       JOIN shops s ON s.id = sp.shop_id WHERE s.company_id = ?`
    )
    .all(companyId);
  for (const row of phoneRows) {
    if (!allPhonesByShop.has(row.shop_id)) allPhonesByShop.set(row.shop_id, new Set());
    allPhonesByShop.get(row.shop_id).add(normalizePhone(row.phone));
  }
  for (const s of shops) {
    if (s.phone) {
      if (!allPhonesByShop.has(s.id)) allPhonesByShop.set(s.id, new Set());
      allPhonesByShop.get(s.id).add(normalizePhone(s.phone));
    }
  }

  const pairs = [];
  for (let i = 0; i < shops.length; i++) {
    for (let j = i + 1; j < shops.length; j++) {
      const a = shops[i];
      const b = shops[j];
      const phonesA = allPhonesByShop.get(a.id) || new Set();
      const phonesB = allPhonesByShop.get(b.id) || new Set();
      const phoneMatch = [...phonesA].some((p) => p && phonesB.has(p));
      const score = nameSimilarity(a.name, b.name);
      if (phoneMatch || score >= NAME_MATCH_THRESHOLD) {
        pairs.push({
          shopA: { id: a.id, name: a.name, phone: a.phone },
          shopB: { id: b.id, name: b.name, phone: b.phone },
          reason: phoneMatch ? 'phone_match' : 'name_match',
          score: phoneMatch ? Math.max(score, 0.99) : score,
        });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

module.exports = { normalizeArabic, nameSimilarity, findDuplicateGroups, NAME_MATCH_THRESHOLD };
