import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { ledgerError } from '../ledger/ledgerShared.js';
import { baseMoney, money } from './purchasingShared.jsx';
import '../../styles/ledger.css';

const emptyForm = { name: '', code: '', contactName: '', phone: '', email: '', address: '', currencyCode: '', paymentTermsDays: '30', taxNumber: '', defaultTaxRate: '', manualRating: '', notes: '', isActive: true };

// Suppliers (Prompt 6): card, balance, statement, computed ratings, price history.
export default function SuppliersPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const id = sp.get('id');
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);
  const load = () => api.purGet('/suppliers', { q }).then(setRows).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => { api.purGet('/meta').then(setMeta).catch((err) => setError(ledgerError(err, t))); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [q, id]);
  if (!meta) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.suppliers')}</h1><p className="ledger-subtitle">{t('pur.suppliers.subtitle')}</p></div>
        <div className="ledger-actions">
          <Link className="ghost-btn" to="/purchasing">{t('nav.purchasing')}</Link>
          {can('post_supplier_invoices') && !id && <button type="button" className="ghost-btn" onClick={() => setSp({ opening: '1' })}>{t('pur.opening.title')}</button>}
          {can('manage_suppliers') && !id && <button type="button" className="gold-btn" onClick={() => setSp({ id: 'new' })}>{t('pur.suppliers.new')}</button>}
        </div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {!id && sp.get('opening') === '1' && <OpeningBalances t={t} meta={meta} done={() => { setSp({}); load(); }} setError={setError} />}
      {!id && sp.get('opening') === '1' && <OpenBillsImport t={t} meta={meta} done={() => { setSp({}); load(); }} setError={setError} />}
      {id ? <SupplierDetail key={id} t={t} meta={meta} can={can} id={id} back={() => setSp({})} open={(x) => setSp({ id: String(x) })} setError={setError} /> : (
        <>
          <div className="ledger-toolbar"><input placeholder={t('pur.search')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <table className="ledger-table">
            <thead><tr><th>{t('pur.supplier')}</th><th>{t('ledger.form.currency')}</th><th>{t('pur.terms')}</th><th className="ledger-num">{t('pur.balance')}</th><th>{t('fr.status')}</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className="ledger-row-click" onClick={() => setSp({ id: String(s.id) })}>
                <td>{s.name}{s.code ? ` (${s.code})` : ''}</td><td>{s.currency_code || meta.base_currency.code}</td><td>{s.payment_terms_days}</td><td className="ledger-num">{baseMoney(meta, s.balance_minor)}</td><td>{s.is_active ? '✓' : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function SupplierDetail({ t, meta, can, id, back, open, setError }) {
  const isNew = id === 'new';
  const [s, setS] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [st, setSt] = useState(null);
  const [prices, setPrices] = useState([]);
  useEffect(() => {
    if (isNew) return;
    api.purGet(`/suppliers/${id}`).then((x) => {
      setS(x);
      setForm({ name: x.name, code: x.code || '', contactName: x.contact_name || '', phone: x.phone || '', email: x.email || '', address: x.address || '', currencyCode: x.currency_code || '', paymentTermsDays: String(x.payment_terms_days), taxNumber: x.tax_number || '', defaultTaxRate: x.default_tax_rate_bp ? String(x.default_tax_rate_bp / 100) : '', manualRating: x.manual_rating ? String(x.manual_rating) : '', notes: x.notes || '', isActive: !!x.is_active });
    }).catch((err) => setError(ledgerError(err, t)));
    api.purGet(`/suppliers/${id}/statement`).then(setSt).catch(() => {});
    api.purGet(`/suppliers/${id}/price-history`).then(setPrices).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const f = (k) => ({ value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }) });
  async function save() {
    setError(null);
    try {
      const body = { ...form, currencyCode: form.currencyCode || null, manualRating: form.manualRating || null, defaultTaxRate: form.defaultTaxRate || 0, paymentTermsDays: Number(form.paymentTermsDays) };
      const r = isNew ? await api.purPost('/suppliers', body) : await api.purPut(`/suppliers/${id}`, body);
      open(r.id);
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }
  const editable = can('manage_suppliers');
  const r = s?.ratings;
  return (
    <>
      <div className="card ledger-card">
        <div className="ledger-form-grid">
          {[['name', 'pur.f.name'], ['code', 'pur.f.code'], ['contactName', 'pur.f.contact'], ['phone', 'pur.f.phone'], ['email', 'pur.f.email'], ['address', 'pur.f.address'], ['taxNumber', 'pur.f.taxNumber'], ['defaultTaxRate', 'pur.f.taxRate'], ['paymentTermsDays', 'pur.terms']].map(([k, label]) => (
            <label key={k} className="ledger-field">{t(label)}<input disabled={!editable} {...f(k)} /></label>
          ))}
          <label className="ledger-field">{t('ledger.form.currency')}<select disabled={!editable} {...f('currencyCode')}><option value="">{meta.base_currency.code}</option>{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>
          <label className="ledger-field">{t('pur.f.manualRating')}<select disabled={!editable} {...f('manualRating')}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}</select></label>
          <label className="ledger-field">{t('sales.notes')}<input disabled={!editable} {...f('notes')} /></label>
        </div>
        <div className="ledger-actions">
          <button type="button" className="ghost-btn" onClick={back}>{t('ledger.back')}</button>
          {editable && <button type="button" className="gold-btn" onClick={save}>{t('ledger.save')}</button>}
        </div>
      </div>
      {r && (
        <div className="card ledger-card ledger-meta-grid">
          <div><div className="ledger-meta-label">{t('pur.rating.onTime')}</div><strong>{r.on_time_pct ?? '—'}{r.on_time_pct !== null ? '%' : ''}</strong> <small>({r.on_time_receipts})</small></div>
          <div><div className="ledger-meta-label">{t('pur.rating.price')}</div><strong>{r.price_consistency_pct ?? '—'}{r.price_consistency_pct !== null ? '%' : ''}</strong> <small>({r.invoice_lines})</small></div>
          <div><div className="ledger-meta-label">{t('pur.rating.quality')}</div><strong>{r.quality_rejection_pct ?? '—'}{r.quality_rejection_pct !== null ? '%' : ''}</strong></div>
          <div><div className="ledger-meta-label">{t('pur.balance')}</div><strong>{baseMoney(meta, s.balance_minor)}</strong></div>
        </div>
      )}
      {st && (
        <div className="card ledger-card">
          <div className="ledger-toolbar">
            <h2 className="atlas-section-title">{t('pur.statement')} · {st.from} → {st.to}</h2>
            <div className="ledger-actions">
              <button type="button" className="ghost-btn" onClick={() => api.purDownload(`/suppliers/${id}/statement`, { format: 'xlsx' })}>Excel</button>
              <button type="button" className="ghost-btn" onClick={() => api.purDownload(`/suppliers/${id}/statement`, { format: 'pdf' })}>PDF</button>
            </div>
          </div>
          <table className="ledger-table">
            <thead><tr><th>{t('fr.date')}</th><th>{t('fr.entry')}</th><th>{t('fr.description')}</th><th className="ledger-num">{t('fr.debit')}</th><th className="ledger-num">{t('fr.credit')}</th><th className="ledger-num">{t('fr.balance')}</th></tr></thead>
            <tbody>
              <tr className="ledger-row-header"><td colSpan={5}>{t('fr.opening')}</td><td className="ledger-num">{baseMoney(meta, st.opening_minor)}</td></tr>
              {st.lines.map((l, i) => <tr key={i}><td>{l.entry_date}</td><td><Link to={`/ledger/entries?id=${l.entry_id}`}>{l.entry_number}</Link></td><td>{l.memo || l.description}</td><td className="ledger-num">{l.debit_minor ? baseMoney(meta, l.debit_minor) : ''}</td><td className="ledger-num">{l.credit_minor ? baseMoney(meta, l.credit_minor) : ''}</td><td className="ledger-num">{baseMoney(meta, l.balance_minor)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
      {prices.length > 0 && (
        <div className="card ledger-card">
          <h2 className="atlas-section-title">{t('pur.priceHistory')}</h2>
          <table className="ledger-table"><tbody>{prices.slice(0, 50).map((p) => <tr key={p.id}><td>{p.price_date}</td><td>{p.product_name || p.description}</td><td>{t(`pur.source.${p.source_type}`)}</td><td className="ledger-num">{money(meta, p.unit_price_minor, p.currency_code)}</td></tr>)}</tbody></table>
        </div>
      )}
    </>
  );
}

// Supplier opening balances: spread a lump AP opening balance (posted
// without suppliers) onto suppliers, or open new balances.
function OpeningBalances({ t, meta, done, setError }) {
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState('reclass');
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [rows, setRows] = useState([{ supplierId: '', amount: '', dueDate: '', ref: '' }]);
  useEffect(() => { api.purGet('/opening-balances').then(setInfo).catch(() => {}); }, []);
  const set = (i, k) => (e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  return (
    <div className="card ledger-card">
      <h2 className="atlas-section-title">{t('pur.opening.title')}</h2>
      <p className="ledger-hint">{t('pur.opening.hint')} {info && <strong>{t('pur.unassigned')}: {baseMoney(meta, info.unassigned_minor)}</strong>}</p>
      <div className="ledger-form-grid">
        <label className="ledger-field">{t('pur.opening.mode')}<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="reclass">{t('pur.opening.reclass')}</option><option value="opening">{t('pur.opening.new')}</option></select></label>
        <label className="ledger-field">{t('fr.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <table className="ledger-table ledger-lines-table"><tbody>{rows.map((r, i) => (
        <tr key={i}>
          <td><select value={r.supplierId} onChange={set(i, 'supplierId')}><option value="">{t('pur.supplier')}</option>{meta.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
          <td><input dir="ltr" placeholder={t('fr.amount')} value={r.amount} onChange={set(i, 'amount')} /></td>
          <td><input type="date" value={r.dueDate} onChange={set(i, 'dueDate')} /></td>
          <td><input placeholder={t('pur.reference')} value={r.ref} onChange={set(i, 'ref')} /></td>
        </tr>
      ))}</tbody></table>
      <div className="ledger-actions" style={{ marginTop: 10 }}>
        <button type="button" className="ghost-btn" onClick={() => setRows((rs) => [...rs, { supplierId: '', amount: '', dueDate: '', ref: '' }])}>{t('ledger.form.addLine')}</button>
        <button type="button" className="gold-btn" onClick={async () => {
          setError(null);
          try {
            await api.purPost('/opening-balances', { mode, date, rows: rows.filter((r) => r.supplierId && r.amount).map((r) => ({ supplierId: Number(r.supplierId), amount: r.amount, dueDate: r.dueDate || undefined, ref: r.ref || undefined })) });
            done();
          } catch (err) {
            setError(ledgerError(err, t));
          }
        }}>{t('ledger.form.post')}</button>
      </div>
    </div>
  );
}

// Open-bills import: one line per unpaid bill
// (supplier name, bill number, bill date, due date, amount), pasted from a
// spreadsheet (tab, comma or semicolon separated). Each supplier's opening
// balance is typed separately; the server refuses the import unless the
// bills of every supplier add up to it.
function OpenBillsImport({ t, meta, done, setError }) {
  const [mode, setMode] = useState('reclass');
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [text, setText] = useState('');
  const [totals, setTotals] = useState({});
  const [msg, setMsg] = useState(null);
  const byName = new Map(meta.suppliers.map((s) => [s.name.trim(), s]));
  const parsed = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const [name, billNumber, billDate, dueDate, amount] = l.split(/\t|;|,/).map((c) => (c || '').trim());
    const s = byName.get(name) || meta.suppliers.find((x) => String(x.id) === name);
    return { line: i + 1, name, supplier: s, billNumber, billDate, dueDate, amount };
  });
  const suppliers = [...new Map(parsed.filter((r) => r.supplier).map((r) => [r.supplier.id, r.supplier])).values()];
  const unknown = parsed.filter((r) => !r.supplier);
  return (
    <div className="card ledger-card">
      <h2 className="atlas-section-title">{t('pur.bills.title')}</h2>
      <p className="ledger-hint">{t('pur.bills.hint')}</p>
      <div className="ledger-form-grid">
        <label className="ledger-field">{t('pur.opening.mode')}<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="reclass">{t('pur.opening.reclass')}</option><option value="opening">{t('pur.opening.new')}</option></select></label>
        <label className="ledger-field">{t('fr.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <textarea dir="ltr" rows={6} style={{ width: '100%' }} placeholder={t('pur.bills.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
      {unknown.length > 0 && <div className="ledger-error">{t('pur.bills.unknown')}: {unknown.map((r) => `${r.line} (${r.name})`).join('، ')}</div>}
      {suppliers.length > 0 && (
        <table className="ledger-table">
          <thead><tr><th>{t('pur.supplier')}</th><th className="ledger-num">{t('pur.bills.count')}</th><th>{t('pur.bills.expected')}</th></tr></thead>
          <tbody>{suppliers.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td className="ledger-num">{parsed.filter((r) => r.supplier?.id === s.id).length}</td><td><input dir="ltr" value={totals[s.id] || ''} onChange={(e) => setTotals({ ...totals, [s.id]: e.target.value })} /></td></tr>
          ))}</tbody>
        </table>
      )}
      {msg && <div className="ledger-notice">{msg}</div>}
      <div className="ledger-actions" style={{ marginTop: 10 }}>
        <button type="button" className="gold-btn" disabled={!suppliers.length || unknown.length > 0} onClick={async () => {
          setError(null);
          try {
            const res = await api.purPost('/opening-balances/bills', {
              mode, date,
              rows: parsed.map((r) => ({ supplierId: r.supplier.id, billNumber: r.billNumber, billDate: r.billDate, dueDate: r.dueDate, amount: r.amount })),
              supplierTotals: suppliers.map((s) => ({ supplierId: s.id, amount: totals[s.id] || '0' })),
            });
            setMsg(`${t('pur.bills.done')}: ${res.invoices.length}`);
            done();
          } catch (err) {
            setError(ledgerError(err, t));
          }
        }}>{t('pur.bills.import')}</button>
      </div>
    </div>
  );
}
