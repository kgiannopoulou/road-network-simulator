import { Point } from '../primitives/point.js';

/**
 * Separating Axis Theorem for convex shapes given as point lists. A list of
 * two points is a line segment (a road border).
 *
 * Returns null when the shapes don't overlap, otherwise the minimum
 * translation vector: `normal` (unit) and `depth` such that moving A by
 * normal × depth separates it from B.
 */
export function satCollision(a, b) {
  let depth = Infinity;
  let normal = null;

  for (const shape of [a, b]) {
    const edges = shape.length === 2 ? 1 : shape.length;
    for (let i = 0; i < edges; i++) {
      const p = shape[i];
      const q = shape[(i + 1) % shape.length];
      const axis = new Point(p.y - q.y, q.x - p.x).normalize();
      if (axis.x === 0 && axis.y === 0) continue;

      const [minA, maxA] = project(a, axis);
      const [minB, maxB] = project(b, axis);
      const pushPositive = maxB - minA; // move A along +axis by this much
      const pushNegative = maxA - minB; // or along −axis by this much
      if (pushPositive <= 0 || pushNegative <= 0) return null; // separating axis found

      if (pushPositive < depth) {
        depth = pushPositive;
        normal = axis;
      }
      if (pushNegative < depth) {
        depth = pushNegative;
        normal = axis.scale(-1);
      }
    }
  }
  return normal ? { normal, depth } : null;
}

function project(points, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}
