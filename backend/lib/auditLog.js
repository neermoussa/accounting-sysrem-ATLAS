const db = require('../db/init');

// `before`/`after` are plain objects (or null) — stored as JSON snapshots so
// the activity log can show exactly what changed without needing a typed
// column per entity kind.
function logAudit({ companyId, actor, action, entityType, entityId, shopId, before, after }) {
  db.prepare(
    `INSERT INTO audit_log (company_id, actor_id, actor_name, action, entity_type, entity_id, shop_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    companyId ?? null,
    actor?.id ?? null,
    actor?.name ?? null,
    action,
    entityType,
    entityId ?? null,
    shopId ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null
  );
}

module.exports = { logAudit };
