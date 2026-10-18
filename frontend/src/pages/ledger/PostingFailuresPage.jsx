import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

// Failed-posting queue: postings refused because no fiscal period covered
// their date are kept here with a retry action (never lost).
export default function PostingFailuresPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = () => api.getPostingFailures(status).then(setRows).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{t('nav.postingFailures')}</h1><p className="ledger-subtitle">{t('rollover.queueHint')}</p></div></div>
      <div className="ledger-tabs">{['open', 'resolved', 'all'].map((k) => <button key={k} type="button" className={`ledger-tab-btn ${status === k ? 'active' : ''}`} onClick={() => setStatus(k)}>{t(`rollover.status.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      <table className="ledger-table">
        <thead><tr><th>{t('rollover.item')}</th><th>{t('rollover.date')}</th><th>{t('rollover.reason')}</th><th>{t('rollover.attempts')}</th><th>{t('rollover.lastTry')}</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td>{r.label || `${r.kind} #${r.source_id}`}</td><td>{r.posting_date || '—'}</td><td>{r.message}</td><td>{r.attempts}</td><td>{r.last_failed_at}</td>
            <td>{r.status === 'open' && (can('post_journal_entries') || can('manage_fiscal_periods')) && (
              <button type="button" className="gold-btn" onClick={async () => {
                setError(null); setNotice(null);
                try { await api.retryPostingFailure(r.id); setNotice(t('rollover.retried')); load(); } catch (err) { setError(ledgerError(err, t)); load(); }
              }}>{t('rollover.retry')}</button>
            )}</td>
          </tr>
        ))}</tbody>
      </table>
      {!rows.length && <p className="ledger-subtitle">{t('rollover.empty')}</p>}
    </div>
  );
}
