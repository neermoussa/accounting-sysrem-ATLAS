import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { unitLabel } from '../../lib/units.js';
import SortableTable from '../../components/SortableTable.jsx';
import ExportOptionsModal from '../../components/ExportOptionsModal.jsx';

const COLUMNS = [
  { key: 'date', header: 'التاريخ' },
  { key: 'shopName', header: 'المحل' },
  { key: 'productName', header: 'المادة' },
  { key: 'enteredQty', header: 'الكمية', numeric: true, render: (r) => `${r.enteredQty} ${unitLabel(r.enteredUnit)}` },
  { key: 'orderTotal', header: 'إجمالي قيمة الطلب', numeric: true, render: (r) => r.orderTotal.toLocaleString('ar') },
];

export default function SalesReportTab() {
  const [shops, setShops] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [shopId, setShopId] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [showExportOptions, setShowExportOptions] = useState(false);

  useEffect(() => {
    api.getShops().then(setShops);
  }, []);

  function load() {
    setLoading(true);
    api
      .getSalesReport({ from, to, shopId, productQuery })
      .then(setRows)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExport({ lang, from: exFrom, to: exTo, format }) {
    setExporting(true);
    setExportError(null);
    return api
      .exportStatsReport('sales', format, { from: exFrom, to: exTo, shopId, productQuery, lang })
      .catch(() => setExportError('تعذّر تصدير الملف، حاول مجددًا.'))
      .finally(() => {
        setExporting(false);
        setShowExportOptions(false);
      });
  }

  const filterSummary = [shopId && `${shops.find((s) => String(s.id) === String(shopId))?.name || shopId}`, productQuery]
    .filter(Boolean)
    .join(' / ');

  return (
    <section className="card stats-panel">
      <div className="stats-panel-header">
        <h2>تقرير المبيعات</h2>
        <div className="qof-actions">
          <button type="button" className="ghost-btn" disabled={exporting} onClick={() => setShowExportOptions(true)}>
            ⬇ {exporting ? '...' : 'تصدير'}
          </button>
        </div>
      </div>
      {exportError && <p className="stats-error">{exportError}</p>}
      {showExportOptions && (
        <ExportOptionsModal
          title="خيارات تصدير تقرير المبيعات"
          onClose={() => setShowExportOptions(false)}
          onConfirm={handleExport}
          showDateRange
          initialFrom={from}
          initialTo={to}
          filterSummary={filterSummary || undefined}
          formats={[{ value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }]}
        />
      )}

      <div className="report-filters">
        <label>
          من تاريخ
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          إلى تاريخ
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          المحل
          <select value={shopId} onChange={(e) => setShopId(e.target.value)}>
            <option value="">كل المحلات</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          المادة
          <input type="text" placeholder="اسم المادة..." value={productQuery} onChange={(e) => setProductQuery(e.target.value)} />
        </label>
        <button type="button" className="gold-btn" onClick={load} disabled={loading}>
          {loading ? 'جارٍ البحث...' : 'تطبيق الفلاتر'}
        </button>
      </div>

      <SortableTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(r, i) => `${r.orderId}-${i}`}
        defaultSortKey="date"
        emptyText="لا يوجد عمليات بيع مطابقة"
      />
    </section>
  );
}
