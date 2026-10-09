import { approach, maxSteerAt } from '../car/physics.js';
import { fromKmh, m } from '../car/units.js';
import { clamp } from '../math/utils.js';
import { Point } from '../primitives/point.js';
import { RoutePlanner } from './routePlanner.js';

const STANLEY_GAIN = 2.5; // 1/s

export const DRIVER_DEFAULTS = {
  desiredSpeed: fromKmh(50), // the driver's own preference (speed limits cap it)
  speedCompliance: 1, // multiple of the speed limit the driver aims for
  timeHeadway: 1.4, // s, following distance in time
  minGap: m(2.5), // bumper-to-bumper gap when stopped
  maxAccel: m(1.6),
  comfortBrake: m(2.5),
  maxBrake: m(8),
  cornerAccel: m(2.2), // lateral acceleration a driver accepts in turns
  sensorRange: m(50),
  routeLength: 10, // steps planned ahead
  laneChangeSpeed: m(1.6), // lateral speed while changing lane
  laneChangeThreshold: m(0.3), // MOBIL: acceleration gain needed to change lanes
  keepRightBias: m(0.4), // MOBIL: extra incentive to move back to the right
  safeBrake: m(3), // MOBIL: the most a new follower may have to brake
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
 *   steering    Stanley controller: heading + cross-track error + curvature
 *   speed       IDM towards min(own preference, speed limit), slowed for
 *               curves and lower limits ahead
 *   following   the nearest car in its lane corridor becomes the IDM leader
 *   junctions   (with a City) asks the junction for its movement and stops
 *               at the line for red lights, stop/yield signs and busy boxes;
 *               stops for pedestrians on zebra crossings
 *   lanes       follows lane connections through junctions; changes lane
 *               when it must (wrong lane for the next turn, lane ending) and
 *               when it pays (MOBIL: overtaking, keeping right); re-routes
 *               if it reaches a junction in a lane that can't make its turn
 */
export class TrafficDriver {
  constructor(car, planner, { rng = Math.random, lane = 0, city = null, laneIndex = null, ...options } = {}) {
    this.car = car;
    this.planner = planner;
    this.rng = rng;
    this.lane = lane;
    this.city = city;
    this.laneIndex = laneIndex ?? city?.laneIndex ?? null;
    this.options = { ...DRIVER_DEFAULTS, ...options };

    this.steps = [];
    this.path = null;
    this.stepStarts = [];
    this.lanePlan = [];
    this.s = 0;
    this.deadEnd = false;
    this.finished = false;

    this.leader = null;
    this.stopFor = null; // the rule currently holding the car: 'junction' | 'crossing' | 'lane' | 'end' | null
    this.shift = 0; // lateral offset while changing lane
    this.shiftTarget = 0;
    this.pendingLane = null;
    this.laneChangeReason = null;
    this.laneTimer = 0;
    this.entered = new Set(); // junctions we hold a reservation in
    this.blockedTime = 0;
    this.patience = 0;
    this.leaving = false;
    this.stuckTime = 0;
    this.target = null; // steering point, for debug drawing
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

  /** Like begin(), but along a given route (extended at random once it runs out). */
  followRoute(steps, along) {
    this.steps = this.planner.extend(steps, Math.max(steps.length, this.options.routeLength), this.rng);
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

  get currentStep() {
    return this.steps[this.stepIndex];
  }

  /** Lane ID of the current lane (Week 23), when driving in a city. */
  get laneId() {
    return this.city ? this.city.laneId(this.currentStep, this.lane) : null;
  }

  /** Where this car is for the lane index: road, direction, s along it, lane(s) it occupies. */
  laneInfo() {
    const step = this.currentStep;
    if (!step) return null;
    const seg = step.road.segment;
    const { offset } = seg.projectPoint(this.car.position);
    const t = clamp(offset, 0, 1);
    const len = seg.length();
    const lanes = this.pendingLane !== null ? [this.lane, this.pendingLane] : [this.lane];
    return { road: step.road, dir: step.dir, s: step.dir > 0 ? t * len : (1 - t) * len, lanes };
  }

  update(dt, cars) {
    const { car, options: o } = this;
    if (!this.path || this.path.length === 0) return;
    const v = car.speed;

    const proj = this.path.project(car.position, this.s - m(3), this.s + m(12));
    if (proj) this.s = proj.s;
    if (!this.deadEnd && this.path.length - this.s < m(70)) this.#restartFromCurrentStep(this.options.routeLength / 2);
    this.#syncLane();

    this.patience = Math.max(0, this.patience - dt);
    this.leader = this.#scan(cars);
    this.#updateLanes(dt, cars);

    // Speed: IDM against the nearest of the leader and every reason to stop.
    const v0 = Math.min(this.#speedTarget(), this.#curveLimit());
    let gap = Infinity;
    let dv = 0;
    if (this.leader) {
      gap = this.leader.gap;
      dv = v - this.leader.speed;
    }
    this.stopFor = null;
    for (const stop of this.#stops()) {
      if (stop.gap < gap) {
        gap = stop.gap;
        dv = v;
        this.stopFor = stop.kind;
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
    this.#releaseJunction();

    // Waiting at a red light, a sign or a crossing, or queueing behind
    // someone who is, is not being stuck.
    const stopped = Math.abs(v) < m(0.3);
    const waitingByRule = this.stopFor === 'junction' || this.stopFor === 'crossing' || !!this.leader?.car.driver?.waitingByRule;
    this.waitingByRule = waitingByRule && stopped;

    // Cars waiting for each other in a circle (a real deadlock, not a queue):
    // after a while, go.
    if (stopped && !this.stopFor && !waitingByRule && this.#inWaitingCycle()) this.blockedTime += dt;
    else this.blockedTime = 0;
    if (this.blockedTime > 6) {
      this.patience = 2.5;
      this.blockedTime = 0;
    }

    // Safety net for gridlock the rules above can't untangle.
    this.stuckTime = stopped && !waitingByRule ? this.stuckTime + dt : 0;

    // Fade in after spawning; fade out and leave at the end of a dead-end
    // route, or after being stuck for a long time.
    if (this.deadEnd && this.path.length - this.s < m(8) && Math.abs(v) < m(3)) this.leaving = true;
    if (this.stuckTime > 12) this.leaving = true;
    car.alpha = clamp(car.alpha + (this.leaving ? -dt / 0.8 : dt / 0.6), 0, 1);
    this.finished = this.leaving && car.alpha === 0;
    if (this.finished) this.#releaseJunction(true);
  }

  /** Does following the chain of leaders lead back to this car? */
  #inWaitingCycle() {
    let car = this.leader?.car;
    for (let hops = 0; car?.driver && hops < 5; hops++) {
      if (car === this.car) return true;
      car = car.driver.leader?.car;
    }
    return car === this.car;
  }

  // ---- route ----------------------------------------------------------------

  #rebuild() {
    this.lanePlan = this.city ? this.city.lanePlan(this.steps, this.lane) : this.steps.map(() => this.lane);
    const { path, stepStarts } = this.planner.buildPath(this.steps, this.lanePlan);
    this.path = path;
    this.stepStarts = stepStarts;
    this.deadEnd = this.planner.nextOptions(this.steps[this.steps.length - 1]).length === 0;
  }

  /** After crossing a junction the car is in the lane its connection led to. */
  #syncLane() {
    if (this.pendingLane !== null) return;
    const planned = this.lanePlan[this.stepIndex];
    if (planned !== undefined) this.lane = planned;
  }

  /** Drop the steps already driven and plan further ahead. */
  #restartFromCurrentStep(extra = 0) {
    const index = this.stepIndex;
    const offset = this.stepStarts[index];
    const kept = this.steps.slice(index);
    this.lane = this.lanePlan[index] ?? this.lane;
    this.steps = this.planner.extend(kept, Math.max(this.options.routeLength, kept.length + extra), this.rng);
    this.#rebuild();
    const estimate = this.s - offset;
    const proj = this.path.project(this.car.position, estimate - m(6), estimate + m(6));
    this.s = proj ? proj.s : estimate;
  }

  /** In a lane that can't make the planned turn, close to the junction: take a turn it can make. */
  #reroute() {
    const k = this.stepIndex;
    const step = this.steps[k];
    const junction = this.city?.junctionAt(RoutePlanner.end(step));
    const options = junction?.movementsFromLane(step, this.lane) ?? [];
    if (!options.length) return false;
    const mv = options[Math.floor(this.rng() * options.length)];
    const out = junction.arms[mv.to].outStep;
    const next = this.planner.allSteps().find((s) => s.road === out.road && s.dir === out.dir);
    if (!next) return false;
    const offset = this.stepStarts[k];
    this.steps = this.planner.extend([step, next], this.options.routeLength, this.rng);
    this.#rebuild();
    const estimate = this.s - offset;
    const proj = this.path.project(this.car.position, estimate - m(6), estimate + m(6));
    this.s = proj ? proj.s : estimate;
    return true;
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
      // In a city, junction reservations keep traffic apart; predicting where
      // other cars will be is only needed for cars without a driver (the player).
      if (!hit && Math.abs(other.speed) > m(1) && !(this.city && other.driver)) {
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

  // ---- speed --------------------------------------------------------------------

  /** min(own preference, speed limit × compliance), slowing early for a lower limit ahead. */
  #speedTarget() {
    const o = this.options;
    const k = this.stepIndex;
    const step = this.steps[k];
    let target = o.desiredSpeed;
    if (step?.road.speedLimit) target = Math.min(target, step.road.speedLimit * o.speedCompliance);
    const next = this.steps[k + 1];
    if (next?.road.speedLimit) {
      const nextLimit = Math.min(o.desiredSpeed, next.road.speedLimit * o.speedCompliance);
      const distance = Math.max(0, (this.stepStarts[k + 1] ?? this.path.length) - this.s);
      target = Math.min(target, Math.sqrt(nextLimit * nextLimit + 2 * o.comfortBrake * distance));
    }
    return target;
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

  /** Virtual obstacles: dead ends, junction stop lines, crossings, a lane we must leave. */
  *#stops() {
    const car = this.car;
    if (this.deadEnd) yield { gap: this.path.length - this.s - car.length / 2 - m(1), kind: 'end' };
    if (!this.city) return;
    const junctionStop = this.#junctionStop();
    if (junctionStop) yield junctionStop;
    const laneEnd = this.#laneEndStop();
    if (laneEnd) yield laneEnd;
    const crossingStop = this.#crossingStop();
    if (crossingStop) yield crossingStop;
  }

  /** Distance from the front bumper to a junction arm's stop line. */
  #distanceToLine(junction, arm) {
    const line = junction.node.add(arm.away.scale(arm.stopDistance));
    const front = this.car.position.add(this.car.forward.scale(this.car.length / 2));
    return line.subtract(front).dot(arm.away.scale(-1));
  }

  #junctionStop() {
    const k = this.stepIndex;
    const step = this.steps[k];
    const next = this.steps[k + 1];
    if (!step || !next) return null;
    const junction = this.city.junctionAt(RoutePlanner.end(step));
    if (!junction || !junction.isIntersection) return null;
    const arm = junction.armOf(step);
    if (!arm) return null;
    const dist = this.#distanceToLine(junction, arm);
    if (dist > m(60)) return null;

    let movement = this.city.movement(step, this.lane, next);
    if (!movement && dist < m(12) && this.pendingLane === null && this.#reroute()) {
      movement = this.city.movement(this.steps[k], this.lane, this.steps[k + 1]);
    }
    // Still in the wrong lane: wait at the line while lane changing keeps trying.
    if (!movement) return dist < m(12) ? { gap: dist - m(0.5), kind: 'lane' } : null;

    const go = junction.request(this, movement, dist, Math.max(0, this.car.speed), this.city.time);
    if (go && junction.occupants.has(this)) this.entered.add(junction);
    return go ? null : { gap: dist - m(0.3), kind: 'junction' };
  }

  /**
   * A lane that ends (lane drop, acceleration lane, a lane that can't reach
   * the next road): don't drive off its end, wait there for a gap to merge.
   */
  #laneEndStop() {
    const k = this.stepIndex;
    const step = this.steps[k];
    const next = this.steps[k + 1];
    if (!step || !next || this.pendingLane !== null) return null;
    const junction = this.city.junctionAt(RoutePlanner.end(step));
    if (!junction || junction.isIntersection) return null;
    const allowed = this.city.allowedLanes(step, next);
    if (!allowed.length || allowed.includes(this.lane)) return null;
    const toNode = (this.stepStarts[k + 1] ?? this.path.length) - this.s;
    return { gap: toNode - this.car.length / 2 - m(6), kind: 'lane' };
  }

  /** Release a junction reservation once the car is clear of the box. */
  #releaseJunction(force = false) {
    for (const junction of this.entered) {
      const clearance = Math.max(...junction.arms.map((a) => a.stopDistance)) + this.car.length;
      // Only once the junction is behind us: a car waiting at its stop line is
      // already this far from the centre.
      const behind = junction.node.subtract(this.car.position).dot(this.car.forward) < 0;
      if (force || (behind && junction.node.distanceTo(this.car.position) > clearance)) {
        junction.release(this);
        this.entered.delete(junction);
      }
    }
  }

  #crossingStop() {
    const k = this.stepIndex;
    for (const i of [k, k + 1]) {
      const step = this.steps[i];
      if (!step) continue;
      const crossing = this.city.crossingOn(step.road);
      if (!crossing || !crossing.occupied) continue;
      const at = this.stepStarts[i] + crossing.distanceFromStart(step.dir);
      const gap = at - this.s - this.car.length / 2 - crossing.depth / 2 - m(1.5);
      if (gap < -m(1)) continue; // already on it: keep going
      const stopping = (this.car.speed * this.car.speed) / (2 * this.options.maxBrake);
      if (gap > stopping * 0.6) return { gap, kind: 'crossing' };
    }
    return null;
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

  // ---- lane changes (Week 23) ----------------------------------------------------

  /**
   * Lane changes, mandatory first: the next movement needs another lane (a
   * turn, an exit, or this lane ending). Otherwise MOBIL: change when the
   * acceleration gained in the other lane beats a threshold (with a bias
   * towards the right-hand lane) and the new follower wouldn't brake hard.
   */
  #updateLanes(dt, cars) {
    const o = this.options;

    if (this.pendingLane !== null) {
      // Someone moved alongside in the target lane: abort and steer back.
      if (this.shiftTarget !== 0 && Math.abs(this.shift) < this.laneWidth * 0.6 && !this.#safe(this.pendingLane, cars, 0.35)) {
        this.shiftTarget = 0;
      }
      // A car can only move sideways while it rolls forward.
      const rate = o.laneChangeSpeed * clamp(Math.abs(this.car.speed) / m(4), 0, 1);
      this.shift = approach(this.shift, this.shiftTarget, rate * dt);
      if (this.shiftTarget === 0 && this.shift === 0) {
        this.pendingLane = null;
        this.laneTimer = 1;
        return;
      }
      if (this.shift === this.shiftTarget) {
        this.lane = this.pendingLane;
        this.lanePlan[this.stepIndex] = this.pendingLane;
        this.pendingLane = null;
        this.shift = 0;
        this.shiftTarget = 0;
        this.#restartFromCurrentStep();
      }
      return;
    }

    this.laneTimer -= dt;
    if (this.laneTimer > 0) return;
    this.laneTimer = 0.4;

    const k = this.stepIndex;
    const step = this.steps[k];
    const next = this.steps[k + 1];
    const count = RoutePlanner.laneCount(step);
    this.lane = Math.min(this.lane, count - 1);
    if (count < 2) return;
    const toEnd = (this.stepStarts[k + 1] ?? this.path.length) - this.s;

    // Mandatory: the next movement isn't possible from this lane.
    const allowedNext = this.city && next ? this.city.allowedLanes(step, next) : null;
    if (allowedNext && allowedNext.length && !allowedNext.includes(this.lane)) {
      const required = allowedNext.reduce((a, b) => (Math.abs(b - this.lane) < Math.abs(a - this.lane) ? b : a));
      const target = this.lane + Math.sign(required - this.lane);
      // The closer the end of the lane, the smaller the gap we accept.
      const urgency = clamp(1 - toEnd / m(120), 0, 1);
      if (this.#safe(target, cars, 1 - urgency * 0.6)) this.#startLaneChange(target, 'mandatory');
      return;
    }
    if (toEnd < m(40)) return;

    // Discretionary (MOBIL).
    const current = this.#accelerationIn(this.lane, cars);
    let best = null;
    for (const target of [this.lane + 1, this.lane - 1]) {
      if (target < 0 || target >= count) continue;
      if (allowedNext && allowedNext.length && !allowedNext.includes(target) && toEnd < m(150)) continue;
      const gain = this.#accelerationIn(target, cars) - current + (target < this.lane ? o.keepRightBias : 0);
      if (gain > o.laneChangeThreshold && (!best || gain > best.gain) && this.#safe(target, cars, 1)) best = { target, gain };
    }
    if (best) this.#startLaneChange(best.target, best.target > this.lane ? 'overtake' : 'keep right');
  }

  #startLaneChange(target, reason) {
    this.pendingLane = target;
    this.laneChangeReason = reason;
    // Higher lane numbers are further left, i.e. negative lateral offset.
    this.shiftTarget = (target > this.lane ? -1 : 1) * this.laneWidth;
  }

  /** IDM acceleration this car would have behind the leader in `lane`. */
  #accelerationIn(lane, cars = []) {
    const o = this.options;
    const v = Math.max(0, this.car.speed);
    const v0 = this.#speedTarget();
    let gap = Infinity;
    let dv = 0;
    if (lane === this.lane && this.leader) {
      gap = this.leader.gap;
      dv = v - this.leader.speed;
    } else {
      const leader = this.laneIndex
        ? this.laneIndex.neighbours(this.laneInfo().road, this.laneInfo().dir, lane, this.laneInfo().s, this.car).leader
        : this.#leaderAtOffset(cars, (this.lane - lane) * this.laneWidth);
      if (leader) {
        gap = leader.gap;
        dv = v - Math.max(0, leader.car.speed);
      }
    }
    return idmAcceleration({ v, v0, gap, dv, a: o.maxAccel, b: o.comfortBrake, s0: o.minGap, T: o.timeHeadway });
  }

  /** Without a lane index: the nearest car ahead whose lateral offset from our path is `offset`. */
  #leaderAtOffset(cars, offset) {
    let best = null;
    for (const other of cars) {
      if (other === this.car) continue;
      const proj = this.path.project(other.position, this.s, this.s + this.options.sensorRange);
      if (!proj || proj.s - this.s <= this.car.length / 2) continue;
      if (Math.abs(proj.lateral - offset) > this.laneWidth / 2) continue;
      const gap = proj.s - this.s - (this.car.length + other.length) / 2;
      if (!best || gap < best.gap) best = { car: other, gap };
    }
    return best;
  }

  /** Is there room in `lane` beside us? `strictness` < 1 accepts tighter gaps (mandatory changes). */
  #safe(lane, cars, strictness) {
    const o = this.options;
    const v = Math.max(0, this.car.speed);
    if (this.laneIndex) {
      const info = this.laneInfo();
      const { leader, follower } = this.laneIndex.neighbours(info.road, info.dir, lane, info.s, this.car);
      if (leader && leader.gap < (m(2) + v * 0.3) * strictness) return false;
      if (follower) {
        if (follower.gap < m(2) * strictness) return false;
        const fv = Math.max(0, follower.car.speed);
        const brake = idmAcceleration({ v: fv, v0: Math.max(fv, m(5)), gap: follower.gap, dv: fv - v, a: o.maxAccel, b: o.comfortBrake, s0: o.minGap, T: o.timeHeadway });
        if (brake < -o.safeBrake / strictness) return false;
      }
      return this.#laneClear(cars, (lane > this.lane ? -1 : 1) * this.laneWidth, strictness);
    }
    return this.#laneClear(cars, (lane > this.lane ? -1 : 1) * this.laneWidth, strictness);
  }

  /** Nobody beside us in the target lane (geometric check, also catches cars on other roads). */
  #laneClear(cars, offset, strictness = 1) {
    const width = this.laneWidth;
    for (const other of cars) {
      if (other === this.car) continue;
      const proj = this.path.project(other.position, this.s - m(12), this.s + m(25));
      if (!proj || proj.distance > width * 2.5) continue;
      const alongOk = proj.s > this.s - m(8) * strictness && proj.s < this.s + m(12) * strictness;
      if (alongOk && Math.abs(proj.lateral - offset) < width * 0.9) return false;
    }
    return true;
  }
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
