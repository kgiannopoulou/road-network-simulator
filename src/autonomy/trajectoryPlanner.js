import { m } from '../car/units.js';
import { Point } from '../primitives/point.js';
import { Quartic, Quintic } from './polynomials.js';

/**
 * Week 28: trajectory planning in Frenet coordinates.
 *
 * Positions are (s, d) along the route's reference path: s = distance along
 * it, d = offset to the right. Every planning cycle a small lattice of
 * candidate trajectories is generated and the cheapest safe one is chosen:
 *
 *   lateral       a quintic d(t) to the centre of each allowed lane
 *   longitudinal  a quartic s(t) to a target speed (the limit, slower, the
 *                 speed of the car ahead), or a quintic that stops exactly
 *                 at a point (a stop line, the destination, behind a car)
 *   durations     3, 4 and 5 s
 *
 * A candidate is rejected if it brakes or turns harder than the limits,
 * leaves the allowed lanes, runs a stop point or comes within a car's width
 * of where perceived objects will be (constant-velocity prediction). The
 * rest are ranked by cost: speed below target, jerk, lane offset from the
 * preferred lane, lane changes, proximity to other cars, unnecessary stops.
 */
export const PLANNER_DEFAULTS = {
  durations: [3, 4, 5],
  horizon: 5, // s
  step: 0.2, // s between samples
  maxAccel: m(2.5),
  maxBrake: m(5),
  maxLateralAccel: m(3),
  cornerAccel: m(1.5),
  carRadius: m(1.05), // three circles along the car
  safety: m(0.5),
  weights: { speed: 1.5, jerk: 0.02, lane: 6, change: 2, proximity: 30, stop: 4 },
};

export class TrajectoryPlanner {
  constructor(route, options = {}) {
    this.route = route;
    this.o = { ...PLANNER_DEFAULTS, ...options, weights: { ...PLANNER_DEFAULTS.weights, ...options.weights } };
    this.candidates = [];
    this.best = null;
  }

  /**
   * ego: { s, d, vs, vd, as, v }; decision from the behaviour planner;
   * objects: tracked objects { x, y, vx, vy } in world units.
   */
  plan(ego, decision, objects, carLength, carWidth) {
    const o = this.o;
    const path = this.route.path;
    const width = this.route.edges[decision.edgeIndex].step.road.laneWidth;
    const vLimit = Math.min(decision.speedLimit, this.#curveLimit(ego.s));
    const dOf = (lane) => (decision.refLane - lane) * width;
    const dPreferred = dOf(decision.preferredLane);
    const laneDs = decision.allowedLanes.map(dOf);
    // The whole car must stay inside the allowed lanes: half a lane either
    // side of the outer lane centres, minus half the car's width.
    const slack = Math.max(m(0.15), width / 2 - (carWidth ?? m(1.8)) / 2 - m(0.15));
    const dMin = Math.min(...laneDs) - slack;
    const dMax = Math.max(...laneDs) + slack;
    const sStopLine = decision.stopAt === null ? null : decision.stopAt - carLength / 2 - m(1);
    const predicted = this.#predict(objects, path, ego);
    // Local cornering speed at any point of the reference path.
    const curveAt = (s) => {
      let k = 0;
      for (const ds of [-m(3), 0, m(3)]) k = Math.max(k, Math.abs(path.curvatureAt(Math.max(0, s + ds))));
      return k < 1e-4 ? Infinity : Math.sqrt(o.cornerAccel / k);
    };

    // Speeds to try: the limit, slower, and the speed of whatever is ahead.
    const speeds = new Set([vLimit, vLimit * 0.7, vLimit * 0.4]);
    for (const p of predicted) if (p.ahead) speeds.add(Math.max(0, Math.min(vLimit, p.vs)));
    // Points to stop at: the behaviour's stop point, and behind each car ahead.
    const stops = [];
    if (sStopLine !== null && sStopLine > ego.s + m(0.3)) stops.push({ s: sStopLine, required: true });
    for (const p of predicted) if (p.ahead && p.s0 - ego.s > m(4)) stops.push({ s: p.s0 - carLength - m(2.5), required: false });

    // Corners ahead: candidates that slow to the corner's speed exactly by the corner.
    const corners = this.#corners(ego.s, curveAt, vLimit);
    // Desired speed at each point ahead: the limit, braking comfortably for corners.
    const profile = (x) => {
      let v = decision.speedLimit;
      for (const c of corners) if (c.s >= x - m(3)) v = Math.min(v, Math.sqrt(c.v * c.v + 2 * m(1.5) * Math.max(0, c.s - x)));
      return Math.min(v, curveAt(x) * 1.05);
    };

    const candidates = [];
    for (const dT of [...new Set(laneDs)]) {
      for (const T of o.durations) {
        const lateral = new Quintic(ego.d, ego.vd, 0, dT, 0, 0, T);
        for (const corner of corners) {
          const Tc = Math.max(1, Math.min(8, (2 * (corner.s - ego.s)) / Math.max(ego.vs + corner.v, m(1))));
          candidates.push(this.#evaluate({ lateral, longitudinal: new Quartic(ego.s, ego.vs, ego.as, corner.v, 0, Tc), T: Tc, target: corner.v, kind: 'speed', dT, corner: true }, ego, { dMin, dMax, dPreferred, sStopLine, predicted, vLimit, width, curveAt, profile, speedLimit: decision.speedLimit }));
        }
        for (const v of speeds) {
          // Long enough that the speed change stays within comfortable acceleration.
          const Tv = Math.max(T, (1.6 * Math.abs(v - ego.vs)) / (0.8 * o.maxAccel));
          candidates.push(this.#evaluate({ lateral, longitudinal: new Quartic(ego.s, ego.vs, ego.as, v, 0, Tv), T: Tv, target: v, kind: 'speed', dT }, ego, { dMin, dMax, dPreferred, sStopLine, predicted, vLimit, width, curveAt, profile, speedLimit: decision.speedLimit }));
        }
        for (const stop of stops) {
          if (stop.s <= ego.s) continue;
          // Durations that suit the distance: about twice the time at the current speed.
          const base = Math.max(1.5, Math.min(10, (2 * (stop.s - ego.s)) / Math.max(ego.vs, m(2))));
          for (const Ts of [base * 0.75, base, base * 1.4]) {
            const longitudinal = new Quintic(ego.s, ego.vs, ego.as, stop.s, 0, 0, Ts);
            candidates.push(this.#evaluate({ lateral, longitudinal, T: Ts, target: 0, kind: stop.required ? 'stop' : 'stop behind', dT, stop: stop.s }, ego, { dMin, dMax, dPreferred, sStopLine, predicted, vLimit, width, curveAt, profile, speedLimit: decision.speedLimit }));
          }
        }
      }
    }

    const feasible = candidates.filter((c) => c.feasible);
    let best = feasible.reduce((a, b) => (!a || b.cost < a.cost ? b : a), null);
    if (!best) {
      // Nothing is safe for the whole horizon (e.g. a car predicted to cross
      // our path). Rather than slamming on the brakes in front of whoever
      // follows, take the option whose predicted conflict is furthest away,
      // if that is far enough to re-plan before it.
      const late = candidates
        .filter((c) => c.why === 'collides' && c.collisionAt >= 1.5)
        .sort((a, b) => b.collisionAt - a.collisionAt || a.cost - b.cost)[0];
      best = late ?? this.#emergency(ego, width);
    }
    this.candidates = candidates;
    this.best = best;
    return { candidates, best, feasible: feasible.length };
  }

  /** The slowest corners within 80 m: { s (where the curve starts), v (its speed) }. */
  #corners(s, curveAt, vLimit) {
    const found = [];
    for (let x = s + m(3); x < s + m(80); x += m(2)) {
      const v = curveAt(x);
      if (v < vLimit * 0.9 && (!found.length || x - found[found.length - 1].s > m(10))) found.push({ s: x, v });
      if (found.length >= 2) break;
    }
    return found;
  }

  /** Comfortable cornering speed for the curves ahead on the reference path. */
  #curveLimit(s) {
    const path = this.route.path;
    let limit = Infinity;
    for (let i = path.indexAt(s) + 1; i < path.points.length - 1 && path.cumulative[i] < s + m(80); i++) {
      const k = path.curvature[i];
      if (k < 1e-4) continue;
      const vc = Math.sqrt(this.o.cornerAccel / k);
      limit = Math.min(limit, Math.sqrt(vc * vc + 2 * m(2) * Math.max(0, path.cumulative[i] - s - m(3))));
    }
    return Math.max(limit, m(3));
  }

  /** Objects in path coordinates, predicted at constant velocity. */
  #predict(objects, path, ego) {
    const out = [];
    for (const obj of objects) {
      const pos = new Point(obj.x, obj.y);
      const proj = path.project(pos, ego.s - m(20), ego.s + m(80));
      if (!proj || proj.distance > m(12)) continue;
      const t = path.tangentAt(proj.s);
      const vs = obj.vx * t.x + obj.vy * t.y;
      // A car behind us in our lane is the follower's responsibility: planning
      // around it would only make us brake in front of it.
      if (proj.s < ego.s - m(2) && Math.abs(proj.lateral - ego.d) < m(1.6)) continue;
      const ahead = proj.s > ego.s && Math.abs(proj.lateral - ego.d) < m(2.5);
      out.push({ obj, s0: proj.s, d0: proj.lateral, vs, ahead });
    }
    return out;
  }

  #evaluate(c, ego, ctx) {
    const o = this.o;
    const w = o.weights;
    const path = this.route.path;
    const samples = [];
    let feasible = true;
    let why = '';
    let jerk = 0;
    let proximity = 0;
    let lag = 0; // shortfall against the desired speed profile
    let prevPoint = null;
    let prevHeading = null;
    for (let t = 0; t <= o.horizon + 1e-9; t += o.step) {
      const lon = c.longitudinal.at(t);
      const lat = c.lateral.at(t);
      // Stops end at rest: don't extrapolate past the stopping time.
      const s = c.kind.startsWith('stop') && t > c.longitudinal.T ? c.stop : lon.x;
      const v = c.kind.startsWith('stop') && t > c.longitudinal.T ? 0 : lon.v;
      const a = c.kind.startsWith('stop') && t > c.longitudinal.T ? 0 : lon.a;
      const point = path.pointAt(s).add(path.normalAt(s).scale(lat.x));
      const heading = prevPoint && point.distanceTo(prevPoint) > 0.5 ? point.subtract(prevPoint).angle() : prevHeading ?? path.tangentAt(s).angle();
      samples.push({ t, s, d: lat.x, v, a, point, heading });

      if (feasible) {
        if (v < -m(0.2)) (feasible = false), (why = 'reverses');
        else if (a > o.maxAccel * 1.05 || a < -o.maxBrake) (feasible = false), (why = 'too hard');
        else if (v > Math.min(ctx.speedLimit, ctx.curveAt(s)) * 1.15 + m(0.5) && t > 0.6) (feasible = false), (why = 'too fast');
        else if (lat.x < ctx.dMin - Math.max(0, ctx.dMin - ego.d + m(0.1)) * Math.max(0, 1 - t / 2.5) || lat.x > ctx.dMax + Math.max(0, ego.d - ctx.dMax + m(0.1)) * Math.max(0, 1 - t / 2.5)) {
          // (starting outside is fine, as long as it comes back within 2.5 s)
          feasible = false;
          why = 'leaves lanes';
        }
        else if (ctx.sStopLine !== null && s > ctx.sStopLine + m(0.5)) (feasible = false), (why = 'runs the stop');
        if (feasible && prevPoint && prevHeading !== null) {
          const ds = point.distanceTo(prevPoint);
          const dHeading = Math.abs(Math.atan2(Math.sin(heading - prevHeading), Math.cos(heading - prevHeading)));
          if (ds > 1 && v > m(2) && (v * v * dHeading) / ds > o.maxLateralAccel * 1.5) (feasible = false), (why = 'turns too hard');
        }
        if (feasible) {
          for (const p of ctx.predicted) {
            const ox = p.obj.x + p.obj.vx * t;
            const oy = p.obj.y + p.obj.vy * t;
            const dist = circlesDistance(point, heading, ox, oy, p.obj);
            const clearance = 2 * o.carRadius + o.safety;
            if (dist < clearance) {
              feasible = false;
              why = 'collides';
              c.collisionAt = t;
              break;
            }
            proximity += Math.exp(-(dist - clearance) / m(2)) * o.step;
          }
        }
      }
      jerk += (lon.j * lon.j + lat.j * lat.j) * o.step;
      lag += ((Math.max(0, ctx.profile(s) - v)) / Math.max(ctx.vLimit, 1)) ** 2 * o.step;
      prevPoint = point;
      prevHeading = heading;
    }

    const end = samples[samples.length - 1];
    const laneChange = Math.abs(c.dT - ego.d) > ctx.width * 0.5 ? 1 : 0;
    const cost =
      w.speed * lag * 4 +
      w.jerk * jerk / (m(1) * m(1)) +
      w.lane * ((c.dT - ctx.dPreferred) / ctx.width) ** 2 +
      w.change * laneChange +
      w.proximity * proximity +
      (c.kind === 'stop behind' ? w.stop : 0) +
      (c.kind === 'speed' ? 0 : w.stop * 0.5) * (ctx.sStopLine === null ? 1 : 0);
    return { ...c, samples, feasible, why, cost, endSpeed: end.v };
  }

  /** Nothing safe: brake as hard as allowed, holding the current offset. */
  #emergency(ego, width) {
    const samples = [];
    let s = ego.s;
    let v = Math.max(0, ego.vs);
    const path = this.route.path;
    for (let t = 0; t <= this.o.horizon + 1e-9; t += this.o.step) {
      const point = path.pointAt(s).add(path.normalAt(s).scale(ego.d));
      samples.push({ t, s, d: ego.d, v, a: v > 0 ? -this.o.maxBrake : 0, point, heading: path.tangentAt(s).angle() });
      s += v * this.o.step;
      v = Math.max(0, v - this.o.maxBrake * this.o.step);
    }
    return { kind: 'emergency', samples, feasible: true, cost: Infinity, why: 'no safe option', dT: ego.d, target: 0, T: 0, width };
  }

  draw(ctx, px, { all = true } = {}) {
    if (all) {
      for (const c of this.candidates) {
        if (c === this.best) continue;
        ctx.beginPath();
        c.samples.forEach((p, i) => (i ? ctx.lineTo(p.point.x, p.point.y) : ctx.moveTo(p.point.x, p.point.y)));
        ctx.strokeStyle = c.feasible ? 'rgba(48, 209, 88, 0.22)' : 'rgba(255, 69, 58, 0.18)';
        ctx.lineWidth = px;
        ctx.stroke();
      }
    }
    if (!this.best) return;
    ctx.beginPath();
    this.best.samples.forEach((p, i) => (i ? ctx.lineTo(p.point.x, p.point.y) : ctx.moveTo(p.point.x, p.point.y)));
    ctx.strokeStyle = this.best.kind === 'emergency' ? '#ff453a' : '#30d158';
    ctx.lineWidth = 3 * px;
    ctx.stroke();
    for (const p of this.best.samples) {
      ctx.beginPath();
      ctx.arc(p.point.x, p.point.y, 2 * px, 0, Math.PI * 2);
      ctx.fillStyle = '#30d158';
      ctx.fill();
    }
  }
}

/** Distance between the ego car (3 circles along its heading) and an object (3 circles along its velocity). */
function circlesDistance(point, heading, ox, oy, obj) {
  const f = { x: Math.cos(heading), y: Math.sin(heading) };
  const speed = Math.hypot(obj.vx, obj.vy);
  const g = speed > 1 ? { x: obj.vx / speed, y: obj.vy / speed } : f;
  let best = Infinity;
  for (const a of [-m(1.4), 0, m(1.4)]) {
    const ex = point.x + f.x * a;
    const ey = point.y + f.y * a;
    for (const b of [-m(1.4), 0, m(1.4)]) {
      const d = Math.hypot(ex - (ox + g.x * b), ey - (oy + g.y * b));
      if (d < best) best = d;
    }
  }
  return best;
}
