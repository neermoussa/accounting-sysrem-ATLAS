const COLUMN_ALIASES = {
  item_name: ['اسم الصنف', 'الصنف', 'اسم', 'item name', 'item', 'name'],
  min_quantity: ['الحد الأدنى', 'حد أدنى', 'min quantity', 'min', 'minimum'],
};

function matchColumns(header) {
  const normalized = header.map((h) => String(h || '').trim().toLowerCase());
  const indices = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    indices[field] = idx === -1 ? null : idx;
  }
  return indices;
}

// existingNames: Set of existing item names (lowercased) already in this
// warehouse's table — a match means "edit this item's threshold", not a
// rejected duplicate, since the file is explicitly allowed to both add new
// items and update existing ones' minimums.
// seenNames: names already seen earlier in this same upload.
function validateRow(row, existingNames, seenNames) {
  const reasons = [];
  const name = (row.item_name || '').toString().trim();
  const minRaw = row.min_quantity;
  const minQuantity = minRaw === null || minRaw === undefined || minRaw === '' ? null : Number(minRaw);

  if (!name) reasons.push('اسم الصنف مفقود');
  if (minQuantity === null || !Number.isFinite(minQuantity) || minQuantity < 0) {
    reasons.push('الحد الأدنى مفقود أو غير صحيح');
  }

  const key = name.toLowerCase();
  let action = 'create';
  if (name) {
    if (seenNames.has(key)) reasons.push('صنف مكرر ضمن نفس الملف');
    else if (existingNames.has(key)) action = 'update';
    seenNames.add(key);
  }

  return {
    item_name: name,
    min_quantity: minQuantity,
    action,
    status: reasons.length ? 'needs_review' : 'ok',
    reasons,
  };
}

module.exports = { matchColumns, validateRow };
