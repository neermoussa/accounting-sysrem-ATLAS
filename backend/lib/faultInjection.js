// backend/lib/faultInjection.js
//
// Test-only failure injection. Code calls checkpoint('name') between two
// writes that must commit together; a test arms that name and asserts that
// nothing persisted. Outside NODE_ENV=test this is a no-op and cannot be
// armed, so it can never fire in production.

const armed = new Set();
const enabled = () => process.env.NODE_ENV === 'test';

function arm(name) {
  if (!enabled()) throw new Error('fault injection is only available when NODE_ENV=test');
  armed.add(name);
}

function disarmAll() {
  armed.clear();
}

function checkpoint(name) {
  if (enabled() && armed.has(name)) {
    armed.delete(name);
    const err = new Error(`fault_injected:${name}`);
    err.faultInjected = true;
    throw err;
  }
}

module.exports = { arm, disarmAll, checkpoint };
