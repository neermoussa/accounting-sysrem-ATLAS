const { chromium } = require('playwright');
const db = require('../db/init');

// No executablePath set by default on purpose — in production this
// resolves via Playwright's normal browser install, same convention as
// lib/pdfExport.js. PLAYWRIGHT_CHROMIUM_PATH only overrides this for a
// sandbox's pre-cached browser during development/testing.
const { getCompany } = require('./companies');
const { ATLAS_IDENTITY, PLATFORM_COLOR_PALETTE } = require('./documentTemplates');
const { getConfig: getNumberingConfig, format: formatDocumentNumber } = require('./documentNumbering');

const DEFAULT_COLOR = PLATFORM_COLOR_PALETTE[0].hex;

function getSelection(companyId, documentType) {
  const row = db
    .prepare('SELECT * FROM company_document_template_selections WHERE company_id = ? AND document_type = ?')
    .get(companyId, documentType);
  if (row) return row;
  // No selection made yet — every document type still renders, just with
  // the platform's own default layout/color, never a blank/broken page.
  return { company_id: companyId, document_type: documentType, template_source: 'platform', platform_template_key: 'classic', custom_template_id: null, brand_color: DEFAULT_COLOR };
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The one piece that's identical across every layout, every document type,
// and every company: the platform's own name/wordmark. Rendered as text
// (no bitmap logo asset exists in this codebase) but styled distinctly so
// it reads as a fixed brand mark, not company content — and it never reads
// any per-company data, so no customization path can ever remove or alter
// it.
function atlasFooterHtml() {
  return `<div class="atlas-footer">
    <span class="atlas-mark">${escapeHtml(ATLAS_IDENTITY.name)} <span class="atlas-mark-en">${escapeHtml(ATLAS_IDENTITY.nameEn)}</span></span>
    <span class="atlas-tagline">${escapeHtml(ATLAS_IDENTITY.tagline)}</span>
  </div>`;
}

function companyHeaderHtml(company, brandColor) {
  const logo = company.logo_url ? `<img class="company-logo" src="${escapeHtml(company.logo_url)}" alt="logo" />` : '';
  const contactBits = [company.contact_phone, company.contact_email, company.address].filter(Boolean).map(escapeHtml);
  return `<div class="company-header" style="border-color:${brandColor}">
    ${logo}
    <div class="company-info">
      <div class="company-name" style="color:${brandColor}">${escapeHtml(company.name)}</div>
      ${contactBits.length ? `<div class="company-contact">${contactBits.join(' — ')}</div>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------
// Per-document-type body builders. Each returns just the body HTML — the
// shared envelope (Atlas footer, company header, brand color, layout
// class) is applied once in buildDocumentHtml.
// ---------------------------------------------------------------------

function invoiceBody(data, brandColor, companyId) {
  const items = data.items || [];
  const rows = items
    .map(
      (it) =>
        `<tr><td>${escapeHtml(it.product_name)}</td><td>${escapeHtml(it.qty)}</td><td>${escapeHtml(it.unit_price ?? it.price ?? '—')}</td><td>${escapeHtml(it.line_total ?? '—')}</td></tr>`
    )
    .join('');
  // Customizable per-company numbering (spec item 5) — a stable format
  // (prefix + zero-padded width the company configured) applied to the
  // order's own id, so re-printing the same invoice always shows the same
  // number rather than issuing a fresh one each print.
  // Ledger sales documents (Prompt 2) already carry their issued number
  // (SI-/CN-) and may set their own title; order-based printing is unchanged.
  const docNumber = data.documentNumber || formatDocumentNumber(getNumberingConfig(companyId, 'invoice'), data.orderId);
  const extraTotals = (data.extraTotals || [])
    .map((t) => `<div class="meta-row"><span>${escapeHtml(t.label)}</span><span>${escapeHtml(t.value)}</span></div>`)
    .join('');
  return `<h1 style="color:${brandColor}">${escapeHtml(data.title || 'فاتورة')} ${escapeHtml(docNumber)}</h1>
    <div class="meta-row"><span>العميل: ${escapeHtml(data.shopName)}</span><span>التاريخ: ${escapeHtml(data.orderDate)}</span></div>
    <table><thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
    ${extraTotals}
    <div class="total-line" style="border-color:${brandColor}">الإجمالي الكلي: <strong>${escapeHtml(data.totalValue)}</strong></div>`;
}

function statementBody(data, brandColor) {
  return `<h1 style="color:${brandColor}">كشف حساب</h1>
    <div class="meta-row"><span>العميل: ${escapeHtml(data.shopName)}</span><span>بتاريخ: ${escapeHtml(data.balanceDate)}</span></div>
    <div class="total-line" style="border-color:${brandColor}">الرصيد الحالي: <strong>${escapeHtml(data.currentBalance)}</strong></div>`;
}

function deliveryNoteBody(data, brandColor) {
  const rows = (data.items || []).map((it) => `<tr><td>${escapeHtml(it.product_name)}</td><td>${escapeHtml(it.qty)}</td></tr>`).join('');
  // Customer's e-signature (spec item 5) — captured at delivery time
  // (order_deliveries.signature_data_url) and shown here when present;
  // never required, so an unsigned delivery note still renders fine.
  const signature = data.signatureDataUrl
    ? `<div class="signature-block"><div class="signature-label">توقيع الاستلام</div><img class="signature-img" src="${escapeHtml(data.signatureDataUrl)}" /></div>`
    : '';
  return `<h1 style="color:${brandColor}">سند تسليم #${escapeHtml(data.orderId)}</h1>
    <div class="meta-row"><span>العميل: ${escapeHtml(data.shopName)}</span><span>التاريخ: ${escapeHtml(data.orderDate)}</span></div>
    <table><thead><tr><th>الصنف</th><th>الكمية</th></tr></thead><tbody>${rows}</tbody></table>
    ${signature}`;
}

function receiptBody(data, brandColor, companyId) {
  const docNumber = formatDocumentNumber(getNumberingConfig(companyId, 'receipt'), data.collectionId);
  return `<h1 style="color:${brandColor}">إيصال قبض ${escapeHtml(docNumber)}</h1>
    <div class="meta-row"><span>العميل: ${escapeHtml(data.shopName)}</span><span>الطريقة: ${escapeHtml(data.method === 'cash' ? 'نقدًا' : 'حوالة')}</span></div>
    <div class="total-line" style="border-color:${brandColor}">المبلغ المستلم: <strong>${escapeHtml(data.amount)}</strong></div>`;
}

function reportBody(data, brandColor) {
  const columns = data.columns || [];
  const rows = data.rows || [];
  const head = columns.map((c) => `<th>${escapeHtml(c.header)}</th>`).join('');
  const body = rows.map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('');
  return `<h1 style="color:${brandColor}">${escapeHtml(data.title || 'تقرير')}</h1>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function whatsappMessageBody(data, brandColor) {
  return `<h1 style="color:${brandColor}">معاينة رسالة واتساب</h1>
    <div class="wa-bubble" style="border-color:${brandColor}">${escapeHtml(data.message)}</div>`;
}

// Certificate of analysis (Prompt 9): one produced lot, its quality checks
// against specification, and the allergen declaration.
function coaBody(data, brandColor) {
  const rows = (data.checks || []).map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.spec)}</td><td>${escapeHtml(c.result)}</td><td>${c.passed === 1 ? '✓' : c.passed === 0 ? '✗' : '—'}</td></tr>`).join('');
  return `<h1 style="color:${brandColor}">شهادة تحليل — ${escapeHtml(data.productName)}</h1>
    <div class="meta-row"><span>الدفعة: ${escapeHtml(data.lotCode)}</span><span>تاريخ الإنتاج: ${escapeHtml(data.productionDate)}</span><span>الصلاحية: ${escapeHtml(data.expiryDate || '—')}</span><span>أمر الإنتاج: ${escapeHtml(data.orderNumber)}</span></div>
    <table><thead><tr><th>الفحص</th><th>المواصفة</th><th>النتيجة</th><th>مطابق</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="total-line" style="border-color:${brandColor}">${escapeHtml(data.allergens || '')}</div>`;
}

const BODY_BUILDERS = {
  coa: coaBody,
  invoice: invoiceBody,
  statement: statementBody,
  delivery_note: deliveryNoteBody,
  receipt: receiptBody,
  report: reportBody,
  whatsapp_message: whatsappMessageBody,
};

function buildDocumentHtml(companyId, documentType, data, { thermal = false } = {}) {
  const company = getCompany(companyId);
  const selection = getSelection(companyId, documentType);
  const brandColor = selection.brand_color || DEFAULT_COLOR;
  const layoutKey = selection.template_source === 'platform' ? selection.platform_template_key || 'classic' : 'classic';
  const bodyBuilder = BODY_BUILDERS[documentType];
  if (!bodyBuilder) throw Object.assign(new Error('invalid_document_type'), { status: 400 });

  const layoutClass = (layoutKey === 'modern' ? 'layout-modern' : 'layout-classic') + (thermal ? ' layout-thermal' : '');

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Tajawal', 'Segoe UI', Arial, sans-serif; padding: 28px; direction: rtl; color: #142018; }
  .company-header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid; padding-bottom: 14px; margin-bottom: 18px; }
  .company-logo { max-height: 56px; max-width: 140px; object-fit: contain; }
  .company-name { font-size: 20px; font-weight: 700; }
  .company-contact { font-size: 11px; color: #5c6e63; margin-top: 2px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  .meta-row { display: flex; gap: 20px; font-size: 12px; color: #5c6e63; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 14px; }
  th, td { border: 1px solid #d8e2dc; padding: 7px 10px; text-align: right; }
  th { background: #f1f5f2; font-weight: 700; }
  .total-line { border-top: 2px solid; padding-top: 10px; font-size: 14px; }
  .wa-bubble { background: #eafbe7; border: 1px solid; border-radius: 10px; padding: 12px; max-width: 320px; }
  .signature-block { margin-top: 20px; }
  .signature-label { font-size: 11px; color: #5c6e63; margin-bottom: 6px; }
  .signature-img { max-height: 80px; border-bottom: 1px solid #d8e2dc; }
  .layout-modern .company-header { flex-direction: row-reverse; text-align: left; }
  .layout-modern table th { background: #142018; color: #fff; }
  .atlas-footer { margin-top: 40px; padding-top: 10px; border-top: 1px dashed #c8d2cb; display: flex; justify-content: space-between; font-size: 10px; color: #8a978f; }
  .atlas-mark { font-weight: 700; color: #142018; }
  .atlas-mark-en { font-weight: 400; opacity: 0.7; }
  /* Thermal printer layout (spec item 5): a single narrow column sized for
     58/80mm receipt paper — the page width itself is set on the PDF (see
     renderDocumentPdf's width:'80mm'), this just tightens spacing/fonts
     and drops the two-column meta row so nothing gets clipped. */
  .layout-thermal body, body.layout-thermal { padding: 8px; font-size: 11px; }
  .layout-thermal .company-header { flex-direction: column; align-items: flex-start; gap: 4px; }
  .layout-thermal .meta-row { flex-direction: column; gap: 4px; }
  .layout-thermal table { font-size: 10px; }
  .layout-thermal th, .layout-thermal td { padding: 3px 4px; }
  .layout-thermal .atlas-footer { flex-direction: column; gap: 2px; margin-top: 16px; }
</style>
</head>
<body class="${layoutClass}">
  ${companyHeaderHtml(company, brandColor)}
  ${bodyBuilder(data, brandColor, companyId)}
  ${atlasFooterHtml()}
</body>
</html>`;
}

async function renderDocumentPdf(companyId, documentType, data, { thermal = false } = {}) {
  const html = buildDocumentHtml(companyId, documentType, data, { thermal });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf(
      thermal
        ? { width: '80mm', margin: { top: '4mm', bottom: '4mm', left: '3mm', right: '3mm' } }
        : { format: 'A4', margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } }
    );
  } finally {
    await browser.close();
  }
}

module.exports = { getSelection, buildDocumentHtml, renderDocumentPdf };
