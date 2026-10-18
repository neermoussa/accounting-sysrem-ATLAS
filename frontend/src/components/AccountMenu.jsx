import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';

// Quick-action dropdown only — "Account Settings" here is an inline
// password-change form, not a routed page, so it never competes with the
// full app-wide /settings screen still reachable from the sidebar.
export default function AccountMenu({ user, roleLabel, onLogout }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok: bool, text: string }
  const boxRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
        setShowPasswordForm(false);
        setFeedback(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function submitPasswordChange(e) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    api
      .changePassword(currentPassword, newPassword)
      .then(() => {
        setFeedback({ ok: true, text: t('account.passwordChanged') });
        setCurrentPassword('');
        setNewPassword('');
      })
      .catch((err) => {
        const msg =
          err.detail?.error === 'current_password_incorrect'
            ? t('account.currentPasswordWrong')
            : err.detail?.error === 'password_too_short'
              ? t('account.passwordTooShort')
              : t('account.passwordChangeFailed');
        setFeedback({ ok: false, text: msg });
      })
      .finally(() => setSaving(false));
  }

  const initial = (user.name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="account-menu" ref={boxRef}>
      <button
        type="button"
        className="account-avatar-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('account.menuLabel')}
      >
        <span className="account-avatar">{initial}</span>
      </button>

      {open && (
        <div className="account-dropdown">
          <div className="account-dropdown-header">
            <span className="account-avatar account-avatar-lg">{initial}</span>
            <div>
              <div className="account-dropdown-name">{user.name}</div>
              {roleLabel && <div className="account-dropdown-role">{roleLabel}</div>}
            </div>
          </div>

          <div className="account-dropdown-divider" />

          {!showPasswordForm ? (
            <button type="button" className="account-dropdown-item" onClick={() => setShowPasswordForm(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              {t('account.settings')}
            </button>
          ) : (
            <form className="account-password-form" onSubmit={submitPasswordChange}>
              <input
                type="password"
                placeholder={t('account.currentPassword')}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
              <input
                type="password"
                placeholder={t('account.newPassword')}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
              {feedback && (
                <p className={'account-password-feedback' + (feedback.ok ? ' ok' : ' error')}>{feedback.text}</p>
              )}
              <div className="account-password-actions">
                <button type="button" className="ghost-btn" onClick={() => setShowPasswordForm(false)}>
                  {t('account.cancel')}
                </button>
                <button type="submit" className="gold-btn" disabled={saving}>
                  {saving ? t('account.saving') : t('account.save')}
                </button>
              </div>
            </form>
          )}

          <div className="account-dropdown-divider" />

          <button type="button" className="account-dropdown-item account-dropdown-logout" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('topbar.logout')}
          </button>
        </div>
      )}
    </div>
  );
}
