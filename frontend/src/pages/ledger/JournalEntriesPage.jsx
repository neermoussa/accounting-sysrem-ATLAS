import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { accountLabel, convertToBaseMinor, formatMinor, ledgerError, rateE8OrNull, toMinorOrNull } from './ledgerShared.js';
import '../../styles/ledger.css';

const STATUSES = ['draft', 'posted', 'reversed'];

// Where a system-generated entry's source document lives. Later prompts add
// their own source types here.
const SOURCE_LINKS = {
  opening_balance: () => '/ledger/opening-balances',
  collection: () => '/collections',
  customer_receipt: (id) => `/receivables/receipts?id=${id}`,
  sales_invoice: (id) => `/sales/invoices?id=${id}`,
  sales_credit_note: (id) => `/sales/credit-notes?id=${id}`,
  return_request: () => '/returns',
  order: () => '/orders',
};

function StatusBadge({ status, t }) {
  return <span className={`ledger-badge ledger-badge-${status}`}>{t(`ledger.status.${status}`)}</span>;
}

export default function JournalEntriesPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.getLedgerMeta(), api.getLedgerAccounts()])
      .then(([m, a]) => {
        setMeta(m);
        setAccounts(a);
      })
      .catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (next) => setParams(next);
  const viewId = params.get('id');
  const editId = params.get('edit');
  const isNew = params.get('new') === '1';

  return (
    <div className="ledger-page">
      {error && <div className="ledger-error">{error}</div>}
      {!meta && !error && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {meta && (isNew || editId) && (
        <EntryForm key={editId || 'new'} t={t} meta={meta} accounts={accounts} editId={editId} can={can} go={go} />
      )}
      {meta && viewId && !editId && <EntryDetail key={viewId} t={t} meta={meta} id={viewId} can={can} go={go} />}
      {meta && !viewId && !editId && !isNew && <EntryList t={t} meta={meta} accounts={accounts} can={can} go={go} />}
    </div>
  );
}

// ---------------------------------------------------------------------
// List
// ---------------------------------------------------------------------

function EntryList({ t, meta, accounts, can, go }) {
  const [filters, setFilters] = useState({ status: '', from: '', to: '', accountId: '', q: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [integrity, setIntegrity] = useState(null);

  function load(f = filters) {
    const query = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
    api.getJournalEntries({ ...query, limit: 200 }).then(setData).catch((err) => setError(ledgerError(err, t)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), []);

  const setF = (k) => (e) => {
    const next = { ...filters, [k]: e.target.value };
    setFilters(next);
    if (k !== 'q') load(next);
  };
  const digits = meta.base_currency?.minor_unit_digits ?? 2;

  async function runIntegrity() {
    try {
      setIntegrity(await api.getLedgerIntegrity());
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('ledger.entries.title')}</h1>
          <p className="ledger-subtitle">{t('ledger.entries.subtitle')}</p>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={runIntegrity}>{t('ledger.integrity.run')}</button>
          {can('post_journal_entries') && (
            <button type="button" className="gold-btn" onClick={() => go({ new: '1' })}>{t('ledger.entries.new')}</button>
          )}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {integrity && (
        <div className={integrity.ok ? 'ledger-notice' : 'ledger-error'}>
          {integrity.ok ? t('ledger.integrity.ok') : t('ledger.integrity.bad')}
          {!integrity.ok && (
            <ul>
              {integrity.violations.slice(0, 20).map((v, i) => (
                <li key={i}>{v.entry_number || v.entry_id || ''} — {v.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">
            {t('ledger.entries.status')}
            <select value={filters.status} onChange={setF('status')}>
              <option value="">{t('ledger.all')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`ledger.status.${s}`)}</option>)}
            </select>
          </label>
          <label className="ledger-field">{t('ledger.from')}<input type="date" value={filters.from} onChange={setF('from')} /></label>
          <label className="ledger-field">{t('ledger.to')}<input type="date" value={filters.to} onChange={setF('to')} /></label>
          <label className="ledger-field">
            {t('ledger.entries.account')}
            <select value={filters.accountId} onChange={setF('accountId')}>
              <option value="">{t('ledger.all')}</option>
              {accounts.filter((a) => a.is_postable).map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
            </select>
          </label>
          <label className="ledger-field">
            {t('ledger.search')}
            <input value={filters.q} onChange={setF('q')} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder={t('ledger.entries.searchPlaceholder')} />
          </label>
        </div>
      </div>
      {!data && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {data && data.entries.length === 0 && <div className="ledger-empty">{t('ledger.entries.empty')}</div>}
      {data && data.entries.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t('ledger.entries.number')}</th>
                <th>{t('ledger.entries.date')}</th>
                <th>{t('ledger.entries.description')}</th>
                <th>{t('ledger.entries.source')}</th>
                <th className="ledger-num">{t('ledger.entries.amount')} ({data.base_currency})</th>
                <th>{t('ledger.entries.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id} className="ledger-row-click" onClick={() => go({ id: String(e.id) })}>
                  <td>{e.entry_number || <span className="ledger-muted">{t('ledger.entries.noNumber')}</span>}</td>
                  <td>{e.entry_date}</td>
                  <td>{e.description}</td>
                  <td>{t(`ledger.source.${e.source_type}`) !== `ledger.source.${e.source_type}` ? t(`ledger.source.${e.source_type}`) : e.source_type}</td>
                  <td className="ledger-num">{formatMinor(e.total_debit_minor, digits)}</td>
                  <td><StatusBadge status={e.status} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.entries.length && <p className="ledger-hint" style={{ padding: 12 }}>{t('ledger.entries.truncated')}</p>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Form (new entry / edit draft)
// ---------------------------------------------------------------------

const emptyLine = () => ({ accountId: '', currencyCode: '', exchangeRate: '', rateQuote: 'base_per_foreign', debit: '', credit: '', costCenterId: '', projectId: '', memo: '' });

function EntryForm({ t, meta, accounts, editId, can, go }) {
  const base = meta.base_currency;
  const [header, setHeader] = useState({ date: new Date().toISOString().slice(0, 10), description: '', branchId: '' });
  const [lines, setLines] = useState([emptyLine(), emptyLine()]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!editId);
  const postable = accounts.filter((a) => a.is_postable && a.is_active);
  const currencyByCode = useMemo(() => Object.fromEntries(meta.currencies.map((c) => [c.code, c])), [meta]);

  useEffect(() => {
    if (!editId) return;
    api
      .getJournalEntry(editId)
      .then((e) => {
        setHeader({ date: e.entry_date, description: e.description || '', branchId: e.branch_id || '' });
        setLines(
          e.lines.map((l) => {
            const foreign = l.currency_code !== base.code;
            return {
              accountId: String(l.account_id),
              currencyCode: foreign ? l.currency_code : '',
              exchangeRate: foreign ? l.exchange_rate : '',
              rateQuote: l.rate_quote || 'base_per_foreign',
              debit: l.debit_minor ? (foreign ? l.amount_original : l.debit) : '',
              credit: l.credit_minor ? (foreign ? l.amount_original : l.credit) : '',
              costCenterId: l.cost_center_id || '',
              projectId: l.project_id || '',
              memo: l.memo || '',
            };
          })
        );
        setLoaded(true);
      })
      .catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  // Live totals in base minor units; a line that cannot be parsed marks the
  // form invalid so the post button stays disabled.
  const summary = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let invalid = false;
    let used = 0;
    for (const l of lines) {
      if (!l.accountId && !l.debit && !l.credit) continue;
      used += 1;
      const cur = currencyByCode[l.currencyCode || base.code];
      const d = toMinorOrNull(l.debit, cur.minor_unit_digits);
      const c = toMinorOrNull(l.credit, cur.minor_unit_digits);
      if (!l.accountId || d === null || c === null || (d > 0) === (c > 0)) {
        invalid = true;
        continue;
      }
      let amount = d || c;
      if (cur.code !== base.code) {
        const e8 = rateE8OrNull(l.exchangeRate);
        if (!e8) {
          invalid = true;
          continue;
        }
        amount = convertToBaseMinor(amount, e8, l.rateQuote, cur.minor_unit_digits, base.minor_unit_digits);
      }
      if (d) debit += amount;
      else credit += amount;
    }
    return { debit, credit, diff: debit - credit, invalid, used, balanced: !invalid && used >= 2 && debit === credit && debit > 0 };
  }, [lines, base, currencyByCode]);

  const setLine = (i, k) => (e) => {
    const v = e.target.value;
    setLines((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      const next = { ...l, [k]: v };
      if (k === 'debit' && v) next.credit = '';
      if (k === 'credit' && v) next.debit = '';
      if (k === 'accountId') {
        const acc = accounts.find((a) => a.id === Number(v));
        if (acc?.currency_code) next.currencyCode = acc.currency_code === base.code ? '' : acc.currency_code;
      }
      return next;
    }));
  };

  function payload() {
    return {
      date: header.date,
      description: header.description,
      branchId: header.branchId ? Number(header.branchId) : null,
      lines: lines
        .filter((l) => l.accountId || l.debit || l.credit)
        .map((l) => ({
          accountId: Number(l.accountId),
          currencyCode: l.currencyCode || base.code,
          exchangeRate: l.currencyCode ? l.exchangeRate : undefined,
          rateQuote: l.currencyCode ? l.rateQuote : undefined,
          debit: l.debit,
          credit: l.credit,
          costCenterId: l.costCenterId ? Number(l.costCenterId) : null,
          projectId: l.projectId ? Number(l.projectId) : null,
          memo: l.memo,
        })),
    };
  }

  async function save(andPost) {
    setSaving(true);
    setError(null);
    try {
      let entry;
      if (editId) {
        entry = await api.updateJournalEntry(editId, payload());
        if (andPost) entry = await api.postJournalEntry(editId);
      } else {
        entry = await api.createJournalEntry({ ...payload(), post: andPost });
      }
      go({ id: String(entry.id) });
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const d = base.minor_unit_digits;

  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{editId ? t('ledger.form.editTitle') : t('ledger.form.newTitle')}</h1>
          <p className="ledger-subtitle">{t('ledger.form.subtitle')}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => go(editId ? { id: editId } : {})}>{t('ledger.back')}</button>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      <div className="card ledger-card">
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ledger.entries.date')}<input type="date" value={header.date} onChange={(e) => setHeader({ ...header, date: e.target.value })} /></label>
          <label className="ledger-field">
            {t('ledger.form.branch')}
            <select value={header.branchId} onChange={(e) => setHeader({ ...header, branchId: e.target.value })}>
              <option value="">—</option>
              {meta.branches.filter((b) => b.is_active || b.id === Number(header.branchId)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="ledger-field" style={{ gridColumn: '1 / -1' }}>
            {t('ledger.entries.description')}
            <input value={header.description} onChange={(e) => setHeader({ ...header, description: e.target.value })} />
          </label>
        </div>
        <div className="ledger-table-wrap">
          <table className="ledger-table ledger-lines-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('ledger.entries.account')}</th>
                <th>{t('ledger.form.currency')}</th>
                <th>{t('ledger.form.rate')}</th>
                <th>{t('ledger.debit')}</th>
                <th>{t('ledger.credit')}</th>
                <th>{t('ledger.form.costCenter')}</th>
                <th>{t('ledger.form.project')}</th>
                <th>{t('ledger.form.memo')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const acc = accounts.find((a) => a.id === Number(l.accountId));
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      <select value={l.accountId} onChange={setLine(i, 'accountId')}>
                        <option value="">—</option>
                        {postable.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={l.currencyCode} onChange={setLine(i, 'currencyCode')} disabled={!!acc?.currency_code}>
                        <option value="">{base.code}</option>
                        {meta.currencies.filter((c) => c.code !== base.code && c.is_active).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                      </select>
                    </td>
                    <td>
                      <input dir="ltr" value={l.exchangeRate} onChange={setLine(i, 'exchangeRate')} disabled={!l.currencyCode} placeholder={l.currencyCode ? '0.00' : '1'} />
                      {l.currencyCode && (
                        <select value={l.rateQuote} onChange={setLine(i, 'rateQuote')} title={t('ledger.rate.quoteHint')}>
                          <option value="base_per_foreign">{base.code} / 1 {l.currencyCode}</option>
                          <option value="foreign_per_base">{l.currencyCode} / 1 {base.code}</option>
                        </select>
                      )}
                    </td>
                    <td><input dir="ltr" inputMode="decimal" value={l.debit} onChange={setLine(i, 'debit')} /></td>
                    <td><input dir="ltr" inputMode="decimal" value={l.credit} onChange={setLine(i, 'credit')} /></td>
                    <td>
                      <select value={l.costCenterId} onChange={setLine(i, 'costCenterId')}>
                        <option value="">—</option>
                        {meta.cost_centers.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={l.projectId} onChange={setLine(i, 'projectId')}>
                        <option value="">—</option>
                        {meta.projects.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                    <td><input value={l.memo} onChange={setLine(i, 'memo')} /></td>
                    <td>
                      {lines.length > 2 && (
                        <button type="button" className="ghost-btn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" className="ghost-btn" style={{ marginTop: 10 }} onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t('ledger.form.addLine')}</button>
        <div className={`ledger-balance ${summary.balanced ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>
          <span>{t('ledger.form.totalDebit')}: <strong>{formatMinor(summary.debit, d)}</strong></span>
          <span>{t('ledger.form.totalCredit')}: <strong>{formatMinor(summary.credit, d)}</strong></span>
          <span>{t('ledger.form.difference')}: <strong>{formatMinor(summary.diff, d)}</strong> {base.code}</span>
          <span>{summary.balanced ? t('ledger.form.balanced') : summary.invalid ? t('ledger.form.invalidLines') : t('ledger.form.unbalanced')}</span>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" disabled={saving || summary.used === 0} onClick={() => save(false)}>{t('ledger.form.saveDraft')}</button>
          {can('post_journal_entries') && (
            <button type="button" className="gold-btn" disabled={saving || !summary.balanced} onClick={() => save(true)} title={summary.balanced ? '' : t('ledger.form.postBlocked')}>
              {t('ledger.form.post')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------

function EntryDetail({ t, meta, id, can, go }) {
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState(null);
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = meta.base_currency?.minor_unit_digits ?? 2;

  function load() {
    api.getJournalEntry(id).then(setEntry).catch((err) => setError(ledgerError(err, t)));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (error && !entry) return <div className="ledger-error">{error}</div>;
  if (!entry) return <div className="ledger-loading">{t('ledger.loading')}</div>;
  const sourceLink = SOURCE_LINKS[entry.source_type]?.(entry.source_id);

  return (
    <>
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">
            {entry.entry_number || t('ledger.entries.noNumber')} <StatusBadge status={entry.status} t={t} />
          </h1>
          <p className="ledger-subtitle">{entry.description}</p>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => go({})}>{t('ledger.back')}</button>
          {entry.status === 'draft' && can('post_journal_entries') && (
            <>
              <button type="button" className="ghost-btn" onClick={() => go({ edit: String(entry.id) })}>{t('ledger.edit')}</button>
              <button type="button" className="danger-btn" disabled={busy} onClick={() => window.confirm(t('ledger.detail.deleteConfirm')) && act(async () => { await api.deleteJournalEntry(entry.id); go({}); })}>
                {t('ledger.delete')}
              </button>
              <button type="button" className="gold-btn" disabled={busy || !entry.is_balanced} onClick={() => act(async () => setEntry(await api.postJournalEntry(entry.id)))}>
                {t('ledger.form.post')}
              </button>
            </>
          )}
          {entry.status === 'posted' && !entry.reverses_entry_id && entry.source_type === 'manual' && can('reverse_journal_entries') && (
            <button type="button" className="danger-btn" onClick={() => setReversing(true)}>{t('ledger.detail.reverse')}</button>
          )}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {entry.status === 'posted' && !['manual', 'reversal'].includes(entry.source_type) && (
        <div className="ledger-hint" style={{ marginBottom: 12 }}>{t('ledger.detail.reverseViaSource')}</div>
      )}
      <div className="card ledger-card">
        <div className="ledger-meta-grid">
          <Meta label={t('ledger.entries.date')} value={entry.entry_date} />
          <Meta label={t('ledger.entries.source')} value={sourceLink ? <Link to={sourceLink}>{t(`ledger.source.${entry.source_type}`)}</Link> : t(`ledger.source.${entry.source_type}`) !== `ledger.source.${entry.source_type}` ? t(`ledger.source.${entry.source_type}`) : entry.source_type} />
          <Meta label={t('ledger.form.branch')} value={entry.branch?.name || '—'} />
          <Meta label={t('ledger.detail.createdBy')} value={entry.created_by_name || '—'} />
          <Meta label={t('ledger.detail.postedBy')} value={entry.posted_by_name ? `${entry.posted_by_name} · ${entry.posted_at}` : '—'} />
          {entry.reverses && <Meta label={t('ledger.detail.reverses')} value={<a href="#" onClick={(e) => { e.preventDefault(); go({ id: String(entry.reverses.id) }); }}>{entry.reverses.entry_number}</a>} />}
          {entry.reversed_by && <Meta label={t('ledger.detail.reversedBy')} value={<a href="#" onClick={(e) => { e.preventDefault(); go({ id: String(entry.reversed_by.id) }); }}>{entry.reversed_by.entry_number}</a>} />}
          {entry.reversal_reason && <Meta label={t('ledger.detail.reason')} value={entry.reversal_reason} />}
        </div>
      </div>
      <div className="ledger-table-wrap">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('ledger.entries.account')}</th>
              <th className="ledger-num">{t('ledger.debit')} ({entry.base_currency})</th>
              <th className="ledger-num">{t('ledger.credit')} ({entry.base_currency})</th>
              <th>{t('ledger.form.currency')}</th>
              <th>{t('ledger.form.costCenter')}</th>
              <th>{t('ledger.form.project')}</th>
              <th>{t('ledger.form.memo')}</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.line_no}</td>
                <td>{l.account_code} — {l.account_name_ar}</td>
                <td className="ledger-num">{l.debit_minor ? formatMinor(l.debit_minor, d) : ''}</td>
                <td className="ledger-num">{l.credit_minor ? formatMinor(l.credit_minor, d) : ''}</td>
                <td>{l.currency_code === entry.base_currency ? l.currency_code : (l.rate_quote === 'foreign_per_base' ? `${l.amount_original} ${l.currency_code} ÷ ${l.exchange_rate} (${l.currency_code}/${entry.base_currency})` : `${l.amount_original} ${l.currency_code} × ${l.exchange_rate} (${entry.base_currency}/${l.currency_code})`)}</td>
                <td>{l.cost_center_name || ''}</td>
                <td>{l.project_name || ''}</td>
                <td>{l.memo || ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td>{t('ledger.total')}</td>
              <td className="ledger-num">{formatMinor(entry.total_debit_minor, d)}</td>
              <td className="ledger-num">{formatMinor(entry.total_credit_minor, d)}</td>
              <td colSpan={4}>{entry.is_balanced ? t('ledger.form.balanced') : t('ledger.form.unbalanced')}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Attachments t={t} entry={entry} canUpload={can('post_journal_entries')} reload={load} setError={setError} />
      {reversing && (
        <ReverseModal
          t={t}
          entry={entry}
          onClose={() => setReversing(false)}
          onDone={(res) => {
            setReversing(false);
            go({ id: String(res.reversal.id) });
          }}
        />
      )}
    </>
  );
}

function Meta({ label, value }) {
  return (
    <div>
      <div className="ledger-meta-label">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function Attachments({ t, entry, canUpload, reload, setError }) {
  const [uploading, setUploading] = useState(false);
  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadJournalAttachment(entry.id, file);
      reload();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setUploading(false);
    }
  }
  return (
    <div className="card ledger-card" style={{ marginTop: 16 }}>
      <h2 className="atlas-section-title">{t('ledger.detail.attachments')}</h2>
      {entry.attachments.length === 0 && <p className="ledger-hint">{t('ledger.detail.noAttachments')}</p>}
      <ul>
        {entry.attachments.map((a) => (
          <li key={a.id}>
            <a href="#" onClick={(e) => { e.preventDefault(); api.downloadJournalAttachment(a.id).catch((err) => setError(ledgerError(err, t))); }}>{a.original_name}</a>
            <span className="ledger-muted"> · {a.created_at}</span>
          </li>
        ))}
      </ul>
      {canUpload && (
        <label className="ghost-btn" style={{ display: 'inline-block', cursor: 'pointer' }}>
          {uploading ? t('ledger.loading') : t('ledger.detail.addAttachment')}
          <input type="file" hidden onChange={upload} disabled={uploading} />
        </label>
      )}
    </div>
  );
}

function ReverseModal({ t, entry, onClose, onDone }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.reverseJournalEntry(entry.id, { date, reason }));
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ledger-modal-backdrop" onClick={onClose}>
      <div className="ledger-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="atlas-section-title">{t('ledger.detail.reverseTitle')} {entry.entry_number}</h2>
        <p className="ledger-hint">{t('ledger.detail.reverseHint')}</p>
        {error && <div className="ledger-error">{error}</div>}
        <label className="ledger-field">{t('ledger.detail.reverseDate')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="ledger-field">{t('ledger.detail.reason')}<textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="ledger-modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('ledger.cancel')}</button>
          <button type="button" className="danger-btn" disabled={busy} onClick={submit}>{t('ledger.detail.reverseConfirm')}</button>
        </div>
      </div>
    </div>
  );
}
