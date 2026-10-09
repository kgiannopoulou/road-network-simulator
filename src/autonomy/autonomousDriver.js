import { m, toMeters } from '../car/units.js';
import { Point } from '../primitives/point.js';
import { BehaviorPlanner, BehaviorState } from './behaviorPlanner.js';
import { TrajectoryController } from './controller.js';
import { Perception } from './perception.js';
import { TrajectoryPlanner } from './trajectoryPlanner.js';

const PLAN_INTERVAL = 0.1; // s between trajectory plans

/**
 * Milestone #5: the autonomous car. Drives the player's car from A to B
 * through four layers, each only talking to the next:
 *
 *   route       (navigation)  edges, lanes, maneuvers, reference path
 *   behaviour   (Week 27)     lanes allowed / preferred, speed, stop point
 *   trajectory  (Week 28)     the best short future path
 *   controller                steering, throttle, brake
 *
 * Perception builds its object list from the car's own LiDAR and radar.
 * Localisation (where the car is) uses the true pose, as an HD-map
 * localiser would provide, or optionally the GPS fix.
 */
export class AutonomousDriver {
  constructor({ car, route, city, sensors, perception = 'sensors', localization = 'perfect' }) {
    this.car = car;
    this.route = route;
    this.city = city;
    this.sensors = sensors;
    this.localization = localization;
    this.perception = new Perception({ mode: perception });
    this.behavior = new BehaviorPlanner(route, city, { key: this, carLength: car.length });
    this.planner = new TrajectoryPlanner(route);
    this.controller = new TrajectoryController();
    this.finished = false; // junctions drop reservations of finished drivers
    this.s = route.sStart;
    this.lastPlan = -Infinity;
    this.planTime = 0;
    this.status = 'driving';
    this.stats = { started: null, time: 0, distance: 0, collisions0: car.collisionCount, redLights0: city?.violations.redLights ?? 0, maxSpeed: 0 };
    this.lastPos = car.position;
    this.ego = null;
    this.decision = null;
  }

  get collisions() {
    return this.car.collisionCount - this.stats.collisions0;
  }

  get redLights() {
    return (this.city?.violations.redLights ?? 0) - this.stats.redLights0;
  }

  /** Called once per frame before physics; returns the car input. */
  update(time, dt, cars) {
    const car = this.car;
    this.stats.started ??= time;
    if (this.status !== 'driving') return { forward: 0, back: 1, steer: 0, handbrake: false, allowReverse: false };

    const ego = this.#localize();
    this.ego = ego;
    this.perception.update(time, { car, sensors: this.sensors, cars });
    const decision = this.behavior.update(ego, time);
    this.decision = decision;

    if (time - this.lastPlan >= PLAN_INTERVAL - 1e-9) {
      // Laterally, continue from where the previous plan says we should be
      // (when that is close and inside the lanes): the controller corrects
      // tracking errors and the planner doesn't bake them into every plan.
      // Through a turn, plan exactly along the reference lane.
      const planned = this.#plannedState(time);
      const width = this.route.edges[decision.edgeIndex].step.road.laneWidth;
      const lanesD = decision.allowedLanes.map((l) => (decision.refLane - l) * width);
      const inside = planned && planned.d >= Math.min(...lanesD) - width / 4 && planned.d <= Math.max(...lanesD) + width / 4;
      const continuePlan = inside && Math.abs(planned.d - ego.d) < m(1);
      const start = decision.turning ? { ...ego, d: 0, vd: 0 } : continuePlan ? { ...ego, d: planned.d, vd: planned.vd } : ego;
      this.planner.plan(start, decision, this.perception.objects, car.length, car.width);
      this.lastPlan = time;
      this.planTime = time;
    }
    const input = this.controller.update(car, this.planner.best, time - this.planTime, this.route.path, this.s);

    this.stats.time = time - this.stats.started;
    this.stats.distance += toMeters(car.position.distanceTo(this.lastPos));
    this.stats.maxSpeed = Math.max(this.stats.maxSpeed, car.speed);
    this.lastPos = car.position;
    if (decision.state === BehaviorState.ARRIVED) {
      this.status = 'arrived';
      this.finish();
    }
    return input;
  }

  /** Lateral offset and lateral speed the current plan expects now. */
  #plannedState(time) {
    const samples = this.planner.best?.samples;
    if (!samples || samples.length < 2 || this.planner.best.kind === 'emergency') return null;
    const t = time - this.planTime;
    const dt = samples[1].t - samples[0].t;
    const i = Math.min(samples.length - 2, Math.max(0, Math.floor(t / dt)));
    const a = samples[i];
    const b = samples[i + 1];
    const f = Math.min(1, Math.max(0, (t - a.t) / dt));
    return { d: a.d + (b.d - a.d) * f, vd: (b.d - a.d) / dt };
  }

  /** Where the car is in route (Frenet) coordinates. */
  #localize() {
    const car = this.car;
    let position = car.position;
    if (this.localization === 'gps') {
      const fix = this.sensors?.read('gps');
      if (fix) position = new Point(m(fix.data.x), m(fix.data.y));
    }
    const path = this.route.path;
    const proj = path.project(position, this.s - m(6), this.s + m(25)) ?? path.project(position);
    this.s = proj.s;
    const tangent = path.tangentAt(proj.s).angle();
    const headingError = Math.atan2(Math.sin(car.state.angle - tangent), Math.cos(car.state.angle - tangent));
    const v = Math.max(0, car.speed);
    return {
      s: proj.s,
      d: proj.lateral,
      v,
      vs: v * Math.cos(headingError),
      vd: v * Math.sin(headingError),
      as: Math.max(-m(5), Math.min(m(2.5), car.state.accel)),
      position: car.position,
      heading: car.state.angle,
    };
  }

  /** Progress along the route, 0…1. */
  get progress() {
    const r = this.route;
    return Math.min(1, Math.max(0, (this.s - r.sStart) / Math.max(1, r.sGoal - r.sStart)));
  }

  finish() {
    this.finished = true;
    this.behavior.releaseAll();
  }

  stop() {
    this.status = 'stopped';
    this.finish();
  }

  draw(ctx, px) {
    this.route.draw(ctx, px, { progress: this.s });
    this.planner.draw(ctx, px);
    this.perception.draw(ctx, px);
    const stop = this.decision?.stopAt;
    if (stop !== null && stop !== undefined) {
      const p = this.route.path.pointAt(stop);
      const n = this.route.path.normalAt(stop).scale(m(2));
      ctx.beginPath();
      ctx.moveTo(p.x - n.x, p.y - n.y);
      ctx.lineTo(p.x + n.x, p.y + n.y);
      ctx.strokeStyle = '#ff453a';
      ctx.lineWidth = 4 * px;
      ctx.stroke();
    }
  }
}
