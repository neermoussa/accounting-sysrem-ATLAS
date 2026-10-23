require('./lib/clock'); // test-only clock override (ATLAS_TEST_NOW); no-op in production
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const path = require('path');

const db = require('./db/init'); // ensure schema exists before routes load

const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const permissionsRouter = require('./routes/permissions');
const shopsRouter = require('./routes/shops');
const settingsRouter = require('./routes/settings');
const importRouter = require('./routes/import');
const shopImportRouter = require('./routes/shopImport');
const dayplanRouter = require('./routes/dayplan');
const productsRouter = require('./routes/products');
const inventoryRouter = require('./routes/inventory');
const factoryInventoryRouter = require('./routes/factoryInventory');
const statsRouter = require('./routes/stats');
const whatsappRouter = require('./routes/whatsapp');
const auditLogRouter = require('./routes/auditLog');
const notificationsRouter = require('./routes/notifications');
const invoicesRouter = require('./routes/invoices');
const targetsRouter = require('./routes/targets');
const companiesRouter = require('./routes/companies');
const platformAdminRouter = require('./routes/platformAdmin');
const leadsRouter = require('./routes/leads');
const publicRouter = require('./routes/public');
const pricingRouter = require('./routes/pricing');
const repsRouter = require('./routes/reps');
const wavesRouter = require('./routes/waves');
const ordersRouter = require('./routes/orders');
const productionRouter = require('./routes/production');
const custodyTransfersRouter = require('./routes/custodyTransfers');
const returnsRouter = require('./routes/returns');
const collectionsRouter = require('./routes/collections');
const whatsappBotRouter = require('./routes/whatsappBot');
const aiRouter = require('./routes/ai');
const legalRouter = require('./routes/legal');
const marketIntelligenceRouter = require('./routes/marketIntelligence');
const dashboardsRouter = require('./routes/dashboards');
const departmentsRouter = require('./routes/departments');
const reportsRouter = require('./routes/reports');
const documentTemplatesRouter = require('./routes/documentTemplates');
const syncRouter = require('./routes/sync');
const devicesRouter = require('./routes/devices');
const searchRouter = require('./routes/search');
const supportTicketsRouter = require('./routes/supportTickets');
const helpCenterRouter = require('./routes/helpCenter');
const ledgerRouter = require('./routes/ledger');
const salesRouter = require('./routes/sales');
const receivablesRouter = require('./routes/receivables');
const financialReportsRouter = require('./routes/financialReports');
const currencyRouter = require('./routes/currency');
const purchasingRouter = require('./routes/purchasing');
const treasuryRouter = require('./routes/treasury');
const stockRouter = require('./routes/stock');
const { runShopAlertSweep } = require('./lib/alertSweep');
const { sweepPaymentReminders } = require('./lib/collections');
const { sweepVisitReminders, sweepUnansweredMessages } = require('./lib/whatsappBot');
const { computeStockForecasts } = require('./lib/aiRecommendations');
const { computeSnapshot } = require('./lib/marketIntelligence');
const { refreshExchangeRateIfStale } = require('./lib/exchangeRate');

const app = express();
const PORT = process.env.PORT || 4000;

// Needed so req.secure reflects the real client protocol behind Nginx
// (Nginx forwards it via the X-Forwarded-Proto header).
app.set('trust proxy', 1);

// Pending-migrations guard: with migrations pending the schema is not the
// one this code expects, so every request except /api/health gets 503
// (no auto-migrate: run scripts/deploy.sh or `node db/migrate.js`). While
// blocked the status is re-read per request, so a migrated DB unblocks.
const migrationStatus = require('./db/migrationStatus');
let schemaStatus = migrationStatus.status(db);
const pendingMessage = () => `قاعدة البيانات تحتاج ترحيلات معلّقة (${schemaStatus.pending.length}): ${schemaStatus.pending.join(', ')} — شغّل scripts/deploy.sh أو node db/migrate.js ثم أعد تشغيل الخادم`;
app.use((req, res, next) => {
  if (schemaStatus.pending.length) schemaStatus = migrationStatus.status(db);
  if (!schemaStatus.pending.length || req.path === '/api/health') return next();
  return res.status(503).json({ error: 'migrations_pending', message: pendingMessage(), pending: schemaStatus.pending });
});

app.use(cors());
// Load-test finding: an 8,000-shop map view came back as 7.2MB of raw
// JSON with no Content-Encoding at all despite the client advertising
// gzip support — every JSON response this app sends benefits from this,
// especially over the slower mobile connections reps use in the field.
app.use(compression());
app.use(express.json());
app.use(cookieParser());
// Only the branding subfolder is served — the rest of uploads/ holds
// transient import files (batch stashes, temp parses) that get deleted
// right after processing and were never meant to be fetchable by URL.
app.use('/uploads/branding', express.static(path.join(__dirname, 'uploads', 'branding')));
app.use('/uploads/invoices', express.static(path.join(__dirname, 'uploads', 'invoices')));
app.use('/uploads/shop-media', express.static(path.join(__dirname, 'uploads', 'shop-media')));
app.use('/uploads/product-images', express.static(path.join(__dirname, 'uploads', 'product-images')));
app.use('/uploads/visit-media', express.static(path.join(__dirname, 'uploads', 'visit-media')));
app.use('/uploads/return-media', express.static(path.join(__dirname, 'uploads', 'return-media')));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/permissions', permissionsRouter);
app.use('/api/shops', shopsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/import', importRouter);
app.use('/api/shop-import', shopImportRouter);
app.use('/api/day-plan', dayplanRouter);
app.use('/api/products', productsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/factory-inventory', factoryInventoryRouter);
app.use('/api/stats', statsRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/audit-log', auditLogRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/targets', targetsRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/platform-admin', platformAdminRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/public', publicRouter);
app.use('/api/pricing', pricingRouter);
app.use('/api/reps', repsRouter);
app.use('/api/waves', wavesRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/production', productionRouter);
app.use('/api/custody-transfers', custodyTransfersRouter);
app.use('/api/returns', returnsRouter);
app.use('/api/collections', collectionsRouter);
app.use('/api/whatsapp-bot', whatsappBotRouter);
app.use('/api/ai', aiRouter);
app.use('/api/legal', legalRouter);
app.use('/api/market-intelligence', marketIntelligenceRouter);
app.use('/api/dashboards', dashboardsRouter);
app.use('/api/departments', departmentsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/document-templates', documentTemplatesRouter);
app.use('/api/sync', syncRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/search', searchRouter);
app.use('/api/support-tickets', supportTicketsRouter);
app.use('/api/help-center', helpCenterRouter);
app.use('/api/ledger', ledgerRouter);
app.use('/api/sales', salesRouter);
app.use('/api/receivables', receivablesRouter);
app.use('/api/financial-reports', financialReportsRouter);
app.use('/api/currency', currencyRouter);
app.use('/api/purchasing', purchasingRouter);
app.use('/api/treasury', treasuryRouter);
app.use('/api/stock', stockRouter);
app.use('/api/manufacturing', require('./routes/manufacturing'));
app.use('/api/accounting', require('./routes/accountingExtras'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/report-builder', require('./routes/reportBuilder'));

app.get('/api/health', (req, res) => {
  schemaStatus = migrationStatus.status(db);
  res.status(schemaStatus.pending.length ? 503 : 200).json({ ok: !schemaStatus.pending.length, schema_version: schemaStatus.version, applied_migrations: schemaStatus.applied, pending_migrations: schemaStatus.pending.length, pending: schemaStatus.pending });
});

// Catches anything that slipped past a route's own try/catch — most notably
// multer's fileFilter rejecting a bad upload (it errors out of the
// middleware chain before any route handler/try-catch runs), but also any
// other uncaught synchronous throw (e.g. a DB write failing). Without this,
// Express's default handler sends a raw HTML page with a full stack trace —
// leaking file paths/internals and, on a JSON-only frontend, showing up as
// an unhelpful blank/broken screen instead of a clear message.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[unhandled]', err);
  // Durable record for Platform Admin's technical dashboard (spec item 3)
  // — best-effort: a logging failure must never mask the original error.
  try {
    db.prepare('INSERT INTO app_error_log (company_id, level, message, path, stack) VALUES (?, ?, ?, ?, ?)').run(
      req.companyId || null,
      'error',
      err.message || 'unknown_error',
      req.originalUrl || req.path || null,
      err.stack || null
    );
  } catch (logErr) {
    console.error('[unhandled] failed to persist to app_error_log:', logErr.message);
  }
  // Our own upload-validation errors are plain Errors we throw ourselves
  // with an Arabic, already-user-facing message — safe to relay as-is.
  // Anything else (library/internal errors) stays generic so nothing about
  // the server's internals leaks to the client.
  const isOwnValidationMessage = typeof err.message === 'string' && /[؀-ۿ]/.test(err.message);
  res.status(err.status || (isOwnValidationMessage ? 400 : 500)).json({
    error: 'request_failed',
    message: isOwnValidationMessage ? err.message : 'حدث خطأ غير متوقع، حاول مجددًا',
  });
});

// Express 4 does not route a rejected promise from an `async` route handler
// to the error middleware above — it surfaces as an unhandled rejection,
// which Node terminates the process on by default. A single failing async
// handler (observed: a PDF export whose headless-browser launch failed)
// therefore took the whole API down for every tenant, with no supervisor to
// restart it. Logging here keeps one broken request from being a
// company-wide outage; the request itself still needs its own try/catch to
// answer the caller (see the PDF export routes), this is only the backstop.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Exported so in-process tests (test/faultInjection.test.js) can mount the
// real app on their own port without the listener or the background sweeps.
// `node server.js` (require.main === module) behaves exactly as before.
module.exports = app;

if (require.main === module && schemaStatus.pending.length) {
  // Listen only so /api/health can report the problem; no sweeps run.
  console.error(`[server] REFUSING TO SERVE: ${pendingMessage()}`);
  app.listen(PORT, () => console.error(`[server] listening on http://localhost:${PORT} — every request except /api/health returns 503 migrations_pending`));
} else if (require.main === module) {
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

// USD/SYP rate: refreshExchangeRateIfStale() itself no-ops unless the
// stored rate is missing or over a day old, so checking hourly is just
// "don't miss the day boundary by much" — not 24 separate real fetches.
// Companies are refreshed in small concurrent batches (Promise.all per
// chunk) rather than either full sequential awaiting or firing every
// fetch at once — the latter was observed under load to behave like
// sequential waits anyway (Node's default per-origin connection pool
// queues excess concurrent requests to the same host), so an explicit cap
// gets real parallelism without opening hundreds of sockets at once.
const EXCHANGE_RATE_BATCH_SIZE = 20;
async function refreshExchangeRatesForAllCompanies() {
  const companyIds = db.prepare('SELECT id FROM companies').all().map((c) => c.id);
  for (let i = 0; i < companyIds.length; i += EXCHANGE_RATE_BATCH_SIZE) {
    const batch = companyIds.slice(i, i + EXCHANGE_RATE_BATCH_SIZE);
    await Promise.all(
      batch.map((companyId) =>
        refreshExchangeRateIfStale(companyId).catch((err) =>
          console.error(`[exchangeRate] refresh failed for company ${companyId}:`, err.message)
        )
      )
    );
  }
}

// ---------------------------------------------------------------------
// Every periodic sweep's *initial* run (the setInterval registrations
// themselves are cheap and harmless immediately) is deferred a few
// seconds after the server starts accepting connections — under load-test
// data these sweeps combined blocked the very first request for ~79s
// when fired synchronously before app.listen() had a chance to matter.
// Deferring doesn't make the sweeps themselves faster; it means the HTTP
// server is already serving normal requests while they run, and (for the
// ones that internally yield the event loop between companies — stock
// forecast, market intelligence) other requests keep interleaving with
// them rather than queuing behind one giant synchronous call.
// ---------------------------------------------------------------------

const STARTUP_SWEEP_DELAY_MS = 3000;

setTimeout(() => {
  // Debt/overdue conditions can appear purely from time passing (no write
  // event fires), so a periodic sweep is what actually catches those
  // transitions — see lib/alertSweep.js. Interval is deliberately not
  // settings-configurable; 15 minutes is frequent enough for a same-day
  // alert without hammering anything, and this is an internal cadence,
  // not a user-facing setting.
  const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(runShopAlertSweep, SWEEP_INTERVAL_MS);
  runShopAlertSweep();
  // Same cadence, separate concern: suggests customer-facing payment
  // reminders for review (never sends on its own — see lib/collections.js).
  setInterval(sweepPaymentReminders, SWEEP_INTERVAL_MS);
  sweepPaymentReminders();
  // Due-cheques alert (Prompt 7): received and issued cheques due within
  // the company's cheque_due_alert_days, one unread notification each.
  const runChequeSweep = () => {
    try {
      require('./lib/treasury').sweepDueCheques();
    } catch (err) {
      console.error('[treasury] due-cheques sweep failed:', err.message);
    }
  };
  setInterval(runChequeSweep, SWEEP_INTERVAL_MS);
  runChequeSweep();
  // Stock ledger (Prompt 8): daily reconciliation (inventory accounts =
  // valuation, legacy quantities = stock moves), once per company per day.
  const runStockCheck = () => {
    try {
      require('./lib/stockLedger').runDailyReconciliation();
    } catch (err) {
      console.error('[stock] daily reconciliation failed:', err.message);
    }
    try {
      require('./lib/stockOps').sweepAlerts();
    } catch (err) {
      console.error('[stock] lot/reorder alert sweep failed:', err.message);
    }
  };
  setInterval(runStockCheck, SWEEP_INTERVAL_MS);
  runStockCheck();
  // Prompt 10: monthly depreciation (up to the last complete month) and
  // recurring / accrual / prepayment templates due today. Both are
  // idempotent (one row per asset per month, one per template per date).
  // Year rollover: create next fiscal year + periods from the last month
  // of the current one (idempotent, audited) — before the depreciation /
  // recurring sweeps so their January postings find a period.
  const runRollover = () => {
    try {
      require('./lib/yearRollover').autoCreateNextYears();
    } catch (err) {
      console.error('[ledger] year rollover failed:', err.message);
    }
  };
  setInterval(runRollover, SWEEP_INTERVAL_MS);
  runRollover();
  // Prompt 12a: bring the analytics fact tables up to date (incremental,
  // from the change queue the source-table triggers fill).
  const FACT_SWEEP_MS = Number(process.env.ATLAS_FACT_SWEEP_MS) || 60 * 1000;
  const runFactSweep = () => {
    try { require('./lib/analytics/facts').sweep(); } catch (err) { console.error('[analytics] fact sweep failed:', err.message); }
  };
  setInterval(runFactSweep, FACT_SWEEP_MS);
  runFactSweep();
  const runAdjustments = () => {
    try {
      require('./lib/fixedAssets').sweep();
    } catch (err) {
      console.error('[fixed-assets] depreciation sweep failed:', err.message);
    }
    try {
      require('./lib/recurringEntries').sweep();
    } catch (err) {
      console.error('[recurring] sweep failed:', err.message);
    }
  };
  setInterval(runAdjustments, SWEEP_INTERVAL_MS);
  runAdjustments();
  // Same cadence: the day-before visit reminder text, and escalating any
  // WhatsApp message left unanswered for over an hour to an in-app alert.
  setInterval(() => sweepVisitReminders().catch((err) => console.error('[whatsappBot] visit reminder sweep failed:', err.message)), SWEEP_INTERVAL_MS);
  sweepVisitReminders().catch((err) => console.error('[whatsappBot] visit reminder sweep failed:', err.message));
  setInterval(sweepUnansweredMessages, SWEEP_INTERVAL_MS);
  sweepUnansweredMessages();
  // Stock-shortage forecast: recomputed on the same cadence, per-company and
  // per-feature-toggle-gated inside computeStockForecasts itself. The
  // function itself yields the event loop between companies (setImmediate),
  // so this is fire-and-forget rather than awaited — the sweep no longer
  // blocks anything else on the server while it runs.
  setInterval(() => {
    computeStockForecasts().catch((err) => console.error('[aiRecommendations] stock forecast sweep failed:', err.message));
  }, SWEEP_INTERVAL_MS);
  computeStockForecasts().catch((err) => console.error('[aiRecommendations] stock forecast sweep failed:', err.message));

  // Anonymized market-intelligence snapshot: a heavier, cross-company
  // aggregation (see lib/marketIntelligence.js), so it runs on a longer,
  // separate cadence rather than the 15-minute sweep interval — every run
  // recomputes the current month from scratch, so it's always safe to run
  // more or less often without risk of double-counting. Also yields the
  // event loop between companies internally, same as the stock forecast.
  const MARKET_INTEL_INTERVAL_MS = 6 * 60 * 60 * 1000;
  setInterval(() => {
    computeSnapshot().catch((err) => console.error('[marketIntelligence] snapshot recompute failed:', err.message));
  }, MARKET_INTEL_INTERVAL_MS);
  computeSnapshot().catch((err) => console.error('[marketIntelligence] snapshot recompute failed:', err.message));

  const EXCHANGE_RATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    refreshExchangeRatesForAllCompanies().catch((err) => console.error('[exchangeRate] sweep failed:', err.message));
  }, EXCHANGE_RATE_CHECK_INTERVAL_MS);
  refreshExchangeRatesForAllCompanies().catch((err) => console.error('[exchangeRate] sweep failed:', err.message));

  // Prompt 3: daily AR control-vs-sub-ledger check, stored per company/day.
  const AR_RECON_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const { runDailyReconciliation } = require('./lib/receivables');
  setInterval(runDailyReconciliation, AR_RECON_INTERVAL_MS);
  runDailyReconciliation();
}, STARTUP_SWEEP_DELAY_MS);
}
