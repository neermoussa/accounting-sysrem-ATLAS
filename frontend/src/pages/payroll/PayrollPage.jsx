import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError, accountLabel } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

// Prompt 11-lite: the accounting side of payroll. The HR program produces
// the figures; here they are imported (JSON from the HR program), posted
// as one accrual entry per period, paid through treasury vouchers, and
// reported. Advances and labour cost rates live here too.
const TABS = ['periods', 'advances', 'rates', 'reports', 'settings'];
const D = () => new Date().toISOString().slice(0, 10);
const SAMPLE = JSON.stringify({ period: '2026-03', externalId: 'HR-2026-03', lines: [{ department: 'المبيعات', costCenterId: null, currencyCode: 'USD', gross: '3000', deductions: '300', employerContributions: '200', net: '2700', headcount: 4 }], advanceRecoveries: [] }, null, 2);

export default function PayrollPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const loadMeta = () => api.prGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => { loadMeta(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (msg) setNotice(msg);
      return r;
    } catch (err) {
      setError(ledgerError(err, t));
      return null;
    }
  };
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'periods';
  const m = (minor, digits = meta.digits) => formatMinor(minor || 0, digits);
  const props = { t, can, meta, act, m, loadMeta };
  return (
    <div className="ledger-page">
      <div className="ledger-header"><div><h1 className="atlas-page-title">{t('nav.payroll')}</h1><p className="ledger-subtitle">{t('pay.subtitle')}</p></div></div>
      {!meta.settings && <div className="ledger-error">{t('pay.noSettings')}</div>}
      <div className="ledger-tabs">{TABS.map((k) => <button key={k} type="button" className={`ledger-tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setSp({ tab: k })}>{t(`pay.tab.${k}`)}</button>)}</div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {tab === 'periods' && <Periods {...props} />}
      {tab === 'advances' && <Advances {...props} />}
      {tab === 'rates' && <Rates {...props} />}
      {tab === 'reports' && <Reports {...props} />}
      {tab === 'settings' && <><Settings {...props} /><DeductionTypes {...props} /></>}
    </div>
  );
}

function Periods({ t, can, meta, act, m }) {
  const [rows, setRows] = useState([]);
  const [json, setJson] = useState(SAMPLE);
  const [fmt, setFmt] = useState('csv');
  const [csvMeta, setCsvMeta] = useState({ period: '', externalId: '' });
  const [csvText, setCsvText] = useState('');
  const [rowErrors, setRowErrors] = useState([]);
  const [pay, setPay] = useState({});
  const load = () => api.prGet('/periods').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <>
      {can('manage_payroll_intake') && (
        <section className="ledger-card">
          <h2>{t('pay.import')}</h2>
          <p className="ledger-subtitle">{t('pay.importHint')}</p>
          <div className="ledger-form-grid">
            <label className="ledger-field">{t('pay.format')}<select value={fmt} onChange={(e) => setFmt(e.target.value)}><option value="csv">CSV</option><option value="json">JSON</option></select></label>
            {fmt === 'csv' && (
              <>
                <label className="ledger-field">{t('pay.period')}<input type="month" value={csvMeta.period} onChange={(e) => setCsvMeta({ ...csvMeta, period: e.target.value })} /></label>
                <label className="ledger-field">{t('pay.batch')}<input value={csvMeta.externalId} onChange={(e) => setCsvMeta({ ...csvMeta, externalId: e.target.value })} /></label>
                <label className="ledger-field">{t('pay.file')}<input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; setCsvText(f ? await f.text() : ''); }} /></label>
              </>
            )}
          </div>
          {fmt === 'json' && <textarea dir="ltr" rows={10} style={{ width: '100%', fontFamily: 'monospace' }} value={json} onChange={(e) => setJson(e.target.value)} />}
          <button type="button" className="gold-btn" onClick={async () => {
            setRowErrors([]);
            let call;
            if (fmt === 'json') {
              let body;
              try { body = JSON.parse(json); } catch { act(() => Promise.reject(Object.assign(new Error('json'), { detail: { message: t('pay.badJson') } }))); return; }
              call = () => api.prPost('/periods/import', body);
            } else call = () => api.prPost('/periods/import-csv', { ...csvMeta, csv: csvText });
            const r = await act(async () => {
              try { return await call(); } catch (err) { setRowErrors(err?.detail?.errors || []); throw err; }
            });
            if (r) { act(async () => null, r.replay ? t('pay.replay') : t('pay.imported')); load(); }
          }}>{t('pay.importBtn')}</button>
          {rowErrors.length > 0 && (
            <table className="ledger-table" data-testid="import-errors"><thead><tr><th>{t('pay.row')}</th><th>{t('pay.errorCode')}</th><th>{t('pay.errorMessage')}</th></tr></thead>
              <tbody>{rowErrors.map((e, k) => <tr key={k}><td>{e.row}</td><td dir="ltr">{e.error}</td><td>{e.message}</td></tr>)}</tbody></table>
          )}
        </section>
      )}
      <section className="ledger-card">
        <h2>{t('pay.periods')}</h2>
        <table className="ledger-table"><thead><tr><th>{t('pay.period')}</th><th>{t('pay.batch')}</th><th>{t('pay.status')}</th><th>{t('pay.totals')}</th><th>{t('pay.entry')}</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td>{p.period}</td><td>{p.external_id}</td><td>{t(`pay.status.${p.status}`)}</td>
              <td>{Object.entries(p.totals).map(([cur, x]) => <div key={cur}>{cur}: {t('pay.net')} {m(x.net_minor, meta.currency_digits[cur] ?? 2)} · {t('pay.paid')} {m(x.paid_minor, meta.currency_digits[cur] ?? 2)}</div>)}</td>
              <td>{p.journal_entry?.entry_number || '—'}</td>
              <td>
                {p.status === 'imported' && can('approve_payroll_posting') && <button type="button" className="ledger-link-btn" onClick={async () => { if (await act(() => api.prPost(`/periods/${p.id}/post`, {}), t('pay.posted'))) load(); }}>{t('pay.post')}</button>}
                {p.status !== 'reopened' && can('approve_payroll_posting') && <button type="button" className="ledger-link-btn" onClick={async () => { const reason = window.prompt(t('pay.reopenReason')); if (reason && await act(() => api.prPost(`/periods/${p.id}/reopen`, { reason }), t('pay.reopened'))) load(); }}>{t('pay.reopen')}</button>}
                {p.status === 'posted' && can('approve_payroll_posting') && (
                  <span>
                    <select value={pay[p.id] || ''} onChange={(e) => setPay({ ...pay, [p.id]: e.target.value })}><option value="">{t('pay.box')}</option>{meta.boxes.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select>
                    <button type="button" className="ledger-link-btn" disabled={!pay[p.id]} onClick={async () => { if (await act(() => api.prPost(`/periods/${p.id}/payments`, { cashBoxId: Number(pay[p.id]) }), t('pay.paymentCreated'))) load(); }}>{t('pay.pay')}</button>
                  </span>
                )}
              </td>
            </tr>
          ))}</tbody></table>
      </section>
    </>
  );
}

function Advances({ t, can, meta, act, m }) {
  const [rep, setRep] = useState(null);
  const [f, setF] = useState({ employeeRef: '', employeeName: '', cashBoxId: '', amount: '', date: D() });
  const load = () => api.prGet('/reports/advances').then(setRep).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <section className="ledger-card">
      <h2>{t('pay.advances')}</h2>
      {can('manage_payroll_intake') && (
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('pay.employeeRef')}<input value={f.employeeRef} onChange={(e) => setF({ ...f, employeeRef: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.employeeName')}<input value={f.employeeName} onChange={(e) => setF({ ...f, employeeName: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.box')}<select value={f.cashBoxId} onChange={(e) => setF({ ...f, cashBoxId: e.target.value })}><option value="">—</option>{meta.boxes.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency_code})</option>)}</select></label>
          <label className="ledger-field">{t('pay.amount')}<input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.date')}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.prPost('/advances', { ...f, cashBoxId: Number(f.cashBoxId) }), t('pay.advanceCreated'))) load(); }}>{t('pay.addAdvance')}</button>
        </div>
      )}
      {rep && (
        <table className="ledger-table"><thead><tr><th>{t('pay.employeeRef')}</th><th>{t('pay.employeeName')}</th><th>{t('pay.currency')}</th><th>{t('pay.advanced')}</th><th>{t('pay.recovered')}</th><th>{t('pay.outstanding')}</th><th>{t('pay.outstandingBase')}</th></tr></thead>
          <tbody>{rep.rows.map((r) => <tr key={`${r.employee_ref}-${r.currency_code}`}><td>{r.employee_ref}</td><td>{r.employee_name || '—'}</td><td>{r.currency_code}</td><td className="num">{m(r.advanced, meta.currency_digits[r.currency_code] ?? 2)}</td><td className="num">{m(r.recovered, meta.currency_digits[r.currency_code] ?? 2)}</td><td className="num">{m(r.outstanding, meta.currency_digits[r.currency_code] ?? 2)}</td><td className="num">{m(r.outstanding_base)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={6}>{t('pay.total')}</td><td className="num">{m(rep.outstanding_base_minor)}</td></tr></tfoot></table>
      )}
    </section>
  );
}

function Rates({ t, can, meta, act, m }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ costCenterId: '', productLine: '', ratePerHour: '', effectiveFrom: D() });
  const load = () => api.prGet('/labor-rates').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <section className="ledger-card">
      <h2>{t('pay.laborRates')}</h2>
      <p className="ledger-subtitle">{t('pay.ratesHint')}</p>
      {can('manage_payroll_intake') && (
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('pay.costCenter')}<select value={f.costCenterId} onChange={(e) => setF({ ...f, costCenterId: e.target.value })}><option value="">{t('pay.allCenters')}</option>{meta.cost_centers.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></label>
          <label className="ledger-field">{t('pay.productLine')}<input value={f.productLine} onChange={(e) => setF({ ...f, productLine: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.ratePerHour')}<input value={f.ratePerHour} onChange={(e) => setF({ ...f, ratePerHour: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.effectiveFrom')}<input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
          <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.prPost('/labor-rates', { ...f, costCenterId: f.costCenterId ? Number(f.costCenterId) : null, productLine: f.productLine || null }), t('pay.saved'))) load(); }}>{t('pay.addRate')}</button>
        </div>
      )}
      <table className="ledger-table"><thead><tr><th>{t('pay.costCenter')}</th><th>{t('pay.productLine')}</th><th>{t('pay.ratePerHour')}</th><th>{t('pay.effectiveFrom')}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.cost_center_code ? `${r.cost_center_code} — ${r.cost_center_name}` : t('pay.allCenters')}</td><td>{r.product_line || '—'}</td><td className="num">{m(r.rate_per_hour_minor)}</td><td>{r.effective_from}</td></tr>)}</tbody></table>
    </section>
  );
}

function Reports({ t, meta, act, m }) {
  const [range, setRange] = useState({ from: '', to: '' });
  const [cost, setCost] = useState(null);
  const [payables, setPayables] = useState(null);
  const load = () => {
    act(() => api.prGet(`/reports/cost?${new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString()}`).then(setCost));
    api.prGet('/reports/payables').then(setPayables).catch(() => {});
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <section className="ledger-card">
        <h2>{t('pay.costReport')}</h2>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('pay.from')}<input type="month" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.to')}<input type="month" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button type="button" className="gold-btn" onClick={load}>{t('pay.show')}</button>
        </div>
        {cost && (
          <table className="ledger-table"><thead><tr><th>{t('pay.period')}</th><th>{t('pay.department')}</th><th>{t('pay.currency')}</th><th>{t('pay.gross')}</th><th>{t('pay.employer')}</th><th>{t('pay.costBase')}</th><th>{t('pay.headcount')}</th></tr></thead>
            <tbody>{cost.rows.map((r) => <tr key={`${r.period}-${r.department}-${r.currency}`}><td>{r.period}</td><td>{r.department}</td><td>{r.currency}</td><td className="num">{m(r.gross_minor, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.employer_contrib_minor, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.cost_base_minor)}</td><td>{r.headcount}</td></tr>)}</tbody>
            <tfoot><tr><td colSpan={5}>{t('pay.total')}</td><td className="num">{m(cost.total_cost_base_minor)}</td><td /></tr></tfoot></table>
        )}
      </section>
      {payables && (
        <section className="ledger-card">
          <h2>{t('pay.payablesReport')}</h2>
          <table className="ledger-table"><thead><tr><th>{t('pay.period')}</th><th>{t('pay.batch')}</th><th>{t('pay.currency')}</th><th>{t('pay.net')}</th><th>{t('pay.paid')}</th><th>{t('pay.inPayment')}</th><th>{t('pay.outstanding')}</th></tr></thead>
            <tbody>{payables.rows.map((r) => <tr key={`${r.period_id}-${r.currency}`}><td>{r.period}</td><td>{r.external_id}</td><td>{r.currency}</td><td className="num">{m(r.net_minor, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.paid_minor, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.in_payment_minor, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.outstanding_minor, meta.currency_digits[r.currency] ?? 2)}</td></tr>)}</tbody></table>
          <p>{t('pay.salariesLedger')}: {m(payables.salaries_payable_ledger_minor)} · {t('pay.deductionsLedger')}: {m(payables.deductions_payable_ledger_minor)}</p>
        </section>
      )}
    </>
  );
}

function DeductionTypes({ t, can, meta, act, m }) {
  const [types, setTypes] = useState([]);
  const [rep, setRep] = useState(null);
  const [f, setF] = useState({ code: '', name: '', accountId: '' });
  const [pay, setPay] = useState({});
  const load = () => { api.prGet('/deduction-types').then(setTypes).catch(() => {}); api.prGet('/reports/deductions').then(setRep).catch(() => {}); };
  useEffect(() => { load(); }, []);
  return (
    <section className="ledger-card">
      <h2>{t('pay.deductionTypes')}</h2>
      <table className="ledger-table"><thead><tr><th>{t('pay.code')}</th><th>{t('pay.name')}</th><th>{t('pay.account')}</th></tr></thead>
        <tbody>{types.map((x) => <tr key={x.id}><td>{x.code}{x.is_default ? ` (${t('pay.default')})` : ''}</td><td>{x.name}</td><td>{x.account_code} — {x.account_name}</td></tr>)}</tbody></table>
      {can('manage_payroll_intake') && (
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('pay.code')}<input dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="social_insurance" /></label>
          <label className="ledger-field">{t('pay.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="ledger-field">{t('pay.account')}<select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">—</option>{meta.accounts.filter((a) => a.type === 'liability').map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}</select></label>
          <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.prPost('/deduction-types', { ...f, accountId: Number(f.accountId) }), t('pay.saved'))) load(); }}>{t('pay.addType')}</button>
        </div>
      )}
      {rep && (
        <>
          <h3>{t('pay.deductionBalances')}</h3>
          <table className="ledger-table"><thead><tr><th>{t('pay.code')}</th><th>{t('pay.currency')}</th><th>{t('pay.accrued')}</th><th>{t('pay.paid')}</th><th>{t('pay.outstanding')}</th><th /></tr></thead>
            <tbody>{rep.rows.map((r) => (
              <tr key={`${r.code}-${r.currency}`}><td>{r.name}</td><td>{r.currency}</td><td className="num">{m(r.accrued, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.paid, meta.currency_digits[r.currency] ?? 2)}</td><td className="num">{m(r.outstanding, meta.currency_digits[r.currency] ?? 2)}</td>
                <td>{can('approve_payroll_posting') && r.available > 0 && (
                  <span><select value={pay[`${r.code}-${r.currency}`] || ''} onChange={(e) => setPay({ ...pay, [`${r.code}-${r.currency}`]: e.target.value })}><option value="">{t('pay.box')}</option>{meta.boxes.filter((b) => b.currency_code === r.currency).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                    <button type="button" className="ledger-link-btn" disabled={!pay[`${r.code}-${r.currency}`]} onClick={async () => { if (await act(() => api.prPost('/deduction-payments', { typeCode: r.code, cashBoxId: Number(pay[`${r.code}-${r.currency}`]) }), t('pay.paymentCreated'))) load(); }}>{t('pay.pay')}</button></span>
                )}</td></tr>
            ))}</tbody></table>
        </>
      )}
    </section>
  );
}

function Settings({ t, can, meta, act, loadMeta }) {
  const s = meta.settings || {};
  const [f, setF] = useState({ expenseAccountId: s.expense_account_id || '', employerExpenseAccountId: s.employer_expense_account_id || '', salariesPayableAccountId: s.salaries_payable_account_id || '', deductionsPayableAccountId: s.deductions_payable_account_id || '', advancesAccountId: s.advances_account_id || '' });
  const fields = [['expenseAccountId', 'expense'], ['employerExpenseAccountId', 'expense'], ['salariesPayableAccountId', 'liability'], ['deductionsPayableAccountId', 'liability'], ['advancesAccountId', 'asset']];
  return (
    <section className="ledger-card">
      <h2>{t('pay.settings')}</h2>
      <div className="ledger-form-grid">
        {fields.map(([k, type]) => (
          <label key={k} className="ledger-field">{t(`pay.acc.${k}`)}
            <select value={f[k]} disabled={!can('manage_payroll_intake')} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">—</option>{meta.accounts.filter((a) => a.type === type).map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}</select>
          </label>
        ))}
      </div>
      {can('manage_payroll_intake') && <button type="button" className="gold-btn" onClick={async () => { if (await act(() => api.prPut('/settings', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)]))), t('pay.saved'))) loadMeta(); }}>{t('pay.save')}</button>}
    </section>
  );
}
