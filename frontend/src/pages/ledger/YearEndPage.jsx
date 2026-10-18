import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

// Month-end checklist per fiscal period, and the year-end close (one entry
// moving every P&L balance to retained earnings; reopenable until the next
// year has postings).
export default function YearEndPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [years, setYears] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [periodId, setPeriodId] = useState('');
  const [checklist, setChecklist] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const canClose = can('run_year_end_close');

  const load = () => api.getYearEnd().then(setYears).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    load();
    api.getFiscalPeriods().then((ps) => {
      setPeriods(ps);
      const today = new Date().toISOString().slice(0, 10);
      const cur = ps.find((p) => p.start_date <= today && p.end_date >= today) || ps[ps.length - 1];
      if (cur) setPeriodId(String(cur.id));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!periodId) return;
    api.getMonthEnd(periodId).then(setChecklist).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function close(fy) {
    if (!window.confirm(t('fr.ye.confirmClose').replace('{year}', fy.year))) return;
    setError(null);
    try {
      const r = await api.closeYear(fy.id);
      setNotice(`${t('fr.ye.closed')} ${r.entry_number} · ${t('fr.net')}: ${formatMinor(r.net_income_minor)}`);
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }
  async function reopen(fy) {
    const reason = window.prompt(t('fr.ye.reopenReason'));
    if (!reason) return;
    try {
      await api.reopenYear(fy.id, reason);
      setNotice(t('fr.ye.reopened'));
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{t('fr.ye.title')}</h1><p className="ledger-subtitle">{t('fr.ye.subtitle')}</p></div></div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}

      <div className="card ledger-card">
        <div className="ledger-toolbar">
          <h2 className="atlas-section-title">{t('fr.me.title')}</h2>
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{p.start_date.slice(0, 7)}</option>)}
          </select>
        </div>
        {checklist && (
          <>
            <div className={`ledger-balance ${checklist.ready_to_close ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{checklist.ready_to_close ? t('fr.me.ready') : `${t('fr.me.blockers')}: ${checklist.blockers}`}</div>
            <ul className="ledger-checklist">
              {checklist.items.map((i) => (
                <li key={i.key}>
                  {i.ok ? '✅' : i.severity === 'blocker' ? '⛔' : '⚠️'} {t(`fr.me.${i.key}`)}{i.count ? ` (${i.count})` : ''}
                  {!i.ok && <> · <Link to={i.link}>{t('fr.me.open')}</Link></>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('fr.ye.years')}</h2>
        <table className="ledger-table">
          <thead><tr><th>{t('ledger.periods.year')}</th><th>{t('fr.status')}</th><th>{t('fr.ye.entry')}</th><th /></tr></thead>
          <tbody>
            {years.map((fy) => (
              <tr key={fy.id}>
                <td>{fy.year} ({fy.start_date} → {fy.end_date})</td>
                <td>{t(`fr.fy.${fy.status}`)}</td>
                <td>{fy.closing_entry ? <Link to={`/ledger/entries?id=${fy.closing_entry.id}`}>{fy.closing_entry.entry_number}</Link> : '—'}</td>
                <td>
                  {canClose && !fy.closing_entry && <button type="button" className="gold-btn" onClick={() => close(fy)}>{t('fr.ye.close')}</button>}
                  {canClose && fy.closing_entry && <button type="button" className="ghost-btn" onClick={() => reopen(fy)}>{t('fr.ye.reopen')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ledger-hint">{t('fr.ye.hint')}</p>
      </div>
    </div>
  );
}
