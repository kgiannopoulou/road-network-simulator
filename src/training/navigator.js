import { m } from '../car/units.js';
import { pick } from '../math/random.js';
import { Point } from '../primitives/point.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { wrapAngle } from '../sensors/noise.js';

/**
 * Follows a car along a planned route path (lane 0 = the right-hand lane of
 * each road) and works out:
 *
 *   s            progress along the route (world units)
 *   lateral      signed offset from the right-hand lane centre (+ = right)
 *   laneError    distance to the nearest centre of a lane going our way
 *   outside      true when the car is not in any lane going our way
 *   bearing      angle from the heading to the route a little way ahead
 *
 * inputs() gives the brain [sin(bearing), lane offset / half a lane].
 */
export class Navigator {
  constructor(path, { stepStarts = [0], laneCounts = [1], laneWidth = 22, lookahead = m(12) } = {}) {
    this.path = path;
    this.stepStarts = stepStarts;
    this.laneCounts = laneCounts;
    this.laneWidth = laneWidth;
    this.lookahead = lookahead;
    this.s = 0;
    this.lateral = 0;
    this.laneError = 0;
    this.laneOffset = 0;
    this.outside = false;
    this.bearing = 0;
    this.distance = 0; // from the route line
  }

  /** Build from route steps via RoutePlanner.buildPath. */
  static forRoute(planner, steps, options = {}) {
    const { path, stepStarts } = planner.buildPath(steps, 0);
    return new Navigator(path, {
      stepStarts,
      laneCounts: steps.map((s) => RoutePlanner.laneCount(s)),
      laneWidth: steps[0].road.laneWidth,
      ...options,
    });
  }

  get remaining() {
    return this.path.length - this.s;
  }

  lanesAt(s) {
    let i = 0;
    while (i + 1 < this.stepStarts.length && this.stepStarts[i + 1] <= s) i++;
    return this.laneCounts[i] ?? 1;
  }

  update(position, heading) {
    const near = this.path.project(position, this.s - m(5), this.s + m(30));
    const proj = near && near.distance < this.laneWidth * 3 ? near : this.path.project(position);
    this.s = proj.s;
    this.lateral = proj.lateral;
    this.distance = proj.distance;

    // Lanes going our way sit at lateral 0, −w, −2w … (further left).
    const w = this.laneWidth;
    const lanes = this.lanesAt(this.s);
    const position01 = -this.lateral / w; // 0 = right-hand lane centre, 1 = next lane left…
    const nearest = Math.min(lanes - 1, Math.max(0, Math.round(position01)));
    this.laneOffset = (nearest - position01) * w; // + = right of that lane's centre
    this.laneError = Math.abs(this.laneOffset);
    this.outside = position01 < -0.5 || position01 > lanes - 0.5;

    const target = this.path.pointAt(Math.min(this.s + this.lookahead, this.path.length));
    this.bearing = wrapAngle(target.subtract(position).angle() - heading);
    return this;
  }

  inputs() {
    return [Math.sin(this.bearing), Math.max(-1, Math.min(1, this.laneOffset / (this.laneWidth / 2)))];
  }
}

/**
 * Plan a random route on a road network starting from a car's pose: the road
 * under the car, in the direction it is facing, then `count` random steps.
 */
export function planRouteFrom(planner, roads, pose, rng, count = 12) {
  const at = new Point(pose.x, pose.y);
  let best = null;
  for (const road of roads) {
    const d = road.segment.distanceToPoint(at);
    if (best && d >= best.d) continue;
    const forward = road.segment.direction();
    const facing = Math.cos(pose.angle) * forward.x + Math.sin(pose.angle) * forward.y;
    const dir = facing >= 0 || road.backwardLanes === 0 ? 1 : -1;
    if (dir === 1 || road.backwardLanes > 0) best = { d, step: { road, dir } };
  }
  if (!best) return null;
  const start = planner.allSteps().find((s) => s.road === best.step.road && s.dir === best.step.dir) ?? pick(rng, planner.allSteps());
  return planner.extend([start], count, rng);
}
