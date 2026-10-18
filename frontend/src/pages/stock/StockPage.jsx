import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';
import { Lots, Counts, Wastage, Reports } from './StockLotsTabs.jsx';

const TABS = ['valuation', 'moves', 'lots', 'counts', 'wastage', 'operations', 'reports', 'reconciliation', 'setup'];
const qtyFmt = (q) => (Math.round(q * 1000) / 1000).toLocaleString('en-US');

// Stock ledger (Prompt 8a): valuation per holder, item moves with running
// quantity and value, transfers / adjustments, daily reconciliation, and
// the setup (valuation methods, standard costs, activation with dry run).
export default function StockPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = () => api.stGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (fn, msg) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (msg) setNotice(msg);
      load();
      return r;
    } catch (err) {
      setError(ledgerError(err, t));
      return null;
    }
  };
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : meta.active ? 'valuation' : 'setup';
  const m = (minor) => formatMinor(minor || 0, meta.digits);
  const props = { t, can, meta, act, m, sp, setSp };
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.stock')}</h1><p className="ledger-subtitle">{t('st.subtitle')}</p></div>
        <span className={`ledger-badge ledger-badge-${meta.active ? 'posted' : 'draft'}`}>{meta.active ? t('st.active') : t('st.notActive')}</span>
      </div>
      <div className="ledger-tabs">{TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`st.tab.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {tab === 'valuation' && <Valuation {...props} />}
      {tab === 'moves' && <Moves {...props} />}
      {tab === 'lots' && <Lots {...props} />}
      {tab === 'counts' && <Counts {...props} />}
      {tab === 'wastage' && <Wastage {...props} />}
      {tab === 'reports' && <Reports {...props} />}
      {tab === 'operations' && <Operations {...props} />}
      {tab === 'reconciliation' && <Reconciliation {...props} />}
      {tab === 'setup' && <Setup {...props} />}
    </div>
  );
}

function Valuation({ t, meta, m }) {
  const [holderId, setHolderId] = useState('');
  const [v, setV] = useState(null);
  useEffect(() => { api.stGet('/valuation', holderId ? { holderId } : {}).then(setV).catch(() => setV(null)); }, [holderId]);
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  return (
    <div className="card ledger-card">
      <div className="ledger-toolbar">
        <label className="ledger-field">{t('st.holder')}<select value={holderId} onChange={(e) => setHolderId(e.target.value)}><option value="">{t('tr.all')}</option>{meta.holders.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      </div>
      {v && (
        <>
          <div className="ledger-meta-grid">
            <div><span className="ledger-hint">{t('st.warehouseValue')}</span><strong>{m(v.warehouse_minor)}</strong></div>
            <div><span className="ledger-hint">{t('st.custodyValue')}</span><strong>{m(v.custody_minor)}</strong></div>
            <div><span className="ledger-hint">{t('st.totalValue')}</span><strong>{m(v.total_minor)}</strong></div>
          </div>
          <table className="ledger-table">
            <thead><tr><th>{t('sales.product')}</th><th>{t('st.holder')}</th><th>{t('st.method')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('st.unitCost')}</th><th className="ledger-num">{t('st.value')}</th><th /></tr></thead>
            <tbody>{v.rows.map((r) => (
              <tr key={`${r.product_id}-${r.holder_id}`}>
                <td><Link to={`/stock/items/${r.product_id}`}>{r.product_name}</Link></td><td>{r.holder_name}</td><td>{t(`st.m.${r.method}`)}</td>
                <td className="ledger-num">{qtyFmt(r.qty)}</td><td className="ledger-num">{m(Math.round(r.unit_cost_minor))}</td><td className="ledger-num">{m(r.value_minor)}</td>
                <td><Link to={`/stock?tab=moves&product=${r.product_id}&holder=${r.holder_id}`}>{t('st.moves')}</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Moves({ t, meta, m, sp, setSp }) {
  const productId = sp.get('product') || '';
  const holderId = sp.get('holder') || '';
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!productId) return setRows(null);
    api.stGet('/moves', { productId, holderId }).then(setRows).catch(() => setRows([]));
    return undefined;
  }, [productId, holderId]);
  return (
    <div className="card ledger-card">
      <div className="ledger-filters">
        <label className="ledger-field">{t('sales.product')}<select value={productId} onChange={(e) => setSp({ tab: 'moves', product: e.target.value, holder: holderId })}><option value="">—</option>{meta.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="ledger-field">{t('st.holder')}<select value={holderId} onChange={(e) => setSp({ tab: 'moves', product: productId, holder: e.target.value })}><option value="">{t('tr.all')}</option>{meta.holders.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      </div>
      {rows && (
        <table className="ledger-table">
          <thead><tr><th>{t('fr.date')}</th><th>{t('st.moveType')}</th><th>{t('st.holder')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('st.value')}</th><th className="ledger-num">{t('st.runningQty')}</th><th className="ledger-num">{t('st.runningValue')}</th><th>{t('tr.entry')}</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{r.move_date}</td><td>{t(`st.type.${r.move_type}`)}{r.reason_code ? <div className="ledger-hint">{r.reason_code}</div> : null}</td><td>{r.holder_name}</td>
              <td className={`ledger-num ${r.qty < 0 ? 'ledger-neg' : ''}`}>{qtyFmt(r.qty)}</td><td className="ledger-num">{m(r.value_minor)}</td>
              <td className="ledger-num">{qtyFmt(r.running_qty)}</td><td className="ledger-num">{m(r.running_value_minor)}</td>
              <td>{r.journal_entry_id ? <Link to={`/ledger/entries/${r.journal_entry_id}`}>#{r.journal_entry_id}</Link> : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function Operations({ t, can, meta, act }) {
  const [tr, setTr] = useState({ productId: '', fromHolderId: '', toHolderId: '', qty: '' });
  const [adj, setAdj] = useState({ productId: '', holderId: '', newQty: '', reasonCode: '' });
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  if (!can('manage_stock_ledger')) return <p className="ledger-hint">{t('st.noPermission')}</p>;
  const sel = (v, on, list, label) => <label className="ledger-field">{label}<select value={v} onChange={(e) => on(e.target.value)}><option value="">—</option>{list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>;
  return (
    <>
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('st.transfer')}</h2>
        <div className="ledger-form-grid">
          {sel(tr.productId, (v) => setTr({ ...tr, productId: v }), meta.products, t('sales.product'))}
          {sel(tr.fromHolderId, (v) => setTr({ ...tr, fromHolderId: v }), meta.holders, t('st.from'))}
          {sel(tr.toHolderId, (v) => setTr({ ...tr, toHolderId: v }), meta.holders, t('st.to'))}
          <label className="ledger-field">{t('sales.qty')}<input dir="ltr" value={tr.qty} onChange={(e) => setTr({ ...tr, qty: e.target.value })} /></label>
        </div>
        <button type="button" className="gold-btn" onClick={() => act(() => api.stPost('/transfers', { ...tr, productId: Number(tr.productId), fromHolderId: Number(tr.fromHolderId), toHolderId: Number(tr.toHolderId), qty: Number(tr.qty) }), t('st.done'))}>{t('ledger.form.post')}</button>
      </div>
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('st.adjust')}</h2>
        <div className="ledger-form-grid">
          {sel(adj.productId, (v) => setAdj({ ...adj, productId: v }), meta.products, t('sales.product'))}
          {sel(adj.holderId, (v) => setAdj({ ...adj, holderId: v }), meta.holders, t('st.holder'))}
          <label className="ledger-field">{t('st.newQty')}<input dir="ltr" value={adj.newQty} onChange={(e) => setAdj({ ...adj, newQty: e.target.value })} /></label>
          <label className="ledger-field">{t('st.reason')}<input value={adj.reasonCode} onChange={(e) => setAdj({ ...adj, reasonCode: e.target.value })} /></label>
        </div>
        <button type="button" className="gold-btn" onClick={() => act(() => api.stPost('/adjustments', { ...adj, productId: Number(adj.productId), holderId: Number(adj.holderId), newQty: Number(adj.newQty) }), t('st.done'))}>{t('ledger.form.post')}</button>
      </div>
    </>
  );
}

function Reconciliation({ t, meta, m }) {
  const [r, setR] = useState(null);
  useEffect(() => { api.stGet('/reconciliation').then(setR).catch(() => setR(null)); }, []);
  if (!meta.active) return <p className="ledger-hint">{t('st.activateFirst')}</p>;
  if (!r) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  return (
    <div className="card ledger-card">
      <div className={`ledger-balance ${r.ok ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{r.ok ? t('st.recOk') : t('st.recBad')}</div>
      <table className="ledger-table"><tbody>
        <tr><td>{t('st.ledgerInventory')}</td><td className="ledger-num">{m(r.ledger_inventory_minor)}</td><td>{t('st.warehouseValue')}</td><td className="ledger-num">{m(r.valuation_warehouse_minor)}</td></tr>
        <tr><td>{t('st.ledgerCustody')}</td><td className="ledger-num">{m(r.ledger_custody_minor)}</td><td>{t('st.custodyValue')}</td><td className="ledger-num">{m(r.valuation_custody_minor)}</td></tr>
        <tr className="ledger-row-header"><td>{t('st.ledgerTotal')}</td><td className="ledger-num">{m(r.ledger_minor)}</td><td>{t('st.totalValue')}</td><td className="ledger-num">{m(r.valuation_minor)}</td></tr>
      </tbody></table>
      {r.qty_mismatches.length > 0 && (
        <table className="ledger-table">
          <thead><tr><th>{t('st.screen')}</th><th>{t('sales.product')}</th><th className="ledger-num">{t('st.legacyQty')}</th><th className="ledger-num">{t('st.movesQty')}</th></tr></thead>
          <tbody>{r.qty_mismatches.map((x) => <tr key={`${x.table}-${x.product_id}`}><td>{x.table === 'car_inventory' ? t('st.carStock') : t('st.factoryStock')}</td><td>{x.item_name}</td><td className="ledger-num">{qtyFmt(x.legacy)}</td><td className="ledger-num">{qtyFmt(x.moves)}</td></tr>)}</tbody>
        </table>
      )}
      {meta.last_reconciliation && <p className="ledger-hint">{t('st.lastCheck')}: {meta.last_reconciliation.as_of} — {meta.last_reconciliation.ok ? t('st.recOk') : t('st.recBad')}</p>}
    </div>
  );
}

function Setup({ t, can, meta, act, m }) {
  const [plan, setPlan] = useState(null);
  const [method, setMethod] = useState({ category: '', method: 'average' });
  const [std, setStd] = useState({ productId: '', standardCost: '' });
  const manage = can('manage_stock_ledger');
  return (
    <>
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('st.methods')}</h2>
        <p className="ledger-hint">{t('st.methodsHint')} — {t('st.companyMethod')}: <strong>{t(`st.m.${meta.method}`)}</strong>{meta.category_methods.map((c) => ` · ${c.category}: ${t(`st.m.${c.method}`)}`).join('')}</p>
        {manage && (
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('st.category')}<select value={method.category} onChange={(e) => setMethod({ ...method, category: e.target.value })}><option value="">{t('st.wholeCompany')}</option>{meta.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label className="ledger-field">{t('st.method')}<select value={method.method} onChange={(e) => setMethod({ ...method, method: e.target.value })}>{['average', 'fifo', 'standard'].map((k) => <option key={k} value={k}>{t(`st.m.${k}`)}</option>)}</select></label>
            <button type="button" className="ghost-btn" onClick={() => act(() => api.stPut('/method', { category: method.category || null, method: method.method }), t('tr.saved'))}>{t('common.save')}</button>
          </div>
        )}
        {manage && (
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('sales.product')}<select value={std.productId} onChange={(e) => setStd({ ...std, productId: e.target.value })}><option value="">—</option>{meta.products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.standard_cost_minor != null ? ` (${m(p.standard_cost_minor)})` : ''}</option>)}</select></label>
            <label className="ledger-field">{t('st.standardCost')}<input dir="ltr" value={std.standardCost} onChange={(e) => setStd({ ...std, standardCost: e.target.value })} /></label>
            <button type="button" className="ghost-btn" onClick={() => act(() => api.stPut(`/standard-costs/${std.productId}`, { standardCost: std.standardCost }), t('tr.saved'))}>{t('common.save')}</button>
          </div>
        )}
      </div>
      {!meta.active && (
        <div className="card ledger-card">
          <h2 className="atlas-section-title">{t('st.activation')}</h2>
          <p className="ledger-hint">{t('st.activationHint')}</p>
          {manage && <button type="button" className="ghost-btn" onClick={async () => setPlan(await act(() => api.stPost('/activation/dry-run', {})))}>{t('st.dryRun')}</button>}
          {plan && (
            <>
              {plan.problems.map((p) => <div key={p.message} className="ledger-error">{p.message}</div>)}
              {plan.warnings.map((p) => <div key={p.message} className="ledger-hint">⚠ {p.message}</div>)}
              {plan.cost_issues?.length > 0 && (
                <>
                  <h3 className="atlas-section-title">{t('st.costIssues')}</h3>
                  <table className="ledger-table">
                    <thead><tr><th>{t('sales.product')}</th><th className="ledger-num">{t('sales.qty')}</th><th>{t('st.costIssue')}</th><th>{t('st.ackReason')}</th><th /></tr></thead>
                    <tbody>{plan.cost_issues.map((c) => (
                      <tr key={c.product_id}>
                        <td>{c.product_name}</td><td className="ledger-num">{qtyFmt(c.qty)}</td><td>{t(`st.costIssue.${c.issue}`)}</td>
                        <td>{c.acknowledged ? `${c.acknowledged.reason} — ${c.acknowledged.created_by_name || ''}` : '—'}</td>
                        <td>{manage && !c.acknowledged && <button type="button" className="ledger-link-btn" onClick={async () => {
                          const reason = window.prompt(t('st.ackPrompt'));
                          if (!reason) return;
                          if (await act(() => api.stPost('/activation/cost-acknowledgements', { productId: c.product_id, reason }), t('tr.saved'))) setPlan(await act(() => api.stPost('/activation/dry-run', {})));
                        }}>{t('st.ackZero')}</button>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </>
              )}
              <table className="ledger-table">
                <thead><tr><th>{t('st.screen')}</th><th>{t('sales.product')}</th><th>{t('st.method')}</th><th className="ledger-num">{t('sales.qty')}</th><th className="ledger-num">{t('st.unitCost')}</th><th className="ledger-num">{t('st.value')}</th></tr></thead>
                <tbody>{plan.rows.map((r) => <tr key={`${r.table}-${r.product_id}`}><td>{r.table === 'car_inventory' ? t('st.carStock') : t('st.factoryStock')}</td><td>{r.product_name}</td><td>{t(`st.m.${r.method}`)}</td><td className="ledger-num">{qtyFmt(r.qty)}</td><td className="ledger-num">{m(Math.round(r.unit_cost_minor))}</td><td className="ledger-num">{m(r.value_minor)}</td></tr>)}</tbody>
              </table>
              <p>{t('st.openingEntry')}: {t('st.factoryStock')} {m(plan.opening_entry.inventory_minor)} · {t('st.carStock')} {m(plan.opening_entry.custody_minor)} ({t('st.ledgerNow')} {m(plan.ledger_inventory_minor)} / {m(plan.ledger_custody_minor)})</p>
              {plan.ok && manage && <button type="button" className="gold-btn" onClick={async () => { const r = await act(() => api.stPost('/activation', { dryRunId: plan.dry_run_id }), t('st.activated')); if (r) setPlan(null); }}>{t('st.activate')}</button>}
            </>
          )}
        </div>
      )}
    </>
  );
}
