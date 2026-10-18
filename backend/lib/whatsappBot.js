const db = require('../db/init');
const { createNotification } = require('./notify');
const { findShopByPhone } = require('./shopLookup');
const { normalizePhone } = require('./phone');
const { getSetting } = require('./orderLifecycle');

// ---------------------------------------------------------------------
// Logging: every inbound/outbound message goes through here regardless of
// how it's handled — this is the independent, permission-gated
// "secondary log" the spec requires (view_whatsapp_log), separate from
// whatsapp_orders which only ever holds order-shaped messages.
// ---------------------------------------------------------------------

function logMessage(companyId, { shopId, direction, fromPhone, toPhone, body, intent, relatedEntityType, relatedEntityId, handledBy, repliedBy }) {
  const info = db
    .prepare(
      `INSERT INTO whatsapp_messages
        (company_id, shop_id, direction, from_phone, to_phone, body, intent, related_entity_type, related_entity_id, handled_by, replied_by_id, replied_by_name, replied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      companyId,
      shopId ?? null,
      direction,
      fromPhone || null,
      toPhone || null,
      body,
      intent || null,
      relatedEntityType || null,
      relatedEntityId ?? null,
      handledBy || null,
      repliedBy?.id ?? null,
      repliedBy?.name ?? null,
      handledBy ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null
    );
  return db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(info.lastInsertRowid);
}

// A reply on ANY message in this shop's thread counts as "answered" for the
// purposes of clearing outstanding alerts — mirrors how a human reading a
// conversation doesn't care which exact message they're replying to.
function resolveOpenAlertsForShop(companyId, shopId, fromPhone) {
  const rows = shopId
    ? db.prepare("SELECT * FROM whatsapp_message_alerts WHERE company_id = ? AND shop_id = ? AND status = 'open'").all(companyId, shopId)
    : db.prepare("SELECT * FROM whatsapp_message_alerts WHERE company_id = ? AND from_phone = ? AND status = 'open'").all(companyId, fromPhone);
  for (const alert of rows) {
    db.prepare("UPDATE whatsapp_message_alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(alert.id);
  }
}

function raiseUnrecognizedAlert(companyId, message, shop, fromPhone) {
  const info = db
    .prepare(
      `INSERT INTO whatsapp_message_alerts (company_id, message_id, shop_id, from_phone, reason) VALUES (?, ?, ?, ?, 'unrecognized')`
    )
    .run(companyId, message.id, shop?.id ?? null, fromPhone);
  createNotification({
    companyId,
    type: 'whatsapp_message_unclear',
    message_ar: `رسالة واتساب غير مفهومة من ${shop ? shop.name : fromPhone} — بحاجة رد يدوي فورًا.`,
    message_en: `Unclear WhatsApp message from ${shop ? shop.name : fromPhone} — needs an immediate manual reply.`,
    link_path: shop ? `/shops/${shop.id}` : null,
    entity_type: 'whatsapp_message_alert',
    entity_id: info.lastInsertRowid,
  });
  return db.prepare('SELECT * FROM whatsapp_message_alerts WHERE id = ?').get(info.lastInsertRowid);
}

// Escalation for a message that's been sitting unanswered for over an hour —
// called from the periodic sweep, never inline on receipt. Idempotent: only
// ever raises one 'unanswered_1h' alert per message.
function sweepUnansweredMessages() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const stale = db
    .prepare(
      `SELECT m.* FROM whatsapp_messages m
       WHERE m.direction = 'in' AND m.handled_by IS NULL AND m.created_at <= ?
       AND NOT EXISTS (SELECT 1 FROM whatsapp_message_alerts a WHERE a.message_id = m.id AND a.reason = 'unanswered_1h')`
    )
    .all(cutoff);
  for (const m of stale) {
    const shop = m.shop_id ? db.prepare('SELECT * FROM shops WHERE id = ?').get(m.shop_id) : null;
    const info = db
      .prepare(`INSERT INTO whatsapp_message_alerts (company_id, message_id, shop_id, from_phone, reason) VALUES (?, ?, ?, ?, 'unanswered_1h')`)
      .run(m.company_id, m.id, m.shop_id, m.from_phone);
    createNotification({
      companyId: m.company_id,
      type: 'whatsapp_message_unanswered',
      message_ar: `رسالة واتساب من ${shop ? shop.name : m.from_phone} بلا رد منذ أكثر من ساعة.`,
      message_en: `A WhatsApp message from ${shop ? shop.name : m.from_phone} has gone unanswered for over an hour.`,
      link_path: shop ? `/shops/${shop.id}` : null,
      entity_type: 'whatsapp_message_alert',
      entity_id: info.lastInsertRowid,
    });
  }
}

// ---------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------

function lastOrderSummary(companyId, shopId) {
  const order = db
    .prepare("SELECT * FROM orders WHERE company_id = ? AND shop_id = ? AND deleted_at IS NULL ORDER BY order_date DESC, id DESC LIMIT 1")
    .get(companyId, shopId);
  if (!order) return 'لا يوجد طلب سابق مسجل لكم بعد.';
  const items = JSON.parse(order.items_json || '[]');
  const lines = items.map((it) => `- ${it.product_name} × ${it.qty}`).join('\n');
  return `آخر طلب لكم بتاريخ ${order.order_date}:\n${lines || '—'}\nالإجمالي: ${Math.round(order.total_value).toLocaleString('ar')} $\n\n(هذا للمرجعية فقط، وسيقوم المندوب بمراجعته معكم قبل تكراره فعليًا)`;
}

function catalogText(companyId) {
  const products = db
    .prepare('SELECT name, unit, base_price FROM products WHERE company_id = ? AND active = 1 ORDER BY sort_order, name COLLATE NOCASE')
    .all(companyId);
  if (products.length === 0) return 'لا توجد قائمة منتجات متاحة حاليًا.';
  const lines = products.map((p) => `- ${p.name}${p.unit ? ` (${p.unit})` : ''}: ${p.base_price != null ? Math.round(p.base_price).toLocaleString('ar') + ' $' : 'السعر عند الطلب'}`);
  return `قائمة الأسعار الحالية:\n${lines.join('\n')}`;
}

const REPEAT_KEYWORDS = ['تكرار', 'كرر', 'نفس الطلب'];
const CATALOG_KEYWORDS = ['كتالوج', 'قائمة الاسعار', 'قائمة الأسعار', 'الاسعار', 'الأسعار'];
const COMPLAINT_KEYWORDS = ['شكوى', 'شكوي', 'مشكلة', 'خلل'];
const STATEMENT_KEYWORDS = ['كشف حساب', 'كشف الحساب'];
const ARRIVAL_KEYWORDS = ['موعد الوصول', 'متى يوصل', 'تاريخ الوصول', 'الشحنة'];
// Personal-data questions ("كم عليّ رصيد؟") — answered instantly from the
// system's own balance data, never from the general knowledge base, and
// only once the sender's phone has already resolved to a specific shop
// (findShopByPhone below) — i.e. that WhatsApp number is actually linked to
// that customer record. A distinct, narrower thing from "كشف حساب" above,
// which sends a full formatted statement and always needs an employee's
// explicit approval first.
const BALANCE_QUERY_KEYWORDS = ['رصيدي', 'رصيدنا', 'كم علي', 'كم عليّ', 'كم عليي', 'المبلغ المستحق', 'كم متبقي'];

function matchesAny(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

// Same as matchesAny, but the keyword has to stand on its own rather than
// appear inside a longer word. Needed for the short command words: plain
// substring matching made "الطلب مكرر بالغلط" ("the order was duplicated by
// mistake" — a complaint) match REPEAT's "كرر" and reply with the customer's
// last order instead. Only the Arabic letter range is treated as "inside a
// word", so an attached prefix/suffix still counts as a boundary the way a
// space does.
const ARABIC_LETTER = '\\u0621-\\u064A';
function matchesAnyWholeWord(text, keywords) {
  return keywords.some((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![${ARABIC_LETTER}])${escaped}(?![${ARABIC_LETTER}])`).test(text);
  });
}

// Plain substring matching against each entry's own keyword list — no ML/
// embeddings, consistent with the rest of this feature. Company-scoped:
// two companies never share an answer even if the question text is
// identical (each row carries its own company_id, queried here by it).
function findKnowledgeBaseAnswer(companyId, text) {
  const entries = db.prepare("SELECT * FROM knowledge_base WHERE company_id = ? AND status = 'active'").all(companyId);
  for (const entry of entries) {
    const keywords = entry.keywords.split(',').map((k) => k.trim()).filter(Boolean);
    if (keywords.some((k) => text.includes(k))) return entry;
  }
  return null;
}

// Reused for both a live whatsapp-web.js session and the manual test
// ingestion endpoint (routes/whatsappBot.js) — the actual sending happens
// through the injected `sendReply` so this stays testable without a real
// WhatsApp connection.
async function handleIncomingMessage(companyId, { fromPhone, body, sendReply }) {
  const normalized = normalizePhone(fromPhone);
  const shop = findShopByPhone(companyId, normalized);
  const text = (body || '').trim();

  const inbound = logMessage(companyId, {
    shopId: shop?.id,
    direction: 'in',
    fromPhone,
    body: text,
  });

  resolveOpenAlertsForShop(companyId, shop?.id, fromPhone);

  const reply = async (message, intent) => {
    logMessage(companyId, {
      shopId: shop?.id,
      direction: 'out',
      toPhone: fromPhone,
      body: message,
      intent,
      handledBy: 'bot',
    });
    if (sendReply) await sendReply(message);
  };

  // Complaints are matched before the command-style intents below: a
  // message like "عندي مشكلة في الأسعار" contains a catalog keyword too,
  // and used to be answered with the price list while the complaint was
  // silently dropped instead of becoming a ticket. A missed complaint is
  // the most costly misroute here, so it wins ties.
  if (matchesAny(text, COMPLAINT_KEYWORDS)) {
    const info = db
      .prepare('INSERT INTO whatsapp_tickets (company_id, shop_id, source_message_id, description) VALUES (?, ?, ?, ?)')
      .run(companyId, shop?.id ?? null, inbound.id, text);
    createNotification({
      companyId,
      type: 'whatsapp_ticket_created',
      message_ar: `شكوى جديدة من ${shop ? shop.name : fromPhone}: ${text.slice(0, 80)}`,
      message_en: `New complaint from ${shop ? shop.name : fromPhone}: ${text.slice(0, 80)}`,
      link_path: shop ? `/shops/${shop.id}` : null,
      entity_type: 'whatsapp_ticket',
      entity_id: info.lastInsertRowid,
    });
    await reply('تم تسجيل شكواكم وسيتم التواصل معكم قريبًا. شكرًا لتنبيهنا.', 'complaint');
    db.prepare("UPDATE whatsapp_messages SET intent = 'complaint', handled_by = 'bot', related_entity_type = 'whatsapp_ticket', related_entity_id = ? WHERE id = ?").run(
      info.lastInsertRowid,
      inbound.id
    );
    return { intent: 'complaint', message: inbound, ticketId: info.lastInsertRowid };
  }

  if (matchesAnyWholeWord(text, REPEAT_KEYWORDS)) {
    if (!shop) {
      await reply('لم نتمكن من التعرف على رقمكم كعميل مسجل — سيتواصل معكم أحد الموظفين.', 'repeat_last_order_unknown_shop');
      raiseUnrecognizedAlert(companyId, inbound, shop, fromPhone);
      return { intent: 'repeat_last_order_unknown_shop', message: inbound };
    }
    const summary = lastOrderSummary(companyId, shop.id);
    await reply(summary, 'repeat_last_order');
    db.prepare("UPDATE whatsapp_messages SET intent = 'repeat_last_order', handled_by = 'bot' WHERE id = ?").run(inbound.id);
    return { intent: 'repeat_last_order', message: inbound };
  }

  if (matchesAny(text, CATALOG_KEYWORDS)) {
    await reply(catalogText(companyId), 'catalog');
    db.prepare("UPDATE whatsapp_messages SET intent = 'catalog', handled_by = 'bot' WHERE id = ?").run(inbound.id);
    return { intent: 'catalog', message: inbound };
  }


  if (matchesAny(text, ARRIVAL_KEYWORDS)) {
    if (shop) {
      const pending = db
        .prepare(
          "SELECT * FROM orders WHERE company_id = ? AND shop_id = ? AND deleted_at IS NULL AND status IN ('approved','processing','out_for_delivery') ORDER BY order_date DESC LIMIT 1"
        )
        .get(companyId, shop.id);
      const message = pending
        ? `طلبكم بتاريخ ${pending.order_date} حاليًا بحالة: ${pending.status === 'out_for_delivery' ? 'في الطريق للتسليم' : pending.status === 'processing' ? 'قيد التجهيز' : 'معتمد وبانتظار التجهيز'}.`
        : 'لا يوجد لديكم طلب قيد التجهيز أو التسليم حاليًا.';
      await reply(message, 'arrival_inquiry');
      db.prepare("UPDATE whatsapp_messages SET intent = 'arrival_inquiry', handled_by = 'bot' WHERE id = ?").run(inbound.id);
      return { intent: 'arrival_inquiry', message: inbound };
    }
  }

  if (matchesAny(text, BALANCE_QUERY_KEYWORDS)) {
    if (!shop) {
      // The whole point of this branch is "this WhatsApp number is
      // verified as belonging to a specific shop" — an unresolved phone
      // never gets a balance answer, no matter how the question is
      // phrased. Falls straight to the unrecognized-alert path.
      raiseUnrecognizedAlert(companyId, inbound, shop, fromPhone);
      return { intent: 'unrecognized', message: inbound };
    }
    const latest = db.prepare('SELECT * FROM balances WHERE shop_id = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(shop.id);
    const message = latest
      ? `رصيدكم الحالي: ${Math.round(latest.balance).toLocaleString('ar')} $ (بتاريخ ${latest.report_date})`
      : 'لا يوجد رصيد مسجل لديكم حاليًا.';
    await reply(message, 'balance_query');
    db.prepare("UPDATE whatsapp_messages SET intent = 'balance_query', handled_by = 'bot' WHERE id = ?").run(inbound.id);
    return { intent: 'balance_query', message: inbound };
  }

  if (matchesAny(text, STATEMENT_KEYWORDS)) {
    // Never auto-sent — only flags for an authorized employee to explicitly
    // trigger via routes/whatsappBot.js's send-statement endpoint.
    await reply('تم استلام طلبكم لكشف الحساب، وسيتم إرساله لكم بعد اعتماد أحد الموظفين المخولين.', 'statement_request');
    db.prepare("UPDATE whatsapp_messages SET intent = 'statement_request' WHERE id = ?").run(inbound.id);
    createNotification({
      companyId,
      type: 'whatsapp_statement_requested',
      message_ar: `${shop ? shop.name : fromPhone} طلب كشف حساب عبر واتساب — بانتظار اعتماد الإرسال.`,
      message_en: `${shop ? shop.name : fromPhone} requested an account statement via WhatsApp — awaiting approval to send.`,
      link_path: shop ? `/shops/${shop.id}` : null,
      entity_type: 'whatsapp_message',
      entity_id: inbound.id,
    });
    return { intent: 'statement_request', message: inbound };
  }

  // Company FAQ (fixed facts — working hours, delivery areas, minimum order,
  // etc.) — Platform-Admin-approved entries only (see lib/permissions.js's
  // suggest_kb_entries and routes/platformAdmin.js's kb_submissions
  // approval). Never used for order/inventory/debt/schedule data, which
  // always comes live from the system's own tables (handled above/below).
  const kbEntry = findKnowledgeBaseAnswer(companyId, text);
  if (kbEntry) {
    await reply(kbEntry.answer, 'kb_answer');
    db.prepare(
      "UPDATE whatsapp_messages SET intent = 'kb_answer', handled_by = 'bot', related_entity_type = 'knowledge_base', related_entity_id = ? WHERE id = ?"
    ).run(kbEntry.id, inbound.id);
    return { intent: 'kb_answer', message: inbound, knowledgeBaseId: kbEntry.id };
  }

  // Free text: either a candidate order (existing whatsapp_orders flow —
  // reused as-is, not duplicated) if the company allows direct bot
  // ordering, or — when that's off, or the sender isn't a known shop — an
  // unrecognized message that must never be guessed at.
  const directOrderEnabled = getSetting(companyId, 'bot_direct_order_enabled', '0') === '1';
  if (directOrderEnabled && shop) {
    const info = db
      .prepare(
        `INSERT INTO whatsapp_orders (company_id, shop_id, from_phone, raw_text, assigned_rep_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run(companyId, shop.id, fromPhone, text, shop.assigned_rep_id ?? null);
    createNotification({
      companyId,
      type: 'whatsapp_order_received',
      message_ar: `رسالة واتساب جديدة من ${shop.name} — بانتظار مراجعة المندوب.`,
      message_en: `New WhatsApp message from ${shop.name} — awaiting rep review.`,
      link_path: `/shops/${shop.id}`,
      entity_type: 'whatsapp_order',
      entity_id: info.lastInsertRowid,
    });
    db.prepare(
      "UPDATE whatsapp_messages SET intent = 'possible_order', related_entity_type = 'whatsapp_order', related_entity_id = ? WHERE id = ?"
    ).run(info.lastInsertRowid, inbound.id);
    return { intent: 'possible_order', message: inbound, whatsappOrderId: info.lastInsertRowid };
  }

  // Unclear / out of scope: never guess, never auto-reply — immediate alert
  // to every authorized WhatsApp user instead.
  raiseUnrecognizedAlert(companyId, inbound, shop, fromPhone);
  return { intent: 'unrecognized', message: inbound };
}

// ---------------------------------------------------------------------
// Visit reminders — the day-before text, sourced from tomorrow's wave
// points (lib/waves.js's data). Idempotent per shop/day via
// whatsapp_visit_reminders_sent.
// ---------------------------------------------------------------------

async function sweepVisitReminders() {
  const { sendToCustomer } = require('./whatsapp');
  const companyIds = db.prepare('SELECT id FROM companies').all().map((r) => r.id);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const companyId of companyIds) {
    const points = db
      .prepare(
        `SELECT DISTINCT wp.shop_id, wi.rep_id FROM wave_points wp
         JOIN wave_instances wi ON wi.id = wp.wave_instance_id
         WHERE wp.company_id = ? AND wi.plan_date = ? AND wp.removed_at IS NULL`
      )
      .all(companyId, tomorrow);

    for (const point of points) {
      const already = db
        .prepare('SELECT 1 FROM whatsapp_visit_reminders_sent WHERE shop_id = ? AND visit_date = ?')
        .get(point.shop_id, tomorrow);
      if (already) continue;

      const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND company_id = ?').get(point.shop_id, companyId);
      if (!shop) continue;

      const message = `مرحبًا ${shop.name}،\nنود تذكيركم بأن مندوبنا سيزوركم غدًا (${tomorrow}). لأي طلبات أو استفسارات يمكنكم الرد على هذه الرسالة.`;
      const sent = await sendToCustomer(companyId, shop, message).catch(() => false);
      logMessage(companyId, {
        shopId: shop.id,
        direction: 'out',
        toPhone: shop.phone,
        body: message,
        intent: 'visit_reminder',
        handledBy: 'bot',
      });
      if (!sent) {
        // Do not record this reminder as sent — leave it eligible for the
        // next sweep so a failed delivery (no live WhatsApp session,
        // customer opted out, etc.) gets retried instead of silently
        // never happening again.
        console.log(`[whatsappBot] visit reminder logged but not delivered (no live session) for shop ${shop.id}`);
        continue;
      }
      db.prepare('INSERT INTO whatsapp_visit_reminders_sent (company_id, shop_id, visit_date) VALUES (?, ?, ?)').run(
        companyId,
        shop.id,
        tomorrow
      );
    }
  }
}

module.exports = {
  logMessage,
  handleIncomingMessage,
  sweepUnansweredMessages,
  sweepVisitReminders,
  resolveOpenAlertsForShop,
  catalogText,
  lastOrderSummary,
  findKnowledgeBaseAnswer,
};
