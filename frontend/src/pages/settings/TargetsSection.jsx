import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useLanguage } from '../../i18n/LanguageContext.jsx';

export default function TargetsSection() {
  const { t } = useLanguage();
  const PERIOD_LABEL = { weekly: t('targets.weeklyTarget'), monthly: t('targets.monthlyTarget') };
  const [reps, setReps] = useState([]);
  const [selectedRepId, setSelectedRepId] = useState(null);
  const [targets, setTargets] = useState(null);
  const [draft, setDraft] = useState({ weekly: '', monthly: '' });
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    api.getReps().then(({ reps, defaultRepId }) => {
      setReps(reps);
      setSelectedRepId(defaultRepId);
    });
  }, []);

  useEffect(() => {
    if (!selectedRepId) return;
    api.getTargets(selectedRepId).then((t) => {
      setTargets(t);
      setDraft({ weekly: t.weekly ?? '', monthly: t.monthly ?? '' });
    });
  }, [selectedRepId]);

  async function save() {
    setSaving(true);
    try {
      let latest;
      for (const period of ['weekly', 'monthly']) {
        latest = await api.setTarget(selectedRepId, period, draft[period]);
      }
      setTargets(latest);
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  if (!selectedRepId) {
    return (
      <section className="card settings-section">
        <h2>{t('targets.title')}</h2>
        <p className="settings-hint">{t('targets.noApprovedRep')}</p>
      </section>
    );
  }

  return (
    <section className="card settings-section">
      <h2>{t('targets.title')}</h2>
      <p className="settings-hint">{t('targets.hint')}</p>

      {reps.length > 1 && (
        <label className="settings-grid" style={{ maxWidth: 360, marginBottom: 16 }}>
          {t('targets.rep')}
          <select value={selectedRepId} onChange={(e) => setSelectedRepId(Number(e.target.value))}>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {reps.length === 1 && <p className="settings-hint">{t('targets.repPrefix')} {reps[0].name}</p>}

      <div className="settings-grid">
        {['weekly', 'monthly'].map((period) => (
          <label key={period}>
            {PERIOD_LABEL[period]}
            <input
              type="number"
              min="0"
              placeholder={t('targets.notSet')}
              value={draft[period]}
              onChange={(e) => setDraft((d) => ({ ...d, [period]: e.target.value }))}
            />
          </label>
        ))}
      </div>

      <div className="qof-actions">
        <button type="button" className="gold-btn" onClick={save} disabled={saving}>
          {saving ? t('targets.saving') : t('targets.save')}
        </button>
        {savedNote && <span className="settings-saved-note">{t('targets.saved')}</span>}
      </div>

      {targets && (targets.weekly || targets.monthly) && (
        <p className="settings-hint">
          {t('targets.lastSavedPrefix')} {targets.weekly ?? t('targets.notSet')} {t('targets.lastSavedMiddle')} {targets.monthly ?? t('targets.notSet')}
        </p>
      )}
    </section>
  );
}
