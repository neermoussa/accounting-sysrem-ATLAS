import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ledgerError, formatMinor } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

// Prompt 12b — the Report Builder. Everything here is ONE query spec
// (backend lib/analytics/query.js): source, measures, calculated ratios,
// dimensions, filters, period / preset, comparison. The server validates
// it against its catalog and the user's permissions (cost and payroll data
// never reach a user without them); this screen only composes it.
// Tabs: builder, saved reports (runs, files, schedules, send requests),
// pending sends (approve / reject).

const PRESETS = ['this_month', 'last_month', 'mtd', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'ytd', 'last_n_days', 'custom'];
const today = () => new Date().toISOString().slice(0, 10);
const emptySpec = () => ({ source: 'sales', measures: ['net'], dimensions: [], filters: [], calcs: [], preset: 'this_month', n: 30, from: `${today().slice(0, 4)}-01-01`, to: today(), compare: '' });

// Screen state <-> the spec the API takes.
function toSpec(s) {
  const spec = { source: s.source, measures: s.measures, dimensions: s.dimensions.filter(Boolean), filters: s.filters.filter((f) => f.dim && f.values.length).map((f) => ({ dim: f.dim, op: f.op, values: f.values })) };
  if (s.calcs.length) spec.calcs = s.calcs.map((c) => ({ key: c.key, label: c.label || c.key, expr: c.expr, format: c.format }));
  spec.period = s.preset === 'custom' ? { from: s.from, to: s.to } : s.preset === 'last_n_days' ? { preset: 'last_n_days', n: Number(s.n) } : { preset: s.preset };
  if (s.compare) spec.compare = s.compare;
  if (s.sortBy) spec.sort = { by: s.sortBy, dir: s.sortDir || 'desc' };
  return spec;
}
function fromSpec(spec) {
  const p = spec.period || {};
  return {
    ...emptySpec(), source: spec.source, measures: spec.measures || [], dimensions: spec.dimensions || [], filters: (spec.filters || []).map((f) => ({ dim: f.dim, op: f.op || 'in', values: f.values })),
    calcs: (spec.calcs || []).map((c) => ({ ...c })), preset: p.preset || 'custom', n: p.n || 30, from: p.from || emptySpec().from, to: p.to || today(), compare: spec.compare || '', sortBy: spec.sort?.by || '', sortDir: spec.sort?.dir || 'desc',
  };
}

function valueText(col, v, digits) {
  if (v === null || v === undefined) return '—';
  if (col.type === 'money') return formatMinor(v, digits);
  if (col.type === 'percent') return `${v}%`;
  return typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v);
}

function FilterRow({ f, dims, source, onChange, onRemove, t, lang }) {
  const [values, setValues] = useState([]);
  useEffect(() => {
    if (!f.dim) return;
    api.rbGet(`/dimension-values?source=${encodeURIComponent(source)}&dim=${encodeURIComponent(f.dim)}`).then(setValues).catch(() => setValues([]));
  }, [source, f.dim]);
  const key = (v) => (v === null ? '__null__' : String(v));
  return (
    <div className="ledger-filters" style={{ alignItems: 'end' }}>
      <label className="ledger-field">{t('rb.filterDim')}
        <select value={f.dim} onChange={(e) => onChange({ dim: e.target.value, op: f.op, values: [] })}>
          <option value="">—</option>
          {dims.map((d) => <option key={d.key} value={d.key}>{lang === 'en' ? d.label_en : d.label_ar}</option>)}
        </select>
      </label>
      <label className="ledger-field">{t('rb.filterOp')}
        <select value={f.op} onChange={(e) => onChange({ ...f, op: e.target.value })}>
          <option value="in">{t('rb.op.in')}</option>
          <option value="not_in">{t('rb.op.not_in')}</option>
        </select>
      </label>
      <label className="ledger-field">{t('rb.filterValues')}
        <select multiple size={Math.min(6, Math.max(2, values.length))} value={f.values.map(key)} onChange={(e) => onChange({ ...f, values: [...e.target.selectedOptions].map((o) => (o.value === '__null__' ? null : values.find((v) => key(v.value) === o.value)?.value)) })}>
          {values.map((v) => <option key={key(v.value)} value={key(v.value)}>{v.value === null ? t('rb.none') : v.label}</option>)}
        </select>
      </label>
      <button type="button" className="ghost-btn" onClick={onRemove}>{t('rb.remove')}</button>
    </div>
  );
}

function ResultTable({ out, digits, t, lang, onDrill }) {
  const cols = out.columns;
  return (
    <div className="ledger-table-wrap" style={{ overflowX: 'auto' }}>
      <table className="ledger-table">
        <thead><tr>{cols.map((c) => <th key={c.key}>{lang === 'en' ? c.label_en : c.label_ar}</th>)}<th /></tr></thead>
        <tbody>{out.rows.map((r, i) => (
          <tr key={i}>
            {cols.map((c) => <td key={c.key} className={c.role === 'dimension' ? undefined : 'ledger-num'}>{valueText(c, r[c.key], digits)}</td>)}
            <td><button type="button" className="ledger-tab-btn" onClick={() => onDrill(r.drill)}>{t('analytics.drill')}</button></td>
          </tr>
        ))}</tbody>
        <tfoot><tr className="ledger-row-total">{cols.map((c, i) => <td key={c.key} className={c.role === 'dimension' ? undefined : 'ledger-num'}><strong>{c.role === 'dimension' ? (i === 0 ? t('analytics.total') : '') : valueText(c, out.totals[c.key], digits)}</strong></td>)}<td /></tr></tfoot>
      </table>
    </div>
  );
}

function SendForm({ run, recipients, t, onSent, onError }) {
  const [channel, setChannel] = useState('whatsapp');
  const [userIds, setUserIds] = useState([]);
  const [outside, setOutside] = useState('');
  const [message, setMessage] = useState('');
  const sensitive = run.needs.length > 0;
  const eligible = recipients.filter((u) => (channel === 'email' ? u.email : u.phone) && run.needs.every((n) => u[n]));
  const submit = async () => {
    const extra = outside.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).map((x) => (channel === 'email' ? { email: x } : { phone: x }));
    try {
      await api.rbPost(`/runs/${run.id}/sends`, { channel, recipients: [...userIds.map((id) => ({ userId: Number(id) })), ...extra], message: message || undefined });
      onSent();
    } catch (err) { onError(err); }
  };
  return (
    <div className="ledger-card" style={{ marginTop: 8 }}>
      <h3>{t('rb.requestSend')}</h3>
      {sensitive && <p className="ledger-notice">{t('rb.sensitiveRecipients')}</p>}
      <div className="ledger-filters" style={{ alignItems: 'end' }}>
        <label className="ledger-field">{t('rb.channel')}
          <select value={channel} onChange={(e) => { setChannel(e.target.value); setUserIds([]); }}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">{t('rb.email')}</option>
          </select>
        </label>
        <label className="ledger-field">{t('rb.users')}
          <select multiple size={Math.min(6, Math.max(2, eligible.length))} value={userIds} onChange={(e) => setUserIds([...e.target.selectedOptions].map((o) => o.value))}>
            {eligible.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
          </select>
        </label>
        {!sensitive && <label className="ledger-field">{channel === 'email' ? t('rb.outsideEmails') : t('rb.outsidePhones')}<textarea rows={2} value={outside} onChange={(e) => setOutside(e.target.value)} /></label>}
        <label className="ledger-field">{t('rb.message')}<input value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} /></label>
        <button type="button" className="gold-btn" onClick={submit}>{t('rb.requestSendBtn')}</button>
      </div>
      <p className="ledger-subtitle">{t('rb.sendNeedsApproval')}</p>
    </div>
  );
}

function ScheduleForm({ reportId, t, onDone, onError }) {
  const [f, setF] = useState({ frequency: 'daily', time: '08:00', weekday: 0, dayOfMonth: 1, format: 'xlsx', lang: 'ar' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    try {
      await api.rbPost(`/saved/${reportId}/schedules`, { ...f, weekday: Number(f.weekday), dayOfMonth: Number(f.dayOfMonth) });
      onDone();
    } catch (err) { onError(err); }
  };
  return (
    <div className="ledger-filters" style={{ alignItems: 'end' }}>
      <label className="ledger-field">{t('rb.frequency')}
        <select value={f.frequency} onChange={set('frequency')}>{['daily', 'weekly', 'monthly'].map((x) => <option key={x} value={x}>{t(`rb.freq.${x}`)}</option>)}</select>
      </label>
      <label className="ledger-field">{t('rb.time')}<input type="time" value={f.time} onChange={set('time')} /></label>
      {f.frequency === 'weekly' && <label className="ledger-field">{t('rb.weekday')}<select value={f.weekday} onChange={set('weekday')}>{[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{t(`rb.day.${d}`)}</option>)}</select></label>}
      {f.frequency === 'monthly' && <label className="ledger-field">{t('rb.dayOfMonth')}<input type="number" min={1} max={31} value={f.dayOfMonth} onChange={set('dayOfMonth')} /></label>}
      <label className="ledger-field">{t('rb.format')}<select value={f.format} onChange={set('format')}>{['xlsx', 'pdf', 'csv'].map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select></label>
      <label className="ledger-field">{t('rb.fileLang')}<select value={f.lang} onChange={set('lang')}><option value="ar">العربية</option><option value="en">English</option></select></label>
      <button type="button" className="gold-btn" onClick={submit}>{t('rb.addSchedule')}</button>
      <p className="ledger-subtitle" style={{ width: '100%' }}>{t('rb.scheduleHint')}</p>
    </div>
  );
}

function SavedDetail({ report, t, can, recipients, digits, onLoad, onChanged, onError }) {
  const [runs, setRuns] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [sendFor, setSendFor] = useState(null);
  const reload = async () => {
    try {
      setRuns(await api.rbGet(`/saved/${report.id}/runs`));
      setSchedules(await api.rbGet(`/saved/${report.id}/schedules`));
    } catch (err) { onError(err); }
  };
  useEffect(() => { reload(); }, [report.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const runNow = async (format) => {
    try { await api.rbPost(`/saved/${report.id}/runs`, { format }); } catch (err) { onError(err); }
    reload();
  };
  const stop = async (id) => { try { await api.rbDelete(`/schedules/${id}`); reload(); } catch (err) { onError(err); } };
  const remove = async () => {
    if (!window.confirm(t('rb.confirmDelete'))) return;
    try { await api.rbDelete(`/saved/${report.id}`); onChanged(); } catch (err) { onError(err); }
  };
  void digits;
  return (
    <div className="ledger-card" style={{ marginTop: 12 }}>
      <div className="ledger-header"><div><h2>{report.name}</h2><p className="ledger-subtitle">{report.owner_name} — {t(`rb.visibility.${report.visibility}`)}{report.needs.length ? ` — ${report.needs.map((n) => t(`rb.need.${n}`)).join('، ')}` : ''}</p></div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => onLoad(report)}>{t('rb.openInBuilder')}</button>
          {['xlsx', 'pdf', 'csv'].map((f) => <button key={f} type="button" className="ghost-btn" onClick={() => runNow(f)}>{t('rb.makeFile')} {f.toUpperCase()}</button>)}
          {report.can_delete && <button type="button" className="ghost-btn" onClick={remove}>{t('rb.delete')}</button>}
        </div>
      </div>
      <h3>{t('rb.runs')}</h3>
      {!runs.length ? <p className="ledger-empty">{t('rb.noRuns')}</p> : (
        <table className="ledger-table">
          <thead><tr><th>#</th><th>{t('rb.kind')}</th><th>{t('rb.status')}</th><th>{t('rb.period')}</th><th>{t('rb.rows')}</th><th /></tr></thead>
          <tbody>{runs.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{t(`rb.runKind.${r.run_kind}`)}{r.scheduled_for ? ` ${r.scheduled_for}` : ''}{r.missed_slots ? ` (${t('rb.missed').replace('{n}', r.missed_slots)})` : ''}</td>
              <td>{t(`rb.runStatus.${r.status}`)}{r.error_message ? ` — ${r.error_message}` : ''}</td>
              <td>{r.period_from ? `${r.period_from} → ${r.period_to}` : '—'}</td>
              <td className="ledger-num">{r.row_count ?? '—'}{r.truncated ? '+' : ''}</td>
              <td>
                {r.has_file && <button type="button" className="ledger-tab-btn" onClick={() => api.rbDownload(`/runs/${r.id}/file`).catch(onError)}>{t('rb.download')} {r.format.toUpperCase()}</button>}
                {r.has_file && can('send_reports') && <button type="button" className="ledger-tab-btn" onClick={() => setSendFor(sendFor?.id === r.id ? null : r)}>{t('rb.send')}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {sendFor && <SendForm run={sendFor} recipients={recipients} t={t} onSent={() => { setSendFor(null); onChanged(); }} onError={onError} />}
      <h3>{t('rb.schedules')}</h3>
      {schedules.filter((s) => s.is_active).map((s) => (
        <p key={s.id} className="ledger-subtitle">
          {t(`rb.freq.${s.frequency}`)} {s.time_of_day}{s.frequency === 'weekly' ? ` — ${t(`rb.day.${s.weekday}`)}` : ''}{s.frequency === 'monthly' ? ` — ${s.day_of_month}` : ''} — {s.format.toUpperCase()} — {t('rb.nextRun')}: {s.next_run_at} UTC
          {' '}<button type="button" className="ledger-tab-btn" onClick={() => stop(s.id)}>{t('rb.stop')}</button>
        </p>
      ))}
      {can('schedule_reports') && <ScheduleForm reportId={report.id} t={t} onDone={reload} onError={onError} />}
    </div>
  );
}

function SendsTab({ t, onError }) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('pending');
  const load = () => api.rbGet(`/sends${status ? `?status=${status}` : ''}`).then(setRows).catch(onError);
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const approve = async (s) => {
    try {
      await api.rbPost(`/sends/${s.id}/approve`, {});
    } catch (err) {
      if (err?.detail?.break_glass_available) {
        const reason = window.prompt(t('rb.breakGlassPrompt'));
        if (reason) { try { await api.rbPost(`/sends/${s.id}/approve`, { breakGlassReason: reason }); } catch (e2) { onError(e2); } }
      } else onError(err);
    }
    load();
  };
  const reject = async (s) => {
    const reason = window.prompt(t('rb.rejectPrompt'));
    if (!reason) return;
    try { await api.rbPost(`/sends/${s.id}/reject`, { reason }); } catch (err) { onError(err); }
    load();
  };
  return (
    <div>
      <div className="ledger-filters"><label className="ledger-field">{t('rb.status')}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">{t('rb.sendStatus.pending')}</option><option value="">{t('rb.all')}</option>
        </select></label></div>
      {!rows.length ? <p className="ledger-empty">{t('rb.noSends')}</p> : (
        <table className="ledger-table">
          <thead><tr><th>#</th><th>{t('rb.report')}</th><th>{t('rb.channel')}</th><th>{t('rb.recipients')}</th><th>{t('rb.requestedBy')}</th><th>{t('rb.status')}</th><th /></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}>
              <td>{s.id}</td><td>{s.report_name}</td><td>{s.channel === 'email' ? t('rb.email') : 'WhatsApp'}</td>
              <td>{s.recipients.map((r) => r.name || r.address).join('، ')}</td>
              <td>{s.requested_by_name}</td>
              <td>{t(`rb.sendStatus.${s.status}`)}{s.results ? ` — ${s.results.filter((x) => x.ok).length}/${s.results.length}` : ''}{s.results?.some((x) => x.error) ? ` (${[...new Set(s.results.filter((x) => x.error).map((x) => t(`rb.sendError.${x.error}`)))].join('، ')})` : ''}</td>
              <td>{s.status === 'pending' && <>
                <button type="button" className="ledger-tab-btn" onClick={() => api.rbDownload(`/sends/${s.id}/file`).catch(onError)}>{t('rb.review')}</button>
                <button type="button" className="ledger-tab-btn" onClick={() => approve(s)}>{t('rb.approveSend')}</button>
                <button type="button" className="ledger-tab-btn" onClick={() => reject(s)}>{t('rb.reject')}</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

export default function ReportBuilderPage() {
  const { t, lang } = useLanguage();
  const { can } = useAuth();
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'builder');
  const [catalog, setCatalog] = useState(null);
  const [s, setS] = useState(emptySpec);
  const [out, setOut] = useState(null);
  const [drill, setDrill] = useState(null);
  const [saved, setSaved] = useState([]);
  const [selected, setSelected] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [saveForm, setSaveForm] = useState({ name: '', description: '', shared: false });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const onError = (err) => setError(ledgerError(err, t));
  const digits = catalog?.digits ?? 2;
  const loadSaved = () => api.rbGet('/saved').then(setSaved).catch(onError);
  useEffect(() => {
    api.rbGet('/catalog').then(setCatalog).catch(onError);
    loadSaved();
    if (can('send_reports')) api.rbGet('/recipients').then(setRecipients).catch(() => setRecipients([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const src = useMemo(() => catalog?.sources.find((x) => x.key === s.source), [catalog, s.source]);
  const label = (x) => (lang === 'en' ? x.label_en : x.label_ar);
  const set = (patch) => { setS((x) => ({ ...x, ...patch })); setOut(null); setDrill(null); };
  const toggleMeasure = (k) => set({ measures: s.measures.includes(k) ? s.measures.filter((m) => m !== k) : [...s.measures, k] });
  const run = async () => {
    setBusy(true); setError(null); setNotice(null); setDrill(null);
    try { setOut(await api.rbPost('/run', { spec: toSpec(s) })); } catch (err) { setOut(null); onError(err); }
    setBusy(false);
  };
  const openDrill = async (d) => {
    try { setDrill(await api.rbGet(`/drill?source=${encodeURIComponent(d.source)}&filters=${encodeURIComponent(JSON.stringify(d.filters))}`)); } catch (err) { onError(err); }
  };
  const exportAs = (format) => api.rbExport({ spec: toSpec(s), format, lang, title: saveForm.name || undefined }).catch(onError);
  const save = async () => {
    setError(null);
    try {
      const r = await api.rbPost('/saved', { name: saveForm.name, description: saveForm.description || undefined, visibility: saveForm.shared ? 'shared' : 'private', spec: toSpec(s) });
      setNotice(t('rb.saved').replace('{name}', r.name));
      setSaveForm({ name: '', description: '', shared: false });
      loadSaved();
    } catch (err) { onError(err); }
  };
  const loadReport = (r) => { setS(fromSpec(r.spec)); setTab('builder'); setOut(null); setDrill(null); };
  const tabs = ['builder', 'saved', ...(can('send_reports') ? ['sends'] : [])];
  const valueKeys = [...s.measures, ...s.calcs.map((c) => c.key)];
  const sortLabel = (k) => { const x = [...(src?.dimensions || []), ...(src?.measures || [])].find((d) => d.key === k); return x ? label(x) : (s.calcs.find((c) => c.key === k)?.label || k); };

  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{t('nav.reportBuilder')}</h1><p className="ledger-subtitle">{t('rb.hint')}</p></div></div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      <div className="ledger-tabs">
        {tabs.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{t(`rb.tab.${k}`)}</button>)}
      </div>

      {tab === 'builder' && catalog && <>
        <div className="ledger-card">
          <div className="ledger-filters" style={{ alignItems: 'end' }}>
            <label className="ledger-field">{t('rb.source')}
              <select value={s.source} onChange={(e) => { const next = catalog.sources.find((x) => x.key === e.target.value); set({ source: e.target.value, measures: [next.measures[0].key], dimensions: [], filters: [], calcs: [], sortBy: '' }); }}>
                {catalog.sources.map((x) => <option key={x.key} value={x.key}>{label(x)}</option>)}
              </select>
            </label>
            {[0, 1, 2].map((i) => (
              <label key={i} className="ledger-field">{t('rb.dimension')} {i + 1}
                <select value={s.dimensions[i] || ''} disabled={i > 0 && !s.dimensions[i - 1]} onChange={(e) => { const d = [...s.dimensions]; d[i] = e.target.value; set({ dimensions: d.slice(0, e.target.value ? 3 : i) }); }}>
                  <option value="">—</option>
                  {(src?.dimensions || []).filter((d) => d.key === s.dimensions[i] || !s.dimensions.includes(d.key)).map((d) => <option key={d.key} value={d.key}>{label(d)}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="ledger-field"><span>{t('rb.measures')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {(src?.measures || []).map((m) => <label key={m.key} style={{ display: 'inline-flex', gap: 4 }}><input type="checkbox" checked={s.measures.includes(m.key)} onChange={() => toggleMeasure(m.key)} />{label(m)} <code>{m.key}</code></label>)}
            </div>
          </div>
          <div className="ledger-field"><span>{t('rb.calcs')}</span>
            {s.calcs.map((c, i) => (
              <div key={i} className="ledger-filters" style={{ alignItems: 'end' }}>
                <label className="ledger-field">{t('rb.calcKey')}<input value={c.key} onChange={(e) => set({ calcs: s.calcs.map((x, j) => (j === i ? { ...x, key: e.target.value.toLowerCase() } : x)) })} /></label>
                <label className="ledger-field">{t('rb.calcLabel')}<input value={c.label} onChange={(e) => set({ calcs: s.calcs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /></label>
                <label className="ledger-field">{t('rb.calcExpr')}<input dir="ltr" value={c.expr} placeholder="(net - cost) / net * 100" onChange={(e) => set({ calcs: s.calcs.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)) })} /></label>
                <label className="ledger-field">{t('rb.calcFormat')}<select value={c.format} onChange={(e) => set({ calcs: s.calcs.map((x, j) => (j === i ? { ...x, format: e.target.value } : x)) })}>{['number', 'percent', 'money'].map((f) => <option key={f} value={f}>{t(`rb.format.${f}`)}</option>)}</select></label>
                <button type="button" className="ghost-btn" onClick={() => set({ calcs: s.calcs.filter((_, j) => j !== i) })}>{t('rb.remove')}</button>
              </div>
            ))}
            {s.calcs.length < 5 && <button type="button" className="ghost-btn" onClick={() => set({ calcs: [...s.calcs, { key: `ratio${s.calcs.length + 1}`, label: '', expr: '', format: 'number' }] })}>{t('rb.addCalc')}</button>}
            <p className="ledger-subtitle">{t('rb.calcHint')} <code dir="ltr">(net - cost) / net * 100</code></p>
          </div>
          <div className="ledger-field"><span>{t('rb.filters')}</span>
            {s.filters.map((f, i) => <FilterRow key={i} f={f} dims={src?.dimensions || []} source={s.source} t={t} lang={lang} onChange={(nf) => set({ filters: s.filters.map((x, j) => (j === i ? nf : x)) })} onRemove={() => set({ filters: s.filters.filter((_, j) => j !== i) })} />)}
            {s.filters.length < 10 && <button type="button" className="ghost-btn" onClick={() => set({ filters: [...s.filters, { dim: '', op: 'in', values: [] }] })}>{t('rb.addFilter')}</button>}
          </div>
          <div className="ledger-filters" style={{ alignItems: 'end' }}>
            <label className="ledger-field">{t('rb.period')}
              <select value={s.preset} onChange={(e) => set({ preset: e.target.value })}>{PRESETS.map((p) => <option key={p} value={p}>{t(`rb.preset.${p}`)}</option>)}</select>
            </label>
            {s.preset === 'last_n_days' && <label className="ledger-field">{t('rb.days')}<input type="number" min={1} max={366} value={s.n} onChange={(e) => set({ n: e.target.value })} /></label>}
            {s.preset === 'custom' && <>
              <label className="ledger-field">{t('analytics.from')}<input type="date" value={s.from} onChange={(e) => set({ from: e.target.value })} /></label>
              <label className="ledger-field">{t('analytics.to')}<input type="date" value={s.to} onChange={(e) => set({ to: e.target.value })} /></label>
            </>}
            <label className="ledger-field">{t('rb.compare')}
              <select value={s.compare} onChange={(e) => set({ compare: e.target.value })}>
                <option value="">—</option><option value="previous_period">{t('rb.compare.previous_period')}</option><option value="previous_year">{t('rb.compare.previous_year')}</option>
              </select>
            </label>
            <label className="ledger-field">{t('rb.sortBy')}
              <select value={s.sortBy || ''} onChange={(e) => set({ sortBy: e.target.value })}>
                <option value="">—</option>
                {[...s.dimensions.filter(Boolean), ...valueKeys].map((k) => <option key={k} value={k}>{sortLabel(k)}</option>)}
              </select>
            </label>
            <label className="ledger-field">{t('rb.sortDir')}
              <select value={s.sortDir || 'desc'} onChange={(e) => set({ sortDir: e.target.value })}><option value="desc">{t('rb.desc')}</option><option value="asc">{t('rb.asc')}</option></select>
            </label>
            <button type="button" className="gold-btn" disabled={busy || !s.measures.length} onClick={run}>{busy ? t('analytics.running') : t('analytics.run')}</button>
          </div>
        </div>

        {out && <>
          <p className={out.freshness?.up_to_date ? 'ledger-subtitle' : 'ledger-notice'}>
            {label(out)} — {out.period.from} → {out.period.to}{out.compare_period ? ` / ${t('rb.vs')} ${out.compare_period.from} → ${out.compare_period.to}` : ''} — {t('analytics.freshAt')}: {out.freshness?.refreshed_at || '—'}
          </p>
          {out.truncated && <div className="ledger-notice">{t('analytics.truncated').replace('{cap}', out.rows.length).replace('{n}', out.row_count)}</div>}
          <div className="ledger-actions" style={{ margin: '8px 0' }}>
            {['xlsx', 'pdf', 'csv'].map((f) => <button key={f} type="button" className="ghost-btn" onClick={() => exportAs(f)}>{f === 'xlsx' ? 'Excel' : f.toUpperCase()}</button>)}
          </div>
          {out.rows.length ? <ResultTable out={out} digits={digits} t={t} lang={lang} onDrill={openDrill} /> : <p className="ledger-empty">{t('analytics.empty')}</p>}
          <details className="ledger-card" style={{ marginTop: 8 }}>
            <summary>{t('rb.specUsed')}</summary>
            <pre dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(toSpec(s), null, 2)}</pre>
          </details>
          <div className="ledger-card" style={{ marginTop: 8 }}>
            <h3>{t('rb.saveTitle')}</h3>
            <div className="ledger-filters" style={{ alignItems: 'end' }}>
              <label className="ledger-field">{t('rb.name')}<input value={saveForm.name} maxLength={100} onChange={(e) => setSaveForm((x) => ({ ...x, name: e.target.value }))} /></label>
              <label className="ledger-field">{t('rb.description')}<input value={saveForm.description} maxLength={500} onChange={(e) => setSaveForm((x) => ({ ...x, description: e.target.value }))} /></label>
              {can('share_reports') && <label style={{ display: 'inline-flex', gap: 4 }}><input type="checkbox" checked={saveForm.shared} onChange={(e) => setSaveForm((x) => ({ ...x, shared: e.target.checked }))} />{t('rb.shareWithUsers')}</label>}
              <button type="button" className="gold-btn" disabled={!saveForm.name.trim()} onClick={save}>{t('rb.save')}</button>
            </div>
          </div>
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
      </>}

      {tab === 'saved' && <>
        {!saved.length ? <p className="ledger-empty">{t('rb.noSaved')}</p> : (
          <table className="ledger-table">
            <thead><tr><th>{t('rb.name')}</th><th>{t('rb.owner')}</th><th>{t('rb.visibilityCol')}</th><th>{t('rb.source')}</th><th /></tr></thead>
            <tbody>{saved.map((r) => (
              <tr key={r.id} className={selected?.id === r.id ? 'ledger-row-selected' : undefined}>
                <td>{r.name}</td><td>{r.owner_name}</td><td>{t(`rb.visibility.${r.visibility}`)}</td>
                <td>{label(catalog?.sources.find((x) => x.key === r.spec.source) || { label_ar: r.spec.source, label_en: r.spec.source })}</td>
                <td><button type="button" className="ledger-tab-btn" onClick={() => setSelected(selected?.id === r.id ? null : r)}>{t('rb.details')}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {selected && <SavedDetail key={selected.id} report={selected} t={t} can={can} recipients={recipients} digits={digits} onLoad={loadReport} onChanged={() => { setSelected(null); loadSaved(); }} onError={onError} />}
      </>}

      {tab === 'sends' && <SendsTab t={t} onError={onError} />}
    </div>
  );
}
