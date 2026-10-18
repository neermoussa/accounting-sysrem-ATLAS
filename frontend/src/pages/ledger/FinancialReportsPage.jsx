import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import { DrillLink, SourceDocLink } from './DrillLink.jsx';
import '../../styles/ledger.css';

const TABS = ['tb', 'is', 'bs', 'cf', 'ea', 'gl'];
const KEY = { tb: 'trial-balance', is: 'income-statement', bs: 'balance-sheet', cf: 'cash-flow', ea: 'expense-analysis', gl: 'general-ledger' };
const FILTERS = ['from', 'to', 'asOf', 'branchId', 'costCenterId', 'projectId', 'compare', 'monthly', 'by', 'accountId', 'type', 'excludeClosing'];
const year = new Date().getFullYear();

// Financial statements from the ledger. Every amount is a DrillLink to the
// ledger lines behind it (tab "gl"), and every ledger line opens its source
// document.
export default function FinancialReportsPage() {
  const { t, lang } = useLanguage();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'tb';
  const [meta, setMeta] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loaded, setLoaded] = useState(null); // { tab, data } — never render one tab's data in another
  const [error, setError] = useState(null);
  const q = useMemo(() => {
    const o = {};
    for (const k of FILTERS) if (sp.get(k)) o[k] = sp.get(k);
    if (!o.from && tab !== 'bs') o.from = `${year}-01-01`;
    if (!o.to) o.to = `${year}-12-31`;
    return o;
  }, [sp, tab]);

  useEffect(() => {
    Promise.all([api.getLedgerMeta(), api.getLedgerAccounts()]).then(([m, a]) => { setMeta(m); setAccounts(a); }).catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (tab === 'gl' && !q.accountId && !q.type) return;
    const params = tab === 'bs' ? { ...q, asOf: q.asOf || q.to, from: '' } : q;
    api.getFinancialReport(KEY[tab], Object.fromEntries(Object.entries(params).filter(([, v]) => v)))
      .then((r) => setLoaded({ tab, data: r }))
      .catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q]);

  const data = loaded?.tab === tab ? loaded.data : null;
  const set = (patch) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setSp(next);
  };
  const d = data?.digits ?? meta?.base_currency?.minor_unit_digits ?? 2;
  const f = (m) => formatMinor(m, d);
  const name = (r) => (lang === 'en' && r.name_en ? r.name_en : r.name_ar);
  const exportAs = (format) => api.downloadFinancialReport(KEY[tab], { ...Object.fromEntries(Object.entries(tab === 'bs' ? { ...q, asOf: q.asOf || q.to, from: '' } : q).filter(([, v]) => v)), format, lang }).catch((err) => setError(ledgerError(err, t)));

  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('fr.title')}</h1>
          <p className="ledger-subtitle">{t('fr.subtitle')}</p>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={() => exportAs('xlsx')} disabled={!data}>Excel</button>
          <button type="button" className="ghost-btn" onClick={() => exportAs('pdf')} disabled={!data}>PDF</button>
        </div>
      </div>
      <div className="ledger-tabs">
        {TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => set({ tab: k })}>{t(`fr.tab.${k}`)}</button>)}
      </div>
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          {tab !== 'bs' && <label className="ledger-field">{t('fr.from')}<input type="date" value={q.from || ''} onChange={(e) => set({ from: e.target.value })} /></label>}
          <label className="ledger-field">{tab === 'bs' ? t('fr.asOf') : t('fr.to')}<input type="date" value={(tab === 'bs' ? q.asOf || q.to : q.to) || ''} onChange={(e) => set(tab === 'bs' ? { asOf: e.target.value } : { to: e.target.value })} /></label>
          <label className="ledger-field">{t('fr.branch')}
            <select value={q.branchId || ''} onChange={(e) => set({ branchId: e.target.value })}>
              <option value="">{t('fr.all')}</option>
              {(meta?.branches || []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          {tab !== 'bs' && tab !== 'cf' && (
            <>
              <label className="ledger-field">{t('fr.costCenter')}
                <select value={q.costCenterId || ''} onChange={(e) => set({ costCenterId: e.target.value })}>
                  <option value="">{t('fr.all')}</option>
                  {(meta?.cost_centers || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="ledger-field">{t('fr.project')}
                <select value={q.projectId || ''} onChange={(e) => set({ projectId: e.target.value })}>
                  <option value="">{t('fr.all')}</option>
                  {(meta?.projects || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </>
          )}
          {(tab === 'is' || tab === 'bs') && (
            <label className="ledger-field">{t('fr.compare')}
              <select value={q.monthly ? 'monthly' : q.compare || ''} onChange={(e) => set(e.target.value === 'monthly' ? { monthly: '1', compare: '' } : { compare: e.target.value, monthly: '' })}>
                <option value="">—</option>
                <option value="prev_period">{t('fr.prevPeriod')}</option>
                <option value="prev_year">{t('fr.prevYear')}</option>
                {tab === 'is' && <option value="monthly">{t('fr.monthly')}</option>}
              </select>
            </label>
          )}
          {tab === 'ea' && (
            <label className="ledger-field">{t('fr.by')}
              <select value={q.by || 'account'} onChange={(e) => set({ by: e.target.value })}>
                {['account', 'cost_center', 'project', 'branch'].map((b) => <option key={b} value={b}>{t(`fr.by.${b}`)}</option>)}
              </select>
            </label>
          )}
          {tab === 'gl' && (
            <label className="ledger-field">{t('fr.account')}
              <select value={q.accountId || ''} onChange={(e) => set({ accountId: e.target.value, type: '' })}>
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {tab === 'gl' && !q.accountId && !q.type && <div className="ledger-empty">{t('fr.pickAccount')}</div>}
      {data?.inventory_opening_missing && <div className="ledger-error ledger-banner-warn" role="alert">⚠️ {t('fr.inventoryBanner')}</div>}
      {data && tab === 'tb' && <TrialBalance r={data} f={f} name={name} t={t} />}
      {data && tab === 'is' && <IncomeStatement r={data} f={f} name={name} t={t} />}
      {data && tab === 'bs' && <BalanceSheet r={data} f={f} name={name} t={t} />}
      {data && tab === 'cf' && <CashFlow r={data} f={f} t={t} />}
      {data && tab === 'ea' && <ExpenseAnalysis r={data} f={f} t={t} />}
      {data && tab === 'gl' && <GeneralLedger r={data} f={f} t={t} />}
    </div>
  );
}

function Card({ children }) {
  return <div className="card ledger-card"><div className="ledger-table-wrap">{children}</div></div>;
}

function TrialBalance({ r, f, name, t }) {
  const n = (v) => (v ? f(v) : '');
  return (
    <Card>
      <div className={`ledger-balance ${r.balanced ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{r.balanced ? t('fr.balanced') : t('fr.notBalanced')}{r.line_filtered ? ` · ${t('fr.lineFiltered')}` : ''}</div>
      <table className="ledger-table">
        <thead><tr><th>{t('fr.code')}</th><th>{t('fr.account')}</th><th className="ledger-num">{t('fr.openDr')}</th><th className="ledger-num">{t('fr.openCr')}</th><th className="ledger-num">{t('fr.periodDr')}</th><th className="ledger-num">{t('fr.periodCr')}</th><th className="ledger-num">{t('fr.closeDr')}</th><th className="ledger-num">{t('fr.closeCr')}</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.account_id} className={x.is_header ? 'ledger-row-header' : ''}>
              <td>{x.code}</td>
              <td style={{ paddingInlineStart: 8 + x.depth * 14 }}><DrillLink drill={x.drill}>{name(x)}</DrillLink></td>
              {['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'closing_debit', 'closing_credit'].map((k) => <td key={k} className="ledger-num"><DrillLink drill={x.drill}>{n(x[k])}</DrillLink></td>)}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th colSpan={2}>{t('fr.total')}</th>{['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'closing_debit', 'closing_credit'].map((k) => <th key={k} className="ledger-num">{f(r.totals[k])}</th>)}</tr></tfoot>
      </table>
    </Card>
  );
}

function Statement({ columns, blocks, f, name }) {
  return (
    <table className="ledger-table">
      <thead><tr><th />{columns.map((c) => <th key={c.key} className="ledger-num">{c.label}</th>)}</tr></thead>
      <tbody>
        {blocks.map((b, i) => (b.rows ? (
          <Fragment key={`b${i}`}>
            <tr className="ledger-row-header"><td colSpan={columns.length + 1}><strong>{b.title}</strong></td></tr>
            {b.rows.map((x) => (
              <tr key={`${i}-${x.account_id}`}>
                <td style={{ paddingInlineStart: 22 }}>{x.code} {name(x)}</td>
                {x.amounts.map((a, j) => <td key={j} className="ledger-num"><DrillLink drill={x.drill[j]}>{f(a)}</DrillLink></td>)}
              </tr>
            ))}
          </Fragment>
        ) : (
          <tr key={`t${i}`} className="ledger-row-total"><th>{b.title}</th>{b.amounts.map((a, j) => <th key={j} className="ledger-num">{b.drill ? <DrillLink drill={b.drill[j]}>{f(a)}</DrillLink> : f(a)}</th>)}</tr>
        )))}
      </tbody>
    </table>
  );
}

function IncomeStatement({ r, f, name, t }) {
  return (
    <Card>
      <Statement columns={r.columns} f={f} name={name} blocks={[
        { title: t('fr.revenue'), rows: r.sections.revenue },
        { title: t('fr.totalRevenue'), amounts: r.totals.revenue, drill: r.total_drill.revenue },
        { title: t('fr.cogs'), rows: r.sections.cost_of_sales },
        { title: t('fr.gross'), amounts: r.totals.gross_profit },
        { title: t('fr.expenses'), rows: r.sections.expenses },
        { title: t('fr.totalExpenses'), amounts: r.totals.expenses, drill: r.total_drill.expenses },
        { title: t('fr.operating'), amounts: r.totals.operating_income },
        ...(r.sections.other.length ? [{ title: t('fr.other'), rows: r.sections.other }, { title: t('fr.totalOther'), amounts: r.totals.other }] : []),
        { title: t('fr.net'), amounts: r.totals.net_income },
      ]} />
    </Card>
  );
}

function BalanceSheet({ r, f, name, t }) {
  const ok = r.balanced.every(Boolean);
  const earnings = { account_id: 'ce', code: '', name_ar: t('fr.currentEarnings'), amounts: r.current_earnings, drill: r.current_earnings_drill };
  return (
    <Card>
      <div className={`ledger-balance ${ok ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{ok ? t('fr.bsBalanced') : t('fr.notBalanced')}</div>
      <Statement columns={r.columns} f={f} name={name} blocks={[
        { title: t('fr.currentAssets'), rows: r.sections.current_assets },
        { title: t('fr.fixedAssets'), rows: r.sections.fixed_assets },
        { title: t('fr.totalAssets'), amounts: r.totals.assets },
        { title: t('fr.currentLiabilities'), rows: r.sections.current_liabilities },
        { title: t('fr.longLiabilities'), rows: r.sections.long_term_liabilities },
        { title: t('fr.equity'), rows: [...r.sections.equity, earnings] },
        { title: t('fr.totalLiabEq'), amounts: r.totals.liabilities_and_equity },
      ]} />
    </Card>
  );
}

function CashFlow({ r, f, t }) {
  const [method, setMethod] = useState('direct');
  const m = r[method];
  return (
    <Card>
      <div className="ledger-tabs">
        {['direct', 'indirect'].map((k) => <button key={k} type="button" className={`ledger-tab-btn ${method === k ? 'active' : ''}`} onClick={() => setMethod(k)}>{t(`fr.cf.${k}`)}</button>)}
      </div>
      <div className={`ledger-balance ${r.reconciles ? 'ledger-balance-ok' : 'ledger-balance-bad'}`}>{t('fr.openingCash')}: <strong>{f(r.opening_cash)}</strong> · {t('fr.closingCash')}: <strong>{f(r.closing_cash)}</strong> · {t('fr.netChange')}: <strong>{f(r.net_change)}</strong></div>
      <table className="ledger-table">
        <tbody>
          {method === 'indirect' && <tr><td>{t('fr.net')}</td><td className="ledger-num">{f(m.net_income)}</td></tr>}
          {['operating', 'investing', 'financing'].map((k) => (
            <Fragment key={k}>
              <tr className="ledger-row-header"><td colSpan={2}><strong>{t(`fr.cf.${k}`)}</strong></td></tr>
              {m.sections[k].map((x) => <tr key={`${k}${x.account_id}`}><td style={{ paddingInlineStart: 22 }}>{x.code} {x.name_ar}</td><td className="ledger-num"><DrillLink drill={x.drill}>{f(x.amount)}</DrillLink></td></tr>)}
              <tr key={`${k}t`} className="ledger-row-total"><th>{t('fr.cf.net')} {t(`fr.cf.${k}`)}</th><th className="ledger-num">{f(m.totals[k])}</th></tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ExpenseAnalysis({ r, f, t }) {
  return (
    <Card>
      <table className="ledger-table">
        <thead><tr><th>{t(`fr.by.${r.by}`)}</th><th className="ledger-num">{t('fr.amount')}</th><th className="ledger-num">%</th></tr></thead>
        <tbody>{r.rows.map((x) => <tr key={String(x.key)}><td>{x.label || t('fr.unassigned')}</td><td className="ledger-num"><DrillLink drill={x.drill}>{f(x.amount)}</DrillLink></td><td className="ledger-num">{x.pct}</td></tr>)}</tbody>
        <tfoot><tr><th>{t('fr.total')}</th><th className="ledger-num">{f(r.total)}</th><th /></tr></tfoot>
      </table>
    </Card>
  );
}

function GeneralLedger({ r, f, t }) {
  return (
    <Card>
      <h2 className="atlas-section-title">{r.account ? `${r.account.code} — ${r.account.name_ar}` : t(`fr.type.${r.type}`)} · {r.from} → {r.to}</h2>
      <table className="ledger-table">
        <thead><tr><th>{t('fr.date')}</th><th>{t('fr.entry')}</th><th>{t('fr.document')}</th><th>{t('fr.account')}</th><th>{t('fr.description')}</th><th className="ledger-num">{t('fr.debit')}</th><th className="ledger-num">{t('fr.credit')}</th><th className="ledger-num">{t('fr.balance')}</th></tr></thead>
        <tbody>
          <tr className="ledger-row-header"><td colSpan={7}>{t('fr.opening')}</td><td className="ledger-num">{f(r.opening_minor)}</td></tr>
          {r.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.entry_date}</td>
              <td><Link to={`/ledger/entries?id=${l.entry_id}`}>{l.entry_number}</Link></td>
              <td><SourceDocLink line={l} />{l.attachments ? ' 📎' : ''}</td>
              <td>{l.account_code}</td>
              <td>{l.memo || l.description}{l.party_name ? ` — ${l.party_name}` : ''}</td>
              <td className="ledger-num">{l.debit_minor ? f(l.debit_minor) : ''}</td>
              <td className="ledger-num">{l.credit_minor ? f(l.credit_minor) : ''}</td>
              <td className="ledger-num">{f(l.running_minor)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th colSpan={5}>{t('fr.closing')}</th><th className="ledger-num">{f(r.period_debit_minor)}</th><th className="ledger-num">{f(r.period_credit_minor)}</th><th className="ledger-num">{f(r.closing_minor)}</th></tr></tfoot>
      </table>
      {r.truncated && <p className="ledger-hint">{t('fr.truncated')}</p>}
    </Card>
  );
}
