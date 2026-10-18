// backend/db/migrations/0029_analytics_facts.js
//
// Prompt 12a: fact tables, fact_queue / fact_state and the change-capture
// triggers (db/factSchema.js). Existing companies get one 'rebuild' queue
// item so their history is loaded by the first refresh (lib/analytics/
// facts.js) — the migration itself writes no fact rows.

const { applyFactSchema } = require('../factSchema');

module.exports.up = function up(db) {
  applyFactSchema(db);
  for (const { company_id: cid } of db.prepare('SELECT DISTINCT company_id FROM journal_entries').all()) {
    if (!db.prepare("SELECT 1 FROM fact_queue WHERE company_id = ? AND fact_group = 'rebuild'").get(cid)) {
      db.prepare("INSERT INTO fact_queue (company_id, fact_group, source_key) VALUES (?, 'rebuild', 'all')").run(cid);
    }
  }
};
