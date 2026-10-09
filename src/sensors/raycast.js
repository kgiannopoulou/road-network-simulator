import { getIntersection } from '../math/utils.js';
import { Point } from '../primitives/point.js';

/**
 * Casts rays against road borders and vehicles. `prepare()` gathers the
 * geometry within range once (spatial hash for borders, a distance check for
 * cars); `cast()` can then be called hundreds of times for a LiDAR sweep.
 */
export class RayCaster {
  constructor(world) {
    this.world = world;
    this.segments = [];
    this.cars = [];
  }

  prepare(origin, range, cars = [], exclude = null) {
    const box = { minX: origin.x - range, minY: origin.y - range, maxX: origin.x + range, maxY: origin.y + range };
    this.segments = this.world.bordersNear(box);
    this.cars = cars
      .filter((c) => c !== exclude && c.position.distanceTo(origin) < range + c.radius)
      .map((car) => ({ car, segments: car.polygon().segments }));
    return this;
  }

  /** Nearest hit along a ray: { distance, point, kind: 'road' | 'car', car } or null. */
  cast(origin, angle, range) {
    const end = new Point(origin.x + Math.cos(angle) * range, origin.y + Math.sin(angle) * range);
    let best = Infinity;
    let kind = null;
    let car = null;
    for (const seg of this.segments) {
      const hit = getIntersection(origin, end, seg.p1, seg.p2);
      if (hit && hit.offset < best) {
        best = hit.offset;
        kind = 'road';
        car = null;
      }
    }
    for (const shape of this.cars) {
      for (const seg of shape.segments) {
        const hit = getIntersection(origin, end, seg.p1, seg.p2);
        if (hit && hit.offset < best) {
          best = hit.offset;
          kind = 'car';
          car = shape.car;
        }
      }
    }
    if (!kind) return null;
    return { distance: best * range, point: Point.lerp(origin, end, best), kind, car };
  }
}
