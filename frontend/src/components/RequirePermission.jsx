import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';

export default function RequirePermission({ permission, anyOf, module, children }) {
  const { can, canAny, moduleEnabled } = useAuth();
  const { t } = useLanguage();
  // Both gates apply: the permission check (as before) AND, if this route
  // is tied to a company module, that module must still be switched on —
  // a direct URL visit can't bypass a disabled module just because the
  // sidebar link is hidden.
  const allowed = (anyOf ? canAny(...anyOf) : can(permission)) && (!module || moduleEnabled(module));
  if (!allowed) {
    return (
      <div className="no-access">
        <p>{t('requirePermission.noAccess')}</p>
      </div>
    );
  }
  return children;
}
