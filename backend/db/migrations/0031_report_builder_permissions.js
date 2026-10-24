// backend/db/migrations/0031_report_builder_permissions.js
//
// Prompt 12b: the Report Builder's permissions (lib/permissions.js) —
// view_costs (cost data in the query engine: unit costs, margins, stock and
// production values, purchase prices), share_reports, schedule_reports,
// send_reports — granted to every manage_permissions holder (company
// owners), as earlier prompts did. Nobody else gains anything. New
// companies get them with ALL_PERMISSION_KEYS. Idempotent (INSERT OR IGNORE).

const PERMS = ['view_costs', 'share_reports', 'schedule_reports', 'send_reports'];
module.exports.PERMS = PERMS;
module.exports.up = function up(db) {
  const owners = db.prepare("SELECT user_id FROM user_permissions WHERE permission = 'manage_permissions'").all();
  const grant = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)');
  for (const o of owners) for (const p of PERMS) grant.run(o.user_id, p);
};
