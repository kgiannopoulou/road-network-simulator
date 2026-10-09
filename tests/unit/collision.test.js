import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Car } from '../../src/car/car.js';
import { m } from '../../src/car/units.js';
import { bounceOffWall, CollisionWorld } from '../../src/collision/collisionWorld.js';
import { satCollision } from '../../src/collision/sat.js';
import { SpatialHash } from '../../src/collision/spatialHash.js';
import { Graph } from '../../src/graph/graph.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';
import { Simulation } from '../../src/sim/simulation.js';

const P = (x, y) => new Point(x, y);
const square = (x, y, size) => [P(x, y), P(x + size, y), P(x + size, y + size), P(x, y + size)];

function straightRoad(length = 2000, lanes = 2) {
  const graph = new Graph();
  const a = graph.addPoint(P(0, 0));
  const b = graph.addPoint(P(length, 0));
  graph.addSegment(new Segment(a, b, { lanes }));
  const network = new RoadNetwork(graph);
  network.update();
  return network;
}

describe('SAT', () => {
  it('finds the minimum translation between overlapping squares', () => {
    const hit = satCollision(square(0, 0, 10), square(8, 2, 10));
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 2) < 1e-9);
    assert.ok(Math.abs(hit.normal.x + 1) < 1e-9 && Math.abs(hit.normal.y) < 1e-9);
  });

  it('returns null for separated or just-touching shapes', () => {
    assert.equal(satCollision(square(0, 0, 10), square(11, 0, 10)), null);
    assert.equal(satCollision(square(0, 0, 10), square(10, 0, 10)), null);
  });

  it('pushes a shape out of a line segment on the side it came from', () => {
    const wall = [P(-50, 0), P(50, 0)];
    const above = satCollision(square(-5, -9, 10), wall); // 1 unit past the wall
    assert.ok(Math.abs(above.depth - 1) < 1e-9);
    assert.ok(above.normal.y < 0);
    const below = satCollision(square(-5, -1, 10), wall);
    assert.ok(below.normal.y > 0);
  });
});

describe('SpatialHash', () => {
  it('returns nearby items once and skips far ones', () => {
    const hash = new SpatialHash(10);
    hash.insert('long', { minX: 0, minY: 0, maxX: 45, maxY: 5 });
    hash.insert('far', { minX: 500, minY: 500, maxX: 505, maxY: 505 });
    assert.deepEqual(hash.query({ minX: 0, minY: 0, maxX: 50, maxY: 10 }), ['long']);
    assert.deepEqual(hash.query({ minX: 200, minY: 200, maxX: 210, maxY: 210 }), []);
  });
});

describe('Collision response', () => {
  it('bounces a head-on hit back with the restitution', () => {
    const car = new Car({ angle: 0 });
    car.state.speed = 100;
    const impact = bounceOffWall(car, P(-1, 0), 0.25, 0.3);
    assert.equal(impact, 100);
    assert.ok(Math.abs(car.state.speed + 25) < 1e-9);
  });

  it('keeps most of the speed in a glancing scrape', () => {
    const car = new Car({ angle: 0.1 });
    car.state.speed = 100;
    bounceOffWall(car, P(0, -1), 0.2, 0.3);
    assert.ok(car.state.speed > 85);
  });

  it('a car cannot drive through a road border, even at full speed with big time steps', () => {
    const network = straightRoad();
    const sim = new Simulation(network, { trafficCount: 0 });
    sim.syncRoads();
    const halfRoad = network.roads[0].width / 2;
    for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI / 3, 0.15]) {
      sim.player.teleport(1000, 0, angle);
      for (let i = 0; i < 300; i++) {
        sim.update(0.1, { forward: 1 });
        const inside = sim.player.polygon().points.every((p) => Math.abs(p.y) <= halfRoad + 0.5);
        assert.ok(inside, `escaped at angle ${angle}: y=${sim.player.state.y}`);
      }
      assert.ok(sim.player.collisionCount > 0);
    }
  });

  it('detects whether a point is on the road surface', () => {
    const network = straightRoad();
    const world = new CollisionWorld();
    world.setRoads(network.roads.map((r) => r.poly), network.borders);
    assert.ok(world.isOnRoad(P(500, 10)));
    assert.ok(!world.isOnRoad(P(500, 200)));
  });

  it('cars cannot overlap: a head-on crash separates them and kills most speed', () => {
    const network = straightRoad();
    const sim = new Simulation(network, { trafficCount: 0 });
    sim.syncRoads();
    const other = new Car({ x: 1100, y: m(1.65), angle: Math.PI });
    sim.traffic.cars.push(other);
    sim.player.teleport(900, m(1.65), 0);
    let crashed = false;
    for (let i = 0; i < 400; i++) {
      sim.update(1 / 60, { forward: 1 });
      other.input = { forward: 1 };
      if (sim.carPairs.length) crashed = true;
      const overlap = sim.player.polygon().intersectsPolygon(other.polygon());
      assert.ok(!overlap || sim.carPairs.length > 0);
    }
    assert.ok(crashed);
    assert.ok(sim.player.state.x < other.state.x);
  });
});
