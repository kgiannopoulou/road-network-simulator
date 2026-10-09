import { fromKmh } from '../car/units.js';
import { Envelope } from '../primitives/envelope.js';
import { defaultSpeedLimit, ROAD_TYPES } from './roadTypes.js';

/**
 * Geometry derived from one graph edge: its width, surface envelope and lane
 * layout. Traffic drives on the right, so lanes travelling p1→p2 ("forward")
 * sit on the right-hand side of the skeleton and "backward" lanes on the left.
 *
 * Lateral offsets are measured from the skeleton, positive to the right of
 * p1→p2, and lanes are indexed from the left edge (index 0) to the right.
 *
 *     left edge  ─────────────────────────   offset −width/2
 *        lane 0   ←  backward
 *                ═════════════════════════   centre line (two-way only)
 *        lane 1   →  forward
 *     right edge ─────────────────────────   offset +width/2
 */
export class Road {
  constructor(segment, { laneWidth = 22, roundness = 12 } = {}) {
    this.segment = segment;
    this.oneWay = segment.oneWay;
    this.laneCount = Math.max(this.oneWay ? 1 : 2, Math.round(segment.lanes) || 0);
    this.laneWidth = laneWidth;
    this.width = this.laneCount * laneWidth;
    this.type = ROAD_TYPES[segment.type] ? segment.type : 'street';
    this.speedLimitKmh = segment.speedLimit || defaultSpeedLimit(this.type, this.laneCount);
    this.speedLimit = fromKmh(this.speedLimitKmh); // world units / s
    this.envelope = new Envelope(segment, this.width, roundness);

    // Filled in by RoadNetwork once neighbours are known.
    this.markings = [];
    this.arrows = [];
  }

  get poly() {
    return this.envelope.poly;
  }

  get forwardLanes() {
    return this.oneWay ? this.laneCount : Math.ceil(this.laneCount / 2);
  }

  get backwardLanes() {
    return this.laneCount - this.forwardLanes;
  }

  laneCenterOffset(index) {
    return -this.width / 2 + (index + 0.5) * this.laneWidth;
  }

  /** Every lane with its lateral offset and travel direction (+1 = p1→p2). */
  lanes() {
    return Array.from({ length: this.laneCount }, (_, index) => ({
      index,
      offset: this.laneCenterOffset(index),
      direction: index < this.backwardLanes ? -1 : 1,
    }));
  }

  /**
   * Inner lane boundaries (the outer edges are the road borders). The boundary
   * that separates opposite directions is the centre line; the rest are
   * dashed lane lines between lanes going the same way.
   */
  boundaries() {
    const result = [];
    for (let k = 1; k < this.laneCount; k++) {
      const type = !this.oneWay && k === this.backwardLanes ? 'center' : 'lane';
      result.push({ offset: -this.width / 2 + k * this.laneWidth, type });
    }
    return result;
  }
}
