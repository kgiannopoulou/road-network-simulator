import { m, toMeters } from '../car/units.js';

/**
 * Week 27: the behaviour planner, the layer between the route and the
 * controls.
 *
 *   Route planner      "Turn left onto Street 3 in 120 m"
 *         ↓
 *   Behaviour planner  "Move into the left lane", "Stop at the line"
 *         ↓
 *   Trajectory planner a short future path (Week 28)
 *         ↓
 *   Driving controller steering, throttle, brake
 *
 * It turns the next maneuver, the junction rules (through the same
 * reservation system traffic uses, as a car would get signal phases over
 * V2I), pedestrian crossings and the destination into a small decision:
 * which lanes are allowed and preferred, how fast, and where to stop.
 */
export const BehaviorState = {
  FOLLOW_ROUTE: 'Follow route',
  PREPARE_LANE_CHANGE: 'Prepare lane change',
  APPROACH_JUNCTION: 'Approach junction',
  STOP_AT_LINE: 'Stop at line',
  WAIT_AT_LINE: 'Wait at line',
  CROSS_JUNCTION: 'Cross junction',
  YIELD_PEDESTRIAN: 'Yield to pedestrians',
  ARRIVING: 'Arriving',
  ARRIVED: 'Arrived',
};

const LANE_PREP_DISTANCE = m(160); // start moving into the turning lane this far ahead
const TURN_ZONE = m(22); // close to a turn: stay in the reference lane

export class BehaviorPlanner {
  constructor(route, city, { key, carLength }) {
    this.route = route;
    this.city = city;
    this.key = key; // identity used for junction reservations
    this.carLength = carLength;
    this.entered = new Set();
    this.decision = null;
  }

  /** ego: { s, d, v, position, heading }; returns the decision for this step. */
  update(ego, time) {
    const route = this.route;
    const k = route.edgeIndexAt(ego.s);
    const edge = route.edges[k];
    const lanes = edge.lanes.length;
    const width = edge.step.road.laneWidth;
    const refLane = route.lanePlan[k];
    const lane = clampLane(Math.round(refLane - ego.d / width), lanes);
    const mv = route.maneuvers[k] ?? null; // the move at the end of this edge
    const toManeuver = mv ? mv.s - ego.s : Infinity;
    const all = Array.from({ length: lanes }, (_, i) => i);

    const decision = {
      state: BehaviorState.FOLLOW_ROUTE,
      text: 'Follow the route',
      lane,
      refLane,
      allowedLanes: all,
      preferredLane: lane,
      stopAt: null,
      speedLimit: this.#speedLimit(k, ego.s),
      maneuver: mv,
      toManeuver,
      edgeIndex: k,
      instruction: this.#instruction(ego.s),
    };

    // Lanes: get into a lane that can make the next move, in good time.
    if (mv && toManeuver < LANE_PREP_DISTANCE) {
      const required = mv.lanes;
      if (!required.includes(lane)) {
        const target = required.reduce((a, b) => (Math.abs(b - lane) < Math.abs(a - lane) ? b : a));
        decision.state = BehaviorState.PREPARE_LANE_CHANGE;
        decision.text = `Move into the ${target > lane ? 'left' : 'right'} lane`;
        decision.preferredLane = target;
        decision.allowedLanes = all.filter((i) => (i - lane) * (target - lane) >= 0 && Math.abs(i - lane) <= Math.abs(target - lane));
      } else {
        decision.allowedLanes = required;
        decision.preferredLane = lane;
      }
    } else if (lane > 0) {
      decision.preferredLane = 0; // keep right when nothing else matters
    }
    // Near a turn, and through it, follow the reference lane exactly.
    const prev = route.maneuvers[k - 1];
    const inTurn = (mv && mv.turn !== 'straight' && toManeuver < TURN_ZONE) || (prev && prev.turn !== 'straight' && ego.s - prev.s < m(12));
    if (inTurn) {
      decision.allowedLanes = [refLane];
      decision.preferredLane = refLane;
      decision.turning = true;
    }

    this.#junction(decision, ego, k, mv, time);
    this.#crossings(decision, ego, k);
    this.#destination(decision, ego);
    this.#releaseJunctions(ego);
    this.decision = decision;
    return decision;
  }

  #speedLimit(k, s) {
    const route = this.route;
    let limit = route.edges[k].step.road.speedLimit;
    const next = route.edges[k + 1];
    if (next) {
      const d = Math.max(0, route.stepStarts[k + 1] - s);
      limit = Math.min(limit, Math.sqrt(next.step.road.speedLimit ** 2 + 2 * m(2.5) * d));
    }
    return limit;
  }

  #instruction(s) {
    const next = this.route.instructions.find((i) => i.s > s + m(1));
    if (!next) return 'You have arrived';
    const d = toMeters(next.s - s);
    return next.turn === 'arrive' ? `Destination in ${Math.round(d)} m` : `${next.text} in ${Math.round(d / 10) * 10} m`;
  }

  /** Junction rules: ask the junction for our movement, stop at the line if refused. */
  #junction(decision, ego, k, mv, time) {
    if (!mv || !mv.junction?.isIntersection) return;
    const junction = mv.junction;
    const step = this.route.steps[k];
    const arm = junction.armOf(step);
    if (!arm) return;
    const linePoint = junction.node.add(arm.away.scale(arm.stopDistance));
    const sLine = this.route.path.project(linePoint, mv.s - m(80), mv.s + m(2))?.s ?? mv.s - arm.stopDistance;
    const front = ego.s + this.carLength / 2;
    const dist = sLine - front;
    if (dist > m(70) || dist < -m(15)) return;

    const movement = this.city.movement(step, decision.lane, this.route.steps[k + 1]);
    if (!movement) {
      // Wrong lane at the junction: wait at the line (the lane change keeps trying).
      if (dist < m(25)) {
        decision.stopAt = sLine;
        decision.state = BehaviorState.STOP_AT_LINE;
        decision.text = 'Wrong lane: waiting to merge';
      }
      return;
    }
    const go = junction.request(this.key, movement, dist, Math.max(0, ego.v), time);
    if (go && junction.occupants.has(this.key)) this.entered.add(junction);
    if (!go) {
      decision.stopAt = sLine;
      const waiting = ego.v < m(0.3) && dist < m(4);
      decision.state = waiting ? BehaviorState.WAIT_AT_LINE : BehaviorState.STOP_AT_LINE;
      decision.text = reason(junction, arm, waiting);
      return;
    }
    if (dist < m(30)) {
      decision.state = dist < 0 ? BehaviorState.CROSS_JUNCTION : BehaviorState.APPROACH_JUNCTION;
      const turn = mv.turn === 'straight' ? 'Go straight' : mv.turn === 'left' ? 'Turn left' : mv.turn === 'right' ? 'Turn right' : 'Continue';
      decision.text = `${turn} (${junction.signals ? 'green' : 'clear'})`;
    }
  }

  #releaseJunctions(ego) {
    for (const junction of this.entered) {
      const clearance = Math.max(...junction.arms.map((a) => a.stopDistance)) + this.carLength;
      const behind = junction.node.subtract(ego.position).dot({ x: Math.cos(ego.heading), y: Math.sin(ego.heading) }) < 0;
      if (behind && junction.node.distanceTo(ego.position) > clearance) {
        junction.release(this.key);
        this.entered.delete(junction);
      }
    }
  }

  releaseAll() {
    for (const junction of this.entered) junction.release(this.key);
    this.entered.clear();
  }

  #crossings(decision, ego, k) {
    for (const i of [k, k + 1]) {
      const step = this.route.steps[i];
      if (!step) continue;
      const crossing = this.city.crossingOn(step.road);
      if (!crossing || !crossing.occupied) continue;
      const at = this.route.stepStarts[i] + crossing.distanceFromStart(step.dir);
      const stopAt = at - crossing.depth / 2 - m(2);
      const front = ego.s + this.carLength / 2;
      if (stopAt - front < -m(1) || stopAt - front > m(45)) continue;
      const braking = (ego.v * ego.v) / (2 * m(6));
      if (stopAt - front < braking * 0.6) continue; // too late to stop: carry on
      if (decision.stopAt === null || stopAt < decision.stopAt) {
        decision.stopAt = stopAt;
        decision.state = BehaviorState.YIELD_PEDESTRIAN;
        decision.text = 'Pedestrian on the crossing';
      }
    }
  }

  #destination(decision, ego) {
    const left = this.route.sGoal - ego.s;
    if (left > m(60)) return;
    if (decision.stopAt === null || this.route.sGoal - this.carLength / 2 < decision.stopAt) {
      decision.stopAt = this.route.sGoal + this.carLength / 2; // stop with the car centred on the destination
    }
    decision.state = left < m(3) && ego.v < m(0.5) ? BehaviorState.ARRIVED : BehaviorState.ARRIVING;
    decision.text = decision.state === BehaviorState.ARRIVED ? 'Arrived' : `Arriving in ${Math.max(0, Math.round(toMeters(left)))} m`;
    decision.preferredLane = decision.lane;
  }
}

function reason(junction, arm, waiting) {
  if (arm.rule === 'signal') {
    const light = junction.signals.state(arm.index);
    return light === 'green' ? 'Green, but yielding' : `${light === 'red' ? 'Red' : 'Yellow'} light: ${waiting ? 'waiting' : 'stopping'}`;
  }
  if (arm.rule === 'stop') return waiting ? 'Stop sign: waiting for a gap' : 'Stop sign: full stop';
  if (arm.rule === 'yield') return 'Yield sign: giving way';
  if (arm.rule === 'right') return 'Giving way to the right';
  return 'Junction busy: waiting';
}

function clampLane(lane, count) {
  return Math.max(0, Math.min(count - 1, lane));
}

