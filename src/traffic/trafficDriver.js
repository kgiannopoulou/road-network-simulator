import { approach, maxSteerAt } from '../car/physics.js';
import { fromKmh, m } from '../car/units.js';
import { clamp } from '../math/utils.js';
import { Point } from '../primitives/point.js';
import { RoutePlanner } from './routePlanner.js';

const STANLEY_GAIN = 2.5; // 1/s

export const DRIVER_DEFAULTS = {
  desiredSpeed: fromKmh(50),
  timeHeadway: 1.4, // s, following distance in time
  minGap: m(2.5), // bumper-to-bumper gap when stopped
  maxAccel: m(1.6),
  comfortBrake: m(2.5),
  maxBrake: m(8),
  cornerAccel: m(2.2), // lateral acceleration a driver accepts in turns
  sensorRange: m(50),
  routeLength: 10, // steps planned ahead
  laneChangeSpeed: m(1.6), // lateral speed while changing lane
};

/**
 * Intelligent Driver Model: the acceleration that keeps a safe, speed-
 * dependent gap to the vehicle in front while approaching the desired speed.
 *   v   own speed       v0  desired speed     gap  bumper-to-bumper distance
 *   dv  closing speed   a   max acceleration  b    comfortable braking
 *   s0  minimum gap     T   time headway
 */
export function idmAcceleration({ v, v0, gap = Infinity, dv = 0, a, b, s0, T, delta = 4 }) {
  const free = 1 - Math.pow(Math.max(v, 0) / Math.max(v0, 1e-3), delta);
  if (!Number.isFinite(gap)) return a * free;
  const desiredGap = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
  return a * (free - (desiredGap / Math.max(gap, 0.01)) ** 2);
}

/**
 * A non-AI driver for a traffic vehicle. It follows a planned route along
 * lane centre lines and controls the car only through its pedals and steering
 * wheel, so traffic obeys exactly the same physics as the player:
 *
 *   steering   Stanley controller: heading + cross-track error + curvature
 *   speed      IDM towards the desired speed, slowed for curves ahead
 *   following  the nearest car in its lane corridor (also cars predicted to
 *              cross it within ~1 s) becomes the IDM leader
 *   avoidance  stuck behind a slow or stopped car, it moves to a free
 *              adjacent lane going the same way
 */
export class TrafficDriver {
  constructor(car, planner, { rng = Math.random, lane = 0, ...options } = {}) {
    this.car = car;
    this.planner = planner;
    this.rng = rng;
    this.lane = lane;
    this.options = { ...DRIVER_DEFAULTS, ...options };

    this.steps = [];
    this.path = null;
    this.stepStarts = [];
    this.s = 0;
    this.deadEnd = false;
    this.finished = false;

    this.leader = null;
    this.shift = 0; // lateral offset while changing lane
    this.shiftTarget = 0;
    this.pendingLane = null;
    this.slowTime = 0;
    this.blockedTime = 0;
    this.patience = 0;
    this.leaving = false;
    this.stuckTime = 0;
    this.target = null; // pure pursuit point, for debug drawing
  }

  /** Put the car `along` units into `step`, at rest, facing its lane. */
  begin(step, along) {
    this.steps = this.planner.extend([step], this.options.routeLength, this.rng);
    this.#rebuild();
    this.s = clamp(along, 0, Math.max(0, this.path.length - 1));
    const p = this.path.pointAt(this.s);
    this.car.teleport(p.x, p.y, this.path.tangentAt(this.s).angle());
    this.car.alpha = 0;
  }

  get stepIndex() {
    let i = 0;
    while (i + 1 < this.stepStarts.length && this.stepStarts[i + 1] <= this.s) i++;
    return i;
  }

  get laneWidth() {
    return this.steps[0]?.road.laneWidth ?? 22;
  }

  update(dt, cars) {
    const { car, options: o } = this;
    if (!this.path || this.path.length === 0) return;
    const v = car.speed;

    const proj = this.path.project(car.position, this.s - m(3), this.s + m(12));
    if (proj) this.s = proj.s;
    if (!this.deadEnd && this.path.length - this.s < m(70)) this.#restartFromCurrentStep(this.options.routeLength / 2);

    this.patience = Math.max(0, this.patience - dt);
    this.leader = this.#scan(cars);
    this.#updateLaneChange(dt, cars);

    // Speed: IDM against the leader, or the end of a dead-end route.
    const v0 = Math.min(o.desiredSpeed, this.#curveLimit());
    let gap = Infinity;
    let dv = 0;
    if (this.leader) {
      gap = this.leader.gap;
      dv = v - this.leader.speed;
    }
    if (this.deadEnd) {
      const endGap = this.path.length - this.s - car.length / 2 - m(1);
      if (endGap < gap) {
        gap = endGap;
        dv = v;
      }
    }
    const accel = clamp(
      idmAcceleration({ v, v0, gap, dv, a: o.maxAccel, b: o.comfortBrake, s0: o.minGap, T: o.timeHeadway }),
      -o.maxBrake,
      o.maxAccel,
    );

    const input = car.input;
    input.allowReverse = false;
    input.handbrake = false;
    if (accel >= 0) {
      const engine = car.params.engineAccel * Math.max(0.05, 1 - (v / car.params.maxSpeed) ** 3);
      input.forward = clamp(accel / engine, 0, 1);
      input.back = 0;
    } else {
      input.forward = 0;
      input.back = clamp(-accel / car.params.brakeDecel, 0, 1);
    }
    input.steer = this.#steer();

    // Two cars politely waiting for each other forever: after a while, go.
    const stopped = Math.abs(v) < m(0.3);
    if (stopped && this.leader?.car.driver) this.blockedTime += dt;
    else this.blockedTime = 0;
    if (this.blockedTime > 6) {
      this.patience = 2.5;
      this.blockedTime = 0;
    }

    // Safety net for gridlock the rules above can't untangle.
    this.stuckTime = stopped ? this.stuckTime + dt : 0;

    // Fade in after spawning; fade out and leave at the end of a dead-end
    // route, or after being stuck for a long time.
    if (this.deadEnd && this.path.length - this.s < m(8) && Math.abs(v) < m(3)) this.leaving = true;
    if (this.stuckTime > 12) this.leaving = true;
    car.alpha = clamp(car.alpha + (this.leaving ? -dt / 0.8 : dt / 0.6), 0, 1);
    this.finished = this.leaving && car.alpha === 0;
  }

  // ---- route ----------------------------------------------------------------

  #rebuild() {
    const { path, stepStarts } = this.planner.buildPath(this.steps, this.lane);
    this.path = path;
    this.stepStarts = stepStarts;
    this.deadEnd = this.planner.nextOptions(this.steps[this.steps.length - 1]).length === 0;
  }

  /** Drop the steps already driven and plan further ahead. */
  #restartFromCurrentStep(extra = 0) {
    const index = this.stepIndex;
    const offset = this.stepStarts[index];
    const kept = this.steps.slice(index);
    this.steps = this.planner.extend(kept, Math.max(this.options.routeLength, kept.length + extra), this.rng);
    this.#rebuild();
    const estimate = this.s - offset;
    const proj = this.path.project(this.car.position, estimate - m(6), estimate + m(6));
    this.s = proj ? proj.s : estimate;
  }

  // ---- perception -------------------------------------------------------------

  /** Nearest car in (or about to enter) this car's lane corridor ahead. */
  #scan(cars) {
    const me = this.car;
    const range = this.options.sensorRange;
    let best = null;
    for (const other of cars) {
      if (other === me) continue;
      if (this.patience > 0 && other.driver) continue;
      const dx = other.state.x - me.state.x;
      const dy = other.state.y - me.state.y;
      const reach = range + other.radius + me.radius;
      if (dx * dx + dy * dy > reach * reach) continue;

      let hit = this.#corridorHit(other, new Point(0, 0));
      let predicted = false;
      if (!hit && Math.abs(other.speed) > m(1)) {
        hit = this.#corridorHit(other, other.velocity.scale(1.2));
        predicted = true;
      }
      if (!hit) continue;

      // Mutual waiting: the car with the lower id goes first.
      if (other.driver?.leader?.car === me && me.id < other.id) continue;

      const speed = predicted ? 0 : Math.max(0, other.velocity.dot(this.path.tangentAt(hit.s)));
      if (!best || hit.gap < best.gap) best = { car: other, gap: hit.gap, speed, predicted };
    }
    return best;
  }

  /**
   * Does `other` (moved by `offset`) block this car's corridor ahead? Checks
   * its centre against the lane and its corners against this car's own
   * width, so a car parked half across the lane is noticed too. Returns the
   * nearest blocking point as { s, gap } (gap is bumper to obstacle).
   */
  #corridorHit(other, offset) {
    const me = this.car;
    const from = this.s;
    const to = this.s + this.options.sensorRange;
    const probes = [
      { point: other.position, reach: this.laneWidth / 2 + other.width / 2 - m(0.3), extra: other.length / 2 },
      ...other.polygon().points.map((point) => ({ point, reach: me.width / 2 + m(0.4), extra: 0 })),
    ];
    let best = null;
    for (const probe of probes) {
      const proj = this.path.project(probe.point.add(offset), from, to);
      if (!proj || proj.s - this.s <= me.length / 2) continue;
      if (Math.abs(proj.lateral - this.shift) > probe.reach) continue;
      const gap = proj.s - this.s - me.length / 2 - probe.extra;
      if (!best || gap < best.gap) best = { s: proj.s, gap };
    }
    return best;
  }

  /** Highest speed that still allows comfortable braking for every curve ahead. */
  #curveLimit() {
    const { path, s, options: o } = this;
    const horizon = s + m(70);
    let limit = Infinity;
    for (let i = path.indexAt(s) + 1; i < path.points.length - 1 && path.cumulative[i] <= horizon; i++) {
      const k = path.curvature[i];
      if (k < 1e-4) continue;
      const vCorner = Math.sqrt(o.cornerAccel / k);
      const distance = Math.max(0, path.cumulative[i] - s - m(2));
      limit = Math.min(limit, Math.sqrt(vCorner * vCorner + 2 * o.comfortBrake * distance));
    }
    return Math.max(limit, m(2));
  }

  // ---- control ---------------------------------------------------------------

  /**
   * Stanley lateral controller, measured at the front axle:
   *   δ = heading error + atan(k · cross-track error / speed) + atan(L · κ)
   * The last term feeds the path's own curvature forward so the car turns
   * with the lane instead of lagging and cutting the corner.
   */
  #steer() {
    const { car, path } = this;
    const p = car.params;
    const v = Math.abs(car.speed);
    const front = car.position.add(car.forward.scale(p.wheelbase / 2));
    const proj = path.project(front, this.s - m(2), this.s + p.wheelbase + m(6));
    if (!proj) return 0;
    this.target = path.pointAt(proj.s).add(path.normalAt(proj.s).scale(this.shift));

    const preview = Math.min(proj.s + v * 0.15, path.length);
    const headingError = wrapAngle(path.tangentAt(preview).angle() - car.state.angle);
    const crossTrack = proj.lateral - this.shift; // positive: car is right of its lane
    const correction = Math.atan2(-STANLEY_GAIN * crossTrack, v + m(1));
    const feedForward = Math.atan(p.wheelbase * path.curvatureAt(proj.s));
    const steer = headingError + correction + feedForward;
    return clamp(steer / maxSteerAt(p, car.speed), -1, 1);
  }

  /** Obstacle avoidance: change to a free adjacent lane when stuck behind a slow car. */
  #updateLaneChange(dt, cars) {
    const o = this.options;
    const width = this.laneWidth;

    if (this.pendingLane !== null) {
      this.shift = approach(this.shift, this.shiftTarget, o.laneChangeSpeed * dt);
      if (this.shift === this.shiftTarget) {
        this.lane = this.pendingLane;
        this.pendingLane = null;
        this.shift = 0;
        this.shiftTarget = 0;
        this.#restartFromCurrentStep();
      }
      return;
    }

    const leader = this.leader;
    if (!leader || leader.predicted || leader.gap > m(20) || leader.speed > 0.4 * o.desiredSpeed) {
      this.slowTime = 0;
      return;
    }
    this.slowTime += dt;
    if (this.slowTime < 1.2) return;

    const index = this.stepIndex;
    const step = this.steps[index];
    const count = RoutePlanner.laneCount(step);
    const stepEnd = this.stepStarts[index + 1] ?? this.path.length;
    if (count < 2 || stepEnd - this.s < m(25)) return;

    const current = Math.min(this.lane, count - 1);
    for (const target of [current + 1, current - 1]) {
      if (target < 0 || target >= count) continue;
      // Higher lane numbers are further left, i.e. negative lateral offset.
      const offset = (target > current ? -1 : 1) * width;
      if (!this.#laneClear(cars, offset)) continue;
      this.lane = current;
      this.pendingLane = target;
      this.shiftTarget = offset;
      this.slowTime = 0;
      return;
    }
  }

  #laneClear(cars, offset) {
    const width = this.laneWidth;
    for (const other of cars) {
      if (other === this.car) continue;
      const proj = this.path.project(other.position, this.s - m(12), this.s + m(25));
      if (!proj || proj.distance > width * 2.5) continue;
      const alongOk = proj.s > this.s - m(10) && proj.s < this.s + m(22);
      if (alongOk && Math.abs(proj.lateral - offset) < width * 0.9) return false;
    }
    return true;
  }
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
