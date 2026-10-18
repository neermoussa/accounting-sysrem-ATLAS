// Rejects impossible coordinates (e.g. lat 999) — not a business-policy
// region restriction, just the actual valid range for any point on Earth.
function isValidCoordPair(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Nearest-neighbor initial tour: `start` is {lat,lng} (the rep's base point
// for this leg — either the actual base, or wherever the previous priority
// group's route ended). `points` is an array of objects that each have .lat
// and .lng. Returns the same objects reordered, with no distance annotation
// yet — nearestNeighborRoute() below attaches that after 2-opt refinement.
function nearestNeighborOrder(points, start) {
  const remaining = [...points];
  const ordered = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }

  return ordered;
}

function totalRouteDistanceKm(orderedPoints, start) {
  let total = 0;
  let prev = start;
  for (const p of orderedPoints) {
    total += haversineKm(prev, p);
    prev = p;
  }
  return total;
}

// 2-opt local search over an existing tour: repeatedly finds two edges whose
// endpoints, if reconnected the other way (reversing the stretch of route
// between them), shorten the total distance — this is exactly what strips
// out the crossed-over/backtracking legs nearest-neighbor tends to leave
// behind, without the combinatorial blowup of solving TSP exactly. `start`
// is fixed (the rep's actual position, never reordered). Converges in a
// handful of passes for the route sizes this app deals with (well under 100
// stops/day), so no need for a smarter (and slower-to-implement) heuristic.
function twoOptImprove(orderedPoints, start, { maxPasses = 1000 } = {}) {
  if (orderedPoints.length < 4) return orderedPoints;
  let route = [...orderedPoints];
  let improved = true;
  let pass = 0;

  while (improved && pass < maxPasses) {
    improved = false;
    pass++;
    outer: for (let i = 0; i < route.length - 1; i++) {
      const a = i === 0 ? start : route[i - 1];
      const b = route[i];
      for (let j = i + 1; j < route.length; j++) {
        const c = route[j];
        const d = j + 1 < route.length ? route[j + 1] : null;
        const removedKm = haversineKm(a, b) + (d ? haversineKm(c, d) : 0);
        const addedKm = haversineKm(a, c) + (d ? haversineKm(b, d) : 0);
        if (addedKm < removedKm - 1e-9) {
          route = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
          improved = true;
          break outer; // route mutated — restart the scan from i=0 against the new order
        }
      }
    }
  }

  return route;
}

// Nearest-neighbor initial tour + 2-opt refinement, then attaches
// distanceFromPrevKm per stop the way callers (day-plan route list) expect.
// Same signature/return shape as the old nearest-neighbor-only version, so
// every caller (routes/dayplan.js) needed no changes to pick up the
// improvement.
function nearestNeighborRoute(points, start) {
  const initial = nearestNeighborOrder(points, start);
  const improvedOrder = twoOptImprove(initial, start);

  let current = start;
  return improvedOrder.map((p) => {
    const d = haversineKm(current, p);
    current = p;
    return { ...p, distanceFromPrevKm: Math.round(d * 10) / 10 };
  });
}

module.exports = {
  haversineKm,
  nearestNeighborRoute,
  nearestNeighborOrder,
  twoOptImprove,
  totalRouteDistanceKm,
  isValidCoordPair,
};
