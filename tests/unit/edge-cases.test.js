import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { m } from '../../src/car/units.js';
import { City } from '../../src/city/city.js';
import { satCollision } from '../../src/collision/sat.js';
import { SpatialHash } from '../../src/collision/spatialHash.js';
import { Graph } from '../../src/graph/graph.js';
import { createRng } from '../../src/math/random.js';
import { getIntersection } from '../../src/math/utils.js';
import { NavGraph } from '../../src/navigation/navGraph.js';
import { findRoute } from '../../src/navigation/pathfinding.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { RoadNetwork } from '../../src/road/roadNetwork.js';

/**
 * The awkward inputs: empty and disconnected maps, destinations behind the
 * car, degenerate geometry, shapes that only just touch. Plus a property test
 * that A* and Dijkstra agree on randomly generated road networks.
 */

const P = (x, y) => new Point(m(x), m(y));
const ALGORITHMS = ['astar', 'dijkstra'];
const MODES = ['fastest', 'shortest'];

function navFor(graph) {
  const network = new RoadNetwork(graph);
  network.update();
  return new NavGraph(new City(network, graph));
}

/** Roads between consecutive points: [[x, y], ...] → nodes, with options. */
function addPath(graph, coords, options = { lanes: 2 }) {
  const nodes = coords.map(([x, y]) => graph.tryAddPoint(P(x, y)) ?? graph.points.find((p) => p.equals(P(x, y))));
  for (let i = 1; i < nodes.length; i++) graph.addSegment(new Segment(nodes[i - 1], nodes[i], { ...options }));
  return nodes;
}

/**
 * A `size` × `size` grid of 120 m blocks with some roads removed and some
 * made one-way, from a seeded RNG, so every run builds the same networks.
 */
function randomGrid(seed, size = 5) {
  const rng = createRng(seed);
  const graph = new Graph();
  const node = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) node.push(graph.addPoint(P(x * 120, y * 120)));
  const at = (x, y) => node[y * size + x];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (x + dx >= size || y + dy >= size) continue;
        const r = rng();
        if (r < 0.15) continue; // no road here
        const [a, b] = rng() < 0.5 ? [at(x, y), at(x + dx, y + dy)] : [at(x + dx, y + dy), at(x, y)];
        graph.addSegment(new Segment(a, b, { lanes: r < 0.35 ? 1 : 2, oneWay: r < 0.35 }));
      }
    }
  }
  return graph;
}

describe('Edge cases: geometry', () => {
  it('parallel, collinear and zero-length segments have no single intersection point', () => {
    const O = new Point(0, 0);
    assert.equal(getIntersection(O, new Point(10, 0), new Point(0, 3), new Point(10, 3)), null); // parallel
    assert.equal(getIntersection(O, new Point(10, 0), new Point(5, 0), new Point(15, 0)), null); // collinear overlap
    assert.equal(getIntersection(O, O, O, new Point(10, 0)), null); // zero length
  });

  it('a T (endpoint on the other segment) and nearly parallel lines still intersect exactly', () => {
    const t = getIntersection(new Point(0, 0), new Point(10, 0), new Point(4, 0), new Point(4, 9));
    assert.deepEqual([t.x, t.y, t.offset, t.u].map((v) => v + 0), [4, 0, 0.4, 0]);
    // 0.0001 rad apart, crossing at x = 500.
    const k = Math.tan(1e-4);
    const thin = getIntersection(new Point(0, 0), new Point(1000, 0), new Point(0, -500 * k), new Point(1000, 500 * k));
    assert.ok(Math.abs(thin.x - 500) < 1e-6 && Math.abs(thin.y) < 1e-9);
  });
});

describe('Edge cases: road graphs', () => {
  it('rejects degenerate and duplicate (reversed) roads', () => {
    const graph = new Graph();
    const a = graph.addPoint(P(0, 0));
    const b = graph.addPoint(P(100, 0));
    assert.equal(graph.tryAddSegment(new Segment(a, a)), null);
    assert.ok(graph.tryAddSegment(new Segment(a, b)));
    assert.equal(graph.tryAddSegment(new Segment(b, a)), null);
    assert.equal(graph.segments.length, 1);
  });

  it('an empty map and a map of lone nodes build without roads or routes', () => {
    const empty = navFor(new Graph());
    assert.equal(empty.edges.length, 0);
    assert.equal(empty.match(P(0, 0)), null);

    const lone = new Graph();
    lone.addPoint(P(0, 0));
    lone.addPoint(P(300, 300));
    const nav = navFor(lone);
    assert.equal(nav.edges.length, 0);
    assert.equal(nav.match(P(0, 0)), null);
  });
});

describe('Edge cases: routing', () => {
  it('no route between two disconnected networks, by any algorithm or cost', () => {
    const graph = new Graph();
    addPath(graph, [[0, 0], [200, 0], [200, 200]]);
    addPath(graph, [[600, 0], [800, 0], [800, 200]]); // a separate island
    const nav = navFor(graph);
    const west = nav.match(P(100, 4.95), 0); // eastbound, towards the rest of its island
    const east = nav.match(P(700, 4.95), 0);
    assert.ok(west && east);
    for (const algorithm of ALGORITHMS) {
      for (const mode of MODES) {
        assert.equal(findRoute(nav, west, east, { algorithm, mode }), null);
        assert.equal(findRoute(nav, east, west, { algorithm, mode }), null);
      }
    }
    // Within an island it still routes.
    assert.ok(findRoute(nav, west, nav.match(P(200, 150))));
  });

  it('a destination behind the car on a dead-end street is unreachable (no U-turns)', () => {
    const graph = new Graph();
    addPath(graph, [[0, 0], [300, 0]]);
    const nav = navFor(graph);
    const edge = nav.edges[0];
    for (const algorithm of ALGORITHMS) {
      assert.equal(findRoute(nav, { edge, s: 200 }, { edge, s: 50 }, { algorithm }), null);
      const ahead = findRoute(nav, { edge, s: 50 }, { edge, s: 200 }, { algorithm });
      assert.equal(ahead.edges.length, 1);
      assert.ok(Math.abs(ahead.distance - 150) < 1e-6);
    }
  });

  it('…but on a loop it drives round the block to get there', () => {
    const graph = new Graph();
    addPath(graph, [[0, 0], [300, 0], [300, 200], [0, 200], [0, 0]]);
    const nav = navFor(graph);
    const start = nav.match(P(250, 0));
    const behind = { edge: start.edge, s: start.s - 150 };
    for (const algorithm of ALGORITHMS) {
      const route = findRoute(nav, start, behind, { algorithm, mode: 'shortest' });
      assert.ok(route, algorithm);
      assert.equal(route.edges[0], start.edge);
      assert.equal(route.edges.at(-1), start.edge);
      assert.ok(route.edges.length >= 4); // all the way round
      assert.ok(route.distance > 800 && route.distance < 1000, `${route.distance}`);
    }
  });

  it('A* and Dijkstra agree on 40 random networks (one-way streets, missing roads, dead ends)', () => {
    let astar = 0;
    let dijkstra = 0;
    let routes = 0;
    let unreachable = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const nav = navFor(randomGrid(seed));
      if (nav.edges.length < 2) continue;
      const rng = createRng(seed * 97);
      for (let i = 0; i < 15; i++) {
        const a = nav.edges[Math.floor(rng() * nav.edges.length)];
        const b = nav.edges[Math.floor(rng() * nav.edges.length)];
        const start = { edge: a, s: a.length * 0.3 };
        const goal = { edge: b, s: b.length * 0.6 };
        for (const mode of MODES) {
          const d = findRoute(nav, start, goal, { algorithm: 'dijkstra', mode });
          const x = findRoute(nav, start, goal, { algorithm: 'astar', mode });
          assert.equal(!!x, !!d, `seed ${seed}: reachability differs`);
          if (!d) {
            unreachable++;
            continue;
          }
          routes++;
          assert.ok(Math.abs(d.cost - x.cost) < 1e-6, `seed ${seed}: ${x.cost} vs ${d.cost}`);
          x.transitions.forEach((t, k) => assert.ok(x.edges[k].transitions.includes(t)));
          astar += x.expanded;
          dijkstra += d.expanded;
        }
      }
    }
    assert.ok(routes > 500, `${routes} routes`);
    assert.ok(unreachable > 0, 'the generator should produce some unreachable pairs');
    assert.ok(astar < dijkstra, `${astar} vs ${dijkstra}`);
  });
});

describe('Edge cases: collisions', () => {
  const rect = (x, y, w, h) => [new Point(x, y), new Point(x + w, y), new Point(x + w, y + h), new Point(x, y + h)];

  it('identical shapes and one shape inside another collide, and the push separates them', () => {
    const same = satCollision(rect(0, 0, 10, 10), rect(0, 0, 10, 10));
    assert.equal(same.depth, 10);

    const inner = rect(4, 3, 2, 2);
    const outer = rect(0, 0, 10, 10);
    const hit = satCollision(inner, outer);
    assert.ok(hit);
    const moved = inner.map((p) => p.add(hit.normal.scale(hit.depth + 1e-9)));
    assert.equal(satCollision(moved, outer), null);
  });

  it('shapes that only touch, corner to edge or edge to edge, do not collide', () => {
    assert.equal(satCollision(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), null);
    const diamond = [new Point(15, 5), new Point(20, 0), new Point(25, 5), new Point(20, 10)];
    assert.equal(satCollision(rect(5, 0, 10, 10), diamond), null);
    // A road border lying along the car's side.
    assert.equal(satCollision(rect(0, 0, 4, 2), [new Point(-5, 0), new Point(10, 0)]), null);
  });

  it('a rotated car overlapping only at a corner is caught', () => {
    const c = Math.SQRT1_2;
    const rotated = [new Point(10.5, 5), new Point(10.5 + 2 * c, 5 - 2 * c), new Point(10.5 + 4 * c, 5), new Point(10.5 + 2 * c, 5 + 2 * c)];
    const hit = satCollision(rect(0, 0, 11, 10), rotated);
    assert.ok(hit && hit.depth > 0 && hit.depth <= 0.5 + 1e-9);
  });

  it('the spatial hash finds items lying exactly on a cell boundary from either side', () => {
    const hash = new SpatialHash(10);
    hash.insert('edge', { minX: 10, minY: 10, maxX: 10, maxY: 10 });
    assert.deepEqual(hash.query({ minX: 5, minY: 5, maxX: 10, maxY: 10 }), ['edge']);
    assert.deepEqual(hash.query({ minX: 10, minY: 10, maxX: 15, maxY: 15 }), ['edge']);
    assert.deepEqual(hash.query({ minX: -100, minY: -100, maxX: -90, maxY: -90 }), []);
  });
});
