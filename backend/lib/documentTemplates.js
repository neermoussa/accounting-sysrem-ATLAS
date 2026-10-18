// Fixed catalog: every "ready-made" layout a company can pick from, per
// document type, plus the platform's own fixed color palette. Deliberately
// NOT company-editable data — spec item 3 is explicit that this stage is
// "pick from what's available", not free-form design. A company's only
// custom-design path is the upload-for-review flow (document_templates
// table / routes/companies.js + routes/platformAdmin.js).

const DOCUMENT_TYPES = ['invoice', 'statement', 'delivery_note', 'receipt', 'report', 'whatsapp_message', 'coa'];

const DOCUMENT_TYPE_LABELS = {
  invoice: 'فاتورة',
  statement: 'كشف حساب',
  delivery_note: 'سند تسليم',
  receipt: 'إيصال قبض',
  report: 'تقرير',
  whatsapp_message: 'رسالة واتساب',
  coa: 'شهادة تحليل',
};

// Two layout options per type is enough to prove "independent templates,
// pick one" without pretending this stage offers a full design library —
// each key maps to a real, distinct layout in lib/documentRenderer.js.
const PLATFORM_TEMPLATES = Object.fromEntries(
  DOCUMENT_TYPES.map((type) => [
    type,
    [
      { key: 'classic', name: 'كلاسيكي' },
      { key: 'modern', name: 'عصري' },
    ],
  ])
);

const PLATFORM_COLOR_PALETTE = [
  { key: 'green', hex: '#0B6E4F' },
  { key: 'blue', hex: '#0EA5E9' },
  { key: 'purple', hex: '#7C3AED' },
  { key: 'orange', hex: '#F97316' },
  { key: 'red', hex: '#DC2626' },
  { key: 'slate', hex: '#334155' },
];

// The platform's own identity — fixed, never a per-company setting, never
// hidden by a company's customization (spec item 1/2 of this feature).
const ATLAS_IDENTITY = {
  name: 'أطلس',
  nameEn: 'Atlas',
  tagline: 'منصّة أطلس لإدارة المبيعات والتوزيع',
};

function isValidDocumentType(type) {
  return DOCUMENT_TYPES.includes(type);
}

function isValidPlatformTemplateKey(documentType, key) {
  return (PLATFORM_TEMPLATES[documentType] || []).some((t) => t.key === key);
}

function isValidBrandColor(hex) {
  return PLATFORM_COLOR_PALETTE.some((c) => c.hex.toLowerCase() === String(hex || '').toLowerCase());
}

module.exports = {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  PLATFORM_TEMPLATES,
  PLATFORM_COLOR_PALETTE,
  ATLAS_IDENTITY,
  isValidDocumentType,
  isValidPlatformTemplateKey,
  isValidBrandColor,
};
