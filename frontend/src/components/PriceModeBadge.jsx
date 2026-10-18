import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';

// Active price mode (tax-inclusive / exclusive) on every invoice screen.
// Shown only for companies that use tax codes; when codes exist but no mode
// has been chosen, a warning: taxed documents cannot post until it is.
export default function PriceModeBadge() {
  const { t } = useLanguage();
  const [pm, setPm] = useState(null);
  useEffect(() => { api.acGet('/price-mode').then(setPm).catch(() => setPm(null)); }, []);
  if (!pm || !pm.has_tax_codes) return null;
  if (!pm.mode) return <div className="ledger-error" data-testid="price-mode">{t('ax.priceModeMissing')} <Link to="/accounting/adjustments?tab=tax">{t('ax.choose')}</Link></div>;
  return <span className="ledger-badge" data-testid="price-mode">{t('ax.priceModeLabel')}: {t(`ax.mode.${pm.mode}`)}</span>;
}
