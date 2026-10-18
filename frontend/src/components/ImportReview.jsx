import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { celebrateImportUpdated } from '../lib/celebration.js';
import '../styles/import.css';

export default function ImportReview({ initialData, onDataChange, onCommitted, onStartOver }) {
  const { can } = useAuth();
  const { t } = useLanguage();
  const [data, setData] = useState(initialData);
  const [shops, setShops] = useState([]);
  const [linkChoice, setLinkChoice] = useState({}); // rowId -> shopId
  const [rememberAlias, setRememberAlias] = useState({}); // rowId -> bool
  const [busyRowId, setBusyRowId] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);

  useEffect(() => {
    api.getShops().then(setShops);
  }, []);

  useEffect(() => {
    setData(initialData);
  }, [initialData]);

  function update(next) {
    setData(next);
    onDataChange?.(next);
  }

  async function handleLink(row) {
    const shopId = linkChoice[row.id];
    if (!shopId) return;
    setBusyRowId(row.id);
    try {
      const next = await api.linkImportRow(data.batch.id, row.id, {
        shop_id: Number(shopId),
        remember_alias: rememberAlias[row.id] !== false,
      });
      update(next);
    } finally {
      setBusyRowId(null);
    }
  }

  async function handleIgnore(row) {
    setBusyRowId(row.id);
    try {
      const next = await api.ignoreImportRow(data.batch.id, row.id);
      update(next);
    } finally {
      setBusyRowId(null);
    }
  }

  async function handleCommit() {
    setCommitting(true);
    try {
      const result = await api.commitImportBatch(data.batch.id);
      update(result);
      setCommitted(true);
      celebrateImportUpdated();
      onCommitted?.(result);
    } finally {
      setCommitting(false);
    }
  }

  const matchedRows = data.rows.filter((r) => r.status === 'matched' || r.status === 'linked');
  const unmatchedRows = data.rows.filter((r) => r.status === 'unmatched');
  const ignoredRows = data.rows.filter((r) => r.status === 'ignored');

  return (
    <div className="import-review">
      <div className="card import-review-summary">
        <h2>{t('importReview.title')} {data.batch.report_date}</h2>
        <div className="import-review-counts">
          <span className="badge green">{matchedRows.length} {t('importReview.balancesToUpdate')}</span>
          <span className="badge yellow">{unmatchedRows.length} {t('importReview.unmatchedCount')}</span>
          {ignoredRows.length > 0 && <span className="badge red">{ignoredRows.length} {t('importReview.ignoredCount')}</span>}
        </div>
        {committed && <p className="import-committed-note">{t('importReview.committedNote')}</p>}
      </div>

      {unmatchedRows.length > 0 && (
        <div className="card import-section">
          <h3>{t('importReview.unmatchedTitle')}</h3>
          <div className="unmatched-list">
            {unmatchedRows.map((row) => (
              <div key={row.id} className="unmatched-row">
                <div className="unmatched-row-info">
                  <strong dir="ltr">{row.phone_raw || t('importReview.noNumber')}</strong>
                  <span>{t('importReview.balance')} {row.balance_raw?.toLocaleString('ar')}</span>
                </div>
                <div className="unmatched-row-actions">
                  <select
                    value={linkChoice[row.id] || ''}
                    onChange={(e) => setLinkChoice((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  >
                    <option value="">{t('importReview.chooseCorrectShop')}</option>
                    {shops.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.phone})
                      </option>
                    ))}
                  </select>
                  <label className="import-checkbox small">
                    <input
                      type="checkbox"
                      checked={rememberAlias[row.id] !== false}
                      onChange={(e) => setRememberAlias((prev) => ({ ...prev, [row.id]: e.target.checked }))}
                    />
                    {t('importReview.rememberForShop')}
                  </label>
                  <div className="unmatched-row-buttons">
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busyRowId === row.id}
                      onClick={() => handleIgnore(row)}
                    >
                      {t('importReview.ignore')}
                    </button>
                    <button
                      type="button"
                      className="gold-btn"
                      disabled={busyRowId === row.id || !linkChoice[row.id]}
                      onClick={() => handleLink(row)}
                    >
                      {t('importReview.link')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card import-section">
        <h3>{t('importReview.balancesToUpdateTitle')} ({matchedRows.length})</h3>
        <div className="matched-list">
          {matchedRows.map((row) => (
            <div key={row.id} className="matched-row">
              <span>{row.shop_name}</span>
              <strong>{row.balance_raw?.toLocaleString('ar')}</strong>
            </div>
          ))}
          {matchedRows.length === 0 && <p className="shop-panel-empty">{t('importReview.noMatchedBalances')}</p>}
        </div>
      </div>

      <div className="import-review-footer">
        <button type="button" className="ghost-btn" onClick={onStartOver}>
          {t('importReview.uploadNewFile')}
        </button>
        {!committed && can('approve_import') && (
          <button type="button" className="gold-btn import-commit-btn" onClick={handleCommit} disabled={committing}>
            {committing ? t('importReview.saving') : `${t('importReview.confirmFinalSavePrefix')} (${matchedRows.length} ${t('importReview.shop')})`}
          </button>
        )}
        {!committed && !can('approve_import') && (
          <p className="import-committed-note">{t('importReview.noApprovalPermission')}</p>
        )}
      </div>
    </div>
  );
}
