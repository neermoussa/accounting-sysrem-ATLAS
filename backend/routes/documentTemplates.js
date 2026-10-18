const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  PLATFORM_TEMPLATES,
  PLATFORM_COLOR_PALETTE,
  isValidDocumentType,
  isValidPlatformTemplateKey,
  isValidBrandColor,
} = require('../lib/documentTemplates');
const { getSelection, renderDocumentPdf, buildDocumentHtml } = require('../lib/documentRenderer');
const { getConfig: getNumberingConfig, setConfig: setNumberingConfig } = require('../lib/documentNumbering');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// Catalog + current selections
// ---------------------------------------------------------------------

router.get('/catalog', (req, res) => {
  res.json({
    documentTypes: DOCUMENT_TYPES.map((t) => ({ key: t, label: DOCUMENT_TYPE_LABELS[t] })),
    platformTemplates: PLATFORM_TEMPLATES,
    colorPalette: PLATFORM_COLOR_PALETTE,
  });
});

router.get('/selections', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json(Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, getSelection(req.companyId, t)])));
});

// Choosing a platform layout + a palette color, OR an already-approved
// custom upload — never a free color/layout, per spec item 3.
router.put('/selections/:documentType', requirePermission('manage_settings'), (req, res) => {
  const { documentType } = req.params;
  if (!isValidDocumentType(documentType)) return res.status(400).json({ error: 'invalid_document_type' });
  const { templateSource, platformTemplateKey, customTemplateId, brandColor } = req.body || {};

  if (!isValidBrandColor(brandColor)) return res.status(400).json({ error: 'invalid_brand_color' });

  if (templateSource === 'platform') {
    if (!isValidPlatformTemplateKey(documentType, platformTemplateKey)) {
      return res.status(400).json({ error: 'invalid_platform_template_key' });
    }
    db.prepare(
      `INSERT INTO company_document_template_selections (company_id, document_type, template_source, platform_template_key, custom_template_id, brand_color)
       VALUES (?, ?, 'platform', ?, NULL, ?)
       ON CONFLICT(company_id, document_type) DO UPDATE SET template_source = 'platform', platform_template_key = excluded.platform_template_key, custom_template_id = NULL, brand_color = excluded.brand_color, updated_at = datetime('now')`
    ).run(req.companyId, documentType, platformTemplateKey, brandColor);
  } else if (templateSource === 'custom') {
    const custom = db
      .prepare("SELECT * FROM document_templates WHERE id = ? AND company_id = ? AND document_type = ? AND status = 'approved'")
      .get(customTemplateId, req.companyId, documentType);
    if (!custom) return res.status(400).json({ error: 'custom_template_not_approved_or_not_found' });
    db.prepare(
      `INSERT INTO company_document_template_selections (company_id, document_type, template_source, platform_template_key, custom_template_id, brand_color)
       VALUES (?, ?, 'custom', NULL, ?, ?)
       ON CONFLICT(company_id, document_type) DO UPDATE SET template_source = 'custom', platform_template_key = NULL, custom_template_id = excluded.custom_template_id, brand_color = excluded.brand_color, updated_at = datetime('now')`
    ).run(req.companyId, documentType, custom.id, brandColor);
  } else {
    return res.status(400).json({ error: 'invalid_template_source' });
  }

  res.json(getSelection(req.companyId, documentType));
});

// ---------------------------------------------------------------------
// Rendering — real per-company data pulled server-side (never trusted
// from the client for invoice/delivery-note/receipt/statement), styled by
// that company's current selection for the document type.
// ---------------------------------------------------------------------

function sendPdf(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="doc.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.end(buffer);
}

function respondRenderedOptions(req) {
  return { thermal: req.query.thermal === '1' };
}

async function respondRendered(req, res, documentType, data, filename) {
  const options = respondRenderedOptions(req);
  if (req.query.format === 'html') {
    res.type('html').send(buildDocumentHtml(req.companyId, documentType, data, options));
    return;
  }
  const buffer = await renderDocumentPdf(req.companyId, documentType, data, options);
  sendPdf(res, buffer, filename);
}

router.get('/render/invoice/:orderId', requireAnyPermission('view_app', 'add_orders'), async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL').get(req.params.orderId, req.companyId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(order.shop_id);
  const data = {
    orderId: order.id,
    orderDate: order.order_date,
    shopName: shop?.name || '—',
    items: JSON.parse(order.items_json || '[]'),
    totalValue: Math.round(order.total_value).toLocaleString('ar'),
  };
  try {
    await respondRendered(req, res, 'invoice', data, `invoice-${order.id}.pdf`);
  } catch (err) {
    console.error('[documentTemplates] invoice render failed:', err.message);
    res.status(500).json({ error: 'render_failed' });
  }
});

router.get('/render/delivery-note/:orderId', requireAnyPermission('view_app', 'record_deliveries'), async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL').get(req.params.orderId, req.companyId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(order.shop_id);
  const delivery = db.prepare('SELECT signature_data_url FROM order_deliveries WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(order.id);
  const data = {
    orderId: order.id,
    orderDate: order.order_date,
    shopName: shop?.name || '—',
    items: JSON.parse(order.items_json || '[]'),
    signatureDataUrl: delivery?.signature_data_url || null,
  };
  try {
    await respondRendered(req, res, 'delivery_note', data, `delivery-note-${order.id}.pdf`);
  } catch (err) {
    console.error('[documentTemplates] delivery-note render failed:', err.message);
    res.status(500).json({ error: 'render_failed' });
  }
});

router.get('/render/receipt/:collectionId', requireAnyPermission('view_app', 'record_collections', 'confirm_collections'), async (req, res) => {
  const collection = db.prepare('SELECT * FROM collections WHERE id = ? AND company_id = ?').get(req.params.collectionId, req.companyId);
  if (!collection) return res.status(404).json({ error: 'collection_not_found' });
  const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(collection.shop_id);
  const data = { collectionId: collection.id, shopName: shop?.name || '—', method: collection.method, amount: Math.round(collection.amount).toLocaleString('ar') };
  try {
    await respondRendered(req, res, 'receipt', data, `receipt-${collection.id}.pdf`);
  } catch (err) {
    console.error('[documentTemplates] receipt render failed:', err.message);
    res.status(500).json({ error: 'render_failed' });
  }
});

router.get('/render/statement/:shopId', requireAnyPermission('view_app', 'view_statistics'), async (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const latest = db.prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shop.id);
  const data = { shopName: shop.name, currentBalance: latest ? Math.round(latest.balance).toLocaleString('ar') : '0', balanceDate: latest?.report_date || '—' };
  try {
    await respondRendered(req, res, 'statement', data, `statement-${shop.id}.pdf`);
  } catch (err) {
    console.error('[documentTemplates] statement render failed:', err.message);
    res.status(500).json({ error: 'render_failed' });
  }
});

router.post('/render/report', requirePermission('view_statistics'), async (req, res) => {
  const { title, columns, rows } = req.body || {};
  if (!Array.isArray(columns) || !Array.isArray(rows)) return res.status(400).json({ error: 'columns_and_rows_required' });
  try {
    await respondRendered(req, res, 'report', { title, columns, rows }, 'report.pdf');
  } catch (err) {
    console.error('[documentTemplates] report render failed:', err.message);
    res.status(500).json({ error: 'render_failed' });
  }
});

router.post('/render/whatsapp-message', requireAnyPermission('view_app', 'manage_settings'), async (req, res) => {
  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message_required' });
  try {
    await respondRendered(req, res, 'whatsapp_message', { message }, 'whatsapp-message.pdf');
  } catch (err) {
    console.error('[documentTemplates] whatsapp-message render failed:', err.message);
    res.status(500).json({ error: 'render_failed' });
  }
});

// ---------------------------------------------------------------------
// Custom template upload — captured here for company visibility; the
// actual submission endpoint (with document_type) lives in
// routes/companies.js's existing document-templates route, extended to
// require it. Review/approve/reject stays in routes/platformAdmin.js's
// generic reviewQueue('document_templates').
// ---------------------------------------------------------------------

// Customizable document numbering (spec item 5) — prefix + zero-padding
// width per company/document type.
router.get('/numbering/:documentType', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  if (!isValidDocumentType(req.params.documentType)) return res.status(400).json({ error: 'invalid_document_type' });
  res.json(getNumberingConfig(req.companyId, req.params.documentType));
});

router.put('/numbering/:documentType', requirePermission('manage_settings'), (req, res) => {
  if (!isValidDocumentType(req.params.documentType)) return res.status(400).json({ error: 'invalid_document_type' });
  const { prefix, padding, nextNumber } = req.body || {};
  res.json(setNumberingConfig(req.companyId, req.params.documentType, { prefix, padding, nextNumber }));
});

router.get('/custom', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  res.json(db.prepare('SELECT * FROM document_templates WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId));
});

module.exports = router;
