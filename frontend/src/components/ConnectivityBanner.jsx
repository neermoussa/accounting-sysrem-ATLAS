import { useEffect, useState } from 'react';
import { isOffline, setOffline, subscribe } from '../lib/connectivity.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/connectivity.css';

const POLL_MS = 8000;

export default function ConnectivityBanner() {
  const { t } = useLanguage();
  const [offline, setOfflineState] = useState(isOffline());

  useEffect(() => subscribe(setOfflineState), []);

  // While offline, nothing else is calling the API for us — actively check
  // for recovery instead of waiting for the user to retry some action.
  useEffect(() => {
    if (!offline) return undefined;
    const timer = setInterval(() => {
      fetch('/api/health', { credentials: 'same-origin' })
        .then((res) => {
          if (res.ok) setOffline(false);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [offline]);

  if (!offline) return null;

  return (
    <div className="connectivity-banner">
      <span className="connectivity-icon">⚠️</span>
      <span>{t('connectivity.offlineMessage')}</span>
    </div>
  );
}
