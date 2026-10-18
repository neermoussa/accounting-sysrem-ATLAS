// Tiny pub-sub so api.js (where fetch failures actually happen) and the
// banner component (which only needs to render) don't need to share a React
// tree — api.js has no component to hook state into.
let offline = false;
const listeners = new Set();

export function setOffline(value) {
  if (value === offline) return;
  offline = value;
  listeners.forEach((fn) => fn(offline));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isOffline() {
  return offline;
}
