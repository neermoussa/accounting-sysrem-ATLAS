const express = require('express');
const db = require('../db/init');
const { requirePermission, requireAnyPermission, requireCompany } = require('../middleware/auth');
const { sendToCustomer } = require('../lib/whatsapp');
const { getSetting } = require('../lib/orderLifecycle');
const { handleIncomingMessage, logMessage } = require('../lib/whatsappBot');

const router = express.Router();
router.use(requireCompany);

// ---------------------------------------------------------------------
// Conversation log — independently permission-gated (view_whatsapp_log),
// separate from every other WhatsApp-related permission. Shows who
// replied, when, and whether it was automatic (bot) or manual.
// ---------------------------------------------------------------------

router.get('/messages', requirePermission('view_whatsapp_log'), (req, res) => {
  const { shopId } = req.query;
  let sql = 'SELECT * FROM whatsapp_messages WHERE company_id = ?';
  const params = [req.companyId];
  if (shopId) {
    sql += ' AND shop_id = ?';
    params.push(shopId);
  }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

router.get('/messages/shop/:shopId', requirePermission('view_whatsapp_log'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const messages = db
    .prepare('SELECT * FROM whatsapp_messages WHERE company_id = ? AND shop_id = ? ORDER BY created_at ASC')
    .all(req.companyId, shop.id);
  res.json(messages);
});

// ---------------------------------------------------------------------
// Manual ingestion — the same entry point a live whatsapp-web.js session
// uses (lib/whatsapp.js's message listener calls handleIncomingMessage
// directly), exposed here so this feature can be exercised end-to-end
// without a real phone connection. Not a customer-facing endpoint.
// ---------------------------------------------------------------------

router.post('/simulate-incoming', requirePermission('manage_settings'), async (req, res) => {
  const { fromPhone, body } = req.body || {};
  if (!fromPhone || !body?.trim()) return res.status(400).json({ error: 'fromPhone_and_body_required' });
  const sentMessages = [];
  const result = await handleIncomingMessage(req.companyId, {
    fromPhone,
    body,
    sendReply: async (text) => {
      sentMessages.push(text);
    },
  });
  res.status(201).json({ ...result, botReplies: sentMessages });
});

// A human manually replying inside the conversation (not one of the
// recognized keywords) — also logged, marked handled_by='employee', and
// resolves any open unanswered/unrecognized alert for this shop.
router.post('/messages/shop/:shopId/reply', requirePermission('respond_whatsapp_alerts'), async (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message_required' });

  const { resolveOpenAlertsForShop } = require('../lib/whatsappBot');
  const sent = await sendToCustomer(req.companyId, shop, message).catch(() => false);
  const row = logMessage(req.companyId, {
    shopId: shop.id,
    direction: 'out',
    toPhone: shop.phone,
    body: message,
    intent: 'manual_reply',
    handledBy: 'employee',
    repliedBy: req.user,
  });
  resolveOpenAlertsForShop(req.companyId, shop.id, null);
  res.status(201).json({ ...row, sent });
});

// ---------------------------------------------------------------------
// Knowledge base — read-only for a company (they can see what's live and
// what they've suggested, never write directly into it) and the
// "employee answers a new question" flow that only ever creates a
// kb_submissions proposal, never a live entry.
// ---------------------------------------------------------------------

router.get('/knowledge-base', requirePermission('suggest_kb_entries'), (req, res) => {
  res.json(db.prepare("SELECT * FROM knowledge_base WHERE company_id = ? AND status = 'active' ORDER BY question COLLATE NOCASE").all(req.companyId));
});

router.get('/knowledge-base/submissions', requirePermission('suggest_kb_entries'), (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM kb_submissions WHERE company_id = ?';
  const params = [req.companyId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// The required test scenario: an employee answers a customer's new
// question inside the conversation. This sends the reply immediately (the
// customer isn't kept waiting for Platform Admin) AND separately files a
// kb_submissions proposal — the general knowledge base itself is untouched
// until Platform Admin approves it (routes/platformAdmin.js).
router.post('/messages/shop/:shopId/answer-new-question', requirePermission('suggest_kb_entries'), async (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const { question, answer, sourceMessageId } = req.body || {};
  if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'question_and_answer_required' });

  const { resolveOpenAlertsForShop } = require('../lib/whatsappBot');
  const sent = await sendToCustomer(req.companyId, shop, answer).catch(() => false);
  const message = logMessage(req.companyId, {
    shopId: shop.id,
    direction: 'out',
    toPhone: shop.phone,
    body: answer,
    intent: 'manual_reply',
    handledBy: 'employee',
    repliedBy: req.user,
  });
  resolveOpenAlertsForShop(req.companyId, shop.id, null);

  const info = db
    .prepare(
      `INSERT INTO kb_submissions (company_id, shop_id, source_message_id, question, answer, submitted_by_id, submitted_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, shop.id, sourceMessageId || null, question.trim(), answer.trim(), req.user.id, req.user.name);
  const submission = db.prepare('SELECT * FROM kb_submissions WHERE id = ?').get(info.lastInsertRowid);

  res.status(201).json({ message: { ...message, sent }, submission });
});

// ---------------------------------------------------------------------
// Unclear/unanswered-message alerts — visible to every permission holder
// until any employee replies; each user can also dismiss one just for
// themselves without affecting anyone else.
// ---------------------------------------------------------------------

router.get('/alerts', requirePermission('respond_whatsapp_alerts'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.* FROM whatsapp_message_alerts a
       WHERE a.company_id = ? AND a.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM whatsapp_message_alert_dismissals d WHERE d.alert_id = a.id AND d.user_id = ?)
       ORDER BY a.created_at DESC`
    )
    .all(req.companyId, req.user.id);
  res.json(rows);
});

router.post('/alerts/:id/dismiss', requirePermission('respond_whatsapp_alerts'), (req, res) => {
  const alert = db.prepare('SELECT * FROM whatsapp_message_alerts WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!alert) return res.status(404).json({ error: 'not_found' });
  db.prepare('INSERT OR IGNORE INTO whatsapp_message_alert_dismissals (alert_id, user_id) VALUES (?, ?)').run(alert.id, req.user.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Complaint tickets
// ---------------------------------------------------------------------

router.get('/tickets', requirePermission('manage_whatsapp_tickets'), (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM whatsapp_tickets WHERE company_id = ?';
  const params = [req.companyId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.put('/tickets/:id', requirePermission('manage_whatsapp_tickets'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM whatsapp_tickets WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!ticket) return res.status(404).json({ error: 'not_found' });
  const { status, assignedToId } = req.body || {};
  if (status && !['open', 'in_progress', 'resolved'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const isResolving = status === 'resolved' && ticket.status !== 'resolved';
  // Reopening has to clear the previous resolution too, not just flip the
  // status — otherwise an open ticket keeps rendering "تم الحل بواسطة …"
  // with the old resolver and timestamp, which reads as already handled.
  const isReopening = !!status && status !== 'resolved' && ticket.status === 'resolved';
  db.prepare(
    `UPDATE whatsapp_tickets SET
       status = COALESCE(?, status),
       assigned_to_id = COALESCE(?, assigned_to_id),
       resolved_by_id = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE resolved_by_id END,
       resolved_by_name = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE resolved_by_name END,
       resolved_at = CASE WHEN ? THEN datetime('now') WHEN ? THEN NULL ELSE resolved_at END
     WHERE id = ?`
  ).run(
    status || null,
    assignedToId ?? null,
    isResolving ? 1 : 0, req.user.id, isReopening ? 1 : 0,
    isResolving ? 1 : 0, req.user.name, isReopening ? 1 : 0,
    isResolving ? 1 : 0, isReopening ? 1 : 0,
    ticket.id
  );
  res.json(db.prepare('SELECT * FROM whatsapp_tickets WHERE id = ?').get(ticket.id));
});

// ---------------------------------------------------------------------
// Account statement — the one message type that's NEVER sent without an
// authorized employee's explicit approval, even when a customer asked for
// it via "كشف حساب" (that just raised a notification, see lib/whatsappBot.js).
// ---------------------------------------------------------------------

router.post('/messages/shop/:shopId/send-statement', requirePermission('send_account_statements'), async (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(req.params.shopId, req.companyId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });
  const latestBalance = db.prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shop.id);
  const message = `مرحبًا ${shop.name}،\nكشف حسابكم الحالي:\nالرصيد: ${latestBalance ? Math.round(latestBalance.balance).toLocaleString('ar') : 0} $\nبتاريخ: ${latestBalance?.report_date ?? '—'}`;
  const sent = await sendToCustomer(req.companyId, shop, message).catch(() => false);
  const row = logMessage(req.companyId, {
    shopId: shop.id,
    direction: 'out',
    toPhone: shop.phone,
    body: message,
    intent: 'account_statement',
    handledBy: 'employee',
    repliedBy: req.user,
  });
  res.status(201).json({ ...row, sent });
});

// ---------------------------------------------------------------------
// Company toggle: direct ordering via the bot's free-text handling.
// ---------------------------------------------------------------------

router.get('/settings', requirePermission('manage_settings'), (req, res) => {
  res.json({ botDirectOrderEnabled: getSetting(req.companyId, 'bot_direct_order_enabled', '0') === '1' });
});

router.put('/settings', requirePermission('manage_settings'), (req, res) => {
  const { botDirectOrderEnabled } = req.body || {};
  db.prepare(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'bot_direct_order_enabled', ?) ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`
  ).run(req.companyId, botDirectOrderEnabled ? '1' : '0');
  res.status(204).end();
});

module.exports = router;
