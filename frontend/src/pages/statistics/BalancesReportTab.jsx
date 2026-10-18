import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SortableTable from '../../components/SortableTable.jsx';
import ExportOptionsModal from '../../components/ExportOptionsModal.jsx';

const COLUMNS = [
  { key: 'name', header: 'المحل' },
  { key: 'balance', header: 'الرصيد الحالي', numeric: true, render: (r) => (r.balance != null ? r.balance.toLocaleString('ar') : '—') },
  { key: 'lastOrderDate', header: 'تاريخ آخر حركة', render: (r) => r.lastOrderDate || '—' },
  { key: 'balanceDate', header: 'تاريخ آخر تحديث أمين', render: (r) => r.balanceDate || '—' },
  { key: 'classification', header: 'التصنيف' },
  { key: 'status', header: 'الحالة' },
];

export default function BalancesReportTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [showExportOptions, setShowExportOptions] = useState(false);

  useEffect(() => {
    api.getBalancesReport().then(setRows).finally(() => setLoading(false));
  }, []);

  function handleExport({ lang, format }) {
    setExporting(true);
    setExportError(null);
    return api
      .exportStatsReport('balances', format, { lang })
      .catch(() => setExportError('تعذّر تصدير الملف، حاول مجددًا.'))
      .finally(() => {
        setExporting(false);
        setShowExportOptions(false);
      });
  }

  return (
    <section className="card stats-panel">
      <div className="stats-panel-header">
        <h2>تقرير الأرصدة</h2>
        <div className="qof-actions">
          <button type="button" className="ghost-btn" disabled={exporting} onClick={() => setShowExportOptions(true)}>
            ⬇ {exporting ? '...' : 'تصدير'}
          </button>
        </div>
      </div>
      {exportError && <p className="stats-error">{exportError}</p>}
      {showExportOptions && (
        <ExportOptionsModal
          title="خيارات تصدير تقرير الأرصدة"
          onClose={() => setShowExportOptions(false)}
          onConfirm={handleExport}
          formats={[{ value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }]}
        />
      )}
      {loading ? (
        <p className="shop-panel-loading">جارٍ التحميل...</p>
      ) : (
        <SortableTable columns={COLUMNS} rows={rows} rowKey={(r) => r.shopId} defaultSortKey="balance" emptyText="لا يوجد محلات" />
      )}
    </section>
  );
}
