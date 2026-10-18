import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

export default function FiscalPeriodsPage() {
  const { can } = useAuth();
  const { t } = useLanguage();
  const [years, setYears] = useState([]);
  const [yearId, setYearId] = useState('');
  const [periods, setPeriods] = useState([]);
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [startMonth, setStartMonth] = useState('1');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function loadYears(selectId) {
    api
      .getFiscalYears()
      .then((ys) => {
        setYears(ys);
        const id = selectId || yearId || ys[0]?.id;
        if (id) setYearId(String(id));
      })
      .catch((err) => setError(ledgerError(err, t)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => loadYears(), []);

  function loadPeriods(id = yearId) {
    if (!id) return setPeriods([]);
    api.getFiscalPeriods(id).then(setPeriods).catch((err) => setError(ledgerError(err, t)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => loadPeriods(), [yearId]);

  async function createYear() {
    setBusy(true);
    setError(null);
    try {
      const fy = await api.createFiscalYear({ year: Number(newYear), startMonth: Number(startMonth) });
      loadYears(fy.id);
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function act(p, action) {
    const msg = t(`ledger.periods.confirm.${action}`).replace('{period}', `${p.year}/${p.number}`);
    if (!window.confirm(msg)) return;
    if (action === 'lock' && !window.confirm(t('ledger.periods.confirm.lockAgain'))) return;
    setBusy(true);
    setError(null);
    try {
      await api.setFiscalPeriodStatus(p.id, action);
      loadPeriods();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  const canManage = can('manage_fiscal_periods');
  const canLock = can('lock_fiscal_periods');

  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('ledger.periods.title')}</h1>
          <p className="ledger-subtitle">{t('ledger.periods.subtitle')}</p>
        </div>
        {canManage && (
          <div className="ledger-actions">
            <label className="ledger-field">{t('ledger.periods.year')}<input type="number" value={newYear} onChange={(e) => setNewYear(e.target.value)} style={{ width: 100 }} /></label>
            <label className="ledger-field">
              {t('ledger.periods.startMonth')}
              <select value={startMonth} onChange={(e) => setStartMonth(e.target.value)}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            </label>
            <button type="button" className="gold-btn" disabled={busy} onClick={createYear}>{t('ledger.periods.createYear')}</button>
          </div>
        )}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {years.length === 0 ? (
        <div className="ledger-empty">{t('ledger.periods.empty')}</div>
      ) : (
        <>
          <div className="ledger-tabs">
            {years.map((y) => (
              <button key={y.id} type="button" className={`ledger-tab-btn${String(y.id) === yearId ? ' active' : ''}`} onClick={() => setYearId(String(y.id))}>
                {y.year}
              </button>
            ))}
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>{t('ledger.periods.number')}</th>
                  <th>{t('ledger.from')}</th>
                  <th>{t('ledger.to')}</th>
                  <th>{t('ledger.entries.status')}</th>
                  <th className="ledger-num">{t('ledger.periods.posted')}</th>
                  <th className="ledger-num">{t('ledger.periods.drafts')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <td>{p.number}</td>
                    <td>{p.start_date}</td>
                    <td>{p.end_date}</td>
                    <td><span className={`ledger-badge ledger-badge-${p.status}`}>{t(`ledger.periodStatus.${p.status}`)}</span></td>
                    <td className="ledger-num">{p.posted_count}</td>
                    <td className="ledger-num">{p.draft_count}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {p.status === 'open' && canManage && <button type="button" className="ghost-btn" disabled={busy} onClick={() => act(p, 'close')}>{t('ledger.periods.close')}</button>}{' '}
                      {p.status === 'closed' && canManage && <button type="button" className="ghost-btn" disabled={busy} onClick={() => act(p, 'reopen')}>{t('ledger.periods.reopen')}</button>}{' '}
                      {p.status !== 'locked' && canLock && <button type="button" className="danger-btn" disabled={busy} onClick={() => act(p, 'lock')}>{t('ledger.periods.lock')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
