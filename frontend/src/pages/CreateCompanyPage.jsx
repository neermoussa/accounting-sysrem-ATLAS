import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';

// The single entry point that brings a new company onto the platform —
// there is no seeded/default company anywhere in the code, so this is the
// only way one is ever created. Submitting logs the new manager straight
// in and the app then routes them into the Startup Setup wizard (see
// App.jsx: any company with setup_completed === 0 is forced there).
export default function CreateCompanyPage({ onSwitchToLogin }) {
  const { setUser, refreshCompany } = useAuth();
  const { t } = useLanguage();
  const [companyName, setCompanyName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminContact, setAdminContact] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!companyName.trim() || !adminName.trim() || !adminContact.trim() || !password) {
      setError(t('createCompany.errorFillAll'));
      return;
    }
    if (password.length < 8) {
      setError(t('createCompany.errorPasswordLength'));
      return;
    }
    if (password !== confirm) {
      setError(t('createCompany.errorPasswordMismatch'));
      return;
    }

    setLoading(true);
    try {
      const res = await api.createCompany({
        companyName: companyName.trim(),
        adminName: adminName.trim(),
        adminContact: adminContact.trim(),
        adminPassword: password,
      });
      setUser(res.user);
      await refreshCompany();
    } catch (err) {
      setError(
        err.detail?.error === 'contact_already_registered'
          ? t('createCompany.errorContactExists')
          : t('createCompany.errorGeneric')
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="card auth-card" onSubmit={handleSubmit}>
      <h1 className="auth-title">{t('createCompany.title')}</h1>
      <p className="auth-pending-message">{t('createCompany.subtitle')}</p>
      <label className="auth-field">
        {t('createCompany.companyName')}
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoFocus required />
      </label>
      <div className="auth-fields-row auth-register-row">
        <label className="auth-field">
          {t('createCompany.adminName')}
          <input value={adminName} onChange={(e) => setAdminName(e.target.value)} required />
        </label>
        <label className="auth-field">
          {t('createCompany.adminContact')}
          <input value={adminContact} onChange={(e) => setAdminContact(e.target.value)} dir="ltr" required />
        </label>
      </div>
      <div className="auth-fields-row auth-register-row">
        <label className="auth-field">
          {t('createCompany.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="auth-field">
          {t('createCompany.confirmPassword')}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      </div>
      {error && <p className="auth-error">{error}</p>}
      <button type="submit" className="gold-btn auth-submit" disabled={loading}>
        {loading ? t('createCompany.sending') : t('createCompany.submit')}
      </button>
      <button type="button" className="ghost-btn auth-switch" onClick={onSwitchToLogin}>
        {t('createCompany.haveAccount')}
      </button>
    </form>
  );
}
