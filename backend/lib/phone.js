// Local Syrian numbers get written three interchangeable ways for the exact
// same line — 0999111222 (local), +963999111222 (international),
// 00963999111222 (dial-out prefix) — so stripping to digits-only isn't
// enough to catch a duplicate; canonicalize the country code down to the
// local "0" form too.
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('00963')) digits = '0' + digits.slice(5);
  else if (digits.startsWith('963') && digits.length === 12) digits = '0' + digits.slice(3);
  return digits;
}

module.exports = { normalizePhone };
