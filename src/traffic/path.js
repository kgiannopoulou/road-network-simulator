import { Point } from '../primitives/point.js';

/**
 * A polyline parameterised by arc length `s`. Traffic vehicles follow one of
 * these: their progress is a single number, and look-ahead, curvature and
 * "is that car in my lane?" checks all become 1D questions along `s`.
 */
export class Path {
  constructor(points) {
    this.points = [];
    for (const p of points) {
      const last = this.points[this.points.length - 1];
      if (!last || last.distanceTo(p) > 1e-3) this.points.push(p);
    }
    this.cumulative = [0];
    for (let i = 1; i < this.points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + this.points[i - 1].distanceTo(this.points[i]));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
    this.curvature = this.#computeCurvature();
  }

  /** Index i of the piece [points[i], points[i+1]] containing `s`. */
  indexAt(s) {
    const c = this.cumulative;
    if (s <= 0) return 0;
    if (s >= this.length) return Math.max(0, c.length - 2);
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pointAt(s) {
    if (this.points.length === 1) return this.points[0];
    const i = this.indexAt(s);
    const a = this.points[i];
    const b = this.points[i + 1];
    const span = this.cumulative[i + 1] - this.cumulative[i];
    const t = span === 0 ? 0 : (Math.min(Math.max(s, 0), this.length) - this.cumulative[i]) / span;
    return Point.lerp(a, b, t);
  }

  tangentAt(s) {
    if (this.points.length < 2) return new Point(1, 0);
    const i = this.indexAt(s);
    return this.points[i + 1].subtract(this.points[i]).normalize();
  }

  /** Unit vector to the right of travel. */
  normalAt(s) {
    return this.tangentAt(s).perpendicular();
  }

  /**
   * Closest point on the path to `point`, searching only pieces that overlap
   * [from, to]. Returns { s, distance, lateral } where `lateral` is signed:
   * positive to the right of travel.
   */
  project(point, from = 0, to = this.length) {
    let best = null;
    const first = this.indexAt(from);
    const last = this.indexAt(to);
    for (let i = first; i <= last; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      if (!b) break;
      const ab = b.subtract(a);
      const lenSq = ab.lengthSq();
      let t = lenSq === 0 ? 0 : point.subtract(a).dot(ab) / lenSq;
      t = Math.min(1, Math.max(0, t));
      const closest = a.add(ab.scale(t));
      const distance = closest.distanceTo(point);
      if (!best || distance < best.distance) {
        const s = this.cumulative[i] + t * Math.sqrt(lenSq);
        const lateral = ab.cross(point.subtract(a)) >= 0 ? distance : -distance;
        best = { s, distance, lateral };
      }
    }
    return best;
  }

  /** Signed curvature at `s` (positive = turning right), interpolated between vertices. */
  curvatureAt(s) {
    const i = this.indexAt(s);
    const span = this.cumulative[i + 1] - this.cumulative[i];
    const t = span > 0 ? (s - this.cumulative[i]) / span : 0;
    const a = this.signedCurvature[i] ?? 0;
    const b = this.signedCurvature[i + 1] ?? 0;
    return a + (b - a) * Math.min(1, Math.max(0, t));
  }

  /** Curvature (1 / radius) at each vertex, from the turn angle over the local length. */
  #computeCurvature() {
    this.signedCurvature = new Array(this.points.length).fill(0);
    for (let i = 1; i < this.points.length - 1; i++) {
      const d1 = this.points[i].subtract(this.points[i - 1]);
      const d2 = this.points[i + 1].subtract(this.points[i]);
      const turn = Math.atan2(d1.cross(d2), d1.dot(d2));
      const span = (d1.length() + d2.length()) / 2;
      this.signedCurvature[i] = span > 0 ? turn / span : 0;
    }
    return this.signedCurvature.map(Math.abs);
  }

  draw(ctx, { color = 'rgba(120, 200, 255, 0.6)', width = 1.5, dash = [] } = {}) {
    if (this.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
