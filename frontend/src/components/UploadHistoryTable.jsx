import { useEffect, useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/stats.css';
import '../styles/uploads.css';

// SQLite's datetime('now') stores "YYYY-MM-DD HH:MM:SS" in UTC with no
// timezone marker — same parseUtc convention used elsewhere in this app —
// then formatted by hand (not toLocaleString) to get an exact
// "DD/MM/YYYY - H:MM AM/PM" layout regardless of locale defaults.
function formatUploadedAt(sqliteDatetime, t) {
  if (!sqliteDatetime) return '—';
  const d = new Date(`${sqliteDatetime.replace(' ', 'T')}Z`);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? t('uploadHistory.pm') : t('uploadHistory.am');
  hours = hours % 12 || 12;
  return `${day}/${month}/${year} - ${hours}:${minutes} ${period}`;
}

export default function UploadHistoryTable({ fetchFn, refreshSignal }) {
  const { t } = useLanguage();
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchFn()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  return (
    <div className="card upload-history-card">
      <h3 className="upload-history-title">{t('uploadHistory.title')}</h3>
      {loading && <p className="import-hint">{t('uploadHistory.loading')}</p>}
      {!loading && (!items || items.length === 0) && <p className="import-hint">{t('uploadHistory.empty')}</p>}
      {!loading && items?.length > 0 && (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{t('uploadHistory.colFilename')}</th>
                <th>{t('uploadHistory.colDateTime')}</th>
                <th>{t('uploadHistory.colUser')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.filename}</td>
                  <td>{formatUploadedAt(item.uploaded_at, t)}</td>
                  <td>{item.uploaded_by_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
