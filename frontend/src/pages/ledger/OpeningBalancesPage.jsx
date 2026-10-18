import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { accountLabel, formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

const emptyRow = () => ({ accountId: '', debit: '', credit: '' });

// Opening balances: ONE posted entry per fiscal year, dated at its start.
// Rows come from the manual grid or from an Excel trial balance; either way
// the server preview is the review step before posting.
export default function OpeningBalancesPage() {
  const { can } = useAuth();
  const { t } = useLanguage();
  const [meta, setMeta] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [years, setYears] = useState([]);
  const [existing, setExisting] = useState([]);
  const [yearId, setYearId] = useState('');
  const [rows, setRows] = useState([emptyRow(), emptyRow(), emptyRow()]);
  const [preview, setPreview] = useState(null);
  const [plug, setPlug] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const canManage = can('manage_opening_balances');

  function loadExisting() {
    api.getOpeningBalanceEntries().then(setExisting).catch(() => {});
  }

  useEffect(() => {
    Promise.all([api.getLedgerMeta(), api.getLedgerAccounts(), api.getFiscalYears()])
      .then(([m, a, ys]) => {
        setMeta(m);
        setAccounts(a.filter((x) => x.is_postable && x.is_active));
        setYears(ys);
        if (ys[0]) setYearId(String(ys[ys.length - 1].id));
      })
      .catch((err) => setError(ledgerError(err, t)));
    loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const digits = meta?.base_currency?.minor_unit_digits ?? 2;
  const manualRows = () => rows.filter((r) => r.accountId).map((r) => ({ accountId: Number(r.accountId), debit: r.debit, credit: r.credit }));

  async function runPreview(source = manualRows()) {
    setError(null);
    setNotice(null);
    try {
      setPreview(await api.previewOpeningBalances(source));
      setPlug(false);
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const p = await api.uploadOpeningBalances(file);
      setPreview(p);
      setPlug(false);
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (!preview || !yearId) return;
    setBusy(true);
    setError(null);
    try {
      const rowsToPost = preview.rows.filter((r) => !r.skipped).map((r) => ({ accountId: r.accountId, debit: r.debit, credit: r.credit }));
      const entry = await api.postOpeningBalances({ fiscalYearId: Number(yearId), rows: rowsToPost, plugToOpeningEquity: plug });
      setNotice(`${t('ledger.opening.posted')} ${entry.entry_number}`);
      setPreview(null);
      setRows([emptyRow(), emptyRow(), emptyRow()]);
      loadExisting();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!meta && !error) return <div className="ledger-page"><div className="ledger-loading">{t('ledger.loading')}</div></div>;
  const balanced = preview && preview.difference_minor === 0;
  const canPost = preview && preview.error_count === 0 && (balanced || (plug && preview.opening_equity_account));

  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('ledger.opening.title')}</h1>
          <p className="ledger-subtitle">{t('ledger.opening.subtitle')}</p>
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}

      {existing.length > 0 && (
        <div className="card ledger-card">
          <h2 className="atlas-section-title">{t('ledger.opening.existing')}</h2>
          <ul>
            {existing.map((e) => (
              <li key={e.id}>
                <Link to={`/ledger/entries?id=${e.id}`}>{e.entry_number}</Link> · {e.entry_date} · {t(`ledger.status.${e.status}`)}
                {e.status === 'posted' && !e.reverses_entry_id && canManage && can('reverse_journal_entries') && (
                  <> · <button type="button" className="ghost-btn" onClick={() => {
                    const reason = window.prompt(t('ledger.opening.reversePrompt'));
                    if (reason) api.reverseOpeningBalances(e.id, reason).then(loadExisting).catch((err) => setError(ledgerError(err, t)));
                  }}>{t('ledger.detail.reverse')}</button></>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {years.length === 0 ? (
        <div className="ledger-empty">{t('ledger.opening.noYear')} <Link to="/ledger/periods">{t('nav.ledgerPeriods')}</Link></div>
      ) : canManage && (
        <>
          <div className="ledger-toolbar">
            <div className="ledger-filters">
              <label className="ledger-field">
                {t('ledger.periods.year')}
                <select value={yearId} onChange={(e) => setYearId(e.target.value)}>
                  {years.map((y) => <option key={y.id} value={y.id}>{y.year} ({y.start_date})</option>)}
                </select>
              </label>
            </div>
            <div className="ledger-actions">
              <label className="ghost-btn" style={{ cursor: 'pointer' }}>
                {t('ledger.opening.uploadExcel')}
                <input type="file" accept=".xlsx" hidden onChange={upload} disabled={busy} />
              </label>
            </div>
          </div>
          <p className="ledger-hint">{t('ledger.opening.excelHint')}</p>

          {!preview && (
            <div className="card ledger-card">
              <div className="ledger-table-wrap">
                <table className="ledger-table ledger-lines-table">
                  <thead>
                    <tr><th>{t('ledger.entries.account')}</th><th>{t('ledger.debit')}</th><th>{t('ledger.credit')}</th><th /></tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <select value={r.accountId} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                            <option value="">—</option>
                            {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                          </select>
                        </td>
                        <td><input dir="ltr" value={r.debit} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x)))} /></td>
                        <td><input dir="ltr" value={r.credit} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x)))} /></td>
                        <td>{rows.length > 1 && <button type="button" className="ghost-btn" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ledger-actions" style={{ marginTop: 10 }}>
                <button type="button" className="ghost-btn" onClick={() => setRows((rs) => [...rs, emptyRow()])}>{t('ledger.form.addLine')}</button>
                <button type="button" className="gold-btn" onClick={() => runPreview()}>{t('ledger.opening.review')}</button>
              </div>
            </div>
          )}

          {preview && (
            <div className="card ledger-card">
              <h2 className="atlas-section-title">{t('ledger.opening.reviewTitle')}</h2>
              <div className="ledger-table-wrap">
                <table className="ledger-table">
                  <thead>
                    <tr><th>#</th><th>{t('ledger.entries.account')}</th><th className="ledger-num">{t('ledger.debit')}</th><th className="ledger-num">{t('ledger.credit')}</th><th>{t('ledger.opening.errors')}</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className={r.errors.length ? 'ledger-row-error' : r.skipped ? 'ledger-inactive' : ''}>
                        <td>{r.row}</td>
                        <td>{r.accountCode} {r.accountName ? `— ${r.accountName}` : ''}</td>
                        <td className="ledger-num">{r.debitMinor ? formatMinor(r.debitMinor, digits) : ''}</td>
                        <td className="ledger-num">{r.creditMinor ? formatMinor(r.creditMinor, digits) : ''}</td>
                        <td>{r.errors.join('، ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={`ledger-balance ${balanced ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>
                <span>{t('ledger.form.totalDebit')}: <strong>{formatMinor(preview.total_debit_minor, digits)}</strong></span>
                <span>{t('ledger.form.totalCredit')}: <strong>{formatMinor(preview.total_credit_minor, digits)}</strong></span>
                <span>{t('ledger.form.difference')}: <strong>{formatMinor(preview.difference_minor, digits)}</strong> {preview.base_currency}</span>
              </div>
              {preview.error_count > 0 && <div className="ledger-error">{t('ledger.opening.fixErrors')}</div>}
              {!balanced && preview.error_count === 0 && (
                preview.opening_equity_account ? (
                  <label className="ledger-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <input type="checkbox" checked={plug} onChange={(e) => setPlug(e.target.checked)} />
                    {t('ledger.opening.plug')} {preview.opening_equity_account.code} — {preview.opening_equity_account.name_ar}
                  </label>
                ) : (
                  <div className="ledger-error">{t('ledger.error.missing_system_account')}</div>
                )
              )}
              <div className="ledger-actions">
                <button type="button" className="ghost-btn" onClick={() => setPreview(null)}>{t('ledger.back')}</button>
                <button type="button" className="gold-btn" disabled={busy || !canPost} onClick={post}>{t('ledger.opening.post')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
