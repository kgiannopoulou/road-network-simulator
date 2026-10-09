import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Car } from '../../src/car/car.js';
import { fromKmh, m } from '../../src/car/units.js';
import { createDemoGraph } from '../../src/data/demo.js';
import { Graph } from '../../src/graph/graph.js';
import { createRng } from '../../src/math/random.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { Simulation } from '../../src/sim/simulation.js';
import { Path } from '../../src/traffic/path.js';
import { RoutePlanner } from '../../src/traffic/routePlanner.js';
import { idmAcceleration, TrafficDriver } from '../../src/traffic/trafficDriver.js';

const P = (x, y) => new Point(x, y);

function network(build) {
  const graph = new Graph();
  build(graph);
  const net = new RoadNetwork(graph);
  net.update();
  return net;
}

describe('IDM', () => {
  const base = { a: 1.5, b: 2.5, s0: 2, T: 1.4 };
  it('accelerates on a free road and settles at the desired speed', () => {
    assert.ok(idmAcceleration({ ...base, v: 0, v0: 14 }) > 1.4);
    assert.ok(Math.abs(idmAcceleration({ ...base, v: 14, v0: 14 })) < 1e-9);
  });

  it('brakes harder the closer and faster it approaches a leader', () => {
    const far = idmAcceleration({ ...base, v: 14, v0: 14, gap: 80, dv: 0 });
    const close = idmAcceleration({ ...base, v: 14, v0: 14, gap: 15, dv: 5 });
    assert.ok(close < far && close < -2.5);
  });
});

describe('Path', () => {
  const path = new Path([P(0, 0), P(100, 0), P(100, 100)]);

  it('is parameterised by arc length', () => {
    assert.equal(path.length, 200);
    assert.deepEqual(path.pointAt(150), P(100, 50));
    assert.deepEqual(path.tangentAt(150), P(0, 1));
  });

  it('projects points with a signed lateral offset (positive = right of travel)', () => {
    const right = path.project(P(50, 10));
    assert.equal(right.s, 50);
    assert.equal(right.lateral, 10);
    assert.equal(path.project(P(50, -10)).lateral, -10);
  });

  it('knows its curvature, signed by turn direction', () => {
    assert.ok(path.curvatureAt(100) > 0); // right turn on screen
    assert.ok(path.curvatureAt(30) < path.curvatureAt(90)); // ramps up towards the corner
    const left = new Path([P(0, 0), P(100, 0), P(100, -100)]);
    assert.ok(left.curvatureAt(100) < 0);
  });
});

describe('RoutePlanner', () => {
  const net = network((g) => {
    const a = g.addPoint(P(0, 0));
    const b = g.addPoint(P(300, 0));
    const c = g.addPoint(P(300, 300));
    const d = g.addPoint(P(600, 0));
    g.addSegment(new Segment(a, b));
    g.addSegment(new Segment(b, c, { lanes: 2, oneWay: true }));
    g.addSegment(new Segment(d, b));
  });
  const planner = new RoutePlanner(net.roads);

  it('never drives against a one-way road', () => {
    const intoOneWay = planner.allSteps().filter((s) => s.road.oneWay);
    assert.ok(intoOneWay.every((s) => s.dir === 1));
  });

  it('turns onto other roads but never U-turns; a dead end ends the route', () => {
    const east = planner.allSteps().find((s) => s.road.segment.p1.x === 0 && s.dir === 1);
    const options = planner.nextOptions(east);
    assert.equal(options.length, 2);
    assert.ok(options.every((s) => s.road !== east.road));
    const toDeadEnd = planner.allSteps().find((s) => s.road.oneWay);
    assert.equal(planner.nextOptions(toDeadEnd).length, 0);
  });

  it('builds paths in the right-hand lane, with arcs at turns', () => {
    const east = planner.allSteps().find((s) => s.road.segment.p1.x === 0 && s.dir === 1);
    const south = planner.allSteps().find((s) => s.road.oneWay);
    const { path, stepStarts } = planner.buildPath([east, south], 0);
    assert.ok(Math.abs(path.pointAt(50).y - 11) < 1e-9); // right of eastbound
    assert.equal(stepStarts.length, 2);
    // Down the one-way road in its right lane, i.e. x < 300.
    assert.ok(Math.abs(path.pointAt(path.length - 1).x - 289) < 1e-6);
    assert.ok(path.curvature.some((k) => k > 0));
  });
});

describe('Traffic driver', () => {
  const avenue = () =>
    network((g) => {
      const a = g.addPoint(P(0, 0));
      const b = g.addPoint(P(3000, 0));
      const c = g.addPoint(P(3000, 600));
      g.addSegment(new Segment(a, b, { lanes: 4 }));
      g.addSegment(new Segment(b, c, { lanes: 4 }));
    });

  function setup(net, lane) {
    const sim = new Simulation(net, { trafficCount: 0 });
    sim.syncRoads();
    sim.player.teleport(-1000, -1000, 0); // out of the way unless a test places it
    const planner = sim.traffic.planner;
    const east = planner.allSteps().find((s) => s.dir === 1 && s.road.segment.p1.x === 0);
    const car = new Car();
    car.driver = new TrafficDriver(car, planner, { rng: createRng(1), lane, desiredSpeed: fromKmh(50) });
    car.driver.begin(east, 100);
    car.alpha = 1;
    sim.traffic.cars.push(car);
    return { sim, car };
  }

  it('reaches its desired speed and keeps to its lane', () => {
    const { sim, car } = setup(avenue(), 0);
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    assert.ok(Math.abs(car.speed - fromKmh(50)) < fromKmh(3));
    assert.ok(Math.abs(car.state.y - 33) < 1.5); // outer eastbound lane centre
  });

  it('stops behind a stopped car without hitting it', () => {
    const net = network((g) => {
      const a = g.addPoint(P(0, 0));
      const b = g.addPoint(P(3000, 0));
      g.addSegment(new Segment(a, b, { lanes: 2 }));
    });
    const { sim, car } = setup(net, 0);
    sim.player.teleport(1200, 11, 0);
    for (let i = 0; i < 60 * 40; i++) {
      sim.update(1 / 60);
      assert.equal(sim.carPairs.length, 0);
    }
    const gap = sim.player.state.x - car.state.x - (car.length + sim.player.length) / 2;
    assert.ok(Math.abs(car.speed) < 0.5);
    assert.ok(gap > m(1) && gap < m(6), `gap ${gap}`);
  });

  it('changes lane to get past a stopped car (basic obstacle avoidance)', () => {
    const { sim, car } = setup(avenue(), 0);
    sim.player.teleport(900, 33, 0); // parked in the outer lane
    let changed = false;
    for (let i = 0; i < 60 * 40; i++) {
      sim.update(1 / 60);
      assert.equal(sim.carPairs.length, 0);
      if (car.driver.pendingLane !== null) changed = true;
    }
    assert.ok(changed);
    assert.ok(car.state.x > 1100, `stuck at x=${car.state.x}`);
  });
});

describe('Demo traffic', () => {
  it('runs a minute of dense traffic on the demo map with no crashes and nobody stuck', () => {
    const net = new RoadNetwork(createDemoGraph());
    net.update();
    const sim = new Simulation(net, { trafficCount: 14, seed: 7 });
    sim.syncRoads();
    const start = new Map(sim.traffic.cars.map((c) => [c, c.position]));
    let pairs = 0;
    for (let i = 0; i < 60 * 60; i++) {
      sim.update(1 / 60);
      pairs += sim.carPairs.length;
    }
    assert.equal(pairs, 0);
    assert.equal(sim.traffic.cars.length, 14);
    const survivors = sim.traffic.cars.filter((c) => start.has(c));
    assert.ok(survivors.every((c) => c.position.distanceTo(start.get(c)) > m(20)));
  });
});
