import { Polygon } from './polygon.js';

/**
 * A capsule-shaped polygon around a skeleton segment: a rectangle of the given
 * width with half-circle caps of `roundness` steps at both ends. The rounded
 * caps make neighbouring road envelopes blend smoothly at shared nodes.
 */
export class Envelope {
  constructor(skeleton, width, roundness = 10) {
    this.skeleton = skeleton;
    this.width = width;
    this.poly = Envelope.generate(skeleton, width, roundness);
  }

  static generate(skeleton, width, roundness) {
    const { p1, p2 } = skeleton;
    const radius = width / 2;
    const alpha = p1.subtract(p2).angle(); // points out of the p1 cap, away from p2
    const start = alpha - Math.PI / 2;
    const end = alpha + Math.PI / 2;
    const step = Math.PI / Math.max(1, roundness);
    const eps = step / 2;

    const points = [];
    for (let a = start; a <= end + eps; a += step) points.push(p1.translate(a, radius));
    for (let a = start; a <= end + eps; a += step) points.push(p2.translate(Math.PI + a, radius));
    return new Polygon(points);
  }

  draw(ctx, options) {
    this.poly.draw(ctx, options);
  }
}
