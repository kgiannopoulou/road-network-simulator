import { m, toKmh } from '../car/units.js';
import { getIntersection } from '../math/utils.js';
import { Point } from '../primitives/point.js';
import { LaneIndex } from '../traffic/laneIndex.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { Crossing } from './crossings.js';
import { Junction } from './junction.js';

/**
 * Phase 6: everything that turns a road network into a city.
 *
 *   junctions    one per node (Week 21): lane connections, control, occupancy
 *   signals      traffic lights inside signalised junctions (Week 22)
 *   crossings    zebra crossings with pedestrians on flagged roads (Week 22)
 *   lanes        the lane graph (Week 23): lane IDs, centrelines, left/right
 *                neighbours and successors through junctions
 *   laneIndex    which car is in which lane right now (lane changes)
 *   violations   red lights run and speeding by the player's car
 */
export class City {
  constructor(network, graph, { seed = 3 } = {}) {
    this.network = network;
    this.graph = graph;
    this.roads = network.roads;
    this.planner = new RoutePlanner(this.roads);
    this.laneIndex = new LaneIndex(this.roads);
    this.time = 0;
    this.violations = { redLights: 0, speedingTime: 0, events: [] };
    this.playerLimit = null;
    this.playerSpeeding = false;

    const roadsAtNode = new Map();
    for (const road of this.roads) {
      for (const p of [road.segment.p1, road.segment.p2]) {
        if (!roadsAtNode.has(p)) roadsAtNode.set(p, []);
        roadsAtNode.get(p).push(road);
      }
    }
    this.junctions = new Map();
    let index = 0;
    for (const [node, roads] of roadsAtNode) {
      this.junctions.set(node, new Junction(node, roads, this.planner, { index: index++, control: graph.controls?.get(node) ?? null }));
    }
    this.crossings = this.roads.filter((r) => r.segment.crossing).map((road, i) => new Crossing(road, { seed: seed * 100 + i }));
    this.crossingByRoad = new Map(this.crossings.map((c) => [c.road, c]));
    this.lanes = this.#buildLaneGraph();
  }

  get intersections() {
    return [...this.junctions.values()].filter((j) => j.isIntersection);
  }

  junctionAt(node) {
    return this.junctions.get(node) ?? null;
  }

  // ---- lane connections (used by route planning and drivers) ---------------------

  /** Movement from `laneIn` of `stepIn` onto `stepOut`, or null when that lane can't go there. */
  movement(stepIn, laneIn, stepOut) {
    const junction = this.junctionAt(RoutePlanner.end(stepIn));
    return junction?.movementsBetween(stepIn, stepOut).find((mv) => mv.inLane === laneIn) ?? null;
  }

  /** Lanes of `stepIn` from which `stepOut` can be reached. */
  allowedLanes(stepIn, stepOut) {
    const junction = this.junctionAt(RoutePlanner.end(stepIn));
    if (!junction) return [];
    return [...new Set(junction.movementsBetween(stepIn, stepOut).map((mv) => mv.inLane))].sort((a, b) => a - b);
  }

  /** Lane plan along a route starting in `lane`: follow each lane connection. */
  lanePlan(steps, lane) {
    const plan = [lane];
    for (let i = 0; i < steps.length - 1; i++) {
      let current = plan[i];
      let mv = this.movement(steps[i], current, steps[i + 1]);
      if (!mv) {
        // The car will change lanes before the junction: plan from the nearest allowed lane.
        const allowed = this.allowedLanes(steps[i], steps[i + 1]);
        if (allowed.length) {
          current = allowed.reduce((a, b) => (Math.abs(b - current) < Math.abs(a - current) ? b : a));
          mv = this.movement(steps[i], current, steps[i + 1]);
        }
      }
      plan.push(mv ? mv.outLane : Math.min(current, RoutePlanner.laneCount(steps[i + 1]) - 1));
    }
    return plan;
  }

  crossingOn(road) {
    return this.crossingByRoad.get(road) ?? null;
  }

  laneId(step, lane) {
    return `L${this.roads.indexOf(step.road)}${step.dir > 0 ? 'F' : 'B'}${lane}`;
  }

  #buildLaneGraph() {
    const lanes = new Map();
    for (const step of this.planner.allSteps()) {
      const count = RoutePlanner.laneCount(step);
      for (let i = 0; i < count; i++) {
        const id = this.laneId(step, i);
        const line = RoutePlanner.laneLine(step, i);
        lanes.set(id, {
          id,
          step,
          index: i,
          centerline: [line.a, line.b],
          length: line.a.distanceTo(line.b),
          left: i + 1 < count ? this.laneId(step, i + 1) : null,
          right: i > 0 ? this.laneId(step, i - 1) : null,
          speedLimit: step.road.speedLimitKmh,
          successors: [],
        });
      }
    }
    for (const lane of lanes.values()) {
      const junction = this.junctionAt(RoutePlanner.end(lane.step));
      if (!junction) continue;
      for (const mv of junction.movementsFromLane(lane.step, lane.index)) {
        const to = junction.arms[mv.to];
        lane.successors.push({ id: this.laneId(to.outStep, mv.outLane), turn: mv.turn });
      }
    }
    return lanes;
  }

  // ---- per frame ----------------------------------------------------------------------

  update(dt, time, cars, player = null) {
    this.time = time;
    for (const j of this.junctions.values()) j.update(dt, time);
    for (const c of this.crossings) c.update(dt);
    this.laneIndex.rebuild(cars);
    if (player) this.#watchPlayer(player, dt);
  }

  /** Red lights run and speeding, for the player's HUD. */
  #watchPlayer(car, dt) {
    const pos = car.position;
    const prev = this.lastPlayerPos ?? pos;
    this.lastPlayerPos = pos;
    const info = car.laneInfo;
    this.playerLimit = info ? info.road.speedLimitKmh : null;
    this.playerSpeeding = !!this.playerLimit && toKmh(Math.abs(car.speed)) > this.playerLimit * 1.1 + 2;
    if (this.playerSpeeding) this.violations.speedingTime += dt;

    if (prev === pos || prev.distanceTo(pos) < 1e-6) return;
    const heading = pos.subtract(prev).normalize();
    for (const j of this.intersections) {
      if (!j.signals || j.node.distanceTo(pos) > m(40)) continue;
      for (const arm of j.arms) {
        if (!arm.inLanes || j.signals.state(arm.index) !== 'red') continue;
        if (heading.dot(arm.away) > -0.4) continue; // not driving towards the junction
        const line = j.stopLine(arm);
        const half = (arm.inLanes * line.laneWidth) / 2;
        const mid = line.offsets.reduce((a, b) => a + b, 0) / line.offsets.length;
        const c = line.base.add(new Point(line.right.x, line.right.y).scale(mid));
        const r = new Point(line.right.x, line.right.y).scale(half);
        if (getIntersection(prev, pos, c.subtract(r), c.add(r))) {
          this.violations.redLights++;
          this.violations.events.push({ type: 'red light', time: this.time });
        }
      }
    }
  }

  stats() {
    let occupants = 0;
    let waiting = 0;
    for (const j of this.junctions.values()) {
      occupants += j.occupants.size;
      waiting += j.waiting.size;
    }
    const pedestrians = this.crossings.reduce((n, c) => n + c.pedestrians.length, 0);
    return { intersections: this.intersections.length, signals: this.intersections.filter((j) => j.signals).length, occupants, waiting, pedestrians, lanes: this.lanes.size };
  }

  // ---- drawing ----------------------------------------------------------------------

  draw(ctx, px, { lanes = false } = {}) {
    for (const c of this.crossings) c.draw(ctx, px);
    for (const j of this.intersections) this.#drawJunction(ctx, j, px);
    this.#drawSpeedSigns(ctx, px);
    if (lanes) this.#drawLanes(ctx, px);
  }

  #drawJunction(ctx, j, px) {
    for (const arm of j.arms) {
      if (!arm.inLanes) continue;
      const line = j.stopLine(arm);
      const right = new Point(line.right.x, line.right.y);
      const lw = line.laneWidth;
      const turns = j.laneTurns(arm);

      // Turn arrows on each approach lane.
      const back = arm.away.scale(arm.stopDistance + m(7));
      line.offsets.forEach((off, lane) => {
        const c = j.node.add(back).add(right.scale(off));
        drawTurnArrow(ctx, c, arm.away.scale(-1), turns[lane]);
      });

      if (arm.rule === 'right' || arm.rule === 'priority' || arm.rule === 'free') continue;
      // Stop / give-way line across the incoming lanes.
      const lo = Math.min(...line.offsets) - lw / 2;
      const hi = Math.max(...line.offsets) + lw / 2;
      const a = line.base.add(right.scale(lo));
      const b = line.base.add(right.scale(hi));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = 'rgba(245, 245, 245, 0.9)';
      ctx.lineWidth = arm.rule === 'yield' ? m(0.25) : m(0.45);
      ctx.setLineDash(arm.rule === 'yield' ? [m(0.6), m(0.4)] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      // The sign or signal head stands on the kerb to the right of the approach.
      const kerb = line.base.add(right.scale(lo - m(1.4)));
      if (arm.rule === 'signal') drawSignal(ctx, kerb, arm.away, j.signals.state(arm.index));
      else if (arm.rule === 'stop') drawStopSign(ctx, kerb);
      else if (arm.rule === 'yield') drawYieldSign(ctx, kerb, arm.away);
    }
  }

  #drawSpeedSigns(ctx, px) {
    for (const step of this.planner.allSteps()) {
      const road = step.road;
      if (road.type === 'street' && road.laneCount < 4 && !road.segment.speedLimit) continue;
      const len = road.segment.length();
      if (len < m(40)) continue;
      const { a, b } = RoutePlanner.laneLine(step, 0);
      const dir = b.subtract(a).normalize();
      const right = dir.perpendicular();
      const lanePos = a.add(dir.scale(m(12)));
      const kerb = lanePos.add(right.scale(road.laneWidth / 2 + m(1.6)));
      drawSpeedSign(ctx, kerb, road.speedLimitKmh);
    }
  }

  #drawLanes(ctx, px) {
    ctx.font = `${Math.max(8, 10 * px)}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'center';
    for (const lane of this.lanes.values()) {
      const [a, b] = lane.centerline;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = 'rgba(100, 210, 255, 0.7)';
      ctx.lineWidth = 1.2 * px;
      ctx.stroke();
      const mid = Point.average(a, b);
      ctx.fillStyle = 'rgba(11, 15, 20, 0.75)';
      ctx.fillRect(mid.x - 16 * px, mid.y - 6 * px, 32 * px, 12 * px);
      ctx.fillStyle = '#64d2ff';
      ctx.fillText(lane.id, mid.x, mid.y + 3.5 * px);
      for (const s of lane.successors) {
        const next = this.lanes.get(s.id);
        if (!next) continue;
        const c = RoutePlanner.end(lane.step);
        const q = next.centerline[0];
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.quadraticCurveTo(c.x, c.y, q.x, q.y);
        ctx.strokeStyle = s.turn === 'left' ? 'rgba(255, 159, 10, 0.6)' : s.turn === 'right' ? 'rgba(48, 209, 88, 0.6)' : 'rgba(191, 90, 242, 0.6)';
        ctx.stroke();
      }
    }
    ctx.textAlign = 'start';
  }
}

// ---- road furniture --------------------------------------------------------------

function drawTurnArrow(ctx, center, forward, turns) {
  if (!turns || turns.size === 0) return;
  const f = forward;
  const r = f.perpendicular();
  const L = m(3.2);
  const tail = center.subtract(f.scale(L * 0.5));
  const joint = center.subtract(f.scale(L * 0.05));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = m(0.3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const head = (tip, dir) => {
    const side = dir.perpendicular().scale(m(0.55));
    const base = tip.subtract(dir.scale(m(0.8)));
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x + side.x, base.y + side.y);
    ctx.lineTo(base.x - side.x, base.y - side.y);
    ctx.closePath();
    ctx.fill();
  };
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(joint.x, joint.y);
  ctx.stroke();
  for (const turn of turns) {
    if (turn === 'straight' || turn === 'merge') {
      const tip = center.add(f.scale(L * 0.5));
      ctx.beginPath();
      ctx.moveTo(joint.x, joint.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      head(tip, f);
    } else {
      const sign = turn === 'left' ? -1 : 1;
      const side = r.scale(sign);
      const corner = joint.add(f.scale(L * 0.25));
      const tip = corner.add(side.scale(L * 0.45));
      ctx.beginPath();
      ctx.moveTo(joint.x, joint.y);
      ctx.lineTo(corner.x, corner.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      head(tip, side);
    }
  }
}

function drawSignal(ctx, at, away, state) {
  const w = m(0.9);
  const h = m(2.3);
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(away.angle() + Math.PI / 2);
  ctx.fillStyle = '#111';
  ctx.strokeStyle = '#555';
  ctx.lineWidth = m(0.08);
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  const lamps = [
    ['red', '#ff3b30'],
    ['yellow', '#ffcc00'],
    ['green', '#30d158'],
  ];
  lamps.forEach(([name, color], i) => {
    ctx.beginPath();
    ctx.arc(0, -h / 2 + (h / 3) * (i + 0.5), m(0.3), 0, Math.PI * 2);
    ctx.fillStyle = state === name ? color : 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
  });
  ctx.restore();
}

function drawStopSign(ctx, at) {
  const r = m(0.75);
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    ctx.lineTo(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = '#d0021b';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = m(0.1);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${m(0.42)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('STOP', at.x, at.y + m(0.15));
  ctx.textAlign = 'start';
}

function drawYieldSign(ctx, at, away) {
  const r = m(0.85);
  // Point down towards the arriving driver (who travels along -away).
  const down = away.scale(-1);
  const pts = [0, 1, 2].map((k) => {
    const a = down.angle() + (k * Math.PI * 2) / 3;
    return { x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r };
  });
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#d0021b';
  ctx.lineWidth = m(0.22);
  ctx.stroke();
}

function drawSpeedSign(ctx, at, kmh) {
  const r = m(0.75);
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#d0021b';
  ctx.lineWidth = m(0.18);
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = `bold ${m(kmh >= 100 ? 0.5 : 0.62)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(kmh), at.x, at.y + m(0.03));
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

