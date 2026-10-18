const COLUMN_ALIASES = {
  name: ['اسم المادة', 'اسم الصنف', 'الاسم', 'name', 'product name'],
  amin_code: ['رمز الأمين', 'الرمز', 'كود', 'code', 'amin code'],
  box_weight_grams: ['وزن العلبة بالغرام', 'وزن العلبة', 'box weight', 'box weight grams'],
};

// Same lightweight exact-label matching as shopImportValidation — this
// file's columns are dictated by the app's own template, not a 3rd-party
// export, so no fuzzy matching is needed.
function matchColumns(header) {
  const normalized = header.map((h) => String(h || '').trim().toLowerCase());
  const indices = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    indices[field] = idx === -1 ? null : idx;
  }
  return indices;
}

function parseWeight(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : NaN; // NaN signals "provided but invalid"
}

// existingByName: Map of lowercased name -> product row, for the upsert
// decision (create vs. update) and to avoid a second in-file duplicate
// racing to create the same product twice.
function validateRow(row, existingByName, seenNames) {
  const reasons = [];
  const name = (row.name || '').toString().trim();
  const aminCode = (row.amin_code || '').toString().trim() || null;
  const boxWeight = parseWeight(row.box_weight_grams);

  if (!name) reasons.push('اسم المادة مفقود');
  if (Number.isNaN(boxWeight)) reasons.push('وزن العلبة يجب أن يكون رقمًا موجبًا');

  const lower = name.toLowerCase();
  if (name && seenNames.has(lower)) reasons.push('اسم مكرر ضمن نفس الملف');
  if (name) seenNames.add(lower);

  const existing = name ? existingByName.get(lower) : null;

  return {
    name,
    amin_code: aminCode,
    box_weight_grams: Number.isNaN(boxWeight) ? null : boxWeight,
    action: existing ? 'update' : 'create',
    productId: existing ? existing.id : null,
    status: reasons.length ? 'needs_review' : 'ok',
    reasons,
  };
}

module.exports = { matchColumns, validateRow };
