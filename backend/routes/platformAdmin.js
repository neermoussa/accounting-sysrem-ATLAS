const express = require('express');
const db = require('../db/init');
const { requirePlatformAdmin } = require('../middleware/auth');
const { listCompanies, getCompany, setSubscriptionStatus } = require('../lib/companies');
const { computeSnapshot, getSnapshot } = require('../lib/marketIntelligence');

const router = express.Router();

// Every route in this file is gated by requirePlatformAdmin — not
// requirePermission. A company manager can hold every permission there is
// inside their own company and still get a flat 403 here, because this
// checks `users.is_platform_admin` only, a column the normal per-company
// permission UI can never touch. There is no company-scoping filter in this
// file on purpose: a platform admin's whole job is cross-company oversight.
router.use(requirePlatformAdmin);

router.get('/companies', (req, res) => {
  res.json(listCompanies());
});

router.get('/companies/:id', (req, res) => {
  const company = getCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'not_found' });
  res.json(company);
});

router.put('/companies/:id/subscription', (req, res) => {
  const { status } = req.body || {};
  try {
    res.json(setSubscriptionStatus(req.params.id, status));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Generic pending/approve/reject helper for the four review queues ----
function reviewQueue(table, extraSelect = '*') {
  router.get(`/${table}`, (req, res) => {
    const status = req.query.status;
    const rows = status
      ? db.prepare(`SELECT ${extraSelect} FROM ${table} WHERE status = ? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT ${extraSelect} FROM ${table} ORDER BY created_at DESC`).all();
    res.json(rows);
  });

  router.post(`/${table}/:id/approve`, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    db.prepare(
      `UPDATE ${table} SET status = 'approved', reviewed_by_id = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`
    ).run(req.user.id, req.body?.note || null, row.id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id));
  });

  router.post(`/${table}/:id/reject`, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    db.prepare(
      `UPDATE ${table} SET status = 'rejected', reviewed_by_id = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`
    ).run(req.user.id, req.body?.note || null, row.id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id));
  });
}

reviewQueue('whatsapp_link_requests');
reviewQueue('data_restore_requests');
reviewQueue('document_templates');

// ---------------------------------------------------------------------
// Bot knowledge-base suggestions: cross-company review queue. Unlike the
// generic reviewQueue helper above, approving one here has a real side
// effect — it publishes a new row into that company's knowledge_base,
// optionally with edited wording (question/answer/keywords in the body) —
// this is the ONLY path anything ever lands in knowledge_base through, per
// spec (a company manager can only ever propose, never publish directly).
// ---------------------------------------------------------------------

router.get('/kb-submissions', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM kb_submissions WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM kb_submissions ORDER BY created_at DESC').all();
  res.json(rows);
});

router.post('/kb-submissions/:id/approve', (req, res) => {
  const submission = db.prepare('SELECT * FROM kb_submissions WHERE id = ?').get(req.params.id);
  if (!submission) return res.status(404).json({ error: 'not_found' });
  if (submission.status !== 'pending') return res.status(409).json({ error: 'already_reviewed', currentStatus: submission.status });

  const { question, answer, keywords, note } = req.body || {};
  const finalQuestion = (question?.trim()) || submission.question;
  const finalAnswer = (answer?.trim()) || submission.answer;
  // No keywords supplied: fall back to the question's own words — still
  // gives the bot something to match on rather than publishing an
  // effectively unreachable entry.
  const finalKeywords = (keywords?.trim()) || finalQuestion;

  const info = db
    .prepare(
      `INSERT INTO knowledge_base (company_id, question, answer, keywords, source_submission_id, approved_by_id, approved_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(submission.company_id, finalQuestion, finalAnswer, finalKeywords, submission.id, req.user.id, req.user.name);

  db.prepare(
    `UPDATE kb_submissions SET status = 'approved', reviewed_by_id = ?, reviewed_at = datetime('now'), review_note = ?, published_kb_id = ? WHERE id = ?`
  ).run(req.user.id, note || null, info.lastInsertRowid, submission.id);

  res.json({
    submission: db.prepare('SELECT * FROM kb_submissions WHERE id = ?').get(submission.id),
    knowledgeBaseEntry: db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(info.lastInsertRowid),
  });
});

router.post('/kb-submissions/:id/reject', (req, res) => {
  const submission = db.prepare('SELECT * FROM kb_submissions WHERE id = ?').get(req.params.id);
  if (!submission) return res.status(404).json({ error: 'not_found' });
  if (submission.status !== 'pending') return res.status(409).json({ error: 'already_reviewed', currentStatus: submission.status });
  db.prepare(
    `UPDATE kb_submissions SET status = 'rejected', reviewed_by_id = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`
  ).run(req.user.id, req.body?.note || null, submission.id);
  res.json(db.prepare('SELECT * FROM kb_submissions WHERE id = ?').get(submission.id));
});

// ---------------------------------------------------------------------
// Market intelligence oversight: Platform Admin can force a recompute (the
// periodic sweep in server.js also does this automatically) and inspect
// the resulting rows exactly as any company would see them — this endpoint
// grants no visibility into anything more identifying than /api/market-
// intelligence/stats already exposes to every company.
// ---------------------------------------------------------------------

router.post('/market-intelligence/recompute', async (req, res) => {
  try {
    res.json(await computeSnapshot(req.body?.period));
  } catch (err) {
    res.status(500).json({ error: err.message || 'server_error' });
  }
});

router.get('/market-intelligence/stats', (req, res) => {
  const { period, geoLevel, geoValue, metricType, productName, allPeriods } = req.query;
  res.json(getSnapshot({ period, geoLevel, geoValue, metricType, productName, allPeriods: allPeriods === '1' }));
});

// ---------------------------------------------------------------------
// Technical dashboard (spec item 3): failed logins, session activity,
// server error log, and per-company integration health — the "فنية"
// (technical) view for the platform team, cross-company by design.
// ---------------------------------------------------------------------

router.get('/technical/failed-logins', (req, res) => {
  const hours = Number(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  res.json(
    db
      .prepare("SELECT * FROM login_attempts WHERE success = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 200")
      .all(since)
  );
});

router.get('/technical/sessions', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.token, s.created_at, s.expires_at, u.id as user_id, u.name, u.company_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > datetime('now') ORDER BY s.created_at DESC LIMIT 200`
    )
    .all();
  res.json(rows.map((r) => ({ ...r, token: undefined }))); // never expose live session tokens, just who/when
});

router.get('/technical/errors', (req, res) => {
  res.json(db.prepare('SELECT * FROM app_error_log ORDER BY created_at DESC LIMIT 200').all());
});

router.get('/technical/integration-health', (req, res) => {
  const { getState } = require('../lib/whatsapp');
  const companies = listCompanies();
  const whatsapp = companies.map((c) => ({ companyId: c.id, companyName: c.name, ...getState(c.id) }));
  const aiConfigured = !!process.env.AI_API_KEY;
  const exchangeRates = db
    .prepare("SELECT company_id, value FROM settings WHERE key = 'usd_exchange_rate_updated_at'")
    .all()
    .map((r) => ({ companyId: r.company_id, lastUpdated: r.value }));
  res.json({ whatsapp, ai: { configured: aiConfigured }, exchangeRates });
});

// ---------------------------------------------------------------------
// Support tickets — companies file via routes/supportTickets.js; the
// platform team owns triage/reply/status here.
// ---------------------------------------------------------------------

router.get('/support-tickets', (req, res) => {
  const { status } = req.query;
  const sql = status ? 'SELECT * FROM support_tickets WHERE status = ? ORDER BY created_at DESC' : 'SELECT * FROM support_tickets ORDER BY created_at DESC';
  res.json(status ? db.prepare(sql).all(status) : db.prepare(sql).all());
});

router.get('/support-tickets/:id', (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'not_found' });
  const replies = db.prepare('SELECT * FROM support_ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id);
  res.json({ ...ticket, replies });
});

router.post('/support-tickets/:id/reply', (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'not_found' });
  const { body, status } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'body_required' });
  db.prepare('INSERT INTO support_ticket_replies (ticket_id, author_id, author_name, is_platform_admin, body) VALUES (?, ?, ?, 1, ?)').run(
    ticket.id,
    req.user.id,
    req.user.name,
    body.trim()
  );
  const nextStatus = ['open', 'in_progress', 'resolved', 'closed'].includes(status) ? status : 'in_progress';
  db.prepare("UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(nextStatus, ticket.id);
  res.status(201).json(db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticket.id));
});

// ---------------------------------------------------------------------
// Help-center content management (training videos, changelog) — companies
// read via routes/helpCenter.js.
// ---------------------------------------------------------------------

router.post('/training-videos', (req, res) => {
  const { title, videoUrl, category } = req.body || {};
  if (!title?.trim() || !videoUrl?.trim()) return res.status(400).json({ error: 'title_and_video_url_required' });
  const info = db.prepare('INSERT INTO training_videos (title, video_url, category) VALUES (?, ?, ?)').run(title.trim(), videoUrl.trim(), category || null);
  res.status(201).json(db.prepare('SELECT * FROM training_videos WHERE id = ?').get(info.lastInsertRowid));
});

router.post('/changelog', (req, res) => {
  const { version, title, description } = req.body || {};
  if (!version?.trim() || !title?.trim()) return res.status(400).json({ error: 'version_and_title_required' });
  const info = db.prepare('INSERT INTO platform_changelog (version, title, description) VALUES (?, ?, ?)').run(version.trim(), title.trim(), description || null);
  res.status(201).json(db.prepare('SELECT * FROM platform_changelog WHERE id = ?').get(info.lastInsertRowid));
});

module.exports = router;
