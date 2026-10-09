import { m } from '../car/units.js';
import { SpatialHash } from '../collision/spatialHash.js';

/**
 * Fitness helper: how much *different* road a car has driven on.
 *
 * Every road's skeleton is cut into bins (2 m by default). A car's position
 * maps to a bin of the road under it; fitness counts distinct bins. Driving
 * in circles or wiggling on the spot earns nothing new, while following the
 * road earns ~1 bin per 2 m. That rewards road following on any network
 * without needing a hand-made track or checkpoints.
 */
export class RoadCoverage {
  constructor(roads, { binSize = m(2) } = {}) {
    this.binSize = binSize;
    this.roads = roads;
    this.hash = new SpatialHash(m(20));
    roads.forEach((road, index) => this.hash.insert({ road, index }, road.poly.box));
  }

  /** Bin key under `point` ("road:bin"), or null when off every road. */
  locate(point) {
    const box = { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
    let best = null;
    let bestDist = Infinity;
    for (const { road, index } of this.hash.query(box)) {
      if (!road.poly.containsPoint(point)) continue;
      const seg = road.segment;
      const { offset } = seg.projectPoint(point);
      const t = Math.min(1, Math.max(0, offset));
      const d = seg.pointAt(t).distanceTo(point);
      if (d < bestDist) {
        bestDist = d;
        best = `${index}:${Math.floor((t * seg.length()) / this.binSize)}`;
      }
    }
    return best;
  }

  /** A tracker for one car. `visit()` returns true when the bin is new. */
  tracker() {
    const seen = new Set();
    const binMetres = this.binSize / m(1);
    return {
      seen,
      visit: (point) => {
        const key = this.locate(point);
        if (key === null || seen.has(key)) return false;
        seen.add(key);
        return true;
      },
      get metres() {
        return seen.size * binMetres;
      },
    };
  }
}
