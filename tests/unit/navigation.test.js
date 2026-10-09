import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutonomousDriver } from '../../src/autonomy/autonomousDriver.js';
import { BehaviorPlanner, BehaviorState } from '../../src/autonomy/behaviorPlanner.js';
import { Perception } from '../../src/autonomy/perception.js';
import { Quartic, Quintic } from '../../src/autonomy/polynomials.js';
import { TrajectoryPlanner } from '../../src/autonomy/trajectoryPlanner.js';
import { Car } from '../../src/car/car.js';
import { fromKmh, m, toMeters } from '../../src/car/units.js';
import { City } from '../../src/city/city.js';
import { createCityGraph } from '../../src/data/city.js';
import { Graph } from '../../src/graph/graph.js';
import { NavGraph } from '../../src/navigation/navGraph.js';
import { findRoute, MinHeap } from '../../src/navigation/pathfinding.js';
import { Route } from '../../src/navigation/route.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { Simulation } from '../../src/sim/simulation.js';
import { RoutePlanner } from '../../src/traffic/routePlanner.js';

const P = (x, y) => new Point(m(x), m(y));

function cityWorld(traffic = 0, seed = 7) {
  const network = new RoadNetwork(createCityGraph());
  network.update();
  const sim = new Simulation(network, { trafficCount: traffic, seed });
  sim.syncRoads();
  return { network, sim, nav: sim.nav, city: sim.city };
}

/** Drive the autonomous car along a route; returns the driver when done. */
function driveRoute(sim, route, { limit = 300, perception = 'sensors' } = {}) {
  const start = route.path.pointAt(route.sStart);
  sim.traffic.cars = sim.traffic.cars.filter((c) => c.position.distanceTo(start) > m(25));
  sim.player.teleport(start.x, start.y, route.path.tangentAt(route.sStart).angle());
  const ad = new AutonomousDriver({ car: sim.player, route, city: sim.city, sensors: sim.sensors, perception });
  sim.startAutonomy(ad);
  while (ad.status === 'driving' && sim.time < limit) sim.update(1 / 60, sim.autonomyInput(1 / 60));
  return ad;
}

describe('Week 25: navigable road graph', () => {
  const { nav, city } = cityWorld();

  it('has one edge per road and direction of travel, with its lanes', () => {
    const roads = city.roads;
    const expected = roads.reduce((n, r) => n + (r.oneWay ? 1 : 2), 0);
    assert.equal(nav.edges.length, expected);
    for (const e of nav.edges) {
      assert.equal(e.lanes.length, RoutePlanner.laneCount(e.step));
      assert.ok(e.lanes.every((id) => city.lanes.has(id)));
      assert.ok(e.length > 0 && e.speed > 0 && e.time > 0);
      assert.ok(e.name);
    }
  });

  it('transitions come from junction lane connections: no U-turns, no wrong-way edges', () => {
    for (const e of nav.edges) {
      for (const t of e.transitions) {
        const next = nav.edges[t.to];
        assert.equal(next.from, e.to); // continuous
        assert.notEqual(next.step.road, e.step.road); // never a U-turn
        assert.ok(city.movement(e.step, t.lanes[0], next.step), 'a real movement');
      }
    }
  });

  it('matches a position (and heading) to the right edge and lane', () => {
    const east = nav.match(P(60, 4.95), 0);
    assert.equal(east.edge.step.dir, 1);
    assert.equal(east.lane, 0);
    assert.ok(Math.abs(east.s - 60) < 1);
    const west = nav.match(P(60, -1.65), Math.PI);
    assert.equal(west.edge.step.dir, -1);
    assert.equal(west.lane, 1);
    assert.equal(nav.match(P(60, 80)), null); // in a block, nowhere near a road
  });
});

describe('Week 26: pathfinding', () => {
  const { nav } = cityWorld();

  it('the heap pops in order', () => {
    const heap = new MinHeap();
    for (const k of [5, 1, 9, 3, 7, 2]) heap.push(k, k);
    const out = [];
    while (heap.size) out.push(heap.pop().key);
    assert.deepEqual(out, [1, 2, 3, 5, 7, 9]);
  });

  it('A* finds routes as good as Dijkstra while exploring fewer edges', () => {
    let astar = 0;
    let dijkstra = 0;
    for (let i = 0; i < 150; i++) {
      const a = { edge: nav.edges[(i * 7) % nav.edges.length], s: 10 };
      const b = { edge: nav.edges[(i * 13 + 5) % nav.edges.length], s: 20 };
      for (const mode of ['fastest', 'shortest']) {
        const d = findRoute(nav, a, b, { algorithm: 'dijkstra', mode });
        const x = findRoute(nav, a, b, { algorithm: 'astar', mode });
        assert.equal(!!d, !!x);
        if (!d) continue;
        assert.ok(Math.abs(d.cost - x.cost) < 1e-6);
        astar += x.expanded;
        dijkstra += d.expanded;
      }
    }
    assert.ok(astar < dijkstra * 0.9, `${astar} vs ${dijkstra}`);
  });

  it('shortest is never longer, fastest never slower, and every step is a legal move', () => {
    const a = nav.match(P(30, 5), 0);
    const b = nav.match(P(560, 290));
    const fast = findRoute(nav, a, b, { mode: 'fastest' });
    const short = findRoute(nav, a, b, { mode: 'shortest' });
    assert.ok(short.distance <= fast.distance + 1e-6);
    assert.ok(fast.cost <= findRoute(nav, a, b, { mode: 'fastest', algorithm: 'dijkstra' }).cost + 1e-6);
    for (const r of [fast, short]) {
      r.transitions.forEach((t, i) => assert.ok(r.edges[i].transitions.includes(t)));
      assert.equal(r.edges[0], a.edge);
      assert.equal(r.edges.at(-1), b.edge);
    }
  });

  it('returns null when one-way streets make the destination unreachable', () => {
    const graph = new Graph();
    const n = [P(0, 0), P(200, 0), P(400, 0)].map((p) => graph.addPoint(p));
    graph.addSegment(new Segment(n[0], n[1], { lanes: 1, oneWay: true }));
    graph.addSegment(new Segment(n[1], n[2], { lanes: 1, oneWay: true }));
    const network = new RoadNetwork(graph);
    network.update();
    const g = new NavGraph(new City(network, graph));
    const fromEnd = { edge: g.edges.find((e) => e.fromPoint === n[1]), s: 100 };
    const toStart = { edge: g.edges.find((e) => e.fromPoint === n[0]), s: 50 };
    assert.equal(findRoute(g, fromEnd, toStart), null);
    assert.ok(findRoute(g, toStart, fromEnd));
  });

  it('a route plans lanes that can make every turn, with directions', () => {
    const route = Route.find(nav, nav.match(P(30, 5), 0), nav.match(P(560, 290)));
    route.transitions.forEach((t, i) => assert.ok(t.lanes.includes(route.lanePlan[i])));
    assert.ok(route.sGoal > route.sStart);
    const texts = route.instructions.map((i) => i.text);
    assert.match(texts[0], /^Head off on /);
    assert.equal(texts.at(-1), 'Arrive at your destination');
    assert.ok(texts.some((t) => /^Turn (left|right) onto /.test(t)));
  });
});

describe('Weeks 27–28: behaviour and trajectories', () => {
  it('quintic and quartic polynomials meet their boundary conditions', () => {
    const q = new Quintic(1, 2, 0.5, 10, 0, 0, 4);
    assert.deepEqual([q.at(0).x, q.at(0).v, q.at(0).a], [1, 2, 0.5]);
    assert.ok(Math.abs(q.at(4).x - 10) < 1e-9 && Math.abs(q.at(4).v) < 1e-9 && Math.abs(q.at(4).a) < 1e-9);
    const k = new Quartic(0, 5, 1, 12, 0, 3);
    assert.ok(Math.abs(k.at(3).v - 12) < 1e-9 && Math.abs(k.at(3).a) < 1e-9);
  });

  it('the behaviour planner moves into the turning lane and stops for a red light', () => {
    const { nav, city, sim } = cityWorld();
    // East along Avenue 1, then right onto Street 7 at x = 600.
    const route = Route.find(nav, { ...nav.match(P(330, 1.65), 0), lane: 1 }, nav.match(P(600, 100)));
    const behavior = new BehaviorPlanner(route, city, { key: { finished: false }, carLength: m(4.4) });
    const sAt = (x) => route.path.project(P(x, 1.65)).s;
    // In the left lane (d = −1 lane relative to the reference right lane), 110 m before the turn.
    const d = (route.lanePlan[route.edgeIndexAt(sAt(490))] - 1) * route.edges[0].step.road.laneWidth;
    const prep = behavior.update({ s: sAt(490), d, v: fromKmh(40), position: P(490, 1.65), heading: 0 }, 0);
    assert.equal(prep.state, BehaviorState.PREPARE_LANE_CHANGE);
    assert.equal(prep.text, 'Move into the right lane');
    assert.equal(prep.preferredLane, 0);

    // Red light at the signalised junction at x = 300 on a route straight through it.
    const through = Route.find(nav, nav.match(P(100, 4.95), 0), nav.match(P(450, 4.95), 0));
    const j = city.junctionAt(sim.network.graph.points.find((p) => Math.abs(p.x - m(300)) < 1 && Math.abs(p.y) < 1));
    const arm = j.armOf(through.steps[through.edges.findIndex((e) => e.toPoint === j.node)]);
    for (let i = 0; i < 4000 && j.signals.state(arm.index) !== 'red'; i++) j.signals.update(0.05);
    j.signals.update(0.3);
    const b2 = new BehaviorPlanner(through, city, { key: { finished: false }, carLength: m(4.4) });
    const s = through.path.project(P(260, 4.95)).s;
    const stop = b2.update({ s, d: 0, v: fromKmh(40), position: P(260, 4.95), heading: 0 }, 1);
    assert.equal(stop.state, BehaviorState.STOP_AT_LINE);
    assert.match(stop.text, /Red light/);
    assert.ok(stop.stopAt > s && stop.stopAt - s < m(40));
  });

  it('the trajectory planner never plans into a stopped car: it stops behind it or changes lane', () => {
    const { nav, city } = cityWorld();
    const route = Route.find(nav, nav.match(P(30, 4.95), 0), nav.match(P(280, 4.95), 0));
    const planner = new TrajectoryPlanner(route);
    const s0 = route.path.project(P(60, 4.95)).s;
    const obstacle = { x: m(85), y: m(4.95), vx: 0, vy: 0 };
    const decision = { edgeIndex: 0, refLane: 0, allowedLanes: [0, 1], preferredLane: 0, stopAt: null, speedLimit: fromKmh(50) };
    const plan = planner.plan({ s: s0, d: 0, vs: fromKmh(40), vd: 0, as: 0, v: fromKmh(40) }, decision, [obstacle], m(4.4), m(1.8));
    assert.ok(plan.best.kind !== 'emergency');
    for (const p of plan.best.samples) assert.ok(p.point.distanceTo(new Point(obstacle.x, obstacle.y)) > m(2.2));
    assert.ok(plan.candidates.some((c) => !c.feasible && c.why === 'collides'));
    // With a stop line, nothing feasible runs it.
    const stopPlan = planner.plan({ s: s0, d: 0, vs: fromKmh(30), vd: 0, as: 0, v: fromKmh(30) }, { ...decision, stopAt: s0 + m(30) }, [], m(4.4), m(1.8));
    assert.ok(stopPlan.best.samples.every((p) => p.s <= s0 + m(30) - m(2.2) - m(1) + m(0.6)));
  });

  it('perception builds tracked objects from LiDAR and radar, with velocities', () => {
    const { sim } = cityWorld();
    sim.player.teleport(m(30), m(4.95), 0);
    const other = new Car({ x: m(50), y: m(4.95), angle: 0 });
    sim.traffic.cars.push(other);
    const perception = new Perception({ mode: 'sensors' });
    for (let i = 0; i < 90; i++) {
      other.state.speed = fromKmh(18); // 5 m/s
      sim.update(1 / 60);
      perception.update(sim.time, { car: sim.player, sensors: sim.sensors, cars: sim.cars });
    }
    const nearest = perception.objects.reduce((a, o) => (!a || Math.hypot(o.x - other.state.x, o.y - other.state.y) < Math.hypot(a.x - other.state.x, a.y - other.state.y) ? o : a), null);
    assert.ok(nearest, 'detected');
    assert.ok(Math.hypot(nearest.x - other.state.x, nearest.y - other.state.y) < m(2));
    assert.ok(Math.abs(toMeters(nearest.vx) - 5) < 1.5, `vx ${toMeters(nearest.vx)}`);
  });
});

describe('Milestone #5: A → B navigation', () => {
  it('drives a route through the city on its own: arrives, no collisions, no red lights', () => {
    const { nav, sim } = cityWorld(0);
    const route = Route.find(nav, nav.match(P(30, 4.95), 0), nav.match(P(560, 290)));
    const ad = driveRoute(sim, route);
    assert.equal(ad.status, 'arrived');
    assert.equal(ad.collisions, 0);
    assert.equal(ad.redLights, 0);
    assert.ok(route.remaining(ad.s) < 4);
  });

  it('does the same in traffic', () => {
    const { nav, sim } = cityWorld(20, 3);
    const route = Route.find(nav, nav.match(P(0, 60), Math.PI / 2), nav.match(P(450, 200)));
    const ad = driveRoute(sim, route, { limit: 400 });
    assert.equal(ad.status, 'arrived');
    assert.equal(ad.collisions, 0);
    assert.equal(ad.redLights, 0);
  });
});
