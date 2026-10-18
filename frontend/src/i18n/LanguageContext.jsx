import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import dict, { DEFAULT_LANGUAGE } from './translations.js';

const STORAGE_KEY = 'atlas_language';
const LanguageContext = createContext(null);

function applyDocumentDirection(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

export function LanguageProvider({ children }) {
  const { user, setUser } = useAuth();
  const [lang, setLangState] = useState(() => localStorage.getItem(STORAGE_KEY) || DEFAULT_LANGUAGE);

  useEffect(() => {
    applyDocumentDirection(lang);
  }, [lang]);

  // Adopt the logged-in user's saved language once, on login/refresh — but
  // only if they haven't already picked a different one on this device via
  // localStorage (an explicit local choice wins over the stored default).
  useEffect(() => {
    if (user?.language && !localStorage.getItem(STORAGE_KEY)) {
      setLangState(user.language);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const setLang = useCallback(
    (next) => {
      setLangState(next);
      localStorage.setItem(STORAGE_KEY, next);
      if (user) {
        api.updateLanguage(next).then((res) => setUser(res.user)).catch(() => {});
      }
    },
    [user, setUser]
  );

  const t = useCallback((key) => dict[lang]?.[key] ?? dict[DEFAULT_LANGUAGE]?.[key] ?? key, [lang]);

  const value = useMemo(() => ({ lang, setLang, t, dir: lang === 'ar' ? 'rtl' : 'ltr' }), [lang, setLang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
