import { clamp, getIntersection } from '../math/utils.js';
import { Point } from './point.js';

/**
 * A straight line between two points. In the road graph a Segment is an edge
 * and also carries the road attributes used by the generator: the lane count
 * and whether traffic flows one way (from p1 to p2).
 */
export class Segment {
  constructor(p1, p2, { lanes = 2, oneWay = false } = {}) {
    this.p1 = p1;
    this.p2 = p2;
    this.lanes = lanes;
    this.oneWay = oneWay;
  }

  get attributes() {
    return { lanes: this.lanes, oneWay: this.oneWay };
  }

  length() {
    return this.p1.distanceTo(this.p2);
  }

  vector() {
    return this.p2.subtract(this.p1);
  }

  direction() {
    return this.vector().normalize();
  }

  angle() {
    return this.vector().angle();
  }

  midpoint() {
    return Point.average(this.p1, this.p2);
  }

  pointAt(t) {
    return Point.lerp(this.p1, this.p2, t);
  }

  /** Undirected equality: A–B equals B–A. */
  equals(seg) {
    return this.includes(seg.p1) && this.includes(seg.p2);
  }

  includes(point) {
    return this.p1.equals(point) || this.p2.equals(point);
  }

  otherEnd(point) {
    return this.p1 === point ? this.p2 : this.p1;
  }

  /** Closest point on the infinite line, with its parameter t along p1→p2. */
  projectPoint(point) {
    const v = this.vector();
    const lenSq = v.lengthSq();
    if (lenSq === 0) return { point: this.p1.clone(), offset: 0 };
    const offset = point.subtract(this.p1).dot(v) / lenSq;
    return { point: this.pointAt(offset), offset };
  }

  /** Shortest distance from `point` to this finite segment. */
  distanceToPoint(point) {
    const { offset } = this.projectPoint(point);
    return this.pointAt(clamp(offset, 0, 1)).distanceTo(point);
  }

  intersection(seg) {
    return getIntersection(this.p1, this.p2, seg.p1, seg.p2);
  }

  /** Parallel copy shifted `distance` units to the right of travel (screen space). */
  offset(distance) {
    const shift = this.direction().perpendicular().scale(distance);
    return new Segment(this.p1.add(shift), this.p2.add(shift), this.attributes);
  }

  reverse() {
    const tmp = this.p1;
    this.p1 = this.p2;
    this.p2 = tmp;
    return this;
  }

  draw(ctx, { width = 2, color = '#e8e8e8', dash = [], cap = 'butt' } = {}) {
    ctx.beginPath();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.lineCap = cap;
    ctx.setLineDash(dash);
    ctx.moveTo(this.p1.x, this.p1.y);
    ctx.lineTo(this.p2.x, this.p2.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
