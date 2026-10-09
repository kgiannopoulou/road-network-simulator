import { getLineIntersection } from '../math/utils.js';
import { pick } from '../math/random.js';
import { Point } from '../primitives/point.js';
import { m } from '../car/units.js';
import { Path } from './path.js';

/**
 * Plans routes over the road network and turns them into lane-accurate paths.
 *
 * A route is a list of steps { road, dir }: drive along `road` from p1 to p2
 * (dir = 1) or from p2 to p1 (dir = −1). One-way roads only allow dir = 1.
 * At each node a route picks one of the exits; it only turns back on the same
 * road at a dead end.
 *
 * Lanes are chosen by `lane`, counted from the right-hand edge of the road
 * (0 = the outer, slow lane) and clamped to the lanes a road actually has.
 */
export class RoutePlanner {
  constructor(roads, { minRadius = m(4.5), clearance = m(1.2) } = {}) {
    this.roads = roads;
    this.minRadius = minRadius; // a car's turning circle, plus a little margin
    this.clearance = clearance; // half a car's width plus a margin
    this.exitsByNode = new Map();
    for (const road of roads) {
      const { p1, p2 } = road.segment;
      this.#addExit(p1, { road, dir: 1 });
      if (road.backwardLanes > 0) this.#addExit(p2, { road, dir: -1 });
    }
  }

  #addExit(node, step) {
    if (!this.exitsByNode.has(node)) this.exitsByNode.set(node, []);
    this.exitsByNode.get(node).push(step);
  }

  static start(step) {
    return step.dir > 0 ? step.road.segment.p1 : step.road.segment.p2;
  }

  static end(step) {
    return step.dir > 0 ? step.road.segment.p2 : step.road.segment.p1;
  }

  static laneCount(step) {
    return step.dir > 0 ? step.road.forwardLanes : step.road.backwardLanes;
  }

  /** Every legal step in the network. */
  allSteps() {
    return [...this.exitsByNode.values()].flat();
  }

  exits(node) {
    return this.exitsByNode.get(node) ?? [];
  }

  /**
   * Possible next steps after `step`. No U-turns: a road is far narrower than
   * a car's turning circle, so a dead end is where a route finishes.
   */
  nextOptions(step) {
    return this.exits(RoutePlanner.end(step)).filter((s) => s.road !== step.road);
  }

  /** Extend `steps` with random choices until it has `count` steps (or hits a dead end). */
  extend(steps, count, rng) {
    const route = [...steps];
    while (route.length < count) {
      const options = this.nextOptions(route[route.length - 1]);
      if (options.length === 0) break;
      route.push(pick(rng, options));
    }
    return route;
  }

  /** A random step, weighted by road length, among roads at least `minLength` long. */
  randomStep(rng, minLength = 0) {
    const steps = this.allSteps().filter((s) => s.road.segment.length() >= minLength);
    if (steps.length === 0) return null;
    const total = steps.reduce((sum, s) => sum + s.road.segment.length(), 0);
    let r = rng() * total;
    for (const s of steps) {
      r -= s.road.segment.length();
      if (r <= 0) return s;
    }
    return steps[steps.length - 1];
  }

  /** Lateral offset of a lane from the road skeleton (positive = right of p1→p2). */
  static laneOffset(step, lane) {
    const { road } = step;
    if (step.dir > 0) {
      const index = road.laneCount - 1 - Math.min(lane, road.forwardLanes - 1);
      return road.laneCenterOffset(index);
    }
    return road.laneCenterOffset(Math.min(lane, road.backwardLanes - 1));
  }

  /** Lane centre line of a step, in travel direction. */
  static laneLine(step, lane) {
    const line = step.road.segment.offset(RoutePlanner.laneOffset(step, lane));
    return step.dir > 0 ? { a: line.p1, b: line.p2 } : { a: line.p2, b: line.p1 };
  }

  /** Lane offset in the travel frame (positive = right of the direction of travel). */
  static travelOffset(step, lane) {
    return step.dir * RoutePlanner.laneOffset(step, lane);
  }

  /**
   * Path through every step of a route in the given lane: straight lane centre
   * lines joined by circular arcs at each node. Returns the path plus the arc
   * length at which each step begins.
   */
  buildPath(steps, lane) {
    const lines = steps.map((s) => RoutePlanner.laneLine(s, lane));
    const points = [lines[0].a];
    const stepIndices = [0];

    for (let i = 0; i < lines.length - 1; i++) {
      const arc = this.#fillet(steps[i], lines[i], steps[i + 1], lines[i + 1], lane);
      points.push(...arc);
      stepIndices.push(points.length - 1 - Math.floor(arc.length / 2));
    }

    points.push(lines[lines.length - 1].b);
    // Arc length at each step start (duplicate points add zero length, so this
    // matches the Path's own parameterisation).
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + points[i - 1].distanceTo(points[i]));
    return { path: new Path(points), stepStarts: stepIndices.map((idx) => cumulative[idx]) };
  }

  /**
   * Circular arc tangent to two consecutive lane lines. The radius is the
   * largest that keeps the car clear of the inner corner of the junction
   * (where the inside road edges meet) and stays near its own lane, but never
   * tighter than a car can physically steer.
   */
  #fillet(step1, line1, step2, line2, lane) {
    const d1 = line1.b.subtract(line1.a).normalize();
    const d2 = line2.b.subtract(line2.a).normalize();
    const turn = Math.atan2(d1.cross(d2), d1.dot(d2)); // positive = right turn
    if (Math.abs(turn) < 0.1) return [Point.average(line1.b, line2.a)];
    if (Math.abs(turn) > 2.9) return [line1.b, line2.a];

    const side = Math.sign(turn);
    const n1 = d1.perpendicular();
    const n2 = d2.perpendicular();
    const shifted = (line, n, by) => [line.a.add(n.scale(by)), line.b.add(n.scale(by))];
    const meet = ([a, b], [c, d]) => {
      const hit = getLineIntersection(a, b, c, d);
      return hit && new Point(hit.x, hit.y);
    };

    // Inner corner: where the road edges on the inside of the turn meet.
    const toInner1 = (side * step1.road.width) / 2 - RoutePlanner.travelOffset(step1, lane);
    const toInner2 = (side * step2.road.width) / 2 - RoutePlanner.travelOffset(step2, lane);
    const innerCorner = meet(shifted(line1, n1, toInner1), shifted(line2, n2, toInner2));

    const centre = (r) => meet(shifted(line1, n1, side * r), shifted(line2, n2, side * r));
    const clearance = (r) => {
      const c = centre(r);
      return innerCorner && c ? r - c.distanceTo(innerCorner) : Infinity;
    };

    const len1 = line1.a.distanceTo(line1.b);
    const len2 = line2.a.distanceTo(line2.b);
    const half = Math.abs(turn) / 2;
    // Fit on both roads, and don't cut the lane corner by more than part of a
    // lane (a wide arc would sweep across the oncoming lanes).
    const maxCut = step1.road.laneWidth * 0.6;
    const fitRadius = Math.min(
      (0.45 * Math.min(len1, len2)) / Math.tan(half),
      maxCut / (1 / Math.cos(half) - 1),
    );
    let r;
    if (fitRadius <= this.minRadius || clearance(fitRadius) >= this.clearance) r = fitRadius;
    else if (clearance(this.minRadius) < this.clearance) r = this.minRadius;
    else {
      let lo = this.minRadius;
      let hi = fitRadius;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (clearance(mid) >= this.clearance) lo = mid;
        else hi = mid;
      }
      r = lo;
    }

    const o = centre(r);
    if (!o) return [Point.average(line1.b, line2.a)];
    const start = o.subtract(n1.scale(side * r)).subtract(o).angle();
    const count = Math.min(24, Math.max(4, Math.ceil((Math.abs(turn) * r) / 6)));
    const arc = [];
    for (let k = 0; k <= count; k++) arc.push(o.add(Point.fromAngle(start + (turn * k) / count, r)));
    return arc;
  }
}
