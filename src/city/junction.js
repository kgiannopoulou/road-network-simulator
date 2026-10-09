import { m } from '../car/units.js';
import { isFreeway } from '../road/roadTypes.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { SignalController } from './signals.js';

/**
 * Week 21: a node where roads meet, with its lane connections, its control
 * rule and its occupancy.
 *
 * kinds          continuation (2 roads), T, cross (4), multi (5+),
 *                merge (one-way roads joining, e.g. an on-ramp),
 *                diverge (one-way road splitting, e.g. an exit)
 * controls       signals, allStop, stop / yield (on the minor roads),
 *                uncontrolled (priority to the right), free (merges,
 *                exits and plain continuations)
 * movements      in arm + in lane → out arm + out lane, with a turn type
 *                (right / straight / left / merge / exit). Lanes are counted
 *                from the right-hand kerb (0) in the direction of travel.
 * occupancy      a car must be granted a movement before entering; no two
 *                granted movements may conflict (cross or merge in the box).
 */
export const CONTROLS = ['auto', 'signals', 'allStop', 'stop', 'yield', 'uncontrolled'];
export const CONTROL_LABELS = {
  auto: 'Automatic',
  signals: 'Traffic lights',
  allStop: 'All-way stop',
  stop: 'Stop signs (minor road)',
  yield: 'Yield signs (minor road)',
  uncontrolled: 'Priority to the right',
  free: 'Free flow',
};

const YIELD_TTA = 4; // s: cars closer than this to the junction have right of way
const COMFORT_BRAKE = m(3); // used for "can I still stop at yellow?"
const CONFLICT_DISTANCE = m(2.4);

export class Junction {
  constructor(node, roads, planner, { index = 0, control = null } = {}) {
    this.node = node;
    this.index = index;
    this.planner = planner;
    this.arms = this.#buildArms(roads);
    this.kind = this.#classify();
    this.control = this.#chooseControl(control);
    this.override = control;
    for (const arm of this.arms) arm.rule = this.#ruleFor(arm);
    this.signals =
      this.control === 'signals' ? new SignalController(this.arms, { offset: (index * 0.37) % 1 }) : null;

    this.movements = new Map(); // key → movement
    this.#buildMovements();
    this.#findConflicts();

    this.occupants = new Map(); // driver → { movement, since }
    this.waiting = new Map(); // driver → { movement, arm, dist, speed, seen, arrivedAt, stoppedSince }
  }

  get isIntersection() {
    return ['T', 'cross', 'multi'].includes(this.kind);
  }

  // ---- structure ---------------------------------------------------------------

  #buildArms(roads) {
    const node = this.node;
    return roads.map((road, index) => {
      const atEnd = road.segment.p2 === node; // the road arrives here in its forward direction
      const away = road.segment.otherEnd(node).subtract(node).normalize();
      const inStep = { road, dir: atEnd ? 1 : -1 };
      const outStep = { road, dir: atEnd ? -1 : 1 };
      return {
        index,
        road,
        angle: away.angle(),
        away,
        inStep,
        outStep,
        inLanes: RoutePlanner.laneCount(inStep),
        outLanes: RoutePlanner.laneCount(outStep),
        priority: (isFreeway(road.type) ? 10 : 0) + road.laneCount,
        stopDistance: 0,
        major: false,
        rule: 'free',
      };
    });
  }

  #classify() {
    const n = this.arms.length;
    const ins = this.arms.filter((a) => a.inLanes > 0);
    const outs = this.arms.filter((a) => a.outLanes > 0);
    if (n <= 1) return 'deadEnd';
    if (n === 2) return 'continuation';
    const oneWay = this.arms.every((a) => a.road.oneWay);
    if (oneWay && ins.length >= 2 && outs.length === 1) return 'merge';
    if (oneWay && ins.length === 1 && outs.length >= 2) return 'diverge';
    if (this.arms.some((a) => isFreeway(a.road.type)) && (ins.length === 1 || outs.length === 1)) {
      return outs.length === 1 ? 'merge' : 'diverge';
    }
    return n === 3 ? 'T' : n === 4 ? 'cross' : 'multi';
  }

  /** Major arms: the highest-priority pair of roughly opposite arms (the through road). */
  #markMajor() {
    let best = null;
    for (const a of this.arms) {
      for (const b of this.arms) {
        if (a.index >= b.index) continue;
        const straightness = Math.abs(Math.abs(wrap(a.angle - b.angle)) - Math.PI);
        if (straightness > Math.PI / 4) continue;
        const score = a.priority + b.priority - straightness;
        if (!best || score > best.score) best = { a, b, score };
      }
    }
    if (best) best.a.major = best.b.major = true;
    return best;
  }

  #chooseControl(override) {
    if (!this.isIntersection) return 'free';
    const majors = this.#markMajor();
    // Stop lines: far enough out that a car waiting there clears every other road.
    for (const arm of this.arms) {
      let d = 0;
      for (const other of this.arms) {
        if (other === arm) continue;
        const sin = Math.abs(Math.sin(other.angle - arm.angle));
        d = Math.max(d, other.road.width / 2 / Math.max(sin, 0.4) + (arm.road.width / 2) * Math.abs(Math.cos(other.angle - arm.angle)) * 0.3);
      }
      arm.stopDistance = Math.min(d + m(1.5), arm.road.segment.length() * 0.4);
    }
    if (override && override !== 'auto') return override;
    const widest = Math.max(...this.arms.map((a) => a.road.laneCount));
    if (this.kind === 'cross' || this.kind === 'multi') return widest >= 4 ? 'signals' : 'allStop';
    // T-junction: lights where an avenue meets an avenue, otherwise signs on the stem.
    const stem = this.arms.find((a) => !a.major);
    if (!majors || !stem) return 'allStop';
    if (stem.road.laneCount >= 4 && majors.a.road.laneCount >= 4) return 'signals';
    return majors.a.road.laneCount >= 4 ? 'stop' : 'yield';
  }

  #ruleFor(arm) {
    switch (this.control) {
      case 'signals':
        return 'signal';
      case 'allStop':
        return 'stop';
      case 'stop':
        return arm.major ? 'priority' : 'stop';
      case 'yield':
        return arm.major ? 'priority' : 'yield';
      case 'uncontrolled':
        return 'right';
      default:
        return 'free';
    }
  }

  // ---- lane connections -----------------------------------------------------------

  /** Turn from heading in (towards the node along `from`) to heading out along `to`. */
  turnBetween(from, to) {
    const headingIn = from.angle + Math.PI;
    const delta = wrap(to.angle - headingIn);
    if (Math.abs(delta) < Math.PI / 5) return 'straight';
    return delta > 0 ? 'right' : 'left';
  }

  #buildMovements() {
    const add = (from, inLane, to, outLane, turn) => {
      const key = movementKey(from.index, inLane, to.index, outLane);
      this.movements.set(key, { key, from: from.index, inLane, to: to.index, outLane, turn, conflicts: new Set(), points: null });
    };
    const ins = this.arms.filter((a) => a.inLanes > 0);
    const outs = this.arms.filter((a) => a.outLanes > 0);

    if (this.kind === 'continuation') {
      const [a, b] = this.arms;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        if (!from.inLanes || !to.outLanes) continue;
        const drop = from.inLanes - to.outLanes;
        // Freeways add/drop lanes on the right (acceleration and exit lanes), streets on the left.
        const right = isFreeway(from.road.type) && isFreeway(to.road.type);
        const turn = this.turnBetween(from, to); // a corner between two roads is still a turn
        for (let i = 0; i < from.inLanes; i++) {
          const target = right ? i - drop : i;
          if (target >= 0 && target < to.outLanes) add(from, i, to, target, turn);
        }
      }
      return;
    }

    if (this.kind === 'merge') {
      const out = outs[0];
      const heading = out.away;
      const rightOf = { x: -heading.y, y: heading.x };
      const ordered = ins.sort((p, q) => dot(q.away, rightOf) - dot(p.away, rightOf)); // rightmost first
      let base = 0;
      for (const from of ordered) {
        for (let i = 0; i < from.inLanes; i++) add(from, i, out, Math.min(base + i, out.outLanes - 1), 'merge');
        base += from.inLanes;
      }
      return;
    }

    if (this.kind === 'diverge') {
      const from = ins[0];
      const heading = { x: -from.away.x, y: -from.away.y };
      const rightOf = { x: -heading.y, y: heading.x };
      const ordered = outs.filter((o) => o !== from).sort((p, q) => dot(q.away, rightOf) - dot(p.away, rightOf));
      ordered.forEach((to, k) => {
        if (k === 0 && ordered.length > 1) {
          // The exit: from the right-hand lane(s) only.
          for (let i = 0; i < Math.min(to.outLanes, from.inLanes); i++) add(from, i, to, i, 'exit');
        } else {
          const shift = Math.max(0, from.inLanes - to.outLanes);
          for (let i = 0; i < from.inLanes; i++) add(from, i, to, Math.max(0, Math.min(to.outLanes - 1, i - shift)), 'straight');
        }
      });
      return;
    }

    // Intersections: turning lanes. Right turns from the right-hand lane,
    // left turns from the left-hand lane, straight from the rest (with three
    // or more lanes the leftmost lane is a dedicated left-turn lane).
    for (const from of ins) {
      // Hairpins sharper than 135° aren't drivable movements (like U-turns).
      const turns = outs
        .filter((o) => o !== from && Math.abs(wrap(o.angle - (from.angle + Math.PI))) < (Math.PI * 3) / 4)
        .map((to) => ({ to, turn: this.turnBetween(from, to) }));
      const hasLeft = turns.some((t) => t.turn === 'left');
      const n = from.inLanes;
      for (const { to, turn } of turns) {
        if (turn === 'right') add(from, 0, to, 0, turn);
        else if (turn === 'left') add(from, n - 1, to, to.outLanes - 1, turn);
        else {
          const last = n >= 3 && hasLeft ? n - 2 : n - 1;
          for (let i = 0; i <= last; i++) add(from, i, to, Math.min(i, to.outLanes - 1), turn);
        }
      }
    }
  }

  /** Two movements conflict when their paths through the junction come within a car width. */
  #findConflicts() {
    if (!this.isIntersection && this.kind !== 'merge') return;
    const radius = Math.max(...this.arms.map((a) => a.stopDistance), m(8)) + m(2);
    for (const mv of this.movements.values()) {
      const from = this.arms[mv.from];
      const to = this.arms[mv.to];
      const { path } = this.planner.buildPath([from.inStep, to.outStep], [mv.inLane, mv.outLane]);
      // Resample evenly: a straight movement is one long segment whose
      // vertices both lie outside the box.
      mv.points = [];
      for (let d = 0; d <= path.length; d += m(0.5)) {
        const p = path.pointAt(d);
        if (p.distanceTo(this.node) <= radius) mv.points.push(p);
      }
      mv.path = path;
    }
    const list = [...this.movements.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.from === b.from && a.inLane === b.inLane) continue; // same queue
        if (a.from === b.from && a.to !== b.to && a.outLane !== b.outLane) continue; // side by side, splitting
        if (closest(a.points, b.points) < CONFLICT_DISTANCE) {
          a.conflicts.add(b.key);
          b.conflicts.add(a.key);
        }
      }
    }
  }

  armOf(step) {
    return this.arms.find((a) => a.road === step.road && a.inStep.dir === step.dir) ?? null;
  }

  armTo(step) {
    return this.arms.find((a) => a.road === step.road && a.outStep.dir === step.dir) ?? null;
  }

  /** Movements possible from an in-step to an out-step. */
  movementsBetween(inStep, outStep) {
    const from = this.armOf(inStep);
    const to = this.armTo(outStep);
    if (!from || !to) return [];
    return [...this.movements.values()].filter((mv) => mv.from === from.index && mv.to === to.index);
  }

  /** Movements possible from a lane of an in-step (for re-routing). */
  movementsFromLane(inStep, lane) {
    const from = this.armOf(inStep);
    if (!from) return [];
    return [...this.movements.values()].filter((mv) => mv.from === from.index && mv.inLane === lane);
  }

  /** Turn-arrow summary per lane of an arm: lane → Set(turns). */
  laneTurns(arm) {
    const turns = Array.from({ length: arm.inLanes }, () => new Set());
    for (const mv of this.movements.values()) if (mv.from === arm.index) turns[mv.inLane].add(mv.turn);
    return turns;
  }

  // ---- runtime ----------------------------------------------------------------------

  update(dt, time) {
    this.signals?.update(dt);
    for (const [driver, entry] of this.waiting) if (time - entry.seen > 0.25) this.waiting.delete(driver);
    for (const [driver, occ] of this.occupants) {
      if (driver.finished || time - occ.since > 25) this.occupants.delete(driver);
    }
  }

  /**
   * May this driver enter with `movement`? Called every frame while it
   * approaches; `dist` is the distance from its front bumper to the stop line.
   * Returns true to keep going, false to stop at the line.
   */
  request(driver, movement, dist, speed, time) {
    const arm = this.arms[movement.from];
    if (this.occupants.has(driver)) {
      // A reservation made on green lapses if the light changes before the
      // car reaches the line and it can still stop comfortably.
      const light = arm.rule === 'signal' ? this.signals.state(arm.index) : 'green';
      const canStop = dist > m(1) && dist > (speed * speed) / (2 * COMFORT_BRAKE);
      if (light === 'green' || !canStop) return true;
      this.occupants.delete(driver);
    }
    if (arm.rule === 'free') return true;

    let entry = this.waiting.get(driver);
    if (!entry) {
      entry = { arrivedAt: time, stoppedSince: null };
      this.waiting.set(driver, entry);
    }
    Object.assign(entry, { movement, arm: movement.from, dist, speed, seen: time });
    const nearLine = dist < m(5);
    if (nearLine && speed < m(0.5)) entry.stoppedSince ??= time;
    else if (!nearLine) entry.stoppedSince = null;

    let allowed = this.#ruleAllows(driver, entry, arm, movement, dist, speed, time);
    if (allowed && this.#boxConflict(movement)) allowed = false;

    // Reserve once close enough that the decision can't be undone safely.
    const grantDistance = Math.max(m(6), (speed * speed) / (2 * COMFORT_BRAKE) + m(3));
    if (allowed && dist < grantDistance) {
      this.occupants.set(driver, { movement, since: time });
      this.waiting.delete(driver);
    }
    return allowed;
  }

  release(driver) {
    this.occupants.delete(driver);
    this.waiting.delete(driver);
  }

  #ruleAllows(driver, entry, arm, movement, dist, speed, time) {
    switch (arm.rule) {
      case 'signal': {
        const light = this.signals.state(arm.index);
        // A left-turner already waiting at the line clears the junction at the
        // end of its green, when oncoming traffic has stopped.
        if (movement.turn === 'left' && entry.stoppedSince !== null && this.signals.clearing(arm.index)) return true;
        if (light === 'red') return dist < -m(0.5); // already over the line
        if (light === 'yellow') return dist < (speed * speed) / (2 * COMFORT_BRAKE * 1.3);
        // Green: a permitted left turn yields to oncoming traffic.
        if (movement.turn === 'left') return !this.#mustYield(driver, entry, movement, time, (other) => this.signals.state(other.arm) !== 'red');
        return true;
      }
      case 'stop': {
        if (entry.stoppedSince === null || time - entry.stoppedSince < 0.6) return false;
        if (this.control === 'allStop') return !this.#earlierWaiter(driver, entry, movement);
        return !this.#mustYield(driver, entry, movement, time, (other) => this.arms[other.arm].major);
      }
      case 'yield':
        return !this.#mustYield(driver, entry, movement, time, (other) => this.arms[other.arm].major);
      case 'priority':
        // Turning left across the other half of the main road: yield to it.
        if (movement.turn === 'left') return !this.#mustYield(driver, entry, movement, time, (other) => this.arms[other.arm].major);
        return true;
      case 'right': {
        if (entry.stoppedSince !== null && time - entry.stoppedSince > 5) return true; // deadlock breaker
        return !this.#mustYield(driver, entry, movement, time, (other) => this.#isToTheRight(arm, this.arms[other.arm]));
      }
      default:
        return true;
    }
  }

  /** A conflicting car with right of way (per `hasPriority`) arriving within YIELD_TTA? */
  #mustYield(driver, entry, movement, time, hasPriority) {
    for (const [other, o] of this.waiting) {
      if (other === driver || o.arm === entry.arm || time - o.seen > 0.25) continue;
      if (!movement.conflicts.has(o.movement.key) || !hasPriority(o)) continue;
      const tta = Math.max(0, o.dist) / Math.max(o.speed, m(0.5));
      if (tta < YIELD_TTA && !(o.stoppedSince !== null && this.arms[o.arm].rule === 'stop')) return true;
    }
    for (const occ of this.occupants.values()) {
      if (movement.conflicts.has(occ.movement.key)) return true;
    }
    return false;
  }

  /** All-way stop: first come, first served among cars stopped at their lines. */
  #earlierWaiter(driver, entry, movement) {
    for (const [other, o] of this.waiting) {
      if (other === driver || o.stoppedSince === null) continue;
      if (o.stoppedSince < entry.stoppedSince && movement.conflicts.has(o.movement.key)) return true;
    }
    return false;
  }

  #boxConflict(movement) {
    for (const occ of this.occupants.values()) if (movement.conflicts.has(occ.movement.key)) return true;
    return false;
  }

  /** Is arm `b` on the right of a driver arriving along arm `a`? */
  #isToTheRight(a, b) {
    const headingIn = a.angle + Math.PI;
    const delta = wrap(b.angle - headingIn);
    return delta > 0 && delta < Math.PI * 0.9;
  }

  /** World position and direction of an arm's stop line (centre of its incoming lanes). */
  stopLine(arm) {
    const { road } = arm;
    const along = arm.away;
    const base = this.node.add(along.scale(arm.stopDistance));
    const right = { x: -along.y, y: along.x }; // looking away from the node
    // Incoming lanes sit on the left of `along` (they travel towards the node on their right).
    const offsets = Array.from({ length: arm.inLanes }, (_, lane) => -RoutePlanner.travelOffset(arm.inStep, lane));
    return { base, along, right, offsets, laneWidth: road.laneWidth };
  }
}

export function movementKey(from, inLane, to, outLane) {
  return `${from}:${inLane}>${to}:${outLane}`;
}

function closest(a, b) {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, p.distanceTo(q));
  return best;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
