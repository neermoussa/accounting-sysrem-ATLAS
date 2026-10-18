// backend/lib/analytics/alloc.js — exact largest-remainder split (no DB).

// total split over weights (|weights|), exact; sign of total kept.
function allocate(total, weights) {
  const w = weights.map((x) => Math.abs(x));
  const sum = w.reduce((t, x) => t + x, 0);
  if (!sum) return weights.map((_, i) => (i === 0 ? total : 0));
  const abs = Math.abs(total);
  const raw = w.map((x) => (abs * x) / sum);
  const out = raw.map(Math.floor);
  let rest = abs - out.reduce((t, x) => t + x, 0);
  raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, i]) => { if (rest > 0) { out[i] += 1; rest -= 1; } });
  return out.map((x) => (total < 0 ? -x : x));
}

module.exports = { allocate };
