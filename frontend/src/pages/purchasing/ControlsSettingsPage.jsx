import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useLanguage } from '../../i18n/LanguageContext.jsx';
import { formatMinor, ledgerError } from '../ledger/ledgerShared.js';
import '../../styles/ledger.css';

// Approval controls: PO approval threshold, three-way-match tolerances and
// separation of duties (enforced per step only when 2+ active users can do
// it; the owner can break glass with a written reason, audited).
export default function ControlsSettingsPage() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [s, setS] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = () => api.purGet('/settings').then((r) => {
    setS(r);
    setForm({
      poApprovalThreshold: formatMinor(r.po_approval_threshold_minor, r.base_digits).replace(/,/g, ''),
      qtyTolerance: (r.purchase_qty_tolerance_bp / 100).toString(),
      priceTolerance: (r.purchase_price_tolerance_bp / 100).toString(),
      enforcePurchasingSeparation: r.enforce_purchasing_separation,
    });
  }).catch((err) => setError(ledgerError(err, t)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!s || !form) return <div className="ledger-page"><div className="ledger-loading">{error || t('ledger.loading')}</div></div>;
  const editable = can('manage_settings') || can('approve_purchase_orders');
  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      const body = { poApprovalThreshold: form.poApprovalThreshold, qtyTolerance: form.qtyTolerance, priceTolerance: form.priceTolerance };
      if (can('manage_settings') && form.enforcePurchasingSeparation !== s.enforce_purchasing_separation) body.enforcePurchasingSeparation = form.enforcePurchasingSeparation;
      await api.purPut('/settings', body);
      setNotice(t('tr.saved'));
      load();
    } catch (err) {
      setError(ledgerError(err, t));
    }
  };
  return (
    <div className="ledger-page">
      <div className="ledger-header">
        <div><h1 className="atlas-page-title">{t('nav.controls')}</h1><p className="ledger-subtitle">{t('ctl.subtitle')}</p></div>
      </div>
      {error && <div className="ledger-error">{error}</div>}
      {notice && <div className="ledger-notice">{notice}</div>}
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('ctl.approval')}</h2>
        <div className="ledger-form-grid">
          <label className="ledger-field">{t('ctl.threshold')}<input dir="ltr" disabled={!editable} value={form.poApprovalThreshold} onChange={(e) => setForm({ ...form, poApprovalThreshold: e.target.value })} /></label>
          <label className="ledger-field">{t('ctl.qtyTolerance')}<input dir="ltr" disabled={!editable} value={form.qtyTolerance} onChange={(e) => setForm({ ...form, qtyTolerance: e.target.value })} /></label>
          <label className="ledger-field">{t('ctl.priceTolerance')}<input dir="ltr" disabled={!editable} value={form.priceTolerance} onChange={(e) => setForm({ ...form, priceTolerance: e.target.value })} /></label>
        </div>
        <p className="ledger-hint">{t('ctl.thresholdHint')}</p>
      </div>
      <div className="card ledger-card">
        <h2 className="atlas-section-title">{t('ctl.sod')}</h2>
        <label className="ledger-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" disabled={!can('manage_settings')} checked={form.enforcePurchasingSeparation} onChange={(e) => setForm({ ...form, enforcePurchasingSeparation: e.target.checked })} />
          {t('ctl.sodToggle')}
        </label>
        <p className="ledger-hint">{t('ctl.sodHint')}</p>
        <table className="ledger-table">
          <thead><tr><th>{t('ctl.step')}</th><th>{t('ctl.firstHolders')}</th><th>{t('ctl.secondHolders')}</th><th>{t('tr.statusLabel')}</th></tr></thead>
          <tbody>{s.separation_steps.map((st) => (
            <tr key={st.kind}>
              <td>{t(`ctl.kind.${st.kind}`)}</td>
              <td>{st.first_holders.map((u) => u.name).join('، ') || '—'}</td>
              <td>{st.second_holders.map((u) => u.name).join('، ') || '—'}</td>
              <td><span className={`ledger-badge ledger-badge-${st.active ? 'posted' : 'draft'}`}>{st.active ? t('ctl.enforced') : t('ctl.notEnforced')}</span></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="ledger-hint">{t('ctl.breakGlassHint')}</p>
      </div>
      {editable && <div className="ledger-actions"><button type="button" className="gold-btn" onClick={save}>{t('common.save')}</button></div>}
    </div>
  );
}
