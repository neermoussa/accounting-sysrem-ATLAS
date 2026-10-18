import { useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/custody-transfers.css'; // reuses .custody-modal-backdrop/.custody-modal chrome
import '../styles/export-options.css';

// A small pre-download step shown before any Excel/PDF export actually
// fires — lets the person pick the exported file's language and, when the
// export is time-scoped, a date range, before the request goes out.
// `showDateRange` only renders the date controls when the export actually
// honors them server-side (see each call site) — never invented for a
// snapshot-style export the backend has no `from`/`to` for.
export default function ExportOptionsModal({
  title,
  onClose,
  onConfirm,
  showDateRange = false,
  initialFrom = '',
  initialTo = '',
  filterSummary, // optional string describing the filter already active on the page
  formats, // optional [{value,label}] — omit for a single-format export
  initialFormat,
}) {
  const { t } = useLanguage();
  const [lang, setLang] = useState('ar');
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [format, setFormat] = useState(initialFormat || formats?.[0]?.value);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm({ lang, from: showDateRange ? from : undefined, to: showDateRange ? to : undefined, format });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="custody-modal-backdrop" onClick={onClose}>
      <div className="custody-modal export-options-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title || t('exportOptions.title')}</h2>
        {filterSummary && <p className="export-options-filter-note">{t('exportOptions.appliedFilter')}: {filterSummary}</p>}

        <div className="export-options-field">
          <span className="export-options-label">{t('exportOptions.language')}</span>
          <div className="export-options-lang-toggle">
            <button
              type="button"
              className={lang === 'ar' ? 'export-options-lang-btn active' : 'export-options-lang-btn'}
              onClick={() => setLang('ar')}
            >
              العربية
            </button>
            <button
              type="button"
              className={lang === 'en' ? 'export-options-lang-btn active' : 'export-options-lang-btn'}
              onClick={() => setLang('en')}
            >
              English
            </button>
          </div>
        </div>

        {showDateRange && (
          <div className="export-options-field">
            <span className="export-options-label">{t('exportOptions.dateRange')}</span>
            <div className="export-options-date-row">
              <label>
                {t('exportOptions.from')}
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                {t('exportOptions.to')}
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          </div>
        )}

        {formats && formats.length > 1 && (
          <div className="export-options-field">
            <span className="export-options-label">{t('exportOptions.format')}</span>
            <div className="export-options-lang-toggle">
              {formats.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={format === f.value ? 'export-options-lang-btn active' : 'export-options-lang-btn'}
                  onClick={() => setFormat(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="custody-modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
            {t('exportOptions.cancel')}
          </button>
          <button type="button" className="gold-btn" onClick={handleConfirm} disabled={busy}>
            {busy ? t('exportOptions.exporting') : t('exportOptions.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
