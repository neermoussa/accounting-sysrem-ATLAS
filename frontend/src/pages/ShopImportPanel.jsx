import { useRef, useState } from 'react';
import { api } from '../api.js';
import UploadHistoryTable from '../components/UploadHistoryTable.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/import.css';
import '../styles/shop-import.css';

const EMPTY_ROW = { name: '', phone: '', lat: '', lng: '', address: '', notes: '' };

export default function ShopImportPanel() {
  const { t } = useLanguage();
  const [uploading, setUploading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [rows, setRows] = useState(null); // preview rows, editable
  const [batchId, setBatchId] = useState(null);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const fileInputRef = useRef(null);

  async function handleFileChosen(file) {
    if (!file) return;
    setError(null);
    setUploading(true);
    setCommitted(false);
    try {
      const result = await api.previewShopImport(file);
      setRows(result.rows);
      setBatchId(result.batchId ?? null);
      setHistoryRefresh((n) => n + 1);
    } catch (err) {
      if (err.detail?.error === 'missing_columns') {
        setError(`${t('shopImport.errorMissingColumns')} ${err.detail.columns.join('، ')}`);
      } else if (err.detail?.error === 'empty_file') {
        setError(t('shopImport.errorEmptyFile'));
      } else {
        setError(t('shopImport.errorUploadFailed'));
      }
    } finally {
      setUploading(false);
    }
  }

  function updateRow(index, field, value) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addBlankRow() {
    setRows((prev) => [...(prev || []), { ...EMPTY_ROW, status: 'needs_review', reasons: [t('shopImport.newRowReason')] }]);
  }

  function removeRow(index) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleCommit() {
    setCommitting(true);
    setError(null);
    try {
      const payload = rows.map((r) => ({
        name: r.name,
        phone: r.phone,
        lat: r.lat === '' ? null : Number(r.lat),
        lng: r.lng === '' ? null : Number(r.lng),
        address: r.address,
        notes: r.notes,
      }));
      const result = await api.commitShopImport(payload, batchId);
      setRows(result.results);
      setCommitted(true);
      setHistoryRefresh((n) => n + 1);
    } catch (err) {
      setError(t('shopImport.errorCommitFailed'));
    } finally {
      setCommitting(false);
    }
  }

  function resetAll() {
    setRows(null);
    setBatchId(null);
    setCommitted(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function statusBadge(row) {
    if (row.outcome === 'created') return <span className="badge green">{t('shopImport.badgeSaved')}</span>;
    if (row.outcome === 'skipped') return <span className="badge red">{t('shopImport.badgeSkipped')}</span>;
    if (row.status === 'ok') return <span className="badge green">{t('shopImport.badgeOk')}</span>;
    return <span className="badge yellow">{t('shopImport.badgeNeedsReview')}</span>;
  }

  const createdCount = rows?.filter((r) => r.outcome === 'created').length ?? 0;
  const skippedCount = rows?.filter((r) => r.outcome === 'skipped').length ?? 0;
  const needsReviewCount = rows?.filter((r) => !r.outcome && r.status === 'needs_review').length ?? 0;

  return (
    <div className="uploads-tab-panel">
      {!rows && (
        <div className="card import-upload-card">
          <p className="import-hint">
            {t('shopImport.hintPart1')} <strong>{t('shopImport.hintShopName')}</strong> {t('shopImport.hintAnd')}
            <strong> {t('shopImport.hintPhone')}</strong>{t('shopImport.hintOptionally')}
            <strong> {t('shopImport.hintLat')}</strong> {t('shopImport.hintAnd')}<strong>{t('shopImport.hintLng')}</strong> {t('shopImport.hintLatLngNote')}
            {' '}{t('shopImport.hintAnd')}<strong>{t('shopImport.hintTextAddress')}</strong> {t('shopImport.hintAnd')}<strong>{t('shopImport.hintNotes')}</strong>{t('shopImport.hintEnd')}
          </p>
          <label className="import-dropzone">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => handleFileChosen(e.target.files?.[0])}
              disabled={uploading}
            />
            <span>{uploading ? t('shopImport.uploading') : t('shopImport.chooseFile')}</span>
          </label>
          {error && <p className="qof-error">{error}</p>}
        </div>
      )}

      {rows && (
        <div className="card shop-import-preview">
          <div className="shop-import-header">
            <h2>{committed ? t('shopImport.resultTitle') : `${t('shopImport.previewTitle')} (${rows.length})`}</h2>
            {!committed && (
              <span className="shop-import-counts">
                {rows.filter((r) => r.status === 'ok').length} {t('shopImport.ok')} · {needsReviewCount} {t('shopImport.needsReview')}
              </span>
            )}
            {committed && (
              <span className="shop-import-counts">
                {createdCount} {t('shopImport.saved')} · {skippedCount} {t('shopImport.skipped')}
              </span>
            )}
          </div>

          <div className="stats-table-wrap">
            <table className="stats-table shop-import-table">
              <thead>
                <tr>
                  <th>{t('shopImport.colName')}</th>
                  <th>{t('shopImport.colPhone')}</th>
                  <th>{t('shopImport.colLat')}</th>
                  <th>{t('shopImport.colLng')}</th>
                  <th>{t('shopImport.colAddress')}</th>
                  <th>{t('shopImport.colNotes')}</th>
                  <th>{t('shopImport.colStatus')}</th>
                  {!committed && <th></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={row.status === 'needs_review' && !row.outcome ? 'needs-review-row' : ''}>
                    <td>
                      <input
                        value={row.name || ''}
                        disabled={committed}
                        onChange={(e) => updateRow(i, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        dir="ltr"
                        value={row.phone || ''}
                        disabled={committed}
                        onChange={(e) => updateRow(i, 'phone', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        dir="ltr"
                        value={row.lat ?? ''}
                        disabled={committed}
                        onChange={(e) => updateRow(i, 'lat', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        dir="ltr"
                        value={row.lng ?? ''}
                        disabled={committed}
                        onChange={(e) => updateRow(i, 'lng', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={row.address || ''}
                        disabled={committed}
                        onChange={(e) => updateRow(i, 'address', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={row.notes || ''}
                        disabled={committed}
                        onChange={(e) => updateRow(i, 'notes', e.target.value)}
                      />
                    </td>
                    <td>
                      {statusBadge(row)}
                      {row.reasons?.length > 0 && <p className="shop-import-reason">{row.reasons.join('، ')}</p>}
                    </td>
                    {!committed && (
                      <td>
                        <button type="button" className="ghost-btn danger" onClick={() => removeRow(i)}>
                          {t('shopImport.delete')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && <p className="qof-error">{error}</p>}

          <div className="qof-actions">
            {!committed && (
              <>
                <button type="button" className="ghost-btn" onClick={resetAll} disabled={committing}>
                  {t('shopImport.cancel')}
                </button>
                <button type="button" className="ghost-btn" onClick={addBlankRow} disabled={committing}>
                  {t('shopImport.addManualRow')}
                </button>
                <button
                  type="button"
                  className="gold-btn qof-save"
                  disabled={committing || rows.length === 0}
                  onClick={handleCommit}
                >
                  {committing ? t('shopImport.saving') : t('shopImport.confirmImport')}
                </button>
              </>
            )}
            {committed && (
              <button type="button" className="gold-btn" onClick={resetAll}>
                {t('shopImport.importAnother')}
              </button>
            )}
          </div>
        </div>
      )}

      <UploadHistoryTable fetchFn={api.listShopImportBatches} refreshSignal={historyRefresh} />
    </div>
  );
}
