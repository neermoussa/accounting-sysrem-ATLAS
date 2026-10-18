import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

const qtyFmt = (q) => (Math.round((q || 0) * 1000) / 1000).toLocaleString('en-US');

// Item card (Prompt 8b): balances per holder, cost, lots, suppliers, last
// 90 days of sales and margin, latest moves; lot / reorder settings.
export default function ItemCardPage() {
  const { id } = useParams();
  const { t } = useLanguage();
  const { can } = useAuth();
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => api.stGet(`/items/${id}`).then((r) => { setC(r); setForm({ trackLots: Boolean(r.settings.track_lots), reorderPoint: r.settings.reorder_point ?? '', reorderQty: r.settings.reorder_qty ?? '' }); }).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const m = (v) => formatMinor(Math.round(v || 0), c.digits);
  const save = async () => {
    setError(null);
    try {
      await api.stPut(`/products/${id}/settings`, { trackLots: form.trackLots, reorderPoint: form.reorderPoint, reorderQty: form.reorderQty });
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  };
  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{c.product.name}</h1><p className="ledger-subtitle">{t('st.itemCard')} · {t(`st.m.${c.method}`)}{c.product.category ? ` · ${c.product.category}` : ''}</p></div><Link to="/stock">{t('nav.stock')}</Link></div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="ledger-meta-grid">
        <div><span className="ledger-hint">{t('sales.qty')}</span><strong>{qtyFmt(c.qty)}</strong></div>
        <div><span className="ledger-hint">{t('st.col.reserved')}</span><strong>{qtyFmt(c.reserved)}</strong></div>
        <div><span className="ledger-hint">{t('st.col.available')}</span><strong>{qtyFmt(c.available)}</strong></div>
        <div><span className="ledger-hint">{t('st.col.on_order')}</span><strong>{qtyFmt(c.on_order)}</strong></div>
        <div><span className="ledger-hint">{t('st.unitCost')}</span><strong>{m(c.unit_cost_minor)}</strong></div>
        <div><span className="ledger-hint">{t('st.value')}</span><strong>{m(c.value_minor)}</strong></div>
        <div><span className="ledger-hint">{t('st.sales90')}</span><strong>{qtyFmt(c.sales_90d.qty)} · {m(c.sales_90d.revenue_minor)}</strong></div>
        <div><span className="ledger-hint">{t('st.margin')}</span><strong>{m(c.sales_90d.margin_minor)}{c.sales_90d.margin_pct !== null ? ` (${c.sales_90d.margin_pct}%)` : ''}</strong></div>
      </div>
      {can('manage_stock_ledger') && form && (
        <section className="card ledger-card">
          <h2 className="atlas-section-title">{t('st.itemSettings')}</h2>
          <div className="ledger-form-grid">
            <label className="ledger-field"><span><input type="checkbox" checked={form.trackLots} onChange={(e) => setForm({ ...form, trackLots: e.target.checked })} /> {t('st.trackLots')}</span></label>
            <label className="ledger-field">{t('st.col.reorder_point')}<input dir="ltr" value={form.reorderPoint} onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })} /></label>
            <label className="ledger-field">{t('st.col.reorder_qty')}<input dir="ltr" value={form.reorderQty} onChange={(e) => setForm({ ...form, reorderQty: e.target.value })} /></label>
          </div>
          <button type="button" className="gold-btn" onClick={save}>{t('common.save')}</button>
        </section>
      )}
      <h2 className="atlas-section-title">{t('st.holder')}</h2>
      <table className="ledger-table"><tbody>{c.holders.map((h) => <tr key={h.holder_id}><td>{h.holder_name}</td><td className="ledger-num">{qtyFmt(h.qty)}</td><td className="ledger-num">{m(h.value_minor)}</td></tr>)}</tbody></table>
      {c.lots.length > 0 && <>
        <h2 className="atlas-section-title">{t('st.tab.lots')}</h2>
        <table className="ledger-table"><tbody>{c.lots.map((l) => <tr key={l.id}><td><Link to={`/stock?tab=lots&lot=${l.id}`}>{l.lot_code}</Link></td><td>{l.expiry_date || '—'}</td><td>{t(`st.lotStatus.${l.status}`)}</td><td className="ledger-num">{qtyFmt(l.qty)}</td></tr>)}</tbody></table>
      </>}
      <h2 className="atlas-section-title">{t('st.supplier')}</h2>
      <table className="ledger-table"><tbody>{c.suppliers.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.last_date}</td><td className="ledger-num">{qtyFmt(s.qty)}</td><td className="ledger-num">{s.last_unit_price_minor !== null ? m(s.last_unit_price_minor) : '—'}</td></tr>)}</tbody></table>
      <h2 className="atlas-section-title">{t('st.tab.moves')}</h2>
      <table className="ledger-table"><tbody>{c.moves.map((mv) => <tr key={mv.id}><td>{mv.move_date}</td><td>{t(`st.type.${mv.move_type}`)}</td><td>{mv.holder_name}</td><td>{mv.lot_code || ''}</td><td className={`ledger-num ${mv.qty < 0 ? 'ledger-neg' : ''}`}>{qtyFmt(mv.qty)}</td><td className="ledger-num">{m(mv.value_minor)}</td></tr>)}</tbody></table>
    </div>
  );
}
