// Shared Excel export styling — grayscale (Atlas' black/white/gray identity;
// Excel has no gradients/blur, so this means clean fills + strong type
// hierarchy instead) plus a small "meta" info band (program/company/date
// range/language/filter) written as the first rows of every exported sheet,
// above the actual header row.

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF262626' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const TITLE_FONT = { bold: true, size: 14, color: { argb: 'FF111111' } };
const META_LABEL_FONT = { bold: true, size: 10, color: { argb: 'FF555555' } };
const META_VALUE_FONT = { size: 10, color: { argb: 'FF111111' } };
const ALT_ROW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
const THIN_GRAY = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const HAIR_GRAY = { style: 'hair', color: { argb: 'FFE2E2E2' } };

const META_LABELS = {
  ar: {
    program: 'البرنامج',
    company: 'الشركة',
    dateRange: 'الفترة الزمنية',
    language: 'لغة الملف',
    filter: 'الفلتر المطبّق',
    generatedAt: 'تاريخ التصدير',
    langName: 'العربية',
    arrow: '→',
  },
  en: {
    program: 'Program',
    company: 'Company',
    dateRange: 'Date range',
    language: 'File language',
    filter: 'Applied filter',
    generatedAt: 'Exported at',
    langName: 'English',
    arrow: '→',
  },
};

function headerText(col, lang) {
  return lang === 'en' && col.headerEn ? col.headerEn : col.header;
}

// columns: [{ header, headerEn?, key, width }], rows: [{ key: value, ... }]
// meta (optional): { title, companyName, dateRange: {from,to}, filterLabel, lang }
function addSheet(workbook, name, columns, rows, meta = {}) {
  const lang = meta.lang === 'en' ? 'en' : 'ar';
  const rtl = lang !== 'en';
  const L = META_LABELS[lang];
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width || 22 }));

  const titleRow = sheet.addRow([meta.title || name]);
  titleRow.getCell(1).font = TITLE_FONT;
  sheet.mergeCells(titleRow.number, 1, titleRow.number, Math.max(columns.length, 2));

  const metaEntries = [
    [L.program, 'Atlas'],
    ...(meta.companyName ? [[L.company, meta.companyName]] : []),
    ...(meta.dateRange && (meta.dateRange.from || meta.dateRange.to)
      ? [[L.dateRange, `${meta.dateRange.from || '—'} ${L.arrow} ${meta.dateRange.to || '—'}`]]
      : []),
    [L.language, L.langName],
    ...(meta.filterLabel ? [[L.filter, meta.filterLabel]] : []),
    [L.generatedAt, new Date().toISOString().slice(0, 19).replace('T', ' ')],
  ];

  metaEntries.forEach(([label, value]) => {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = META_LABEL_FONT;
    row.getCell(2).font = META_VALUE_FONT;
    row.getCell(1).alignment = { horizontal: rtl ? 'right' : 'left' };
    row.getCell(2).alignment = { horizontal: rtl ? 'right' : 'left' };
    sheet.mergeCells(row.number, 2, row.number, Math.max(columns.length, 2));
  });
  sheet.addRow([]); // spacer

  const headerRow = sheet.addRow(columns.map((c) => headerText(c, lang)));
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: rtl ? 'right' : 'left', vertical: 'middle' };
    cell.border = { top: THIN_GRAY, bottom: THIN_GRAY, left: THIN_GRAY, right: THIN_GRAY };
  });
  headerRow.height = 20;

  rows.forEach((r, i) => {
    const row = sheet.addRow(r);
    row.eachCell((cell) => {
      cell.alignment = { horizontal: rtl ? 'right' : 'left', vertical: 'middle' };
      cell.border = { bottom: HAIR_GRAY };
      if (i % 2 === 1) cell.fill = ALT_ROW_FILL;
    });
    row.height = 18;
  });

  sheet.views = [{ state: 'frozen', ySplit: headerRow.number, rightToLeft: rtl }];
  sheet.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: headerRow.number, column: columns.length } };
  return sheet;
}

function setDownloadHeaders(res, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}

async function sendWorkbook(res, workbook, filename) {
  setDownloadHeaders(res, filename);
  await workbook.xlsx.write(res);
  res.end();
}

// Reads `lang` off the request query string, defaulting to Arabic (matches
// prior, pre-existing behavior when the param is absent) — used by export
// routes to build the `meta` object passed to addSheet.
function langFromQuery(req) {
  return req.query.lang === 'en' ? 'en' : 'ar';
}

module.exports = { addSheet, setDownloadHeaders, sendWorkbook, langFromQuery };
