// @ts-check
// Stroke simplification for pen objects. Pointer events arrive at 60-240 Hz, so a few seconds of
// drawing is hundreds of points; nearly all of them are collinear at screen resolution. The client
// simplifies before committing (and before sending in-progress strokes as presence) so stored
// strokes stay far below LIMITS.penPoints and presence payloads stay small.
//
// Two passes: a cheap radial-distance filter drops points closer than `epsilon` to the last kept
// one, then Ramer-Douglas-Peucker (iterative, no recursion depth issues) removes points within
// `epsilon` of the chord. Endpoints are always kept. Epsilon is in the same units as the points,
// so a caller working in world coordinates passes screenPixels / zoom.

/**
 * @param {number[]} flat  [x0, y0, x1, y1, ...]
 * @param {number} epsilon
 * @returns {number[]}
 */
export function radialFilter(flat, epsilon) {
  const n = Math.floor(flat.length / 2);
  if (n <= 2) return flat.slice(0, n * 2);
  const out = [flat[0], flat[1]];
  const e2 = epsilon * epsilon;
  let lx = flat[0], ly = flat[1];
  for (let i = 1; i < n - 1; i++) {
    const x = flat[2 * i], y = flat[2 * i + 1];
    const dx = x - lx, dy = y - ly;
    if (dx * dx + dy * dy >= e2) {
      out.push(x, y);
      lx = x; ly = y;
    }
  }
  out.push(flat[2 * n - 2], flat[2 * n - 1]);
  return out;
}

/**
 * @param {number[]} flat
 * @param {number} epsilon
 * @returns {number[]}
 */
export function rdp(flat, epsilon) {
  const n = Math.floor(flat.length / 2);
  if (n <= 2) return flat.slice(0, n * 2);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const e2 = epsilon * epsilon;
  /** @type {number[]} */
  const stack = [0, n - 1];
  while (stack.length) {
    const last = /** @type {number} */ (stack.pop());
    const first = /** @type {number} */ (stack.pop());
    const ax = flat[2 * first], ay = flat[2 * first + 1];
    const bx = flat[2 * last], by = flat[2 * last + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, index = -1;
    for (let i = first + 1; i < last; i++) {
      const px = flat[2 * i], py = flat[2 * i + 1];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) { maxD = d2; index = i; }
    }
    if (index !== -1 && maxD > e2) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
  return out;
}

/**
 * Radial filter then RDP, then (if still above `maxPoints`) RDP again with a doubling epsilon
 * until it fits.
 * @param {number[]} flat
 * @param {number} epsilon
 * @param {number} [maxPoints]
 * @returns {number[]}
 */
export function simplifyStroke(flat, epsilon, maxPoints = Infinity) {
  let eps = Math.max(0, epsilon);
  let out = rdp(radialFilter(flat, eps), eps);
  for (let i = 0; i < 40 && out.length / 2 > maxPoints; i++) {
    eps = eps > 0 ? eps * 2 : 0.5;
    out = rdp(out, eps);
  }
  if (out.length / 2 > maxPoints) {
    // Pathological input (e.g. every point far apart): keep an evenly spaced subset.
    const n = out.length / 2, step = (n - 1) / (maxPoints - 1), sub = [];
    for (let i = 0; i < maxPoints; i++) {
      const j = Math.round(i * step);
      sub.push(out[2 * j], out[2 * j + 1]);
    }
    out = sub;
  }
  return out;
}
