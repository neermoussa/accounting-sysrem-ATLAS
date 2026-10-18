const { normalizePhone } = require('./phone');
const { findShopByPhone } = require('./shopLookup');
const { isValidCoordPair } = require('./geo');

const COLUMN_ALIASES = {
  name: ['اسم المحل', 'الاسم', 'اسم', 'name', 'shop name'],
  phone: ['رقم الهاتف', 'الهاتف', 'هاتف', 'phone', 'phone number'],
  lat: ['خط العرض', 'lat', 'latitude'],
  lng: ['خط الطول', 'lng', 'lon', 'long', 'longitude'],
  address: ['عنوان نصي', 'العنوان', 'عنوان', 'address'],
  notes: ['ملاحظات', 'notes', 'note'],
};

// Matches the uploaded file's header row to the fields we need, by exact
// (trimmed, case-insensitive) label match against known Arabic/English names —
// this file's columns are dictated by the app's own template, unlike the
// Amin report (a 3rd-party export), so a lighter match is enough here.
function matchColumns(header) {
  const normalized = header.map((h) => String(h || '').trim().toLowerCase());
  const indices = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    indices[field] = idx === -1 ? null : idx;
  }
  return indices;
}

function parseCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// seenPhones: Set of normalized phones already seen earlier in this same
// upload, so two new rows can't create duplicate shops of each other either.
//
// Coordinates are optional here, matching the manual "add shop" form
// (routes/shops.js POST /) exactly: a shop imported without a location is a
// completely normal outcome, not an error — it's just excluded from the map
// and day-plan route until someone sets its location later, the same as any
// hand-added shop with no pin yet. Requiring lat/lng at import time used to
// mean a realistic shop list (name/phone/address only, no GPS data on hand)
// got every single row silently skipped at commit.
function validateRow(row, seenPhones) {
  const reasons = [];
  const name = (row.name || '').toString().trim();
  const phoneRaw = (row.phone || '').toString().trim();
  const normalizedPhone = normalizePhone(phoneRaw);
  const latProvided = row.lat !== null && row.lat !== undefined && row.lat !== '';
  const lngProvided = row.lng !== null && row.lng !== undefined && row.lng !== '';
  const lat = parseCoord(row.lat);
  const lng = parseCoord(row.lng);

  if (!name) reasons.push('الاسم مفقود');
  if (!phoneRaw) reasons.push('رقم الهاتف مفقود');
  if (latProvided || lngProvided) {
    // Either both coordinates parse as real numbers, or the row is treated
    // as "no location given" — a half-filled pair is the only coordinate
    // case worth flagging, since it's ambiguous rather than simply absent.
    if (lat === null || lng === null) {
      reasons.push('الإحداثيات غير مكتملة — إما أدخل خط العرض وخط الطول معًا أو اتركهما فاضيين');
    } else if (!isValidCoordPair(lat, lng)) {
      reasons.push('الإحداثيات خارج النطاق الجغرافي المنطقي');
    }
  }

  if (normalizedPhone) {
    const existing = findShopByPhone(normalizedPhone);
    if (existing) reasons.push(`رقم الهاتف مستخدم لمحل موجود: ${existing.name}`);
    else if (seenPhones.has(normalizedPhone)) reasons.push('رقم مكرر ضمن نفس الملف');
  }

  if (normalizedPhone) seenPhones.add(normalizedPhone);

  return {
    name,
    phone: phoneRaw,
    lat,
    lng,
    address: (row.address || '').toString().trim() || null,
    notes: (row.notes || '').toString().trim() || null,
    status: reasons.length ? 'needs_review' : 'ok',
    reasons,
  };
}

module.exports = { matchColumns, validateRow };
