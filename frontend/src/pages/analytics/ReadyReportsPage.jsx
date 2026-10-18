import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError, formatMinor } from '../ledger/ledgerShared.js';
import { DrillLink } from '../ledger/DrillLink.jsx';
import '../../styles/ledger.css';

// Prompt 12a — ready reports over the analytics fact tables. Every report
// shows its data-freshness stamp; financial amounts drill into the general
// ledger, operational amounts open the fact rows behind them.
const FAMILIES = ['financial', 'sales', 'purchases', 'inventory', 'receivables', 'operations', 'manufacturing', 'payroll'];
const today = () => new Date().toISOString().slice(0, 10);

function Freshness({ f, t, onRefresh }) {
  if (!f) return null;
  if (f.live) return <p className="ledger-subtitle">{t('analytics.live')} — {f.as_of?.slice(0, 19).replace('T', ' ')}</p>;
  return (
    <p className={f.up_to_date ? 'ledger-subtitle' : 'ledger-notice'}>
      {t('analytics.freshAt')}: {f.refreshed_at || '—'}
      {f.pending_changes > 0 && <> — {t('analytics.pending').replace('{n}', f.pending_changes)}</>}
      {' '}<button type="button" className="ledger-tab-btn" onClick={onRefresh}>{t('analytics.refresh')}</button>
    </p>
  );
}

function Cell({ col, row, digits }) {
  const v = row[col.key];
  const text = col.type === 'money' ? (v === null || v === undefined ? '—' : formatMinor(v, digits)) : (v ?? '—');
  return <td className={col.type === 'money' || col.type === 'number' ? 'num' : undefined}>{text}</td>;
}

export default function ReadyReportsPage() {
  const { t, lang } = useLanguage();
  const [catalog, setCatalog] = useState(null);
  const [key, setKey] = useState('trial_balance');
  const [params, setParams] = useState({ from: `${today().slice(0, 4)}-01-01`, to: today() });
  const [out, setOut] = useState(null);
  const [drill, setDrill] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const digits = 2;
  useEffect(() => { api.getAnalyticsCatalog().then(setCatalog).catch((err) => setError(ledgerError(err, t))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const def = catalog?.reports.find((r) => r.key === key);
  const name = (r) => (lang === 'en' ? r.name_en : r.name_ar);
  const runIt = async () => {
    setBusy(true); setError(null); setDrill(null);
    try { setOut(await api.runAnalyticsReport(key, params)); } catch (err) { setOut(null); setError(ledgerError(err, t)); }
    setBusy(false);
  };
  const refresh = async () => { try { await api.refreshAnalytics(); await runIt(); } catch (err) { setError(ledgerError(err, t)); } };
  const openDrill = async (d) => {
    if (d.kind !== 'facts') return;
    try { setDrill(await api.analyticsDrill(d.fact, d.filters)); } catch (err) { setError(ledgerError(err, t)); }
  };
  const set = (k) => (e) => setParams((p) => ({ ...p, [k]: e.target.value }));
  const cols = out?.columns || [];
  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{t('nav.readyReports')}</h1><p className="ledger-subtitle">{t('analytics.hint')}</p></div></div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="ledger-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
        <label>{t('analytics.report')}
          <select value={key} onChange={(e) => { setKey(e.target.value); setOut(null); setDrill(null); }}>
            {FAMILIES.map((f) => {
              const rs = (catalog?.reports || []).filter((r) => r.family === f);
              return rs.length ? <optgroup key={f} label={t(`analytics.family.${f}`)}>{rs.map((r) => <option key={r.key} value={r.key}>{name(r)}</option>)}</optgroup> : null;
            })}
          </select>
        </label>
        {def?.as_of ? <label>{t('analytics.asOf')}<input type="date" value={params.asOf || params.to} onChange={set('asOf')} /></label> : <>
          <label>{t('analytics.from')}<input type="date" value={params.from} onChange={set('from')} /></label>
          <label>{t('analytics.to')}<input type="date" value={params.to} onChange={set('to')} /></label>
        </>}
        {def?.dims && <label>{t('analytics.by')}<select value={params.by || ''} onChange={set('by')}><option value="">—</option>{def.dims.map((d) => <option key={d} value={d}>{t(`analytics.dim.${d}`)}</option>)}</select></label>}
        {(def?.params || []).map((p) => <label key={p}>{t(`analytics.param.${p}`)}<input inputMode="numeric" value={params[p] || ''} onChange={set(p)} /></label>)}
        <button type="button" className="gold-btn" disabled={busy} onClick={runIt}>{busy ? t('analytics.running') : t('analytics.run')}</button>
      </div>
      {out && <>
        <Freshness f={out.freshness} t={t} onRefresh={refresh} />
        {out.truncated && <div className="ledger-notice">{t('analytics.truncated').replace('{cap}', out.row_cap).replace('{n}', out.row_count)}</div>}
        {out.live && !out.columns ? <pre className="ledger-subtitle" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(out.result, null, 2)}</pre> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ledger-table">
              <thead><tr>{cols.map((c) => <th key={c.key}>{lang === 'en' ? c.label_en : c.label_ar}</th>)}<th /></tr></thead>
              <tbody>{out.rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => <Cell key={c.key} col={c} row={r} digits={digits} />)}
                  <td>{r.drill?.kind === 'gl' ? <DrillLink drill={r.drill}>{t('analytics.drill')}</DrillLink>
                    : r.drill?.kind === 'facts' ? <button type="button" className="ledger-tab-btn" onClick={() => openDrill(r.drill)}>{t('analytics.drill')}</button> : null}</td>
                </tr>
              ))}</tbody>
              {out.totals && <tfoot><tr>{cols.map((c, i) => <td key={c.key} className="num"><strong>{i === 0 ? t('analytics.total') : (out.totals[c.key] !== undefined && c.type === 'money' ? formatMinor(out.totals[c.key], digits) : out.totals[c.key] ?? '')}</strong></td>)}<td /></tr></tfoot>}
            </table>
          </div>
        )}
        {!out.rows?.length && !out.live && <p className="ledger-subtitle">{t('analytics.empty')}</p>}
      </>}
      {drill && (
        <div className="ledger-card" style={{ marginTop: 16 }}>
          <h2>{t('analytics.drillTitle')} ({drill.rows.length}{drill.truncated ? '+' : ''})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="ledger-table">
              <thead><tr>{Object.keys(drill.rows[0] || {}).filter((k) => k !== 'company_id').map((k) => <th key={k}>{k}</th>)}</tr></thead>
              <tbody>{drill.rows.map((r, i) => <tr key={i}>{Object.entries(r).filter(([k]) => k !== 'company_id').map(([k, v]) => <td key={k}>{k.endsWith('_minor') && typeof v === 'number' ? formatMinor(v, digits) : String(v ?? '—')}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
