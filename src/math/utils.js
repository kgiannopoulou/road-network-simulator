// Scalar helpers and low-level intersection maths shared by every geometry class.

export const EPSILON = 1e-9;

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function inverseLerp(a, b, value) {
  return a === b ? 0 : (value - a) / (b - a);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function degToRad(degrees) {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians) {
  return (radians * 180) / Math.PI;
}

export function nearlyEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

export function snap(value, step) {
  return Math.round(value / step) * step;
}

/**
 * Intersection of segment AB with segment CD.
 * Returns { x, y, offset, u } where `offset` is the parameter along AB and
 * `u` the parameter along CD (both in [0, 1]), or null if they don't touch.
 */
export function getIntersection(A, B, C, D) {
  const hit = getLineIntersection(A, B, C, D);
  if (hit && hit.offset >= 0 && hit.offset <= 1 && hit.u >= 0 && hit.u <= 1) return hit;
  return null;
}

/**
 * Intersection of the infinite lines through AB and CD.
 * Same return shape as getIntersection, but offsets may fall outside [0, 1].
 * Returns null for parallel lines.
 */
export function getLineIntersection(A, B, C, D) {
  const tTop = (D.x - C.x) * (A.y - C.y) - (D.y - C.y) * (A.x - C.x);
  const uTop = (C.y - A.y) * (A.x - B.x) - (C.x - A.x) * (A.y - B.y);
  const bottom = (D.y - C.y) * (B.x - A.x) - (D.x - C.x) * (B.y - A.y);
  if (Math.abs(bottom) <= EPSILON) return null;
  const t = tTop / bottom;
  return { x: lerp(A.x, B.x, t), y: lerp(A.y, B.y, t), offset: t, u: uTop / bottom };
}

/** Overlap test for { minX, minY, maxX, maxY } bounding boxes. */
export function boxesOverlap(a, b, margin = 0) {
  return (
    a.minX - margin <= b.maxX &&
    a.maxX + margin >= b.minX &&
    a.minY - margin <= b.maxY &&
    a.maxY + margin >= b.minY
  );
}
