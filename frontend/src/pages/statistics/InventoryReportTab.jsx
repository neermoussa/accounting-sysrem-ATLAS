import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SortableTable from '../../components/SortableTable.jsx';
import ExportOptionsModal from '../../components/ExportOptionsModal.jsx';

const COLUMNS = [
  { key: 'name', header: 'الصنف' },
  { key: 'carQty', header: 'كمية السيارة', numeric: true, render: (r) => r.carQty ?? '—' },
  { key: 'carMin', header: 'حد السيارة الأدنى', numeric: true, render: (r) => r.carMin ?? '—' },
  { key: 'factoryQty', header: 'كمية المعمل', numeric: true, render: (r) => r.factoryQty ?? '—' },
  { key: 'factoryMin', header: 'حد المعمل الأدنى', numeric: true, render: (r) => r.factoryMin ?? '—' },
  { key: 'status', header: 'الحالة' },
];

export default function InventoryReportTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [showExportOptions, setShowExportOptions] = useState(false);

  useEffect(() => {
    api.getInventoryReport().then(setRows).finally(() => setLoading(false));
  }, []);

  function handleExport({ lang, format }) {
    setExporting(true);
    setExportError(null);
    return api
      .exportStatsReport('inventory', format, { lang })
      .catch(() => setExportError('تعذّر تصدير الملف، حاول مجددًا.'))
      .finally(() => {
        setExporting(false);
        setShowExportOptions(false);
      });
  }

  return (
    <section className="card stats-panel">
      <div className="stats-panel-header">
        <h2>تقرير المخزون (سيارة + معمل)</h2>
        <div className="qof-actions">
          <button type="button" className="ghost-btn" disabled={exporting} onClick={() => setShowExportOptions(true)}>
            ⬇ {exporting ? '...' : 'تصدير'}
          </button>
        </div>
      </div>
      {exportError && <p className="stats-error">{exportError}</p>}
      {showExportOptions && (
        <ExportOptionsModal
          title="خيارات تصدير تقرير المخزون"
          onClose={() => setShowExportOptions(false)}
          onConfirm={handleExport}
          formats={[{ value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }]}
        />
      )}
      {loading ? (
        <p className="shop-panel-loading">جارٍ التحميل...</p>
      ) : (
        <SortableTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.name}
          defaultSortKey="name"
          defaultSortDir="asc"
          emptyText="لا يوجد أصناف مسجّلة"
        />
      )}
    </section>
  );
}
