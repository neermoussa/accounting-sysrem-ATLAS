import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';

export default function LoginPage({ onSwitchToRegister }) {
  const { login } = useAuth();
  const { t } = useLanguage();
  const ERROR_MESSAGES = {
    invalid_credentials: t('login.invalidCredentials'),
    pending_approval: t('login.pendingApproval'),
    account_rejected: t('login.accountRejected'),
  };
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(contact.trim(), password);
    } catch (err) {
      setError(ERROR_MESSAGES[err.detail?.error] || t('login.errorGeneric'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="card auth-card" onSubmit={handleSubmit}>
      <h1 className="auth-title">{t('login.title')}</h1>
      <div className="auth-fields-row">
        <label className="auth-field">
          {t('login.contactLabel')}
          <input value={contact} onChange={(e) => setContact(e.target.value)} autoFocus dir="ltr" required />
        </label>
        <label className="auth-field">
          {t('login.passwordLabel')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
      </div>
      {error && <p className="auth-error">{error}</p>}
      <button type="submit" className="gold-btn auth-submit" disabled={loading}>
        {loading ? t('login.loggingIn') : t('login.submit')}
      </button>
      <button type="button" className="ghost-btn auth-switch-inline" onClick={onSwitchToRegister}>
        {t('login.noAccount')}
      </button>
    </form>
  );
}
