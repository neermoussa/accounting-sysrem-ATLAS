import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import { DrillLink } from './DrillLink.jsx';
import '../../styles/ledger.css';

const TABS = ['balances', 'fx', 'revaluation'];
const today = () => new Date().toISOString().slice(0, 10);
const monthEnd = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
};

// Multi-currency reports (Prompt 5): balances by currency, FX gain/loss,
// and the period-end revaluation (preview, then post + automatic reversal).
export default function CurrencyReportsPage() {
  const { t } = useLanguage();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'balances';
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('fx.reports.title')}</h1>
          <p className="ledger-subtitle">{t('fx.reports.subtitle')}</p>
        </div>
        <Link className="ghost-btn" to="/ledger/exchange-rates">{t('nav.exchangeRates')}</Link>
      </div>
      <div className="ledger-tabs">
        {TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`fx.tab.${k}`)}</button>)}
      </div>
      {tab === 'balances' && <Balances t={t} />}
      {tab === 'fx' && <FxReport t={t} />}
      {tab === 'revaluation' && <Revaluation t={t} />}
    </div>
  );
}

function Balances({ t }) {
  const [asOf, setAsOf] = useState(today());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setData(null);
    api.getCurrencyBalances({ asOf }).then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf]);
  const dg = (c) => data?.digits?.[c] ?? 2;
  return (
    <>
      <div className="ledger-toolbar">
        <label className="ledger-field">{t('fr.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => api.downloadCurrencyBalances({ asOf, format: 'xlsx' })}>Excel</button>
          <button type="button" className="ghost-btn" onClick={() => api.downloadCurrencyBalances({ asOf, format: 'pdf' })}>PDF</button>
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {data && (
        <>
          <div className="card ledger-card">
            <h2 className="atlas-section-title">{t('fx.totalsByCurrency')}</h2>
            <table className="ledger-table">
              <thead><tr><th>{t('ledger.form.currency')}</th><th className="ledger-num">{t('fx.balanceInCurrency')}</th><th className="ledger-num">{t('fx.balanceInBase')} ({data.base_currency})</th></tr></thead>
              <tbody>{data.receivable_totals.map((r) => <tr key={r.currency_code}><td>{r.currency_code}</td><td className="ledger-num">{formatMinor(r.balance_minor, dg(r.currency_code))}</td><td className="ledger-num">{formatMinor(r.base_minor, dg(data.base_currency))}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="card ledger-card">
            <h2 className="atlas-section-title">{t('fx.customers')}</h2>
            <div className="ledger-table-wrap">
              <table className="ledger-table">
                <thead><tr><th>{t('sales.customer')}</th><th>{t('ledger.form.currency')}</th><th className="ledger-num">{t('fx.balanceInCurrency')}</th><th className="ledger-num">{t('fx.balanceInBase')}</th></tr></thead>
                <tbody>{data.customers.map((c) => (
                  <tr key={`${c.shop_id}-${c.currency_code}`}><td><Link to={`/sales/customers?shop=${c.shop_id}`}>{c.shop_name}</Link></td><td>{c.currency_code}</td><td className="ledger-num">{formatMinor(c.balance_minor, dg(c.currency_code))}</td><td className="ledger-num">{formatMinor(c.base_minor, dg(data.base_currency))}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          {data.accounts.length > 0 && (
            <div className="card ledger-card">
              <h2 className="atlas-section-title">{t('fx.foreignAccounts')}</h2>
              <table className="ledger-table">
                <thead><tr><th>{t('fr.account')}</th><th>{t('ledger.form.currency')}</th><th className="ledger-num">{t('fx.balanceInCurrency')}</th><th className="ledger-num">{t('fx.balanceInBase')}</th></tr></thead>
                <tbody>{data.accounts.map((a) => (
                  <tr key={`${a.account_id}-${a.currency_code}`}><td><DrillLink drill={{ accountId: a.account_id, from: '1900-01-01', to: asOf }}>{a.code} {a.name_ar}</DrillLink></td><td>{a.currency_code}</td><td className="ledger-num">{formatMinor(a.original_minor, dg(a.currency_code))}</td><td className="ledger-num">{formatMinor(a.base_minor, dg(data.base_currency))}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function FxReport({ t }) {
  const [q, setQ] = useState({ from: `${today().slice(0, 4)}-01-01`, to: today() });
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.getLedgerMeta().then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    setData(null);
    api.getFxReport(q).then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const d = meta?.base_currency?.minor_unit_digits ?? 2;
  return (
    <>
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">{t('fr.from')}<input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
          <label className="ledger-field">{t('fr.to')}<input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => api.downloadFxReport({ ...q, format: 'xlsx' })}>Excel</button>
          <button type="button" className="ghost-btn" onClick={() => api.downloadFxReport({ ...q, format: 'pdf' })}>PDF</button>
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {data && (
        <div className="card ledger-card">
          <div className="ledger-balance ledger-balance-ok">
            <span>{t('fx.kind.realized')}: <strong>{formatMinor(data.totals.realized, d)}</strong></span>
            <span>{t('fx.kind.unrealized')}: <strong>{formatMinor(data.totals.unrealized, d)}</strong></span>
            <span>{t('fx.net')}: <strong>{formatMinor(data.totals.net, d)}</strong></span>
          </div>
          <table className="ledger-table">
            <thead><tr><th>{t('fr.date')}</th><th>{t('fr.entry')}</th><th>{t('fx.kindLabel')}</th><th>{t('fr.account')}</th><th>{t('fr.description')}</th><th className="ledger-num">{t('fx.gainLoss')}</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={`${r.entry_id}-${r.gain_minor}`}>
                <td>{r.entry_date}</td>
                <td><Link to={`/ledger/entries?id=${r.entry_id}`}>{r.entry_number}</Link></td>
                <td>{t(`fx.kind.${r.kind}`)}</td>
                <td>{data.accounts?.[r.account === 'fx_unrealized' ? 'unrealized' : 'realized']?.code}</td>
                <td>{r.document ? <><Link to={`/sales/invoices?id=${r.document.invoice_id}`}>{r.document.invoice_number}</Link> ← <Link to={`/receivables/receipts?id=${r.document.receipt_id}`}>{r.document.receipt_number}</Link></> : r.description}</td>
                <td className="ledger-num"><DrillLink drill={{ accountId: r.account_id, from: r.entry_date, to: r.entry_date }}>{formatMinor(r.gain_minor, d)}</DrillLink></td>
              </tr>
            ))}</tbody>
          </table>
          {data.rows.length === 0 && <div className="ledger-empty">{t('fx.noFx')}</div>}
        </div>
      )}
    </>
  );
}

function Revaluation({ t }) {
  const { can } = useAuth();
  const [asOf, setAsOf] = useState(monthEnd());
  const [preview, setPreview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.getRevaluations().then(setRuns).catch(() => {});
  useEffect(() => {
    load();
    api.getLedgerMeta().then(setMeta).catch(() => {});
  }, []);
  const d = meta?.base_currency?.minor_unit_digits ?? 2;
  const dg = (c) => meta?.currencies?.find((x) => x.code === c)?.minor_unit_digits ?? 2;
  async function run(fn) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="ledger-toolbar">
        <label className="ledger-field">{t('fx.revalueAt')}<input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setPreview(null); }} /></label>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => run(async () => setPreview(await api.previewRevaluation(asOf)))}>{t('fx.preview')}</button>
          {can('run_fx_revaluation') && preview && preview.lines.length > 0 && !preview.already_posted && (
            <button type="button" className="gold-btn" disabled={busy || preview.missing_rates.length > 0} onClick={() => window.confirm(t('fx.postConfirm').replace('{date}', preview.reversal_date)) && run(async () => {
              const r = await api.postRevaluation(asOf);
              setNotice(`${t('fx.posted')} ${r.journal_entry.entry_number} · ${t('fx.reversal')} ${r.reversal_entry.entry_number}`);
              setPreview(null);
              load();
            })}>{t('fx.post')}</button>
          )}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {preview && (
        <div className="card ledger-card">
          {preview.missing_rates.length > 0 && <div className="ledger-error">{t('fx.missingRates')}: {preview.missing_rates.join('، ')}</div>}
          {preview.already_posted && <div className="ledger-error">{t('fx.alreadyPosted')}</div>}
          <p className="ledger-hint">{t('fx.previewHint').replace('{date}', preview.reversal_date)}</p>
          <table className="ledger-table">
            <thead><tr><th>{t('fx.item')}</th><th>{t('ledger.form.currency')}</th><th className="ledger-num">{t('fx.balanceInCurrency')}</th><th className="ledger-num">{t('fx.carrying')}</th><th className="ledger-num">{t('fx.closingRate')}</th><th className="ledger-num">{t('fx.revalued')}</th><th className="ledger-num">{t('fx.difference')}</th></tr></thead>
            <tbody>{preview.lines.map((l) => (
              <tr key={`${l.kind}-${l.document_id || l.account_id}-${l.currency_code}`}>
                <td>{l.kind === 'account' ? `${l.number} ${l.name}` : `${l.number} — ${l.shop_name}`}</td>
                <td>{l.currency_code}</td>
                <td className="ledger-num">{formatMinor(l.open_minor, dg(l.currency_code))}</td>
                <td className="ledger-num">{formatMinor(l.carrying_base_minor, d)}</td>
                <td className="ledger-num" dir="ltr">{l.closing_rate}</td>
                <td className="ledger-num">{formatMinor(l.revalued_base_minor, d)}</td>
                <td className="ledger-num">{formatMinor(l.difference_minor, d)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th colSpan={6}>{t('fx.net')}</th><th className="ledger-num">{formatMinor(preview.total_minor, d)}</th></tr></tfoot>
          </table>
          {preview.lines.length === 0 && <div className="ledger-empty">{t('fx.nothing')}</div>}
        </div>
      )}
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('fx.runs')}</h2>
        <table className="ledger-table">
          <thead><tr><th>{t('fx.revalueAt')}</th><th>{t('fr.entry')}</th><th>{t('fx.reversal')}</th><th className="ledger-num">{t('fx.net')}</th></tr></thead>
          <tbody>{runs.map((r) => (
            <tr key={r.id}><td>{r.as_of}</td><td><Link to={`/ledger/entries?id=${r.journal_entry_id}`}>{r.entry_number}</Link></td><td><Link to={`/ledger/entries?id=${r.reversal_entry_id}`}>{r.reversal_entry_number}</Link> ({r.reversal_date})</td><td className="ledger-num">{formatMinor(r.total_minor, d)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}
