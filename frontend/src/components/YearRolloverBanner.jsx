import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';

// Year rollover banner: within 60 days of the fiscal year end when the next
// year does not exist yet (it is created automatically from the last
// month), when today has no fiscal period at all, or when postings are
// waiting in the failed-posting queue. Shown to whoever manages periods
// or posts entries.
export default function YearRolloverBanner() {
  const { t } = useLanguage();
  const { user, can } = useAuth();
  const [s, setS] = useState(null);
  const allowed = user && (can('manage_fiscal_periods') || can('post_journal_entries'));
  useEffect(() => { if (allowed) api.getYearStatus().then(setS).catch(() => setS(null)); }, [allowed]);
  if (!allowed || !s || !s.has_ledger_years) return null;
  const parts = [];
  if (!s.today_covered) parts.push(t('rollover.noPeriodToday'));
  else if (s.warn) parts.push(t('rollover.nextMissing').replace('{days}', s.days_left).replace('{year}', s.year + 1));
  if (s.open_posting_failures) parts.push(t('rollover.failures').replace('{n}', s.open_posting_failures));
  if (!parts.length) return null;
  return (
    <div className="ledger-error" role="status" data-testid="year-rollover-banner" style={{ margin: 0, borderRadius: 0 }}>
      {parts.join(' — ')} <Link to="/ledger/periods">{t('rollover.periods')}</Link>{s.open_posting_failures ? <> · <Link to="/ledger/posting-failures">{t('rollover.queue')}</Link></> : null}
    </div>
  );
}
