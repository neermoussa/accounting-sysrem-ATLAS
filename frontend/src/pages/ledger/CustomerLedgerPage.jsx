import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

// The accounting app has no customer detail page of its own (shops live in
// the sales app), so the "Customer ledger" tab lives here: pick a customer,
// see every receivable line. Plus the Amin reconciliation and go-live tabs.
const SOURCE_LINK = {
  sales_invoice: (id) => `/sales/invoices?id=${id}`,
  sales_credit_note: (id) => `/sales/credit-notes?id=${id}`,
};

export default function CustomerLedgerPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'ledger';
  const tabs = ['ledger', ...(can('view_ledger') ? ['reconciliation'] : []), ...(can('manage_settings') ? ['go-live'] : [])];
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('sales.customerLedger')}</h1>
          <p className="ledger-subtitle">{t('sales.customerLedgerHint')}</p>
        </div>
      </div>
      <div className="ledger-tabs">
        {tabs.map((k) => (
          <button key={k} type="button" className={`ledger-tab-btn${tab === k ? ' active' : ''}`} onClick={() => setParams({ tab: k })}>{t(`sales.tab.${k}`)}</button>
        ))}
      </div>
      {tab === 'ledger' && <LedgerTab t={t} params={params} setParams={setParams} />}
      {tab === 'reconciliation' && <ReconciliationTab t={t} />}
      {tab === 'go-live' && <GoLiveTab t={t} />}
    </div>
  );
}

function LedgerTab({ t, params, setParams }) {
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const shopId = params.get('shop') || '';

  useEffect(() => {
    api.getSalesMeta().then(setMeta).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setData(null);
    if (shopId) api.getCustomerLedger(shopId).then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  if (!meta) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  const d = meta.base_currency.minor_unit_digits;
  return (
    <>
      {error && <div className="ledger-error">{error}</div>}
      <div className="ledger-toolbar">
        <label className="ledger-field">
          {t('sales.customer')}
          <select value={shopId} onChange={(e) => setParams({ tab: 'ledger', shop: e.target.value })}>
            <option value="">—</option>
            {meta.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {data && (
          <div className="ledger-balance ledger-balance-ok" style={{ margin: 0 }}>
            <span>{t('sales.ledgerBalance')}: <strong>{formatMinor(data.balance_minor, d)}</strong></span>
            <span>{t('sales.displayedBalance')}: <strong>{data.displayed_balance ? data.displayed_balance.balance : '—'}</strong></span>
          </div>
        )}
      </div>
      {!meta.live && <div className="ledger-notice">{t('sales.live.off')}</div>}
      {shopId && <StatementBar t={t} shopId={shopId} />}
      {data && data.lines.length === 0 && <div className="ledger-empty">{t('sales.noLines')}</div>}
      {data && data.lines.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr><th>{t('ledger.entries.date')}</th><th>{t('ledger.entries.number')}</th><th>{t('ledger.entries.description')}</th><th>{t('sales.document')}</th><th className="ledger-num">{t('ledger.debit')}</th><th className="ledger-num">{t('ledger.credit')}</th><th className="ledger-num">{t('sales.running')}</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.entry_date}</td>
                  <td><Link to={`/ledger/entries?id=${l.entry_id}`}>{l.entry_number}</Link></td>
                  <td>{l.description}</td>
                  <td>{SOURCE_LINK[l.source_type] ? <Link to={SOURCE_LINK[l.source_type](l.source_id)}>{l.source_number || l.source_id}</Link> : t(`ledger.source.${l.source_type}`)}</td>
                  <td className="ledger-num">{l.debit_minor ? formatMinor(l.debit_minor, d) : ''}</td>
                  <td className="ledger-num">{l.credit_minor ? formatMinor(l.credit_minor, d) : ''}</td>
                  <td className="ledger-num">{formatMinor(l.running_minor, d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Customer statement from the ledger: Excel / PDF via the existing export
// code, and WhatsApp sending (needs send_account_statements).
function StatementBar({ t, shopId }) {
  const { can } = useAuth();
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const [range, setRange] = useState({ from: yearStart, to: new Date().toISOString().slice(0, 10) });
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const run = (fn) => { setMsg(null); setError(null); fn().catch((err) => setError(ledgerError(err, t))); };
  return (
    <div className="card ledger-card">
      <div className="ledger-toolbar" style={{ marginBottom: 0 }}>
        <div className="ledger-filters">
          <span className="atlas-card-title">{t('rec.statement')}</span>
          <label className="ledger-field">{t('ledger.from')}<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="ledger-field">{t('ledger.to')}<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => run(() => api.downloadCustomerStatement(shopId, { ...range, format: 'xlsx' }))}>Excel</button>
          <button type="button" className="ghost-btn" onClick={() => run(() => api.downloadCustomerStatement(shopId, { ...range, format: 'pdf' }))}>PDF</button>
          {can('send_account_statements') && (
            <button type="button" className="gold-btn" onClick={() => window.confirm(t('rec.statementSendConfirm')) && run(async () => {
              const r = await api.sendCustomerStatement(shopId, range);
              setMsg(r.sent ? t('rec.statementSent') : t('rec.statementLogged'));
            })}>{t('rec.statementSend')}</button>
          )}
        </div>
      </div>
      {msg && <div className="ledger-notice" style={{ marginTop: 10 }}>{msg}</div>}
      {error && <div className="ledger-error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}

function ReconciliationTab({ t }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getSalesReconciliation().then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  const rows = data.rows.filter((r) => r.external_minor !== null || r.ledger_minor !== 0);
  return (
    <>
      <p className="ledger-hint">{t('sales.reconciliationHint')}</p>
      <div className={data.mismatches ? 'ledger-error' : 'ledger-notice'}>{t('sales.mismatches')}: {data.mismatches}</div>
      <div className="ledger-table-wrap">
        <table className="ledger-table">
          <thead><tr><th>{t('sales.customer')}</th><th className="ledger-num">{t('sales.ledgerBalance')}</th><th className="ledger-num">{t('sales.externalBalance')}</th><th>{t('sales.externalDate')}</th><th className="ledger-num">{t('ledger.form.difference')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shop_id} className={r.difference_minor ? 'ledger-row-error' : ''}>
                <td>{r.shop_name}</td><td className="ledger-num">{r.ledger}</td><td className="ledger-num">{r.external ?? '—'}</td>
                <td>{r.external_date || '—'}</td><td className="ledger-num">{r.difference_minor === null ? '—' : r.difference_minor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Go-live open items: customer, invoice number, invoice date, due date,
// amount. Staged after validation; the next dry run uses it.
function OpenItemsCard({ t, onChange }) {
  const [staged, setStaged] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.getOpenItemsImport().then(setStaged).catch((err) => setError(ledgerError(err, t)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      setResult(await api.uploadOpenItems(file));
    } catch (err) {
      if (err?.detail?.rows) setResult(err.detail);
      setError(ledgerError(err, t));
    }
    load();
    onChange();
  }
  const customers = result?.customers || staged?.customers || [];
  return (
    <div className="card ledger-card">
      <h2 className="atlas-section-title">{t('sales.openItems.title')}</h2>
      <p className="ledger-hint">{t('sales.openItems.hint')}</p>
      {error && <div className="ledger-error">{error}</div>}
      {staged?.import && <div className="ledger-notice">{t('sales.openItems.staged')}: {staged.import.filename} · {staged.import.row_count}</div>}
      <div className="ledger-actions" style={{ marginBottom: 12 }}>
        <label className="ghost-btn" style={{ cursor: 'pointer' }}>{t('sales.openItems.upload')}<input type="file" accept=".xlsx" hidden onChange={upload} /></label>
        {staged?.import && <button type="button" className="ghost-btn" onClick={() => api.discardOpenItems().then(() => { setResult(null); load(); onChange(); })}>{t('sales.openItems.discard')}</button>}
      </div>
      {result?.rows?.some((r) => r.errors.length) && (
        <div className="ledger-table-wrap" style={{ marginBottom: 12 }}>
          <table className="ledger-table">
            <thead><tr><th>#</th><th>{t('sales.customer')}</th><th>{t('sales.invoices.number')}</th><th>{t('sales.opening.errors')}</th></tr></thead>
            <tbody>{result.rows.filter((r) => r.errors.length).map((r) => <tr key={r.row} className="ledger-row-error"><td>{r.row}</td><td>{r.shop_name || '—'}</td><td>{r.invoice_number}</td><td>{r.errors.join('، ')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {customers.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>{t('sales.customer')}</th><th className="ledger-num">{t('sales.goLive.openItems')}</th><th className="ledger-num">{t('sales.goLive.snapshot')}</th><th className="ledger-num">{t('sales.goLive.legacy')}</th></tr></thead>
            <tbody>{customers.map((c) => <tr key={c.shop_id} className={c.warning ? 'ledger-row-error' : ''}><td>{c.shop_name}</td><td className="ledger-num">{c.items} · {c.items_minor}</td><td className="ledger-num">{c.snapshot_minor}</td><td className="ledger-num">{c.difference}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GoLiveTab({ t }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [info, setInfo] = useState(null);
  const [plan, setPlan] = useState(null);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadRuns = () => api.getGoLiveRuns().then(setInfo).catch((err) => setError(ledgerError(err, t)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadRuns(); }, []);

  async function dryRun() {
    setError(null);
    setResult(null);
    setTyped('');
    try {
      setPlan(await api.goLiveDryRun(date));
      loadRuns();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }
  async function execute() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.executeGoLive(plan.dry_run_id, typed));
      setPlan(null);
      loadRuns();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  const sentence = info?.confirmation_text || '';
  return (
    <>
      <p className="ledger-hint">{t('sales.goLive.hint')}</p>
      {error && <div className="ledger-error">{error}</div>}
      {result && (
        <div className="ledger-notice">
          {t('sales.goLive.done')} ({result.customers})<br />
          {t('sales.goLive.backupAt')}: <code dir="ltr">{result.backup_path}</code>
        </div>
      )}
      {info?.live && !result && <div className="ledger-notice">{t('sales.live.on')}</div>}
      {!info?.live && <OpenItemsCard t={t} onChange={() => setPlan(null)} />}
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">{t('sales.goLive.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button type="button" className="ghost-btn" onClick={dryRun}>{t('sales.goLive.dryRun')}</button>
        </div>
      </div>
      {plan && (
        <div className="card ledger-card">
          <h2 className="atlas-section-title">{t('sales.goLive.report')} #{plan.dry_run_id}</h2>
          {plan.problems.map((p) => <div key={p.code} className="ledger-error">{p.message}</div>)}
          <p>{t('sales.goLive.summary')}: {plan.customers} · {plan.total}</p>
          {plan.stock_mode && <div className="ledger-balance">{t('sales.goLive.stockMode')}: <strong>{t(`sales.goLive.stockMode.${plan.stock_mode.mode}`)}</strong></div>}
          {(plan.settings_changes || []).length > 0 && (
            <div className="ledger-balance">{t('sales.goLive.settingsChanges')}: {plan.settings_changes.map((c) => c.message).join(' — ')}</div>
          )}
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead><tr><th>{t('sales.customer')}</th><th>{t('sales.externalDate')}</th><th className="ledger-num">{t('sales.goLive.snapshot')}</th><th className="ledger-num">{t('sales.goLive.existing')}</th><th className="ledger-num">{t('sales.goLive.openItems')}</th><th className="ledger-num">{t('sales.goLive.legacy')}</th><th className="ledger-num">{t('sales.goLive.opening')}</th></tr></thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.shop_id} className={r.legacy_minor < 0 ? 'ledger-row-error' : ''}><td>{r.shop_name}</td><td>{r.snapshot_date || '—'}</td><td className="ledger-num">{r.snapshot_minor}</td><td className="ledger-num">{r.existing_ledger_minor}</td><td className="ledger-num">{r.items?.length ? `${r.items.length} · ${r.items_minor}` : '—'}</td><td className="ledger-num">{r.legacy}</td><td className="ledger-num">{r.opening}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.ok && (
            <>
              <p className="ledger-hint" style={{ marginTop: 12 }}>{t('sales.goLive.typeToConfirm')}</p>
              <p><code dir="ltr">{sentence}</code></p>
              <input dir="ltr" style={{ width: '100%' }} value={typed} onChange={(e) => setTyped(e.target.value)} />
              <div className="ledger-actions" style={{ marginTop: 12 }}>
                <button type="button" className="danger-btn" disabled={busy || typed !== sentence} onClick={execute}>{t('sales.goLive.execute')}</button>
              </div>
            </>
          )}
        </div>
      )}
      {info && info.runs.length > 0 && (
        <div className="card ledger-card">
          <h2 className="atlas-section-title">{t('sales.goLive.history')}</h2>
          <ul>
            {info.runs.map((r) => (
              <li key={r.id}>#{r.id} · {t(`sales.goLive.kind.${r.kind}`)} · {r.go_live_date} · {r.created_at}{r.backup_path ? <> · <code dir="ltr">{r.backup_path}</code></> : null}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
