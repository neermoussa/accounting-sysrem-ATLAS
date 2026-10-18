const ExcelJS = require('exceljs');

// Reads the first worksheet into a plain header row + data rows, unwrapping
// ExcelJS's rich-text/formula cell objects down to plain values.
async function readSheetRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { header: [], dataRows: [] };

  const colCount = worksheet.columnCount || worksheet.actualColumnCount || 0;
  const rows = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const arr = [];
    for (let c = 1; c <= colCount; c++) {
      let v = row.getCell(c).value;
      if (v && typeof v === 'object') {
        if (Array.isArray(v.richText)) v = v.richText.map((rt) => rt.text).join('');
        else if (v.text !== undefined) v = v.text;
        else if (v.result !== undefined) v = v.result;
        // else leave Date objects (and other primitives) as-is
      }
      arr.push(v === undefined ? null : v);
    }
    rows.push(arr);
  });

  const header = (rows[0] || []).map((h) => (h === null ? '' : String(h).trim()));
  const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell !== null && cell !== ''));
  return { header, dataRows };
}

module.exports = { readSheetRows };
