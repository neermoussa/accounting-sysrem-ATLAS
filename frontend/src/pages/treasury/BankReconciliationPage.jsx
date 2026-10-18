import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

const FIELDS = ['date', 'description', 'reference', 'amount', 'debit', 'credit', 'balance'];
const today = () => new Date().toISOString().slice(0, 10);

// Bank reconciliation (Prompt 7): import a statement (Excel/CSV) -> map the
// columns -> auto-match with confidence -> review the exceptions only ->
// reconciliation report (book vs bank with the reconciling items).
export default function BankReconciliationPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const banks = (meta?.boxes || []).filter((b) => b.kind === 'bank');
  const boxId = sp.get('box') || banks[0]?.id || '';
  const statementId = sp.get('statement');
  useEffect(() => { api.trGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t))); }, []);
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const box = banks.find((b) => String(b.id) === String(boxId));
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.bankReconciliation')}</h1><p className="ledger-subtitle">{t('tr.bank.subtitle')}</p></div>
        <Link className="ghost-btn" to="/treasury">{t('nav.treasury')}</Link>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {!banks.length ? <div className="card ledger-card"><p className="ledger-hint">{t('tr.bank.noBanks')}</p></div> : (
        <>
          <div className="ledger-toolbar">
            <div className="ledger-filters"><label className="ledger-field">{t('tr.kind.bank')}<select value={boxId} onChange={(e) => setSp({ box: e.target.value })}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select></label></div>
          </div>
          {statementId
            ? <StatementReview t={t} can={can} box={box} id={statementId} back={() => setSp({ box: boxId })} setError={setError} setNotice={setNotice} />
            : <>
                {can('reconcile_bank') && <Importer t={t} box={box} done={(st) => setSp({ box: boxId, statement: String(st.id) })} setError={setError} />}
                <Statements t={t} box={box} open={(sid) => setSp({ box: boxId, statement: String(sid) })} />
                <Report t={t} box={box} />
              </>}
        </>
      )}
    </div>
  );
}

function Importer({ t, box, done, setError }) {
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [opening, setOpening] = useState('');
  const load = async (fn) => {
    setError(null);
    try {
      const p = await fn();
      setPreview(p);
      setMapping(p.mapping || {});
    } catch (err) {
      setError(ledgerError(err, t));
    }
  };
  return (
    <div className="card ledger-card">
      <h2 className="atlas-section-title">{t('tr.bank.import')}</h2>
      <p className="ledger-hint">{t('tr.bank.importHint')}</p>
      <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => e.target.files[0] && load(() => api.trUploadStatement(e.target.files[0]))} />
      {preview && (
        <>
          <div className="ledger-form-grid" style={{ marginTop: 12 }}>
            {FIELDS.map((f) => (
              <label key={f} className="ledger-field">{t(`tr.bank.col.${f}`)}
                <select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                  <option value="">—</option>
                  {preview.header.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}
                </select>
              </label>
            ))}
            <label className="ledger-field">{t('tr.bank.opening')}<input dir="ltr" value={opening} placeholder={t('tr.bank.openingHint')} onChange={(e) => setOpening(e.target.value)} /></label>
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead><tr>{preview.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{preview.rows.slice(0, 8).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c === null ? '' : String(c)}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <p className="ledger-hint">{t('tr.bank.rows')}: {preview.rows.length}</p>
          <div className="ledger-actions">
            <button type="button" className="ghost-btn" onClick={() => setPreview(null)}>{t('common.cancel')}</button>
            <button type="button" className="gold-btn" onClick={async () => {
              setError(null);
              try {
                done(await api.trPost('/bank/statements', { cashBoxId: box.id, fileName: preview.file_name, mapping, rows: preview.rows, openingBalance: opening || undefined }));
              } catch (err) {
                setError(ledgerError(err, t));
              }
            }}>{t('tr.bank.importMatch')}</button>
          </div>
        </>
      )}
    </div>
  );
}

function Statements({ t, box, open }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.trGet('/bank/statements', { cashBoxId: box.id }).then(setRows).catch(() => setRows([])); }, [box.id]);
  if (!rows?.length) return null;
  return (
    <div className="card ledger-card">
      <h2 className="atlas-section-title">{t('tr.bank.statements')}</h2>
      <table className="ledger-table">
        <thead><tr><th>{t('fr.from')}</th><th>{t('fr.to')}</th><th>{t('tr.bank.file')}</th><th className="ledger-num">{t('tr.bank.rows')}</th><th className="ledger-num">{t('tr.bank.closing')}</th><th /></tr></thead>
        <tbody>{rows.map((s) => <tr key={s.id} className="ledger-row-click" onClick={() => open(s.id)}><td>{s.date_from}</td><td>{s.date_to}</td><td>{s.file_name || '—'}</td><td className="ledger-num">{s.line_count}</td><td className="ledger-num">{s.closing_balance_minor === null ? '—' : formatMinor(s.closing_balance_minor, box.digits)}</td><td>{t('tr.bank.review')}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function StatementReview({ t, can, box, id, back, setError, setNotice }) {
  const [st, setSt] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [cands, setCands] = useState(null);
  const load = () => api.trGet(`/bank/statements/${id}`).then(setSt).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const review = async (lineId, body) => {
    setError(null);
    try {
      await api.trPost(`/bank/lines/${lineId}/review`, body);
      setCands(null);
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  };
  if (!st) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const m = (minor) => formatMinor(minor, st.digits);
  const rows = showAll ? st.lines : st.exceptions;
  return (
    <div className="card ledger-card">
      <div className="ledger-toolbar">
        <button type="button" className="ghost-btn" onClick={back}>{t('tr.bank.back')}</button>
        <div className="ledger-actions">
          <label className="ledger-field" style={{ flexDirection: 'row', gap: 6 }}><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />{t('tr.bank.showAll')}</label>
          {can('reconcile_bank') && <button type="button" className="ghost-btn" onClick={async () => { const r = await api.trPost(`/bank/statements/${id}/auto-match`, {}); setNotice(`${t('tr.bank.autoMatched')}: ${r.matched} — ${t('tr.bank.suggested')}: ${r.suggested}`); setSt(r.statement); }}>{t('tr.bank.rematch')}</button>}
        </div>
      </div>
      <div className="ledger-meta-grid">
        {['matched', 'suggested', 'unmatched', 'ignored'].map((k) => <div key={k}><span className="ledger-hint">{t(`tr.bank.st.${k}`)}</span><strong>{st.counts[k]}</strong></div>)}
      </div>
      {!rows.length && <div className="ledger-balance ledger-balance-ok">{t('tr.bank.noExceptions')}</div>}
      <table className="ledger-table">
        <thead><tr><th>{t('fr.date')}</th><th>{t('tr.bank.col.description')}</th><th>{t('tr.bank.col.reference')}</th><th className="ledger-num">{t('fr.amount')}</th><th>{t('tr.statusLabel')}</th><th>{t('tr.bank.bookLine')}</th><th /></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id}>
            <td>{l.line_date}</td><td>{l.description}</td><td dir="ltr">{l.reference}</td>
            <td className={`ledger-num ${l.amount_minor < 0 ? 'ledger-neg' : ''}`}>{m(l.amount_minor)}</td>
            <td>{t(`tr.bank.st.${l.status}`)}{l.confidence ? ` (${l.confidence}%)` : ''}</td>
            <td>{l.journal_line ? <Link to={`/ledger/entries/${l.journal_line.entry_id}`}>{l.journal_line.entry_number} — {l.journal_line.entry_date}</Link> : '—'}</td>
            <td>
              {can('reconcile_bank') && l.status === 'suggested' && <button type="button" className="gold-btn" onClick={() => review(l.id, { action: 'confirm' })}>{t('tr.bank.confirm')}</button>}
              {can('reconcile_bank') && ['unmatched', 'suggested'].includes(l.status) && <button type="button" className="ghost-btn" onClick={async () => setCands({ line: l, rows: await api.trGet(`/bank/lines/${l.id}/candidates`) })}>{t('tr.bank.find')}</button>}
              {can('reconcile_bank') && ['unmatched', 'suggested'].includes(l.status) && <button type="button" className="ghost-btn" onClick={() => review(l.id, { action: 'ignore' })}>{t('tr.bank.ignore')}</button>}
              {can('reconcile_bank') && l.status === 'matched' && <button type="button" className="ghost-btn" onClick={() => review(l.id, { action: 'unmatch' })}>{t('tr.bank.unmatch')}</button>}
              {can('reconcile_bank') && l.status === 'ignored' && <button type="button" className="ghost-btn" onClick={() => review(l.id, { action: 'unignore' })}>{t('tr.bank.unignore')}</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
      {cands && (
        <div className="card ledger-card">
          <h3 className="atlas-section-title">{t('tr.bank.candidatesFor')} {cands.line.line_date} — {m(cands.line.amount_minor)}</h3>
          <p className="ledger-hint">{t('tr.bank.candidatesHint')}</p>
          <table className="ledger-table">
            <thead><tr><th>{t('fr.date')}</th><th>{t('tr.entry')}</th><th>{t('sales.description')}</th><th className="ledger-num">{t('fr.amount')}</th><th className="ledger-num">%</th><th /></tr></thead>
            <tbody>{cands.rows.map((c) => (
              <tr key={c.id}>
                <td>{c.entry_date}</td><td dir="ltr">{c.entry_number}</td><td>{c.memo || c.description}</td><td className="ledger-num">{m(c.amount_minor)}</td><td className="ledger-num">{c.confidence || ''}</td>
                <td>{c.amount_minor === cands.line.amount_minor ? <button type="button" className="gold-btn" onClick={() => review(cands.line.id, { action: 'match', journalLineId: c.id })}>{t('tr.bank.match')}</button> : <span className="ledger-hint">{t('tr.bank.amountDiffers')}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
          <button type="button" className="ghost-btn" onClick={() => setCands(null)}>{t('common.cancel')}</button>
        </div>
      )}
    </div>
  );
}

function Report({ t, box }) {
  const [asOf, setAsOf] = useState(today());
  const [r, setR] = useState(null);
  useEffect(() => { setR(null); api.trGet('/bank/reconciliation', { cashBoxId: box.id, asOf }).then(setR).catch(() => setR(null)); }, [box.id, asOf]);
  const m = (minor) => (minor === null || minor === undefined ? '—' : formatMinor(minor, box.digits));
  return (
    <div className="card ledger-card">
      <div className="ledger-toolbar">
        <h2 className="atlas-section-title">{t('tr.bank.report')}</h2>
        <label className="ledger-field">{t('fr.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
      </div>
      {!r ? <div className="ledger-loading">{t('ledger.loading')}</div> : (
        <>
          {r.difference_minor !== null && <div className={`ledger-balance ${r.difference_minor === 0 ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{t('tr.bank.difference')}: {m(r.difference_minor)} {box.currency_code}</div>}
          <table className="ledger-table">
            <tbody>
              <tr><td>{t('tr.bank.bookBalance')}</td><td className="ledger-num">{m(r.book_balance_minor)}</td></tr>
              <tr><td>− {t('tr.bank.depositsInTransit')}</td><td className="ledger-num">{m(r.deposits_in_transit_minor)}</td></tr>
              <tr><td>+ {t('tr.bank.unpresented')}</td><td className="ledger-num">{m(r.unpresented_payments_minor)}</td></tr>
              <tr><td>+ {t('tr.bank.bankIn')}</td><td className="ledger-num">{m(r.bank_only_in_minor)}</td></tr>
              <tr><td>− {t('tr.bank.bankOut')}</td><td className="ledger-num">{m(r.bank_only_out_minor)}</td></tr>
              {r.opening_difference_minor !== 0 && <tr><td>± {t('tr.bank.openingDiff')}</td><td className="ledger-num">{m(r.opening_difference_minor)}</td></tr>}
              <tr className="ledger-row-header"><td>{t('tr.bank.expectedBank')}</td><td className="ledger-num">{m(r.expected_bank_balance_minor)}</td></tr>
              <tr className="ledger-row-header"><td>{t('tr.bank.bankBalance')}</td><td className="ledger-num">{m(r.bank_balance_minor)}</td></tr>
            </tbody>
          </table>
          {r.outstanding_book_lines.length > 0 && (
            <>
              <h3 className="atlas-section-title">{t('tr.bank.outstanding')}</h3>
              <table className="ledger-table"><tbody>{r.outstanding_book_lines.map((l) => <tr key={l.id}><td>{l.entry_date}</td><td dir="ltr">{l.entry_number}</td><td>{l.memo || l.description}</td><td className="ledger-num">{m(l.amount_minor)}</td></tr>)}</tbody></table>
            </>
          )}
          {r.unmatched_bank_lines.length > 0 && (
            <>
              <h3 className="atlas-section-title">{t('tr.bank.unmatchedBank')}</h3>
              <table className="ledger-table"><tbody>{r.unmatched_bank_lines.map((l) => <tr key={l.id}><td>{l.line_date}</td><td>{l.description}</td><td dir="ltr">{l.reference}</td><td className="ledger-num">{m(l.amount_minor)}</td></tr>)}</tbody></table>
            </>
          )}
          {!r.started_at && <p className="ledger-hint">{t('tr.bank.noStatement')}</p>}
        </>
      )}
    </div>
  );
}
