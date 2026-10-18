const { chromium } = require('playwright');

// Renders a titled data table to PDF via headless Chromium instead of a
// hand-rolled PDF text layout — Arabic shaping/bidi/RTL is notoriously hard
// to get right with a raw PDF-drawing library (no font in this project ships
// both Arabic and Latin/digit glyphs together, and libraries like
// arabic-reshaper + bidi-js need very careful sequencing to avoid silently
// garbled output), whereas Chromium's own text engine is what already
// renders every Arabic string correctly throughout the live app. No
// executablePath is set here on purpose — in production this resolves via
// Playwright's normal browser install (`npx playwright install chromium`,
// see DEPLOYMENT.md); PLAYWRIGHT_CHROMIUM_PATH is only for pointing this at
// this sandbox's pre-cached browser during development/testing.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Grayscale, Atlas-identity styling — matches the Excel export's look
// (backend/lib/xlsxExport.js): near-black header row, thin gray borders,
// alternating row shading, no color accent.
function buildTableHtml({ title, subtitle, columns, rows, meta, lang }) {
  const rtl = lang !== 'en';
  const headerCells = columns
    .map((c) => `<th>${escapeHtml(lang === 'en' && c.headerEn ? c.headerEn : c.header)}</th>`)
    .join('');
  const bodyRows = rows
    .map((row) => {
      const cells = columns.map((c) => `<td>${escapeHtml(row[c.key] ?? '—')}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  const metaHtml = meta
    ? `<div class="meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'ar' : 'en'}">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Tajawal', 'Segoe UI', Arial, sans-serif; padding: 28px; direction: ${rtl ? 'rtl' : 'ltr'}; color: #16181b; background: #ffffff; }
  h1 { color: #111214; font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #6b7076; font-size: 12px; margin: 0 0 14px; }
  .meta { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; font-size: 12px; color: #4c4f54; }
  .meta span { background: #f0f0f1; border: 1px solid #dcdcde; border-radius: 6px; padding: 5px 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #d6d6d8; padding: 8px 10px; text-align: ${rtl ? 'right' : 'left'}; }
  th { background: #262626; color: #ffffff; font-weight: 700; }
  tr:nth-child(even) td { background: #f5f5f5; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ''}
  ${metaHtml}
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body>
</html>`;
}

async function renderTablePdf({ title, subtitle, columns, rows, meta, lang }) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(buildTableHtml({ title, subtitle, columns, rows, meta, lang }), { waitUntil: 'networkidle' });
    const buffer = await page.pdf({
      format: 'A4',
      landscape: columns.length > 5,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    });
    return buffer;
  } finally {
    await browser.close();
  }
}

function sendPdfHeaders(res, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="export.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`);
}

// Answers the caller itself rather than letting a render failure escape as a
// rejected promise: every caller is an `async` Express 4 route handler, and
// Express 4 does not route those rejections to the error middleware — an
// unanswered one used to reach process level and kill the server (a headless
// Chromium that fails to launch is the easiest way to hit it, but a bad row,
// a timeout or an OOM inside page.pdf() does the same). PDF headers are only
// set once rendering succeeded, so nothing has been written to the response
// yet at the point this catches.
async function sendTablePdf(res, opts, filename) {
  let buffer;
  try {
    buffer = await renderTablePdf(opts);
  } catch (err) {
    console.error('[pdfExport] render failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'pdf_export_failed' });
    return;
  }
  sendPdfHeaders(res, filename);
  res.end(buffer);
}

module.exports = { renderTablePdf, sendTablePdf };
