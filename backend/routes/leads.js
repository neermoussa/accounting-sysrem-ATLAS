const express = require('express');
const crypto = require('crypto');
const db = require('../db/init');
const { requirePermission } = require('../middleware/auth');
const { getGlobalSettings, enrichShop } = require('../lib/shopData');

const router = express.Router();
router.use(requirePermission('manage_leads'));

router.get('/', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM leads WHERE company_id = ? AND status = ? ORDER BY created_at DESC').all(req.companyId, status)
    : db.prepare('SELECT * FROM leads WHERE company_id = ? ORDER BY created_at DESC').all(req.companyId);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name, phone, address, region, notes, source, assigned_rep_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  const info = db
    .prepare(
      `INSERT INTO leads (company_id, name, phone, address, region, notes, source, assigned_rep_id, created_by_id, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, name, phone || null, address || null, region || null, notes || null, source || null, assigned_rep_id || null, req.user.id, req.user.name);
  res.status(201).json(db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!lead) return res.status(404).json({ error: 'lead_not_found' });
  const { name, phone, address, region, notes, source, status, assigned_rep_id } = req.body || {};
  db.prepare(
    `UPDATE leads SET name = ?, phone = ?, address = ?, region = ?, notes = ?, source = ?, status = ?, assigned_rep_id = ?, updated_at = datetime('now')
     WHERE id = ? AND company_id = ?`
  ).run(
    name ?? lead.name,
    phone ?? lead.phone,
    address ?? lead.address,
    region ?? lead.region,
    notes ?? lead.notes,
    source ?? lead.source,
    status ?? lead.status,
    assigned_rep_id ?? lead.assigned_rep_id,
    lead.id,
    req.companyId
  );
  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id));
});

router.delete('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!lead) return res.status(404).json({ error: 'lead_not_found' });
  db.prepare('DELETE FROM leads WHERE id = ? AND company_id = ?').run(lead.id, req.companyId);
  res.status(204).end();
});

// Converting a lead creates a real shop from its data and links back via
// converted_shop_id — the lead row itself stays (as history of provenance),
// it just moves to status='converted' instead of being deleted.
router.post('/:id/convert', requirePermission('manage_shops'), (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(req.params.id, req.companyId);
  if (!lead) return res.status(404).json({ error: 'lead_not_found' });
  if (lead.status === 'converted' && lead.converted_shop_id) {
    return res.status(409).json({ error: 'already_converted', shopId: lead.converted_shop_id });
  }
  const publicToken = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare(
      `INSERT INTO shops (company_id, name, phone, address, region, notes, assigned_rep_id, public_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.companyId, lead.name, lead.phone || null, lead.address || null, lead.region || null, lead.notes || null, lead.assigned_rep_id, publicToken);
  const shopId = info.lastInsertRowid;
  if (lead.phone) {
    db.prepare('INSERT INTO shop_phones (company_id, shop_id, phone, is_primary) VALUES (?, ?, ?, 1)').run(req.companyId, shopId, lead.phone);
  }
  db.prepare("UPDATE leads SET status = 'converted', converted_shop_id = ?, converted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(
    shopId,
    lead.id
  );
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
  res.status(201).json(enrichShop(shop, getGlobalSettings(req.companyId)));
});

module.exports = router;
