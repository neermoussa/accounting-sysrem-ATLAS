const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const db = require('../db/init');
const { requirePermission } = require('../middleware/auth');
const { createNotification } = require('../lib/notify');
const { reconcileShopDay } = require('../lib/reconciliation');
const { recomputeShopClassification } = require('../lib/classification');
const { getGlobalSettings } = require('../lib/shopData');
const { addSheet, sendWorkbook, langFromQuery } = require('../lib/xlsxExport');
const { sendTablePdf } = require('../lib/pdfExport');
const { sendToCustomer } = require('../lib/whatsapp');

const INVOICE_DAY_COLUMNS = [
  { header: 'المحل', headerEn: 'Shop', key: 'shopName', width: 26 },
  { header: 'الوقت', headerEn: 'Time', key: 'time', width: 18 },
  { header: 'المبلغ الإجمالي', headerEn: 'Total amount', key: 'total', width: 16 },
  { header: 'عدد الأصناف', headerEn: 'Item count', key: 'itemCount', width: 12 },
];

const router = express.Router();
router.use(requirePermission('add_orders'));

const INVOICES_DIR = path.join(__dirname, '..', 'uploads', 'invoices');
if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, INVOICES_DIR),
    filename: (req, file, cb) => cb(null, `invoice-${Date.now()}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('يجب أن تكون الصورة بصيغة PNG أو JPG أو WEBP'), ok);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

function serializeInvoice(row) {
  if (!row) return null;
  const order = row.order_id
    ? db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').get(row.order_id, row.company_id)
    : null;
  return {
    ...row,
    image_url: `/uploads/invoices/${path.basename(row.image_path)}`,
    extracted_items: row.extracted_items_json ? JSON.parse(row.extracted_items_json) : [],
    order: order ? { ...order, items: JSON.parse(order.items_json || '[]') } : null,
  };
}

// Step 1: attach the photo to a shop/date. No auto-extraction is wired in
// yet — reading a fixed-layout Amin invoice reliably needs real sample
// screenshots to know where each field actually sits, which this build
// doesn't have. The rep enters the fields manually in the review step below
// against the image; extraction_method stays 'manual' until that's added.
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.body.shop_id, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const invoiceDate = req.body.invoice_date || new Date().toISOString().slice(0, 10);

  const info = db
    .prepare(
      `INSERT INTO invoices (company_id, shop_id, image_path, invoice_date, extraction_method, uploaded_by_id, uploaded_by_name)
       VALUES (?, ?, ?, ?, 'manual', ?, ?)`
    )
    .run(req.companyId, shop.id, req.file.path, invoiceDate, req.user.id, req.user.name);

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').get(info.lastInsertRowid, req.companyId);
  res.status(201).json(serializeInvoice(invoice));
});

// Registered before '/:id' so 'by-day' isn't swallowed as an :id param.
// Only confirmed invoices (order_id set) count as a day's invoices — an
// upload still in manual review isn't a recorded sale yet.
router.get('/by-day', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT i.id, i.shop_id, s.name as shop_name, i.created_at, i.reconciliation_status, o.total_value, o.items_json
       FROM invoices i
       JOIN shops s ON s.id = i.shop_id
       JOIN orders o ON o.id = i.order_id
       WHERE i.invoice_date = ? AND i.order_id IS NOT NULL AND i.company_id = ?
       ORDER BY i.created_at ASC`
    )
    .all(date, req.companyId);

  const invoices = rows.map((r) => {
    const items = JSON.parse(r.items_json || '[]');
    return {
      id: r.id,
      shopId: r.shop_id,
      shopName: r.shop_name,
      time: r.created_at,
      total: Number(r.total_value) || 0,
      itemCount: items.length,
      reconciliationStatus: r.reconciliation_status,
    };
  });

  const totalSales = invoices.reduce((sum, i) => sum + i.total, 0);
  const count = invoices.length;
  const avgValue = count > 0 ? Math.round((totalSales / count) * 100) / 100 : 0;

  res.json({ date, invoices, summary: { totalSales, count, avgValue } });
});

router.get('/by-day/export', requirePermission('export_data'), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
  const rows = db
    .prepare(
      `SELECT i.id, s.name as shop_name, i.created_at, o.total_value, o.items_json
       FROM invoices i JOIN shops s ON s.id = i.shop_id JOIN orders o ON o.id = i.order_id
       WHERE i.invoice_date = ? AND i.order_id IS NOT NULL AND i.company_id = ?
       ORDER BY i.created_at ASC`
    )
    .all(date, req.companyId);
  const tableRows = rows.map((r) => ({
    shopName: r.shop_name,
    time: r.created_at,
    total: Number(r.total_value) || 0,
    itemCount: JSON.parse(r.items_json || '[]').length,
  }));

  const lang = langFromQuery(req);
  const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(req.companyId);
  if (format === 'pdf') {
    await sendTablePdf(
      res,
      {
        title: lang === 'en' ? `Daily invoices — ${date}` : `فواتير يوم ${date}`,
        columns: INVOICE_DAY_COLUMNS,
        rows: tableRows,
        lang,
        meta: ['Atlas', company?.name, date, lang === 'en' ? 'English' : 'العربية'].filter(Boolean),
      },
      `invoices-${date}.pdf`
    );
    return;
  }
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, `فواتير ${date}`, INVOICE_DAY_COLUMNS, tableRows, {
    title: lang === 'en' ? `Daily invoices — ${date}` : `فواتير يوم ${date}`,
    lang,
    companyName: company?.name,
    dateRange: { from: date, to: date },
  });
  await sendWorkbook(res, workbook, `invoices-${date}.xlsx`);
});

router.get('/', (req, res) => {
  const shopId = req.query.shopId;
  const rows = shopId
    ? db.prepare('SELECT * FROM invoices WHERE shop_id = ? AND company_id = ? ORDER BY created_at DESC').all(shopId, req.companyId)
    : db.prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY created_at DESC LIMIT 100').all(req.companyId);
  res.json(rows.map(serializeInvoice));
});

router.get('/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!invoice) return res.status(404).json({ error: 'invoice_not_found' });
  res.json(serializeInvoice(invoice));
});

// Step 2: the rep confirms/corrects the fields next to the image, which
// writes the same orders row shape a normal QuickOrderForm order would
// (items_json/total_value) — an invoice-derived sale is not a different
// kind of order, just a different way of entering one.
router.post('/:id/confirm', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!invoice) return res.status(404).json({ error: 'invoice_not_found' });
  if (invoice.order_id) return res.status(409).json({ error: 'invoice_already_confirmed' });

  const { invoice_date, items, total_value } = req.body;
  if (!invoice_date || total_value === undefined) {
    return res.status(400).json({ error: 'invoice_date_and_total_value_required' });
  }
  if (!(Number(total_value) > 0)) {
    return res.status(400).json({ error: 'total_value_must_be_positive' });
  }
  const itemsList = Array.isArray(items) ? items : [];
  if (itemsList.some((it) => !(Number(it.qty) > 0))) {
    return res.status(400).json({ error: 'item_quantity_must_be_positive' });
  }

  const orderInfo = db
    .prepare('INSERT INTO orders (company_id, shop_id, rep_id, order_date, items_json, total_value) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.companyId, invoice.shop_id, req.user.id, invoice_date, JSON.stringify(itemsList), total_value);

  db.prepare('UPDATE invoices SET order_id = ?, invoice_date = ? WHERE id = ? AND company_id = ?').run(
    orderInfo.lastInsertRowid,
    invoice_date,
    invoice.id,
    req.companyId
  );

  recomputeShopClassification(invoice.shop_id, getGlobalSettings(req.companyId));

  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(invoice.shop_id, req.companyId);
  createNotification({
    companyId: req.companyId,
    type: 'invoice_processed',
    message_ar: `✓ فاتورة جديدة تم رفعها ومعالجتها بنجاح — ${shop.name}\nالقيمة: ${Number(total_value).toLocaleString('ar')}`,
    message_en: `New invoice uploaded and processed — ${shop.name}\nTotal: ${total_value}`,
    link_path: `/?shop=${invoice.shop_id}&invoice=${invoice.id}`,
    entity_type: 'invoice',
    entity_id: invoice.id,
  });

  reconcileShopDay(invoice.shop_id, invoice_date).catch((err) => console.error('[reconcile] failed:', err.message));

  const latestBalance = db
    .prepare('SELECT balance FROM balances WHERE shop_id = ? ORDER BY report_date DESC LIMIT 1')
    .get(shop.id);
  const itemsSummary = itemsList.map((it) => `${it.product_name} × ${it.qty}`).join('، ');
  const customerMessage =
    `مرحبًا ${shop.name}،\n` +
    `تم تسجيل طلبكم بتاريخ ${invoice_date}.\n` +
    `الأصناف: ${itemsSummary || '—'}\n` +
    `إجمالي الطلب: ${Math.round(total_value).toLocaleString('ar')} $\n` +
    `الرصيد الحالي: ${latestBalance ? Math.round(latestBalance.balance).toLocaleString('ar') : 0} $`;
  sendToCustomer(req.companyId, shop, customerMessage).catch((err) => console.error('[whatsapp] customer send failed:', err.message));

  const updated = db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').get(invoice.id, req.companyId);
  res.json(serializeInvoice(updated));
});

module.exports = router;
