import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from './ledgerShared.js';
import '../../styles/ledger.css';

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export default function ChartOfAccountsPage() {
  const { can } = useAuth();
  const { t } = useLanguage();
  const [tab, setTab] = useState('accounts');
  const [meta, setMeta] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const canManage = can('manage_accounts');

  function load() {
    setLoading(true);
    Promise.all([api.getLedgerMeta(), api.getLedgerAccounts()])
      .then(([m, a]) => {
        setMeta(m);
        setAccounts(a);
      })
      .catch((err) => setError(ledgerError(err, t)))
      .finally(() => setLoading(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div>
          <h1 className="atlas-page-title">{t('ledger.coa.title')}</h1>
          <p className="ledger-subtitle">{t('ledger.coa.subtitle')}</p>
        </div>
      </div>
      <div className="ledger-tabs">
        {['accounts', 'cost-centers', 'projects'].map((k) => (
          <button key={k} type="button" className={`ledger-tab-btn${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            {t(`ledger.coa.tab.${k}`)}
          </button>
        ))}
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      {loading && <div className="ledger-loading">{t('ledger.loading')}</div>}
      {!loading && meta && tab === 'accounts' && (
        <AccountsView t={t} meta={meta} accounts={accounts} canManage={canManage} reload={load} setError={setError} setNotice={setNotice} />
      )}
      {!loading && meta && tab !== 'accounts' && (
        <DimensionView
          key={tab}
          t={t}
          kind={tab}
          rows={tab === 'cost-centers' ? meta.cost_centers : meta.projects}
          canManage={canManage}
          reload={load}
          setError={setError}
        />
      )}
    </div>
  );
}

function AccountsView({ t, meta, accounts, canManage, reload, setError, setNotice }) {
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [editing, setEditing] = useState(null); // { account?, parent? }
  const [template, setTemplate] = useState(meta.templates[0]?.key || '');
  const digits = meta.base_currency?.minor_unit_digits ?? 2;

  const childrenOf = useMemo(() => {
    const map = new Map();
    for (const a of accounts) {
      const key = a.parent_id || 0;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return map;
  }, [accounts]);

  const rows = useMemo(() => {
    const visible = (a) => showInactive || a.is_active;
    const q = search.trim().toLowerCase();
    if (q) {
      return accounts
        .filter((a) => visible(a) && (a.code.toLowerCase().includes(q) || a.name_ar.toLowerCase().includes(q) || (a.name_en || '').toLowerCase().includes(q)))
        .map((a) => ({ a, depth: 0 }));
    }
    const out = [];
    const walk = (parentId, depth) => {
      for (const a of childrenOf.get(parentId) || []) {
        if (!visible(a)) continue;
        out.push({ a, depth });
        if (!collapsed[a.id]) walk(a.id, depth + 1);
      }
    };
    walk(0, 0);
    return out;
  }, [accounts, childrenOf, collapsed, search, showInactive]);

  async function applyTemplate() {
    if (!template || !window.confirm(t('ledger.coa.applyConfirm'))) return;
    setError(null);
    try {
      await api.applyCoaTemplate(template);
      setNotice(t('ledger.coa.applied'));
      reload();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  async function toggleActive(a) {
    setError(null);
    try {
      await api.updateLedgerAccount(a.id, { isActive: !a.is_active });
      reload();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  // Subtree balance for header accounts so the tree reads like a trial balance.
  function balanceOf(a) {
    let total = a.debit_total_minor - a.credit_total_minor;
    for (const c of childrenOf.get(a.id) || []) total += balanceOf(c);
    return total;
  }

  return (
    <>
      <div className="ledger-toolbar">
        <div className="ledger-filters">
          <label className="ledger-field">
            {t('ledger.search')}
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('ledger.coa.searchPlaceholder')} />
          </label>
          <label className="ledger-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            {t('ledger.coa.showInactive')}
          </label>
        </div>
        {canManage && (
          <div className="ledger-actions">
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              {meta.templates.map((tp) => (
                <option key={tp.key} value={tp.key}>{tp.nameAr}</option>
              ))}
            </select>
            <button type="button" className="ghost-btn" onClick={applyTemplate}>{t('ledger.coa.applyTemplate')}</button>
            <button type="button" className="gold-btn" onClick={() => setEditing({})}>{t('ledger.coa.add')}</button>
          </div>
        )}
      </div>

      {accounts.length === 0 ? (
        <div className="ledger-empty">{t('ledger.coa.empty')}</div>
      ) : (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t('ledger.coa.code')}</th>
                <th>{t('ledger.coa.name')}</th>
                <th>{t('ledger.coa.type')}</th>
                <th>{t('ledger.coa.normal')}</th>
                <th>{t('ledger.coa.currency')}</th>
                <th className="ledger-num">{t('ledger.coa.balance')} ({meta.base_currency?.code})</th>
                <th />
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ a, depth }) => {
                const hasChildren = (childrenOf.get(a.id) || []).length > 0;
                return (
                  <tr key={a.id} className={a.is_active ? '' : 'ledger-inactive'}>
                    <td className="ledger-num" style={{ textAlign: 'start' }}>{a.code}</td>
                    <td className={a.is_postable ? '' : 'ledger-header-account'} style={{ paddingInlineStart: 12 + depth * 18 }}>
                      {hasChildren && !search && (
                        <button type="button" className="ledger-tree-toggle" onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))}>
                          {collapsed[a.id] ? '+' : '−'}
                        </button>
                      )}
                      {a.name_ar}
                      {a.name_en && <span className="ledger-muted"> · {a.name_en}</span>}
                    </td>
                    <td>{t(`ledger.type.${a.type}`)}</td>
                    <td>{t(`ledger.normal.${a.normal_balance}`)}</td>
                    <td>{a.currency_code || t('ledger.coa.anyCurrency')}</td>
                    <td className="ledger-num">{formatMinor(balanceOf(a), digits)}</td>
                    <td>
                      {!a.is_postable && <span className="ledger-badge">{t('ledger.coa.header')}</span>}
                      {!!a.is_system && <span className="ledger-badge">{t('ledger.coa.system')}</span>}
                      {!a.is_active && <span className="ledger-badge ledger-badge-reversed">{t('ledger.coa.inactive')}</span>}
                    </td>
                    {canManage && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="ghost-btn" onClick={() => setEditing({ account: a })}>{t('ledger.edit')}</button>{' '}
                        {!a.is_used && (
                          <button type="button" className="ghost-btn" onClick={() => setEditing({ parent: a })}>{t('ledger.coa.addChild')}</button>
                        )}{' '}
                        {!a.is_system && (
                          <button type="button" className="ghost-btn" onClick={() => toggleActive(a)}>
                            {a.is_active ? t('ledger.coa.deactivate') : t('ledger.coa.activate')}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <AccountModal
          t={t}
          meta={meta}
          accounts={accounts}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

// Mirrors backend/lib/reportClass.js BY_TYPE.
const REPORT_CLASSES = {
  asset: ['cash', 'current_asset', 'fixed_asset', 'contra_asset'],
  liability: ['current_liability', 'long_term_liability'],
  equity: ['equity'],
  revenue: ['revenue', 'other'],
  expense: ['cogs', 'opex', 'other'],
};

function AccountModal({ t, meta, accounts, editing, onClose, onSaved }) {
  const existing = editing.account;
  const [form, setForm] = useState({
    code: existing?.code || '',
    nameAr: existing?.name_ar || '',
    nameEn: existing?.name_en || '',
    parentId: existing?.parent_id || editing.parent?.id || '',
    type: existing?.type || editing.parent?.type || 'asset',
    currencyCode: existing?.currency_code || '',
    reportClass: existing?.report_class || '',
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const parentOptions = accounts.filter((a) => a.is_active && !a.is_used && (!existing || a.id !== existing.id));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await api.updateLedgerAccount(existing.id, { code: form.code, nameAr: form.nameAr, nameEn: form.nameEn, currencyCode: form.currencyCode || null, ...(form.reportClass ? { reportClass: form.reportClass } : {}) });
      } else {
        await api.createLedgerAccount({
          code: form.code,
          nameAr: form.nameAr,
          nameEn: form.nameEn,
          parentId: form.parentId ? Number(form.parentId) : null,
          type: form.type,
          currencyCode: form.currencyCode || null,
          reportClass: form.reportClass || undefined,
        });
      }
      onSaved();
    } catch (err) {
      setError(ledgerError(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ledger-modal-backdrop" onClick={onClose}>
      <div className="ledger-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="atlas-section-title">{existing ? t('ledger.coa.editTitle') : t('ledger.coa.addTitle')}</h2>
        {error && <div className="ledger-error">{error}</div>}
        <label className="ledger-field">{t('ledger.coa.code')}<input value={form.code} onChange={set('code')} /></label>
        <label className="ledger-field">{t('ledger.coa.nameAr')}<input value={form.nameAr} onChange={set('nameAr')} /></label>
        <label className="ledger-field">{t('ledger.coa.nameEn')}<input value={form.nameEn} onChange={set('nameEn')} dir="ltr" /></label>
        {!existing && (
          <>
            <label className="ledger-field">
              {t('ledger.coa.parent')}
              <select value={form.parentId} onChange={(e) => {
                const p = accounts.find((a) => a.id === Number(e.target.value));
                setForm((f) => ({ ...f, parentId: e.target.value, type: p ? p.type : f.type }));
              }}>
                <option value="">{t('ledger.coa.noParent')}</option>
                {parentOptions.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}
              </select>
            </label>
            <label className="ledger-field">
              {t('ledger.coa.type')}
              <select value={form.type} onChange={set('type')} disabled={!!form.parentId}>
                {TYPES.map((ty) => <option key={ty} value={ty}>{t(`ledger.type.${ty}`)}</option>)}
              </select>
            </label>
          </>
        )}
        <label className="ledger-field">
          {t('ledger.coa.reportClass')}
          <select value={form.reportClass} onChange={set('reportClass')}>
            {!existing && <option value="">{t('ledger.coa.reportClassAuto')}</option>}
            {(REPORT_CLASSES[form.type] || []).map((c) => <option key={c} value={c}>{t(`ledger.reportClass.${c}`)}</option>)}
          </select>
        </label>
        <p className="ledger-hint">{t('ledger.coa.reportClassHint')}</p>
        <label className="ledger-field">
          {t('ledger.coa.currency')}
          <select value={form.currencyCode} onChange={set('currencyCode')}>
            <option value="">{t('ledger.coa.anyCurrency')}</option>
            {meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
        </label>
        <div className="ledger-modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>{t('ledger.cancel')}</button>
          <button type="button" className="gold-btn" onClick={save} disabled={saving}>{t('ledger.save')}</button>
        </div>
      </div>
    </div>
  );
}

function DimensionView({ t, kind, rows, canManage, reload, setError }) {
  const [form, setForm] = useState({ code: '', name: '' });

  async function add() {
    setError(null);
    try {
      await api.saveLedgerDimension(kind, null, form);
      setForm({ code: '', name: '' });
      reload();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  async function toggle(r) {
    setError(null);
    try {
      await api.saveLedgerDimension(kind, r.id, { isActive: !r.is_active });
      reload();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  }

  return (
    <>
      {canManage && (
        <div className="ledger-toolbar">
          <div className="ledger-filters">
            <label className="ledger-field">{t('ledger.coa.code')}<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
            <label className="ledger-field">{t('ledger.coa.name')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <button type="button" className="gold-btn" onClick={add}>{t('ledger.add')}</button>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="ledger-empty">{t('ledger.dimension.empty')}</div>
      ) : (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr><th>{t('ledger.coa.code')}</th><th>{t('ledger.coa.name')}</th><th />{canManage && <th />}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.is_active ? '' : 'ledger-inactive'}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{!r.is_active && <span className="ledger-badge ledger-badge-reversed">{t('ledger.coa.inactive')}</span>}</td>
                  {canManage && (
                    <td>
                      <button type="button" className="ghost-btn" onClick={() => toggle(r)}>
                        {r.is_active ? t('ledger.coa.deactivate') : t('ledger.coa.activate')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
