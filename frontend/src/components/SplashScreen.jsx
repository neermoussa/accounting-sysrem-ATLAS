import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/splash.css';

// Pure CSS logo splash — no video/external assets, so it can never delay the
// page's own load. `fading` starts the fade-out transition (the parent
// unmounts this once it finishes); `error` freezes the pulse and shows a
// message instead of animating forever when the real data load never
// resolves.
export default function SplashScreen({ fading, error }) {
  const { t } = useLanguage();
  return (
    <div className={'splash-screen' + (fading ? ' fading' : '') + (error ? ' error' : '')}>
      <div className="atlas-splash-lockup" aria-label="Atlas"><img className="atlas-splash-wordmark" src="/atlas-lockup-white.png" alt="Atlas" /></div>
      {error && <p className="splash-error">{t('splash.error')}</p>}
    </div>
  );
}
