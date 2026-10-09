import { lerp } from '../math/utils.js';

/**
 * A 2D point that doubles as a vector. Arithmetic methods return new
 * instances so points stored in the road graph are never changed by accident;
 * use `set()` when mutation is intended (e.g. dragging a node).
 */
export class Point {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static from({ x, y }) {
    return new Point(x, y);
  }

  static fromAngle(angle, length = 1) {
    return new Point(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static lerp(a, b, t) {
    return new Point(lerp(a.x, b.x, t), lerp(a.y, b.y, t));
  }

  static average(a, b) {
    return new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  clone() {
    return new Point(this.x, this.y);
  }

  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  equals(p, epsilon = 1e-6) {
    return Math.abs(this.x - p.x) <= epsilon && Math.abs(this.y - p.y) <= epsilon;
  }

  add(p) {
    return new Point(this.x + p.x, this.y + p.y);
  }

  subtract(p) {
    return new Point(this.x - p.x, this.y - p.y);
  }

  scale(s) {
    return new Point(this.x * s, this.y * s);
  }

  dot(p) {
    return this.x * p.x + this.y * p.y;
  }

  /** z-component of the 3D cross product; its sign tells which side `p` lies on. */
  cross(p) {
    return this.x * p.y - this.y * p.x;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const len = this.length();
    return len === 0 ? new Point(0, 0) : this.scale(1 / len);
  }

  /**
   * Vector rotated +90°. In screen space (y pointing down) this is the
   * right-hand side of the direction of travel.
   */
  perpendicular() {
    return new Point(-this.y, this.x);
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }

  distanceTo(p) {
    return Math.hypot(this.x - p.x, this.y - p.y);
  }

  distanceSqTo(p) {
    const dx = this.x - p.x;
    const dy = this.y - p.y;
    return dx * dx + dy * dy;
  }

  /** Move `offset` units in direction `angle`. */
  translate(angle, offset) {
    return new Point(this.x + Math.cos(angle) * offset, this.y + Math.sin(angle) * offset);
  }

  rotate(angle, origin = new Point(0, 0)) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = this.x - origin.x;
    const dy = this.y - origin.y;
    return new Point(origin.x + dx * cos - dy * sin, origin.y + dx * sin + dy * cos);
  }

  draw(ctx, { size = 18, color = '#e8e8e8', outline = false, fill = false } = {}) {
    const r = size / 2;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (outline) {
      ctx.beginPath();
      ctx.lineWidth = r * 0.25;
      ctx.strokeStyle = typeof outline === 'string' ? outline : '#ffd54a';
      ctx.arc(this.x, this.y, r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (fill) {
      ctx.beginPath();
      ctx.fillStyle = typeof fill === 'string' ? fill : '#ffd54a';
      ctx.arc(this.x, this.y, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
