import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SortableTable from '../../components/SortableTable.jsx';
import InvoiceUploadReview from '../../components/InvoiceUploadReview.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import ExportOptionsModal from '../../components/ExportOptionsModal.jsx';
import '../../styles/invoices-tab.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function formatTime(iso) {
  try {
    return new Date(iso.includes('Z') ? iso : `${iso}Z`).toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

const RECON_LABEL = { matched: 'مطابقة ✓', mismatch: '⚠ شبهة خطأ', pending: 'بانتظار الأمين' };

const COLUMNS = [
  { key: 'shopName', header: 'المحل' },
  { key: 'time', header: 'الوقت', render: (r) => formatTime(r.time) },
  { key: 'total', header: 'المبلغ الإجمالي', numeric: true, render: (r) => r.total.toLocaleString('ar') },
  { key: 'itemCount', header: 'عدد الأصناف', numeric: true },
  {
    key: 'reconciliationStatus',
    header: 'حالة التطابق',
    render: (r) => (
      <span className={'recon-pill ' + r.reconciliationStatus}>{RECON_LABEL[r.reconciliationStatus] || r.reconciliationStatus}</span>
    ),
  },
];

export default function InvoicesTab() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [openInvoice, setOpenInvoice] = useState(null);
  const [showExportOptions, setShowExportOptions] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .getInvoicesByDay(date)
      .then(setData)
      .finally(() => setLoading(false));
  }, [date]);

  function handleExport({ lang, format }) {
    setExporting(true);
    return api.exportInvoicesByDay(date, format, lang).finally(() => {
      setExporting(false);
      setShowExportOptions(false);
    });
  }

  return (
    <section className="card stats-panel invoices-tab">
      <div className="stats-panel-header">
        <h2>الفواتير اليومية</h2>
        <div className="qof-actions">
          <button type="button" className="ghost-btn" disabled={exporting} onClick={() => setShowExportOptions(true)}>
            ⬇ {exporting ? '...' : 'تصدير'}
          </button>
        </div>
      </div>
      {showExportOptions && (
        <ExportOptionsModal
          title="خيارات تصدير فواتير اليوم"
          onClose={() => setShowExportOptions(false)}
          onConfirm={handleExport}
          filterSummary={date}
          formats={[{ value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }]}
        />
      )}

      <div className="invoices-day-nav">
        <button type="button" className="ghost-btn" onClick={() => setDate((d) => addDays(d, -1))}>
          ◀ اليوم السابق
        </button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button type="button" className="ghost-btn" onClick={() => setDate((d) => addDays(d, 1))}>
          اليوم التالي ▶
        </button>
      </div>

      {loading && <p className="shop-panel-loading">جارٍ التحميل...</p>}

      {!loading && data && (
        <>
          <div className="kpi-cards-row invoices-summary-row">
            <KpiCard title="إجمالي مبيعات اليوم" value={data.summary.totalSales.toLocaleString('ar')} gradient={1} />
            <KpiCard title="عدد الفواتير" value={data.summary.count} gradient={2} />
            <KpiCard title="متوسط قيمة الفاتورة" value={data.summary.avgValue.toLocaleString('ar')} gradient={3} />
          </div>

          <SortableTable
            columns={COLUMNS}
            rows={data.invoices}
            rowKey={(r) => r.id}
            defaultSortKey="time"
            defaultSortDir="asc"
            onRowClick={(r) => setOpenInvoice({ invoiceId: r.id, shopId: r.shopId })}
            emptyText="لا يوجد فواتير مسجّلة بهذا اليوم"
          />
        </>
      )}

      {openInvoice && (
        <div className="invoice-detail-overlay" onClick={() => setOpenInvoice(null)}>
          <div className="invoice-detail-modal card" onClick={(e) => e.stopPropagation()}>
            <InvoiceUploadReview
              shopId={openInvoice.shopId}
              invoiceId={openInvoice.invoiceId}
              onCancel={() => setOpenInvoice(null)}
              onSaved={() => setOpenInvoice(null)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
