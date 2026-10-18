import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

const BUCKETS = ['b0_30', 'b31_60', 'b61_90', 'b90_plus', 'legacy', 'credits'];
const DOC_LINK = {
  sales_invoice: (id) => `/sales/invoices?id=${id}`,
  customer_receipt: (id) => `/receivables/receipts?id=${id}`,
  open_item: null,
  sales_credit_note: (id) => `/sales/credit-notes?id=${id}`,
};

// Aging, collection forecast, AR reconciliation and receivables settings.
export default function ReceivablesReportsPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'aging';
  const tabs = ['aging', 'forecast', 'reconciliation', ...(can('manage_settings') ? ['settings'] : [])];
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('rec.reports.title')}</h1>
          <p className="ledger-subtitle">{t('rec.reports.subtitle')}</p>
        </div>
      </div>
      <div className="ledger-tabs">
        {tabs.map((k) => <button key={k} type="button" className={`ledger-tab-btn${tab === k ? ' active' : ''}`} onClick={() => setParams({ tab: k })}>{t(`rec.tab.${k}`)}</button>)}
      </div>
      {tab === 'aging' && <AgingTab t={t} params={params} setParams={setParams} />}
      {tab === 'forecast' && <ForecastTab t={t} />}
      {tab === 'reconciliation' && <ReconciliationTab t={t} />}
      {tab === 'settings' && <SettingsTab t={t} />}
    </div>
  );
}

function AgingTab({ t, params, setParams }) {
  const asOf = params.get('asOf') || new Date().toISOString().slice(0, 10);
  const groupBy = params.get('groupBy') || 'customer';
  const shop = params.get('shop');
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const set = (patch) => setParams({ tab: 'aging', asOf, groupBy, ...(shop ? { shop } : {}), ...patch });

  useEffect(() => {
    setData(null);
    api.getAging({ asOf, groupBy }).then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, groupBy]);
  useEffect(() => {
    setDetail(null);
    if (shop) api.getCustomerAging(shop, asOf).then(setDetail).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, asOf]);

  const d = data?.digits ?? 2;
  return (
    <>
      {error && <div className="ledger-error">{error}</div>}
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">{t('rec.asOf')}<input type="date" value={asOf} onChange={(e) => set({ asOf: e.target.value })} /></label>
          <label className="ledger-field">{t('rec.groupBy')}
            <select value={groupBy} onChange={(e) => setParams({ tab: 'aging', asOf, groupBy: e.target.value })}>
              {['customer', 'rep', 'region', 'branch'].map((g) => <option key={g} value={g}>{t(`rec.group.${g}`)}</option>)}
            </select>
          </label>
        </div>
        {data && (
          <div className={`ledger-balance ${data.totals.total === data.control_minor ? 'ledger-balance-ok' : 'ledger-balance-bad'}`} style={{ margin: 0 }}>
            <span>{t('rec.agingTotal')}: <strong>{formatMinor(data.totals.total, d)}</strong></span>
            <span>{t('rec.controlAccount')}: <strong>{formatMinor(data.control_minor, d)}</strong></span>
            {data.unassigned_minor ? <span>{t('rec.unassigned')}: <strong>{formatMinor(data.unassigned_minor, d)}</strong></span> : null}
          </div>
        )}
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => api.downloadAging({ asOf, groupBy, format: 'xlsx' }).catch((err) => setError(ledgerError(err, t)))}>Excel</button>
          <button type="button" className="ghost-btn" onClick={() => api.downloadAging({ asOf, groupBy, format: 'pdf' }).catch((err) => setError(ledgerError(err, t)))}>PDF</button>
        </div>
      </div>
      {!data && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {data && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>{t(`rec.group.${groupBy}`)}</th>{BUCKETS.map((b) => <th key={b} className="ledger-num">{t(`rec.bucket.${b}`)}</th>)}<th className="ledger-num">{t('sales.total')}</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className={groupBy === 'customer' ? 'ledger-row-click' : ''} onClick={() => groupBy === 'customer' && set({ shop: String(r.key) })}>
                  <td>{r.label}{groupBy !== 'customer' ? <span className="ledger-muted"> ({r.customers})</span> : null}</td>
                  {BUCKETS.map((b) => <td key={b} className="ledger-num">{r[b] ? formatMinor(r[b], d) : ''}</td>)}
                  <td className="ledger-num"><strong>{formatMinor(r.total, d)}</strong></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>{t('ledger.total')}</td>{BUCKETS.map((b) => <td key={b} className="ledger-num">{formatMinor(data.totals[b], d)}</td>)}<td className="ledger-num">{formatMinor(data.totals.total, d)}</td></tr></tfoot>
          </table>
        </div>
      )}
      {detail && (
        <div className="card ledger-card" style={{ marginTop: 16 }}>
          <div className="ledger-toolbar">
            <h2 className="atlas-section-title">{detail.shop.name}</h2>
            <Link className="ghost-btn" to={`/sales/customers?tab=ledger&shop=${detail.shop.id}`}>{t('sales.customerLedger')}</Link>
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead><tr><th>{t('sales.document')}</th><th>{t('ledger.entries.date')}</th><th>{t('sales.dueDate')}</th><th className="ledger-num">{t('rec.daysOverdue')}</th><th>{t('rec.bucket')}</th><th className="ledger-num">{t('sales.open')}</th></tr></thead>
              <tbody>
                {detail.items.map((it) => (
                  <tr key={it.key}>
                    <td>{it.document && DOC_LINK[it.document.type] ? <Link to={DOC_LINK[it.document.type](it.document.id)}>{it.number}</Link> : <Link to={`/ledger/entries?id=${it.entry_id}`}>{it.number}</Link>}</td>
                    <td>{it.date}</td><td>{it.due_date}</td><td className="ledger-num">{it.amount_minor > 0 ? it.days_overdue : ''}</td>
                    <td>{t(`rec.bucket.${it.bucket}`)}</td><td className="ledger-num">{formatMinor(it.amount_minor, detail.digits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function ForecastTab({ t }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getCollectionForecast(12).then(setData).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  const d = data.digits;
  const max = Math.max(1, ...data.weeks.map((w) => w.amount_minor));
  return (
    <>
      <p className="ledger-hint">{t('rec.forecast.hint')} ({t('rec.forecast.companyDelay')}: {data.company_delay_days})</p>
      <div className="ledger-table-wrap">
        <table className="ledger-table">
          <thead><tr><th>{t('rec.forecast.week')}</th><th className="ledger-num">{t('rec.forecast.expected')}</th><th className="ledger-num">{t('rec.forecast.items')}</th><th style={{ width: '40%' }} /></tr></thead>
          <tbody>
            {data.weeks.map((w) => (
              <tr key={w.week_start}>
                <td>{w.week_start === 'later' ? t('rec.forecast.later') : w.week_start}</td>
                <td className="ledger-num">{formatMinor(w.amount_minor, d)}</td><td className="ledger-num">{w.items}</td>
                <td><div style={{ height: 10, borderRadius: 4, background: 'var(--atlas-positive)', width: `${(w.amount_minor / max) * 100}%`, opacity: 0.7 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="atlas-section-title" style={{ marginTop: 20 }}>{t('rec.forecast.byCustomer')}</h2>
      <div className="ledger-table-wrap">
        <table className="ledger-table">
          <thead><tr><th>{t('sales.customer')}</th><th className="ledger-num">{t('rec.forecast.delay')}</th><th className="ledger-num">{t('sales.open')}</th></tr></thead>
          <tbody>{data.customers.map((c) => <tr key={c.shop_id}><td>{c.shop_name}</td><td className="ledger-num">{c.delay_days}</td><td className="ledger-num">{formatMinor(c.open_minor, d)}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

function ReconciliationTab({ t }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.getArReconciliation().then(setData).catch((err) => setError(ledgerError(err, t)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  if (!data) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  const c = data.current;
  const d = c.digits;
  return (
    <>
      <div className="ledger-toolbar">
        <div className={`ledger-balance ${c.difference_minor === 0 && !c.differences.length ? 'ledger-balance-ok' : 'ledger-balance-bad'}`} style={{ margin: 0 }}>
          <span>{t('rec.controlAccount')}: <strong>{formatMinor(c.control_minor, d)}</strong></span>
          <span>{t('rec.subledgerTotal')}: <strong>{formatMinor(c.subledger_minor, d)}</strong></span>
          <span>{t('ledger.form.difference')}: <strong>{formatMinor(c.difference_minor, d)}</strong></span>
        </div>
        <button type="button" className="ghost-btn" onClick={() => api.runArReconciliation().then(load)}>{t('rec.runCheck')}</button>
      </div>
      {c.differences.length === 0 && <div className="ledger-notice">{t('rec.reconciled')}</div>}
      {c.differences.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>{t('rec.diffType')}</th><th>{t('sales.customer')}</th><th className="ledger-num">{t('sales.ledgerBalance')}</th><th className="ledger-num">{t('sales.displayedBalance')}</th><th className="ledger-num">{t('ledger.form.difference')}</th></tr></thead>
            <tbody>
              {c.differences.map((x, i) => (
                <tr key={i} className="ledger-row-error">
                  <td>{t(`rec.diff.${x.type}`)}</td><td>{x.shop_name || t('rec.noCustomer')}</td>
                  <td className="ledger-num">{formatMinor(x.ledger_minor, d)}</td><td className="ledger-num">{x.displayed_minor !== undefined ? formatMinor(x.displayed_minor, d) : '—'}</td>
                  <td className="ledger-num">{formatMinor(x.difference_minor, d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2 className="atlas-section-title" style={{ marginTop: 20 }}>{t('rec.dailyHistory')}</h2>
      <ul>{data.history.map((h) => <li key={h.id}>{h.check_date} · {t('ledger.form.difference')} {formatMinor(h.difference_minor, d)} · {h.difference_count}</li>)}</ul>
    </>
  );
}

function SettingsTab({ t }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.getReceivablesSettings().then(setS).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!s) return error ? <div className="ledger-error">{error}</div> : <div className="ledger-loading">{t('ledger.loading')}</div>;
  return (
    <div className="card ledger-card">
      {error && <div className="ledger-error">{error}</div>}
      {saved && <div className="ledger-notice">{t('rec.settings.saved')}</div>}
      <label className="ledger-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={s.receiptAutoAllocate} onChange={(e) => setS({ ...s, receiptAutoAllocate: e.target.checked })} /> {t('rec.settings.autoAllocate')}
      </label>
      <label className="ledger-field">{t('rec.settings.creditPolicy')}
        <select value={s.invoiceCreditPolicy} onChange={(e) => setS({ ...s, invoiceCreditPolicy: e.target.value })}>
          <option value="warn">{t('rec.settings.warn')}</option>
          <option value="block">{t('rec.settings.block')}</option>
        </select>
      </label>
      <label className="ledger-field" style={{ marginTop: 12 }}>{t('rec.settings.legacyPolicy')}
        <select value={s.legacyDebtPolicy} onChange={(e) => setS({ ...s, legacyDebtPolicy: e.target.value })}>
          <option value="overdue">{t('rec.settings.legacyOverdue')}</option>
          <option value="current">{t('rec.settings.legacyCurrent')}</option>
        </select>
      </label>
      <label className="ledger-field" style={{ marginTop: 12 }}>{t('rec.settings.overdueDays')}<input type="number" value={s.overdueInvoiceDays} onChange={(e) => setS({ ...s, overdueInvoiceDays: e.target.value })} /></label>
      <button type="button" className="gold-btn" style={{ marginTop: 12 }} onClick={() => api.saveReceivablesSettings(s).then(() => setSaved(true)).catch((err) => setError(ledgerError(err, t)))}>{t('ledger.save')}</button>
    </div>
  );
}
