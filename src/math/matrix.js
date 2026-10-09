import { Point } from '../primitives/point.js';

/**
 * 2D affine transform using the same layout as CanvasRenderingContext2D:
 *
 *   | a c e |      x' = a·x + c·y + e
 *   | b d f |      y' = b·x + d·y + f
 *   | 0 0 1 |
 *
 * Instances are immutable — every operation returns a new Matrix.
 */
export class Matrix {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  static identity() {
    return new Matrix();
  }

  static translation(tx, ty) {
    return new Matrix(1, 0, 0, 1, tx, ty);
  }

  static rotation(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Matrix(cos, sin, -sin, cos, 0, 0);
  }

  static scaling(sx, sy = sx) {
    return new Matrix(sx, 0, 0, sy, 0, 0);
  }

  /** this × m — `m` is applied first, then `this`. */
  multiply(m) {
    return new Matrix(
      this.a * m.a + this.c * m.b,
      this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e,
      this.b * m.e + this.d * m.f + this.f,
    );
  }

  translate(tx, ty) {
    return this.multiply(Matrix.translation(tx, ty));
  }

  rotate(angle) {
    return this.multiply(Matrix.rotation(angle));
  }

  /** Rotate around a pivot point instead of the origin. */
  rotateAround(angle, pivot) {
    return this.translate(pivot.x, pivot.y).rotate(angle).translate(-pivot.x, -pivot.y);
  }

  scale(sx, sy = sx) {
    return this.multiply(Matrix.scaling(sx, sy));
  }

  determinant() {
    return this.a * this.d - this.b * this.c;
  }

  invert() {
    const det = this.determinant();
    if (det === 0) throw new Error('Matrix is not invertible');
    return new Matrix(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    );
  }

  apply(point) {
    return new Point(
      this.a * point.x + this.c * point.y + this.e,
      this.b * point.x + this.d * point.y + this.f,
    );
  }

  applyAll(points) {
    return points.map((p) => this.apply(p));
  }

  /** Replace the context transform; `pixelRatio` maps CSS pixels to device pixels. */
  setOn(ctx, pixelRatio = 1) {
    const r = pixelRatio;
    ctx.setTransform(this.a * r, this.b * r, this.c * r, this.d * r, this.e * r, this.f * r);
  }
}
