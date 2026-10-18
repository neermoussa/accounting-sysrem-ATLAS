// Shared rep-visibility guard for any endpoint that accepts a `repId` (or
// equivalent) parameter to select whose route/schedule/call-log data to
// return — used by routes/dayplan.js and routes/waves.js.
//
// `manage_waves` ("إدارة اللفات وخطة المندوبين") is reused as the
// manager-level permission here rather than inventing a new one: its own
// catalog label already explicitly covers reps' schedules/plans, not just
// the Waves feature narrowly, and it's already the permission gating every
// write action across both of these route files.
const MANAGE_REPS_PERMISSION = 'manage_waves';

// Resolves which rep's data a request may see.
//   - A holder of MANAGE_REPS_PERMISSION gets exactly what they asked for
//     (including no repId at all, where that means "whole company" to the
//     caller — unchanged from before this guard existed).
//   - Anyone else (a plain rep) may only ever see their own id: asking for
//     a different rep's id is rejected outright, and asking for none at all
//     is resolved to their own id rather than silently falling through to
//     a company-wide result.
// Returns { ok: true, repId } or { ok: false }.
function resolveRepScope(req, requestedRepId) {
  if (req.user.permissions.includes(MANAGE_REPS_PERMISSION)) {
    return { ok: true, repId: requestedRepId ?? null };
  }
  if (requestedRepId != null && Number(requestedRepId) !== req.user.id) {
    return { ok: false };
  }
  return { ok: true, repId: req.user.id };
}

// ---------------------------------------------------------------------
// Generalized versions of the same pattern, for call sites where the
// "elevated/supervisor" signal is NOT manage_waves — e.g. Orders
// (approve_orders / manage_settings) and Collections (confirm_collections).
// resolveRepScope()/MANAGE_REPS_PERMISSION above are left completely
// unchanged so day-plan/waves/visit-recording keep behaving exactly as
// before.
// ---------------------------------------------------------------------

function hasAnyPermission(req, permissions) {
  return permissions.some((p) => req.user.permissions.includes(p));
}

// List-style scoping: same semantics as resolveRepScope() above (a
// requested repId different from the caller's own id is rejected outright
// for a non-elevated caller; no repId requested resolves to "my own"), but
// with a caller-supplied set of permissions counting as "elevated" instead
// of the hardcoded manage_waves.
// Returns { ok: true, repId } or { ok: false }.
function resolveScopeWithElevation(req, requestedRepId, elevatedPermissions) {
  if (hasAnyPermission(req, elevatedPermissions)) {
    return { ok: true, repId: requestedRepId ?? null };
  }
  if (requestedRepId != null && Number(requestedRepId) !== req.user.id) {
    return { ok: false };
  }
  return { ok: true, repId: req.user.id };
}

// Detail/action-style ownership check for a single already-fetched record
// (e.g. an order or a collection). Unlike resolveScopeWithElevation()/
// resolveRepScope() above — where "no repId requested" means "give me my
// own" — a record whose owning rep_id is NULL (e.g. an office-entered
// order with no rep assigned) is intentionally NOT treated as "mine": a
// null rep_id means "not assigned to any specific rep", which is closer to
// "office/company-wide" than "belongs to nobody", so only an elevated
// holder may access it. Returns a plain boolean.
function canAccessRepOwnedRecord(req, ownerRepId, elevatedPermissions) {
  if (hasAnyPermission(req, elevatedPermissions)) return true;
  return ownerRepId != null && Number(ownerRepId) === req.user.id;
}

// Elevated-signal permission sets for the two call sites this was added
// for, kept alongside the helpers so every route file reuses the same
// constant instead of re-typing the permission list.
const ORDER_ELEVATED_PERMISSIONS = ['approve_orders', 'manage_settings'];
const COLLECTIONS_ELEVATED_PERMISSIONS = ['confirm_collections'];
const RETURNS_ELEVATED_PERMISSIONS = ['approve_returns'];

module.exports = {
  resolveRepScope,
  MANAGE_REPS_PERMISSION,
  resolveScopeWithElevation,
  canAccessRepOwnedRecord,
  ORDER_ELEVATED_PERMISSIONS,
  COLLECTIONS_ELEVATED_PERMISSIONS,
  RETURNS_ELEVATED_PERMISSIONS,
};
