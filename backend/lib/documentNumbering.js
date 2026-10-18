const db = require('../db/init');

function getConfig(companyId, documentType) {
  const row = db.prepare('SELECT * FROM document_number_sequences WHERE company_id = ? AND document_type = ?').get(companyId, documentType);
  if (row) return row;
  return { company_id: companyId, document_type: documentType, prefix: '', padding: 5, next_number: 1 };
}

function setConfig(companyId, documentType, { prefix, padding, nextNumber }) {
  const current = getConfig(companyId, documentType);
  db.prepare(
    `INSERT INTO document_number_sequences (company_id, document_type, prefix, padding, next_number) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(company_id, document_type) DO UPDATE SET prefix = excluded.prefix, padding = excluded.padding, next_number = excluded.next_number`
  ).run(companyId, documentType, prefix ?? current.prefix, padding ?? current.padding, nextNumber ?? current.next_number);
  return getConfig(companyId, documentType);
}

function format(config, number) {
  return `${config.prefix || ''}${String(number).padStart(config.padding, '0')}`;
}

// Atomically issues the next number and advances the counter — every call
// returns a distinct, ever-increasing number for that company+document type.
function issueNext(companyId, documentType) {
  const current = getConfig(companyId, documentType);
  db.prepare(
    `INSERT INTO document_number_sequences (company_id, document_type, prefix, padding, next_number) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(company_id, document_type) DO UPDATE SET next_number = next_number + 1`
  ).run(companyId, documentType, current.prefix, current.padding, current.next_number + 1);
  return format(current, current.next_number);
}

module.exports = { getConfig, setConfig, issueNext, format };
