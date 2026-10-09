import { m, toMeters } from '../car/units.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { findRoute } from './pathfinding.js';

// The car's tightest turning circle is ~4.7 m (2.7 m wheelbase, 35° lock), so
// the reference path's corners must be a little wider than that.
const MIN_TURN_RADIUS = m(5.5);

const TURN_TEXT = {
  left: 'Turn left',
  right: 'Turn right',
  exit: 'Take the exit',
  merge: 'Merge',
  straight: 'Continue',
};

/**
 * A route ready to drive: the edges found by the search plus everything the
 * lower layers need.
 *
 *   lanePlan     per edge, the lane the car should be in to make the next
 *                move (from the junction's lane connections)
 *   path         the lane-level reference path through all of it (the
 *                Frenet frame for trajectory planning)
 *   maneuvers    each junction on the way: where (path s), which turn,
 *                which lanes can make it
 *   instructions turn-by-turn text ("Turn left onto Street 3")
 */
export class Route {
  constructor(graph, result, { startLane = 0 } = {}) {
    this.graph = graph;
    this.result = result;
    this.edges = result.edges;
    this.transitions = result.transitions;
    this.steps = this.edges.map((e) => e.step);
    const city = graph.city;

    // Lane plan: from the start lane, move to a lane that can make each turn;
    // after the turn we are in the lane the connection leads to.
    this.lanePlan = [];
    let lane = startLane;
    for (let i = 0; i < this.edges.length; i++) {
      const t = this.transitions[i];
      if (t) {
        const target = t.lanes.reduce((a, b) => (Math.abs(b - lane) < Math.abs(a - lane) ? b : a));
        this.lanePlan.push(target);
        lane = city.movement(this.steps[i], target, this.steps[i + 1])?.outLane ?? 0;
      } else {
        this.lanePlan.push(Math.min(lane, this.edges[i].lanes.length - 1));
      }
    }

    const planner = new RoutePlanner(city.roads, { minRadius: MIN_TURN_RADIUS });
    const { path, stepStarts } = planner.buildPath(this.steps, this.lanePlan);
    this.path = path;
    this.stepStarts = stepStarts;
    this.start = this.#pointOn(result.start);
    this.goal = this.#pointOn(result.goal);
    this.sStart = path.project(this.start, 0, m(result.start.s) + m(10)).s;
    const lastStart = stepStarts[stepStarts.length - 1];
    this.sGoal = path.project(this.goal, lastStart - m(5), path.length).s;

    this.maneuvers = this.transitions.map((t, i) => {
      const from = this.edges[i];
      const to = this.edges[i + 1];
      return {
        index: i,
        s: stepStarts[i + 1],
        turn: t.turn,
        lanes: t.lanes,
        controlled: t.controlled,
        node: from.toPoint,
        from: from.name,
        to: to.name,
        junction: city.junctionAt(from.toPoint),
      };
    });
    this.instructions = this.#instructions();
  }

  static find(graph, start, goal, options = {}) {
    const result = findRoute(graph, start, goal, options);
    return result ? new Route(graph, result, { startLane: start.lane ?? 0 }) : null;
  }

  get distance() {
    return this.result.distance;
  }

  get time() {
    return this.result.time;
  }

  /** Index of the edge being driven at path position s. */
  edgeIndexAt(s) {
    let i = 0;
    while (i + 1 < this.stepStarts.length && this.stepStarts[i + 1] <= s) i++;
    return i;
  }

  /** The next maneuver at or after path position s. */
  nextManeuver(s) {
    return this.maneuvers.find((mv) => mv.s > s - m(2)) ?? null;
  }

  #pointOn({ edge, s }) {
    return edge.fromPoint.add(edge.toPoint.subtract(edge.fromPoint).scale(s / edge.length));
  }

  #instructions() {
    const out = [{ s: this.sStart, text: `Head off on ${this.edges[0].name}`, turn: 'start' }];
    for (const mv of this.maneuvers) {
      const intersection = mv.junction?.isIntersection;
      if (mv.turn === 'straight' && (mv.from === mv.to || !intersection)) continue;
      const verb = TURN_TEXT[mv.turn] ?? 'Continue';
      const text = mv.turn === 'straight' ? `Continue onto ${mv.to}` : mv.turn === 'merge' ? `Merge onto ${mv.to}` : `${verb} onto ${mv.to}`;
      out.push({ s: mv.s, text, turn: mv.turn });
    }
    out.push({ s: this.sGoal, text: 'Arrive at your destination', turn: 'arrive' });
    return out;
  }

  /** Remaining metres from path position s to the destination. */
  remaining(s) {
    return Math.max(0, toMeters(this.sGoal - s));
  }

  draw(ctx, px, { progress = null } = {}) {
    const from = progress ?? this.sStart;
    ctx.beginPath();
    let first = true;
    for (let s = from; s <= this.sGoal; s += m(1)) {
      const p = this.path.pointAt(s);
      if (first) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
      first = false;
    }
    const end = this.path.pointAt(this.sGoal);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = 'rgba(57, 135, 229, 0.55)';
    ctx.lineWidth = Math.max(m(1.6), 5 * px);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    // Maneuver markers.
    for (const mv of this.maneuvers) {
      if (mv.turn === 'straight' || mv.s < from) continue;
      const p = this.path.pointAt(mv.s);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(m(1.2), 5 * px), 0, Math.PI * 2);
      ctx.fillStyle = mv.turn === 'left' ? '#ff9f0a' : mv.turn === 'right' ? '#30d158' : '#64d2ff';
      ctx.fill();
    }
  }
}
