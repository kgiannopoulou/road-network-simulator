import { m, toMeters } from '../car/units.js';
import { RoutePlanner } from '../traffic/routePlanner.js';

/**
 * Week 25: the city as a navigable "GPS" graph.
 *
 *   nodes        junctions (graph points)
 *   edges        one per road and direction of travel, with length (m),
 *                speed limit (m/s), free-flow travel time (s), a road name,
 *                and the IDs of its lanes (from the City's lane graph)
 *   transitions  edge → edge moves allowed at the junction between them,
 *                taken from the junction's lane connections, so turn
 *                restrictions (no U-turns, no hairpins, one-way roads,
 *                exits only from the right lane) come for free
 *
 * match() snaps a world position + heading to the nearest edge (map
 * matching), which is how a click or a GPS fix becomes a place on the graph.
 */
export class NavGraph {
  constructor(city) {
    this.city = city;
    this.nodes = new Map(); // Point → { id, point, in: [], out: [] }
    this.edges = [];
    this.byStep = new Map(); // road → { 1: edge, -1: edge }
    this.names = nameRoads(city.roads);

    for (const step of city.planner.allSteps()) {
      const from = this.#node(RoutePlanner.start(step));
      const to = this.#node(RoutePlanner.end(step));
      const road = step.road;
      const length = toMeters(road.segment.length());
      const speed = toMeters(road.speedLimit);
      const lanes = Array.from({ length: RoutePlanner.laneCount(step) }, (_, i) => city.laneId(step, i));
      const edge = {
        id: this.edges.length,
        step,
        from: from.id,
        to: to.id,
        fromPoint: from.point,
        toPoint: to.point,
        length,
        speed,
        time: length / speed,
        lanes,
        type: road.type,
        name: this.names.get(road),
        transitions: [],
      };
      this.edges.push(edge);
      from.out.push(edge.id);
      to.in.push(edge.id);
      if (!this.byStep.has(road)) this.byStep.set(road, {});
      this.byStep.get(road)[step.dir] = edge;
    }

    // Transitions through each junction, from its movements.
    for (const edge of this.edges) {
      const junction = city.junctionAt(edge.toPoint);
      if (!junction) continue;
      for (const nextId of this.nodeById(edge.to).out) {
        const next = this.edges[nextId];
        const movements = junction.movementsBetween(edge.step, next.step);
        if (!movements.length) continue;
        edge.transitions.push({
          to: next.id,
          turn: movements[0].turn,
          lanes: [...new Set(movements.map((mv) => mv.inLane))].sort((a, b) => a - b),
          controlled: junction.isIntersection && junction.armOf(edge.step)?.rule !== 'priority',
          signals: !!junction.signals,
        });
      }
    }
    this.maxSpeed = Math.max(...this.edges.map((e) => e.speed), 1);
  }

  #node(point) {
    if (!this.nodes.has(point)) this.nodes.set(point, { id: this.nodes.size, point, in: [], out: [] });
    return this.nodes.get(point);
  }

  nodeById(id) {
    for (const n of this.nodes.values()) if (n.id === id) return n;
    return null;
  }

  edgeForStep(step) {
    return this.byStep.get(step.road)?.[step.dir] ?? null;
  }

  /**
   * Map matching: the edge (and lane) a world position lies on, preferring
   * the direction of travel that agrees with `heading` when one is given.
   * Returns { edge, s (m from the edge's start), lateral, lane, distance } or null.
   */
  match(point, heading = null, { maxDistance = m(12) } = {}) {
    let best = null;
    for (const edge of this.edges) {
      const { a, b } = RoutePlanner.laneLine(edge.step, 0);
      const ab = b.subtract(a);
      const len = ab.length();
      const t = Math.max(0, Math.min(1, point.subtract(a).dot(ab) / (len * len)));
      const foot = a.add(ab.scale(t));
      const lateral = ab.normalize().perpendicular().dot(point.subtract(foot)); // + = right of lane 0
      const road = edge.step.road;
      // Inside this direction's half of the road: from lane 0's centre to the last lane's centre.
      const lanes = edge.lanes.length;
      const fromRightLane = -lateral / road.laneWidth; // 0 = right lane, 1 = next lane left…
      const lane = Math.max(0, Math.min(lanes - 1, Math.round(fromRightLane)));
      const off = Math.abs(fromRightLane - lane) * road.laneWidth;
      const outside = fromRightLane < -0.7 || fromRightLane > lanes - 0.3;
      let score = off + (outside ? road.laneWidth * 2 : 0) + foot.distanceTo(point) * (t <= 0 || t >= 1 ? 1 : 0);
      if (heading !== null) {
        const align = Math.cos(heading) * ab.x / len + Math.sin(heading) * ab.y / len;
        score += (1 - align) * road.laneWidth * 2;
      }
      if (score > maxDistance) continue;
      if (!best || score < best.score) {
        best = { edge, s: toMeters(t * len), lateral, lane, distance: off, score, point: foot.add(ab.normalize().perpendicular().scale(-lane * road.laneWidth)) };
      }
    }
    return best;
  }
}

/**
 * Street names for directions: roads that continue each other almost
 * straight (and have the same type) form one street. Avenues, streets,
 * highway carriageways and ramps are numbered separately.
 */
export function nameRoads(roads) {
  const parent = new Map(roads.map((r) => [r, r]));
  const find = (r) => (parent.get(r) === r ? r : (parent.set(r, find(parent.get(r))), parent.get(r)));
  const kind = (r) => (r.type === 'street' ? (r.laneCount >= 4 ? 'Avenue' : 'Street') : r.type === 'highway' ? 'Highway' : 'Ramp');
  const atNode = new Map();
  for (const r of roads) for (const p of [r.segment.p1, r.segment.p2]) atNode.set(p, [...(atNode.get(p) ?? []), r]);
  for (const [node, list] of atNode) {
    for (const a of list) {
      let best = null;
      for (const b of list) {
        if (a === b || kind(a) !== kind(b)) continue;
        const da = a.segment.otherEnd(node).subtract(node).normalize();
        const db = b.segment.otherEnd(node).subtract(node).normalize();
        const straightness = -da.dot(db); // 1 = perfectly straight through
        if (straightness > Math.cos((25 * Math.PI) / 180) && (!best || straightness > best.straightness)) best = { b, straightness };
      }
      if (best) parent.set(find(a), find(best.b));
    }
  }
  // Number each kind by position (west/north first) so names are stable.
  const groups = new Map();
  for (const r of roads) {
    const root = find(r);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  const counters = {};
  const names = new Map();
  const ordered = [...groups.values()].sort((a, b) => {
    const ka = Math.min(...a.map((r) => r.segment.midpoint().x + r.segment.midpoint().y * 0.01));
    const kb = Math.min(...b.map((r) => r.segment.midpoint().x + r.segment.midpoint().y * 0.01));
    return ka - kb;
  });
  for (const group of ordered) {
    const k = kind(group[0]);
    counters[k] = (counters[k] ?? 0) + 1;
    const name = k === 'Highway' || k === 'Ramp' ? (k === 'Ramp' ? 'the ramp' : `Highway ${counters[k]}`) : `${k} ${counters[k]}`;
    for (const r of group) names.set(r, name);
  }
  return names;
}
