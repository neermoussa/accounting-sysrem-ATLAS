const db = require('../db/init');

// Free, no-API-key exchange-rate endpoint — USD as base, SYP among the
// returned rates. No SLA/uptime guarantee, so every failure is swallowed:
// the last known rate (whether from a previous fetch or a manual admin
// edit) just stays in place until the next successful run.
const RATE_API_URL = 'https://open.er-api.com/v6/latest/USD';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getStoredRate(companyId) {
  const rows = db
    .prepare(
      `SELECT key, value FROM settings WHERE company_id = ? AND key IN ('usd_exchange_rate','usd_exchange_rate_updated_at','usd_exchange_rate_source')`
    )
    .all(companyId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return {
    rate: obj.usd_exchange_rate || '',
    updatedAt: obj.usd_exchange_rate_updated_at || '',
    source: obj.usd_exchange_rate_source || '',
  };
}

function writeRate(companyId, rate, source) {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  );
  const tx = db.transaction(() => {
    upsert.run(companyId, 'usd_exchange_rate', String(rate));
    upsert.run(companyId, 'usd_exchange_rate_updated_at', now);
    upsert.run(companyId, 'usd_exchange_rate_source', source);
  });
  tx();
}

// Only refreshes if the stored rate is missing or over a day old — an admin's
// manual edit (routes/settings.js PUT, same 'usd_exchange_rate' key) is
// never overwritten until this window naturally elapses again.
async function refreshExchangeRateIfStale(companyId) {
  const { rate, updatedAt } = getStoredRate(companyId);
  if (rate && updatedAt) {
    const age = Date.now() - new Date(updatedAt).getTime();
    if (age < ONE_DAY_MS) return;
  }

  try {
    const res = await fetch(RATE_API_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const syp = data?.rates?.SYP;
    if (!Number.isFinite(syp) || syp <= 0) throw new Error('malformed rate response');
    writeRate(companyId, syp, 'auto');
    // Prompt 5: the same rate goes into the exchange_rates history (source
    // 'api'), in the significant direction (SYP per 1 USD). Never breaks
    // the existing fetch.
    try {
      require('./currency').recordApiUsdSyp(companyId, syp, 'api');
    } catch (err) {
      console.log('[exchangeRate] could not record rate history:', err.message);
    }
    console.log(`[exchangeRate] refreshed USD/SYP rate to ${syp} for company ${companyId}`);
  } catch (err) {
    console.log('[exchangeRate] auto-refresh failed (keeping last known rate):', err.message);
  }
}

module.exports = { refreshExchangeRateIfStale, getStoredRate };
