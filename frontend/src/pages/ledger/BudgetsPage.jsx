import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import { DrillLink } from './DrillLink.jsx';
import '../../styles/ledger.css';

// Budgets per fiscal year: monthly amounts per revenue/expense account
// (optionally per cost center), then budget vs actual with drill-down.
export default function BudgetsPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const canManage = can('manage_budgets');
  const [budgets, setBudgets] = useState([]);
  const [years, setYears] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [selected, setSelected] = useState(null);
  const [bva, setBva] = useState(null);
  const [form, setForm] = useState({ fiscalYearId: '', name: '' });
  const [grid, setGrid] = useState({});
  const [newRow, setNewRow] = useState({ accountId: '', costCenterId: '' });
  const [error, setError] = useState(null);
  const d = meta?.base_currency?.minor_unit_digits ?? 2;
  const f = (m) => formatMinor(m, d);

  const load = () => api.getBudgets().then(setBudgets).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    load();
    Promise.all([api.getFiscalYears(), api.getLedgerAccounts(), api.getLedgerMeta()])
      .then(([y, a, m]) => { setYears(y); setAccounts(a.filter((x) => x.is_postable && ['revenue', 'expense'].includes(x.type))); setMeta(m); })
      .catch((err) => setError(ledgerError(err, t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(id) {
    setError(null);
    try {
      const b = await api.getBudget(id);
      setSelected(b);
      const g = {};
      for (const l of b.lines) g[`${l.account_id}|${l.cost_center_id || ''}|${l.period_id}`] = formatMinor(l.amount_minor, d).replace(/,/g, '');
      setGrid(g);
      setBva(await api.getFinancialReport(`budgets/${id}/vs-actual`));
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  async function create(e) {
    e.preventDefault();
    try {
      const b = await api.createBudget({ fiscalYearId: Number(form.fiscalYearId), name: form.name });
      setForm({ fiscalYearId: '', name: '' });
      await load();
      open(b.id);
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  const rowKeys = selected ? [...new Set(Object.keys(grid).map((k) => k.split('|').slice(0, 2).join('|')))] : [];
  async function save() {
    const lines = Object.entries(grid).map(([k, amount]) => {
      const [accountId, costCenterId, periodId] = k.split('|');
      return { accountId: Number(accountId), costCenterId: costCenterId ? Number(costCenterId) : null, periodId: Number(periodId), amount };
    });
    try {
      await api.setBudgetLines(selected.id, lines);
      await open(selected.id);
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }
  function addRow() {
    if (!newRow.accountId) return;
    const g = { ...grid };
    for (const p of selected.periods) g[`${newRow.accountId}|${newRow.costCenterId}|${p.id}`] ??= '';
    setGrid(g);
    setNewRow({ accountId: '', costCenterId: '' });
  }
  const accName = (id) => { const a = accounts.find((x) => x.id === Number(id)); return a ? `${a.code} — ${a.name_ar}` : id; };
  const ccName = (id) => (id ? meta?.cost_centers?.find((c) => c.id === Number(id))?.name : '');
  const editable = canManage && selected?.status !== 'approved';

  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{t('fr.budgets.title')}</h1><p className="ledger-subtitle">{t('fr.budgets.subtitle')}</p></div></div>
      {error && <div className="ledger-error">{error}</div>}
      {canManage && (
        <form className="ledger-toolbar" onSubmit={create}>
          <div className="ledger-filters">
            <label className="ledger-field">{t('ledger.periods.year')}
              <select value={form.fiscalYearId} onChange={(e) => setForm({ ...form, fiscalYearId: e.target.value })} required>
                <option value="">—</option>
                {years.map((y) => <option key={y.id} value={y.id}>{y.year}</option>)}
              </select>
            </label>
            <label className="ledger-field">{t('fr.budgets.name')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          </div>
          <button type="submit" className="gold-btn">{t('fr.budgets.create')}</button>
        </form>
      )}
      <div className="card ledger-card">
        <table className="ledger-table">
          <thead><tr><th>{t('fr.budgets.name')}</th><th>{t('ledger.periods.year')}</th><th>{t('fr.status')}</th><th className="ledger-num">{t('fr.total')}</th></tr></thead>
          <tbody>{budgets.map((b) => <tr key={b.id} onClick={() => open(b.id)} style={{ cursor: 'pointer' }} className={selected?.id === b.id ? 'ledger-row-selected' : ''}><td>{b.name}</td><td>{b.year}</td><td>{t(`fr.budgets.${b.status}`)}</td><td className="ledger-num">{f(b.total_minor)}</td></tr>)}</tbody>
        </table>
      </div>

      {selected && (
        <div className="card ledger-card">
          <div className="ledger-toolbar">
            <h2 className="atlas-section-title">{selected.name} · {t(`fr.budgets.${selected.status}`)}</h2>
            {canManage && (
              <div className="ledger-actions">
                {editable && <button type="button" className="gold-btn" onClick={save}>{t('fr.budgets.save')}</button>}
                <button type="button" className="ghost-btn" onClick={() => api.setBudgetStatus(selected.id, selected.status === 'approved' ? 'draft' : 'approved').then(() => { open(selected.id); load(); }).catch((err) => setError(ledgerError(err, t)))}>
                  {selected.status === 'approved' ? t('fr.budgets.toDraft') : t('fr.budgets.approve')}
                </button>
              </div>
            )}
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table ledger-lines-table">
              <thead><tr><th>{t('fr.account')}</th><th>{t('fr.costCenter')}</th>{selected.periods.map((p) => <th key={p.id}>{p.start_date.slice(0, 7)}</th>)}</tr></thead>
              <tbody>
                {rowKeys.map((rk) => {
                  const [a, cc] = rk.split('|');
                  return (
                    <tr key={rk}>
                      <td>{accName(a)}</td><td>{ccName(cc)}</td>
                      {selected.periods.map((p) => {
                        const k = `${a}|${cc}|${p.id}`;
                        return <td key={p.id}><input dir="ltr" style={{ width: 80 }} disabled={!editable} value={grid[k] ?? ''} onChange={(e) => setGrid({ ...grid, [k]: e.target.value })} /></td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {editable && (
            <div className="ledger-filters" style={{ marginTop: 10 }}>
              <select value={newRow.accountId} onChange={(e) => setNewRow({ ...newRow, accountId: e.target.value })}>
                <option value="">{t('fr.account')}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}
              </select>
              <select value={newRow.costCenterId} onChange={(e) => setNewRow({ ...newRow, costCenterId: e.target.value })}>
                <option value="">{t('fr.costCenter')} —</option>
                {(meta?.cost_centers || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" className="ghost-btn" onClick={addRow}>{t('fr.budgets.addRow')}</button>
            </div>
          )}
        </div>
      )}

      {bva && (
        <div className="card ledger-card">
          <div className="ledger-toolbar">
            <h2 className="atlas-section-title">{t('fr.budgets.vsActual')}</h2>
            <div className="ledger-actions">
              <button type="button" className="ghost-btn" onClick={() => api.downloadFinancialReport(`budgets/${selected.id}/vs-actual`, { format: 'xlsx' })}>Excel</button>
              <button type="button" className="ghost-btn" onClick={() => api.downloadFinancialReport(`budgets/${selected.id}/vs-actual`, { format: 'pdf' })}>PDF</button>
            </div>
          </div>
          <table className="ledger-table">
            <thead><tr><th>{t('fr.account')}</th><th>{t('fr.costCenter')}</th><th className="ledger-num">{t('fr.budgets.budget')}</th><th className="ledger-num">{t('fr.budgets.actual')}</th><th className="ledger-num">{t('fr.budgets.variance')}</th><th className="ledger-num">%</th></tr></thead>
            <tbody>
              {bva.rows.map((r) => (
                <tr key={`${r.account_id}-${r.cost_center_id}`}>
                  <td>{r.code} {r.name_ar}</td><td>{r.cost_center_name || ''}</td>
                  <td className="ledger-num">{f(r.budget)}</td>
                  <td className="ledger-num"><DrillLink drill={r.drill}>{f(r.actual)}</DrillLink></td>
                  <td className="ledger-num" style={{ color: r.favourable ? 'var(--atlas-success, green)' : 'var(--atlas-danger, #c0392b)' }}>{f(r.variance)}</td>
                  <td className="ledger-num">{r.variance_pct ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
