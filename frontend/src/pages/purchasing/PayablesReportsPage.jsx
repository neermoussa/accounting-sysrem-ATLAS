import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError } from '../ledger/ledgerShared.js';
import { DrillLink } from '../ledger/DrillLink.jsx';
import { baseMoney, money } from './purchasingShared.jsx';
import '../../styles/ledger.css';

const TABS = ['aging', 'ppv', 'purchases', 'ratings'];
const BUCKETS = ['current', 'b1_30', 'b31_60', 'b61_90', 'b90_plus', 'legacy', 'advances'];
const today = () => new Date().toISOString().slice(0, 10);

// Payables reports (Prompt 6): aging (= AP control), purchase price
// variance (= PPV account), purchases by supplier / item, supplier ratings.
export default function PayablesReportsPage() {
  const { t } = useLanguage();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'aging';
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [q, setQ] = useState({ asOf: today(), from: `${today().slice(0, 4)}-01-01`, to: today(), by: 'supplier' });
  const [error, setError] = useState(null);
  useEffect(() => { api.purGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t))); }, []);
  useEffect(() => {
    setData(null);
    const path = { aging: '/reports/aging', ppv: '/reports/ppv', purchases: '/reports/purchases', ratings: '/reports/ratings' }[tab];
    const params = tab === 'aging' ? { asOf: q.asOf } : tab === 'ratings' ? {} : { from: q.from, to: q.to, by: q.by };
    api.purGet(path, params).then((d) => setData({ tab, d })).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q]);
  const d = data?.tab === tab ? data.d : null;
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.payablesReports')}</h1><p className="ledger-subtitle">{t('pur.reports.subtitle')}</p></div>
        <Link className="ghost-btn" to="/purchasing">{t('nav.purchasing')}</Link>
      </div>
      <div className="ledger-tabs">{TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`pur.rep.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          {tab === 'aging' && <label className="ledger-field">{t('fr.asOf')}<input type="date" value={q.asOf} onChange={(e) => setQ({ ...q, asOf: e.target.value })} /></label>}
          {(tab === 'ppv' || tab === 'purchases') && (
            <>
              <label className="ledger-field">{t('fr.from')}<input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
              <label className="ledger-field">{t('fr.to')}<input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
            </>
          )}
          {tab === 'purchases' && <label className="ledger-field">{t('fr.by')}<select value={q.by} onChange={(e) => setQ({ ...q, by: e.target.value })}><option value="supplier">{t('pur.supplier')}</option><option value="item">{t('sales.product')}</option></select></label>}
        </div>
        {tab === 'aging' && (
          <div className="ledger-actions">
            <button type="button" className="ghost-btn" onClick={() => api.purDownload('/reports/aging', { asOf: q.asOf, format: 'xlsx' })}>Excel</button>
            <button type="button" className="ghost-btn" onClick={() => api.purDownload('/reports/aging', { asOf: q.asOf, format: 'pdf' })}>PDF</button>
          </div>
        )}
      </div>
      {!d && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {d && tab === 'aging' && (
        <div className="card ledger-card">
          <div className={`ledger-balance ${d.unassigned_minor ? 'ledger-balance-bad' : 'ledger-balance-ok'}`}>{t('pur.agingVsControl')}: {baseMoney(meta, d.totals.total)} / {baseMoney(meta, d.control_minor)}</div>
          <table className="ledger-table">
            <thead><tr><th>{t('pur.supplier')}</th>{BUCKETS.map((b) => <th key={b} className="ledger-num">{t(`pur.bucket.${b}`)}</th>)}<th className="ledger-num">{t('fr.total')}</th></tr></thead>
            <tbody>{d.rows.map((r) => <tr key={r.supplier_id}><td><Link to={`/purchasing/suppliers?id=${r.supplier_id}`}>{r.supplier_name}</Link></td>{BUCKETS.map((b) => <td key={b} className="ledger-num">{r[b] ? baseMoney(meta, r[b]) : ''}</td>)}<td className="ledger-num">{baseMoney(meta, r.total)}</td></tr>)}</tbody>
            <tfoot>
              <tr><th>{t('fr.total')}</th>{BUCKETS.map((b) => <th key={b} className="ledger-num">{baseMoney(meta, d.totals[b])}</th>)}<th className="ledger-num">{baseMoney(meta, d.totals.total)}</th></tr>
              {d.unassigned_minor !== 0 && <tr><td colSpan={BUCKETS.length + 1}>{t('pur.unassigned')} — <Link to="/purchasing/suppliers?opening=1">{t('pur.opening.fix')}</Link></td><td className="ledger-num">{baseMoney(meta, d.unassigned_minor)}</td></tr>}
            </tfoot>
          </table>
        </div>
      )}
      {d && tab === 'ppv' && (
        <div className="card ledger-card">
          <div className={`ledger-balance ${d.total_minor === d.ledger_total_minor ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{t('pur.ppvVsLedger')}: {baseMoney(meta, d.total_minor)} / <DrillLink drill={{ accountId: d.account_id, from: d.from, to: d.to }}>{baseMoney(meta, d.ledger_total_minor)}</DrillLink></div>
          <table className="ledger-table">
            <thead><tr><th>{t('fr.date')}</th><th>{t('pur.tab.invoices')}</th><th>{t('pur.supplier')}</th><th>{t('sales.product')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('pur.poPrice')}</th><th className="ledger-num">{t('pur.invPrice')}</th><th className="ledger-num">{t('pur.ppv')}</th></tr></thead>
            <tbody>{d.rows.map((r, i) => <tr key={i}><td>{r.invoice_date}</td><td><Link to={`/purchasing?tab=invoices&id=${r.invoice_id}`}>{r.invoice_number}</Link></td><td>{r.supplier_name}</td><td>{r.product_name || r.description}</td><td className="ledger-num">{r.qty}</td><td className="ledger-num">{money(meta, r.po_unit_price_minor, r.currency_code)}</td><td className="ledger-num">{money(meta, r.unit_price_minor, r.currency_code)}</td><td className="ledger-num">{baseMoney(meta, r.ppv_base_minor)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {d && tab === 'purchases' && (
        <div className="card ledger-card">
          <table className="ledger-table">
            <thead><tr><th>{q.by === 'supplier' ? t('pur.supplier') : t('sales.product')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('pur.tab.invoices')}</th><th className="ledger-num">{t('fr.amount')} ({meta.base_currency.code})</th></tr></thead>
            <tbody>{d.rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="ledger-num">{r.qty}</td><td className="ledger-num">{r.invoices}</td><td className="ledger-num">{baseMoney(meta, r.base_minor)}</td></tr>)}</tbody>
            <tfoot><tr><th colSpan={3}>{t('fr.total')}</th><th className="ledger-num">{baseMoney(meta, d.total_minor)}</th></tr></tfoot>
          </table>
        </div>
      )}
      {d && tab === 'ratings' && (
        <div className="card ledger-card">
          <table className="ledger-table">
            <thead><tr><th>{t('pur.supplier')}</th><th className="ledger-num">{t('pur.rating.onTime')}</th><th className="ledger-num">{t('pur.rating.price')}</th><th className="ledger-num">{t('pur.rating.quality')}</th><th>{t('pur.f.manualRating')}</th></tr></thead>
            <tbody>{d.map((r) => <tr key={r.id}><td><Link to={`/purchasing/suppliers?id=${r.id}`}>{r.name}</Link></td><td className="ledger-num">{r.on_time_pct ?? '—'}</td><td className="ledger-num">{r.price_consistency_pct ?? '—'}</td><td className="ledger-num">{r.quality_rejection_pct ?? '—'}</td><td>{r.manual_rating ? '★'.repeat(r.manual_rating) : ''}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
