const express = require('express');
const db = require('../db/init');

const router = express.Router();

// Unauthenticated on purpose — this is the page a customer reaches by
// scanning their own shop's QR code / clicking their own link. The token
// is an unguessable 32-hex-char random value (see shops.public_token), so
// knowing it is treated as proof of being that shop, the same trust model
// as any other "secret link" feature. Only a small, safe read-only profile
// is exposed — never balances, order history, or internal notes.
router.get('/shops/:token', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE public_token = ? AND active = 1').get(req.params.token);
  if (!shop) return res.status(404).json({ error: 'not_found' });
  res.json({
    name: shop.name,
    address: shop.address,
    working_hours: shop.working_hours,
    business_type: shop.business_type,
  });
});

// A lightweight "send a request" form — recorded as a reminder-type note on
// the shop plus a notification for the company, rather than a full order
// (no pricing/authorization happens over this public, unauthenticated
// channel).
router.post('/shops/:token/request', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE public_token = ? AND active = 1').get(req.params.token);
  if (!shop) return res.status(404).json({ error: 'not_found' });
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'message_required' });
  db.prepare(
    `INSERT INTO shop_notes (company_id, shop_id, type, body, author_name) VALUES (?, ?, 'reminder', ?, ?)`
  ).run(shop.company_id, shop.id, `طلب من العميل عبر الرابط العام: ${message}`, shop.name);
  db.prepare(
    `INSERT INTO notifications (company_id, type, message_ar, message_en, link_path, entity_type, entity_id)
     VALUES (?, 'customer_public_request', ?, ?, ?, 'shop', ?)`
  ).run(
    shop.company_id,
    `طلب جديد من محل ${shop.name} عبر الرابط العام`,
    `New request from ${shop.name} via the public link`,
    `/shops/${shop.id}`,
    shop.id
  );
  res.status(201).json({ ok: true });
});

module.exports = router;
