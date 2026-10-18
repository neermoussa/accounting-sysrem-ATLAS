import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

// Exchange-rate history (Prompt 5): daily manual rates, the automatic
// USD/SYP fetch (source "api"), and a rate history chart per currency.
// Rates are entered in the direction that makes them >= 1.
export default function ExchangeRatesPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [code, setCode] = useState('');
  const [form, setForm] = useState({ rate: '', rateQuote: 'base_per_foreign', effectiveAt: new Date().toISOString().slice(0, 10), notes: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    api.getLedgerMeta().then((m) => {
      setMeta(m);
      const first = m.currencies.find((c) => c.is_active && c.code !== m.base_currency.code);
      if (first) {
        setCode(first.code);
        // SYP-style currencies (many units per base) are typed per 1 base.
        if (first.minor_unit_digits === 0 && m.base_currency.minor_unit_digits > 0) setForm((f) => ({ ...f, rateQuote: 'foreign_per_base' }));
      }
    }).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const load = () => code && api.getExchangeRates({ currencyCode: code, limit: 1000 }).then(setRows).catch((err) => setError(ledgerError(err, t)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [code]);

  async function add(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.addExchangeRate({ currencyCode: code, ...form });
      setNotice(t('fx.rateSaved'));
      setForm({ ...form, rate: '', notes: '' });
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const baseCode = meta.base_currency.code;
  const quoteLabel = (q) => (q === 'foreign_per_base' ? `${code} / 1 ${baseCode}` : `${baseCode} / 1 ${code}`);
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('fx.rates.title')}</h1>
          <p className="ledger-subtitle">{t('fx.rates.subtitle')}</p>
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      <div className="ledger-tabs">
        {meta.currencies.filter((c) => c.is_active && c.code !== baseCode).map((c) => (
          <button key={c.code} type="button" className={`ledger-tab-btn ${code === c.code ? 'active' : ''}`} onClick={() => setCode(c.code)}>{c.code}</button>
        ))}
      </div>
      {can('manage_exchange_rates') && code && (
        <form className="card ledger-card" onSubmit={add}>
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('fx.rate')}<input dir="ltr" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} required placeholder="13500.25" /></label>
            <label className="ledger-field">{t('fx.direction')}
              <select value={form.rateQuote} onChange={(e) => setForm({ ...form, rateQuote: e.target.value })}>
                <option value="base_per_foreign">{quoteLabel('base_per_foreign')}</option>
                <option value="foreign_per_base">{quoteLabel('foreign_per_base')}</option>
              </select>
            </label>
            <label className="ledger-field">{t('fx.effective')}<input type="date" value={form.effectiveAt} onChange={(e) => setForm({ ...form, effectiveAt: e.target.value })} /></label>
            <label className="ledger-field">{t('sales.notes')}<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <p className="ledger-hint">{t('ledger.rate.quoteHint')}</p>
          <button type="submit" className="gold-btn">{t('fx.addRate')}</button>
        </form>
      )}
      {rows.length > 1 && <RateChart rows={rows} label={rows[0] ? quoteLabel(rows[0].rate_quote) : ''} />}
      <div className="card ledger-card">
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr><th>{t('fx.effective')}</th><th className="ledger-num">{t('fx.rate')}</th><th>{t('fx.direction')}</th><th>{t('fx.source')}</th><th>{t('sales.notes')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}><td>{r.effective_at}</td><td className="ledger-num" dir="ltr">{r.rate}</td><td>{quoteLabel(r.rate_quote)}</td><td>{t(`fx.source.${r.source}`)}</td><td>{r.notes || ''}</td></tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="ledger-empty">{t('fx.noRates')}</div>}
        </div>
      </div>
    </div>
  );
}

// Simple inline SVG line chart (no chart library). Rates of one direction
// only — the series switches direction rarely; mixed points are converted
// to the direction of the latest rate.
function RateChart({ rows, label }) {
  const pts = useMemo(() => {
    const dir = rows[0].rate_quote;
    return [...rows]
      .reverse()
      .map((r) => ({ at: r.effective_at, v: r.rate_quote === dir ? Number(r.rate) : 1 / Number(r.rate) }));
  }, [rows]);
  const W = 720;
  const H = 220;
  const pad = 40;
  const t0 = Date.parse(pts[0].at.replace(' ', 'T'));
  const t1 = Date.parse(pts[pts.length - 1].at.replace(' ', 'T')) || t0 + 1;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (at) => pad + ((Date.parse(at.replace(' ', 'T')) - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / Math.max(1e-12, hi - lo)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return (
    <div className="card ledger-card" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ maxHeight: 260 }}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="currentColor" opacity="0.25" />
        <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="currentColor" opacity="0.25" />
        <text x={pad} y={pad - 10} fontSize="12" fill="currentColor" opacity="0.7">{label}</text>
        <text x={4} y={y(hi) + 4} fontSize="11" fill="currentColor" opacity="0.7">{hi}</text>
        <text x={4} y={y(lo) + 4} fontSize="11" fill="currentColor" opacity="0.7">{lo}</text>
        <text x={pad} y={H - pad + 16} fontSize="11" fill="currentColor" opacity="0.7">{pts[0].at.slice(0, 10)}</text>
        <text x={W - pad} y={H - pad + 16} fontSize="11" textAnchor="end" fill="currentColor" opacity="0.7">{pts[pts.length - 1].at.slice(0, 10)}</text>
        <path d={d} fill="none" stroke="var(--atlas-brand, #c9a227)" strokeWidth="2" />
        {pts.map((p) => <circle key={p.at + p.v} cx={x(p.at)} cy={y(p.v)} r="3" fill="var(--atlas-brand, #c9a227)"><title>{`${p.at} · ${p.v}`}</title></circle>)}
      </svg>
    </div>
  );
}
