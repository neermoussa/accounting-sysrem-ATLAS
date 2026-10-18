const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');

const router = express.Router();
router.use(requireCompany);

// A company files a ticket — reaches Platform Admin's queue
// (routes/platformAdmin.js's /support-tickets endpoints) exactly like
// kb_submissions/document_templates elsewhere in this app.
router.post('/', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  const { subject, description, priority } = req.body || {};
  if (!subject?.trim() || !description?.trim()) return res.status(400).json({ error: 'subject_and_description_required' });
  const info = db
    .prepare(
      `INSERT INTO support_tickets (company_id, subject, description, priority, submitted_by_id, submitted_by_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, subject.trim(), description.trim(), ['low', 'normal', 'high'].includes(priority) ? priority : 'normal', req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM support_tickets WHERE company_id = ?';
  const params = [req.companyId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!ticket) return res.status(404).json({ error: 'not_found' });
  const replies = db.prepare('SELECT * FROM support_ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id);
  res.json({ ...ticket, replies });
});

router.post('/:id/reply', requireAnyPermission('view_app', 'manage_settings'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!ticket) return res.status(404).json({ error: 'not_found' });
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'body_required' });
  db.prepare('INSERT INTO support_ticket_replies (ticket_id, author_id, author_name, is_platform_admin, body) VALUES (?, ?, ?, 0, ?)').run(
    ticket.id,
    req.user.id,
    req.user.name,
    body.trim()
  );
  db.prepare("UPDATE support_tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  res.status(201).json(db.prepare('SELECT * FROM support_ticket_replies WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1').get(ticket.id));
});

module.exports = router;
