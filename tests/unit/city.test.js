import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Car } from '../../src/car/car.js';
import { fromKmh, m, toKmh } from '../../src/car/units.js';
import { City } from '../../src/city/city.js';
import { Crossing } from '../../src/city/crossings.js';
import { SignalController } from '../../src/city/signals.js';
import { createCityGraph } from '../../src/data/city.js';
import { Graph } from '../../src/graph/graph.js';
import { createRng } from '../../src/math/random.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { Road } from '../../src/road/road.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { Simulation } from '../../src/sim/simulation.js';
import { LaneIndex } from '../../src/traffic/laneIndex.js';
import { RoutePlanner } from '../../src/traffic/routePlanner.js';
import { TrafficDriver } from '../../src/traffic/trafficDriver.js';

const M = (x, y) => new Point(m(x), m(y));

/** A graph from [name, x, y] nodes (metres) and [a, b, attrs] roads. */
function build(nodes, roads, controls = {}) {
  const graph = new Graph();
  const byName = {};
  for (const [name, x, y] of nodes) byName[name] = graph.addPoint(M(x, y));
  for (const [a, b, attrs] of roads) graph.addSegment(new Segment(byName[a], byName[b], { lanes: 2, ...attrs }));
  for (const [name, control] of Object.entries(controls)) graph.controls.set(byName[name], control);
  const network = new RoadNetwork(graph);
  network.update();
  return { graph, network, nodes: byName, city: new City(network, graph) };
}

/** A four-way crossroads of 300 m arms. */
const crossroads = (attrs = {}, controls = {}) =>
  build(
    [
      ['c', 0, 0],
      ['w', -300, 0],
      ['e', 300, 0],
      ['n', 0, -300],
      ['s', 0, 300],
    ],
    [
      ['w', 'c', attrs],
      ['c', 'e', attrs],
      ['n', 'c', attrs],
      ['c', 's', attrs],
    ],
    controls,
  );

function stepBetween(city, from, to) {
  return city.planner.allSteps().find((s) => RoutePlanner.start(s) === from && RoutePlanner.end(s) === to);
}

/** A traffic car with a fixed route through named nodes. */
function addDriver(sim, nodes, route, { lane = 0, along = 0.3, ...options } = {}) {
  const planner = sim.traffic.planner;
  const steps = [];
  for (let i = 0; i < route.length - 1; i++) {
    steps.push(planner.allSteps().find((s) => RoutePlanner.start(s) === nodes[route[i]] && RoutePlanner.end(s) === nodes[route[i + 1]]));
  }
  const car = new Car();
  car.driver = new TrafficDriver(car, planner, { rng: createRng(1), lane, city: sim.city, ...options });
  car.driver.followRoute(steps, along * steps[0].road.segment.length());
  car.alpha = 1;
  sim.traffic.cars.push(car);
  return car;
}

describe('Road attributes and types (Weeks 22, 24)', () => {
  it('saves road type, speed limit, crossings and junction controls in the map JSON', () => {
    const { graph, nodes } = crossroads({ type: 'street' }, { c: 'allStop' });
    graph.segments[0].type = 'highway';
    graph.segments[1].speedLimit = 30;
    graph.segments[2].crossing = true;
    const copy = Graph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
    assert.equal(copy.segments[0].type, 'highway');
    assert.equal(copy.segments[1].speedLimit, 30);
    assert.equal(copy.segments[2].crossing, true);
    assert.equal(copy.controls.get(copy.points[graph.points.indexOf(nodes.c)]), 'allStop');
  });

  it('gives each road type a default speed limit', () => {
    const seg = (attrs) => new Road(new Segment(new Point(0, 0), new Point(100, 0), attrs));
    assert.equal(seg({ lanes: 2 }).speedLimitKmh, 50);
    assert.equal(seg({ lanes: 4 }).speedLimitKmh, 60);
    assert.equal(seg({ type: 'highway', oneWay: true }).speedLimitKmh, 110);
    assert.equal(seg({ type: 'ramp', oneWay: true, lanes: 1 }).speedLimitKmh, 60);
    assert.equal(seg({ speedLimit: 30 }).speedLimitKmh, 30);
    assert.ok(Math.abs(toKmh(seg({ speedLimit: 30 }).speedLimit) - 30) < 1e-9);
  });
});

describe('Week 21: junctions', () => {
  it('classifies the city: T-junctions, crossroads, merges, diverges', () => {
    const graph = createCityGraph();
    const network = new RoadNetwork(graph);
    network.update();
    const city = new City(network, graph);
    const kinds = [...city.junctions.values()].map((j) => j.kind);
    for (const kind of ['T', 'cross', 'merge', 'diverge', 'continuation']) assert.ok(kinds.includes(kind), kind);
    assert.ok(city.stats().signals >= 3);
  });

  it('chooses controls automatically: lights for avenues, all-way stop for streets, signs on a T stem', () => {
    const avenues = crossroads({ lanes: 4 });
    assert.equal(avenues.city.junctionAt(avenues.nodes.c).control, 'signals');
    const streets = crossroads();
    assert.equal(streets.city.junctionAt(streets.nodes.c).control, 'allStop');
    const t = build(
      [
        ['c', 0, 0],
        ['w', -300, 0],
        ['e', 300, 0],
        ['s', 0, 300],
      ],
      [
        ['w', 'c', { lanes: 4 }],
        ['c', 'e', { lanes: 4 }],
        ['c', 's'],
      ],
    );
    const j = t.city.junctionAt(t.nodes.c);
    assert.equal(j.kind, 'T');
    assert.equal(j.control, 'stop');
    assert.deepEqual(j.arms.map((a) => a.rule).sort(), ['priority', 'priority', 'stop']);
    const overridden = crossroads({}, { c: 'uncontrolled' });
    assert.equal(overridden.city.junctionAt(overridden.nodes.c).control, 'uncontrolled');
  });

  it('turning lanes: right turns from the right lane, left turns from the left lane', () => {
    const { city, nodes } = crossroads({ lanes: 4 });
    const fromWest = stepBetween(city, nodes.w, nodes.c);
    assert.deepEqual(city.allowedLanes(fromWest, stepBetween(city, nodes.c, nodes.s)), [0]); // right
    assert.deepEqual(city.allowedLanes(fromWest, stepBetween(city, nodes.c, nodes.n)), [1]); // left
    assert.deepEqual(city.allowedLanes(fromWest, stepBetween(city, nodes.c, nodes.e)), [0, 1]); // straight
    assert.equal(city.movement(fromWest, 1, stepBetween(city, nodes.c, nodes.n)).outLane, 1);
  });

  it('with three lanes the left lane is a dedicated left-turn lane', () => {
    const { city, nodes } = crossroads({ lanes: 6 });
    const fromWest = stepBetween(city, nodes.w, nodes.c);
    assert.deepEqual(city.allowedLanes(fromWest, stepBetween(city, nodes.c, nodes.e)), [0, 1]);
    assert.deepEqual(city.allowedLanes(fromWest, stepBetween(city, nodes.c, nodes.n)), [2]);
  });

  it('knows which movements conflict', () => {
    const { city, nodes } = crossroads({ lanes: 4 });
    const j = city.junctionAt(nodes.c);
    const mv = (a, lane, b) => city.movement(stepBetween(city, nodes[a], nodes.c), lane, stepBetween(city, nodes.c, nodes[b]));
    const leftWN = mv('w', 1, 'n');
    const straightEW = mv('e', 0, 'w');
    const straightWE = mv('w', 0, 'e');
    const rightES = mv('e', 0, 'n'); // east → north is a right turn
    assert.ok(leftWN.conflicts.has(straightEW.key)); // left across oncoming traffic
    assert.ok(!straightWE.conflicts.has(straightEW.key)); // opposite straights pass
    assert.ok(mv('n', 0, 's').conflicts.has(straightWE.key)); // crossing straights
    assert.ok(!rightES.conflicts.has(straightWE.key));
    assert.ok(j.movements.size > 0);
  });

  it('merges stack lanes from the right and diverges only exit from the right lane', () => {
    const graph = createCityGraph();
    const network = new RoadNetwork(graph);
    network.update();
    const city = new City(network, graph);
    const merge = [...city.junctions.values()].find((j) => j.kind === 'merge');
    const ramp = merge.arms.find((a) => a.road.type === 'ramp' && a.inLanes);
    const rampMove = [...merge.movements.values()].find((mv) => mv.from === ramp.index);
    assert.equal(rampMove.outLane, 0); // onto the acceleration lane
    const highwayMoves = [...merge.movements.values()].filter((mv) => mv.from !== ramp.index).map((mv) => mv.outLane);
    assert.deepEqual(highwayMoves.sort(), [1, 2]);
    const diverge = [...city.junctions.values()].find((j) => j.kind === 'diverge');
    const exits = [...diverge.movements.values()].filter((mv) => mv.turn === 'exit');
    assert.deepEqual(exits.map((mv) => mv.inLane), [0]);
  });

  it('a car must be granted its movement; conflicting movements wait until it has left', () => {
    const { city, nodes } = crossroads({}, { c: 'uncontrolled' });
    const j = city.junctionAt(nodes.c);
    const mv = (a, b) => city.movement(stepBetween(city, nodes[a], nodes.c), 0, stepBetween(city, nodes.c, nodes[b]));
    const a = { finished: false };
    const b = { finished: false };
    assert.ok(j.request(a, mv('w', 'e'), m(2), m(5), 0));
    assert.ok(j.occupants.has(a));
    assert.equal(j.request(b, mv('n', 's'), m(2), m(5), 0), false);
    j.release(a);
    assert.ok(j.request(b, mv('n', 's'), m(2), m(5), 0.1));
  });
});

describe('Week 22: lights, signs, crossings', () => {
  it('signals give one phase green at a time: green → yellow → all-red', () => {
    const { city, nodes } = crossroads({ lanes: 4 });
    const s = city.junctionAt(nodes.c).signals;
    assert.equal(s.phases.length, 2);
    const seen = new Set();
    for (let t = 0; t < s.cycle; t += 0.1) {
      s.update(0.1);
      const states = [0, 1, 2, 3].map((arm) => s.state(arm));
      assert.ok(states.filter((x) => x === 'green').length <= 2); // a pair of opposite arms
      seen.add(states.join());
    }
    assert.ok([...seen].some((x) => x.includes('yellow')));
    assert.ok([...seen].some((x) => x === 'red,red,red,red')); // all-red clearance
  });

  it('red means stop, green means go; yellow only if it is too late to stop', () => {
    const { city, nodes } = crossroads({ lanes: 4 });
    const j = city.junctionAt(nodes.c);
    const fromWest = stepBetween(city, nodes.w, nodes.c);
    const mv = city.movement(fromWest, 0, stepBetween(city, nodes.c, nodes.e));
    const arm = j.armOf(fromWest).index;
    const until = (state) => {
      for (let i = 0; i < 2000 && j.signals.state(arm) !== state; i++) j.signals.update(0.05);
    };
    until('red');
    assert.equal(j.request({}, mv, m(10), m(10), 1), false);
    until('green');
    assert.equal(j.request({}, mv, m(10), m(10), 2), true);
    until('yellow');
    assert.equal(j.request({}, mv, m(30), m(10), 3), false); // can stop comfortably
    assert.equal(j.request({}, mv, m(2), m(14), 3), true); // too close to stop
  });

  it('a stop sign needs a full stop at the line first', () => {
    const { city, nodes } = crossroads();
    const j = city.junctionAt(nodes.c); // all-way stop
    const mv = city.movement(stepBetween(city, nodes.w, nodes.c), 0, stepBetween(city, nodes.c, nodes.e));
    const car = {};
    assert.equal(j.request(car, mv, m(2), m(4), 0), false); // rolling up
    assert.equal(j.request(car, mv, m(1), 0, 0.1), false); // stopped…
    assert.equal(j.request(car, mv, m(1), 0, 0.5), false); // …not long enough
    assert.equal(j.request(car, mv, m(1), 0, 0.8), true);
  });

  it('pedestrians cross the zebra and keep it occupied while on it', () => {
    const road = new Road(new Segment(new Point(0, 0), new Point(m(100), 0)));
    const c = new Crossing(road, { seed: 2 });
    let occupied = 0;
    let spawned = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const before = c.pedestrians.length;
      c.update(1 / 60);
      if (c.pedestrians.length > before) spawned++;
      if (c.occupied) occupied++;
    }
    assert.ok(spawned >= 4);
    assert.ok(occupied > 60 * 5 && occupied < 60 * 55);
  });
});

describe('Week 23: lanes', () => {
  it('every lane has an ID, a centreline, neighbours and successors', () => {
    const { city, nodes } = crossroads({ lanes: 4 });
    const fromWest = stepBetween(city, nodes.w, nodes.c);
    const id = city.laneId(fromWest, 0);
    const lane = city.lanes.get(id);
    assert.match(id, /^L\d+[FB]0$/);
    assert.equal(lane.left, city.laneId(fromWest, 1));
    assert.equal(lane.right, null);
    assert.equal(lane.centerline.length, 2);
    assert.ok(lane.successors.some((s) => s.turn === 'right'));
    assert.ok(lane.successors.some((s) => s.turn === 'straight'));
    assert.ok(!lane.successors.some((s) => s.turn === 'left'));
  });

  it('the lane index finds leaders and followers per lane', () => {
    const road = new Road(new Segment(new Point(0, 0), new Point(m(500), 0), { lanes: 4 }));
    const index = new LaneIndex([road]);
    const at = (x, lane) => {
      const car = new Car({ x: m(x), y: lane === 0 ? 33 : 11, angle: 0 });
      return car;
    };
    const me = at(100, 0);
    const ahead = at(130, 0);
    const behind = at(80, 1);
    index.rebuild([me, ahead, behind]);
    assert.equal(me.laneInfo.lanes[0], 0);
    assert.equal(behind.laneInfo.lanes[0], 1);
    const n = index.neighbours(road, 1, 0, me.laneInfo.s, me);
    assert.equal(n.leader.car, ahead);
    assert.equal(index.neighbours(road, 1, 1, me.laneInfo.s, me).follower.car, behind);
  });

  it('overtakes a slow car, then keeps right again (MOBIL)', () => {
    const { network, nodes } = build(
      [
        ['a', 0, 0],
        ['b', 900, 0],
      ],
      [['a', 'b', { lanes: 4 }]],
    );
    const sim = new Simulation(network, { trafficCount: 0 });
    sim.syncRoads();
    sim.player.teleport(-5000, -5000, 0);
    const slow = addDriver(sim, nodes, ['a', 'b'], { lane: 0, along: 0.2, desiredSpeed: fromKmh(25) });
    const fast = addDriver(sim, nodes, ['a', 'b'], { lane: 0, along: 0.05, desiredSpeed: fromKmh(60) });
    const reasons = new Set();
    for (let i = 0; i < 60 * 45 && fast.state.x < m(800); i++) {
      sim.update(1 / 60);
      if (fast.driver.pendingLane !== null) reasons.add(fast.driver.laneChangeReason);
      assert.equal(sim.carPairs.length, 0);
    }
    assert.ok(fast.state.x > slow.state.x, 'overtook');
    assert.ok(reasons.has('overtake'));
    assert.ok(reasons.has('keep right'));
  });

  it('changes lanes before a junction to make its turn', () => {
    const { network, nodes } = crossroads({ lanes: 4 });
    const sim = new Simulation(network, { trafficCount: 0 });
    sim.syncRoads();
    sim.player.teleport(-5000, -5000, 0);
    const car = addDriver(sim, nodes, ['w', 'c', 's'], { lane: 1, along: 0.1 }); // right turn from the left lane
    let reached = false;
    for (let i = 0; i < 60 * 60 && !reached; i++) {
      sim.update(1 / 60);
      reached = car.state.y > m(30);
    }
    assert.ok(reached, 'made the right turn');
    assert.ok(car.driver.laneChangeReason === 'mandatory');
  });
});

describe('Week 24: the city', () => {
  it('runs a minute of busy city traffic with no crashes, everyone moving, highway speeds and lane changes', () => {
    const graph = createCityGraph();
    const network = new RoadNetwork(graph);
    network.update();
    const sim = new Simulation(network, { trafficCount: 40, seed: 7 });
    sim.syncRoads();
    const driven = new Map(sim.traffic.cars.map((c) => [c, 0]));
    const reasons = new Set();
    let topHighway = 0;
    let pairs = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const before = new Map(sim.traffic.cars.map((c) => [c, c.position]));
      sim.update(1 / 60);
      pairs += sim.carPairs.length;
      for (const c of sim.traffic.cars) {
        if (c.driver.pendingLane !== null) reasons.add(c.driver.laneChangeReason);
        if (c.driver.currentStep?.road.type === 'highway') topHighway = Math.max(topHighway, toKmh(c.speed));
      }
      for (const [c, p] of before) if (driven.has(c)) driven.set(c, driven.get(c) + p.distanceTo(c.position));
    }
    assert.equal(pairs, 0);
    const survivors = [...driven.entries()].filter(([c]) => sim.traffic.cars.includes(c));
    assert.ok(survivors.every(([, d]) => d > m(30)), 'someone is stuck');
    assert.ok(topHighway > 80, `highway top speed ${topHighway}`);
    for (const reason of ['mandatory', 'overtake', 'keep right']) assert.ok(reasons.has(reason), reason);
  });

  it('counts the player running a red light', () => {
    const { network, nodes } = crossroads({ lanes: 4 });
    const sim = new Simulation(network, { trafficCount: 0 });
    sim.syncRoads();
    const j = sim.city.junctionAt(nodes.c);
    const arm = j.armOf(stepBetween(sim.city, nodes.w, nodes.c)).index;
    for (let i = 0; i < 4000 && j.signals.state(arm) !== 'red'; i++) j.signals.update(0.05);
    j.signals.update(0.5); // well into the red
    sim.player.teleport(m(-40), m(1.65), 0);
    for (let i = 0; i < 120; i++) {
      sim.player.state.speed = fromKmh(40);
      sim.update(1 / 60);
    }
    assert.equal(sim.city.violations.redLights, 1);
  });
});
