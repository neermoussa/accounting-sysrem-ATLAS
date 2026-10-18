const express = require('express');
const db = require('../db/init');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(requirePermission('view_app'));

// Persisted log (see lib/notify.js for the single insertion point) rather
// than the old live-recomputed list — that's what makes read/unread state
// meaningful: a row exists to attach it to.
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE company_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.companyId);
  const items = rows.map((r) => ({ ...r, read: !!r.read_at }));
  const unreadCount = items.filter((i) => !i.read).length;
  res.json({ items, unreadCount });
});

router.post('/:id/read', (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND company_id = ? AND read_at IS NULL").run(
    req.params.id,
    req.companyId
  );
  res.json({ ok: true });
});

router.post('/mark-all-read', (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE company_id = ? AND read_at IS NULL").run(req.companyId);
  res.json({ ok: true });
});

module.exports = router;
