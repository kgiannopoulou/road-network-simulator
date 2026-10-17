// A* vs Dijkstra on the NavGraph: edges expanded, time per query, and a check
// that both always find routes of the same cost.
//
//   node tools/bench-pathfinding.mjs            # table for the README / docs
//   node tools/bench-pathfinding.mjs --json
//
// Networks: the Phase 6 city, plus square grids of 120 m blocks (seeded, a
// few roads missing and some one-way) from 10×10 to 40×40 nodes. Queries are
// random edge pairs from a seeded RNG, so every run measures the same routes.

import { m } from '../src/car/units.js';
import { City } from '../src/city/city.js';
import { createCityGraph } from '../src/data/city.js';
import { Graph } from '../src/graph/graph.js';
import { createRng } from '../src/math/random.js';
import { NavGraph } from '../src/navigation/navGraph.js';
import { findRoute } from '../src/navigation/pathfinding.js';
import { Point } from '../src/primitives/point.js';
import { Segment } from '../src/primitives/segment.js';
import { RoadNetwork } from '../src/road/roadNetwork.js';

const QUERIES = 300;
const json = process.argv.includes('--json');

function navFor(graph) {
  const network = new RoadNetwork(graph);
  network.update();
  return new NavGraph(new City(network, graph));
}

function grid(size, seed = 1) {
  const rng = createRng(seed);
  const graph = new Graph();
  const node = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) node.push(graph.addPoint(new Point(m(x * 120), m(y * 120))));
  const at = (x, y) => node[y * size + x];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (x + dx >= size || y + dy >= size) continue;
        const r = rng();
        if (r < 0.05) continue;
        const oneWay = r < 0.2;
        const [a, b] = rng() < 0.5 ? [at(x, y), at(x + dx, y + dy)] : [at(x + dx, y + dy), at(x, y)];
        graph.addSegment(new Segment(a, b, { lanes: oneWay ? 1 : 2, oneWay }));
      }
    }
  }
  return graph;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function bench(name, nav, mode) {
  const rng = createRng(42);
  const pairs = [];
  while (pairs.length < QUERIES) {
    const a = nav.edges[Math.floor(rng() * nav.edges.length)];
    const b = nav.edges[Math.floor(rng() * nav.edges.length)];
    if (a !== b) pairs.push([{ edge: a, s: a.length * 0.5 }, { edge: b, s: b.length * 0.5 }]);
  }
  const out = { network: name, edges: nav.edges.length, mode, routes: 0, unreachable: 0, mismatches: 0 };
  const stats = {};
  for (const algorithm of ['dijkstra', 'astar']) {
    // Warm up the JIT, then time each query.
    for (const [a, b] of pairs.slice(0, 20)) findRoute(nav, a, b, { algorithm, mode });
    const expanded = [];
    const micros = [];
    for (const [a, b] of pairs) {
      const t0 = process.hrtime.bigint();
      const r = findRoute(nav, a, b, { algorithm, mode });
      micros.push(Number(process.hrtime.bigint() - t0) / 1000);
      if (r) expanded.push(r.expanded);
    }
    stats[algorithm] = { expanded: median(expanded), meanExpanded: expanded.reduce((s, x) => s + x, 0) / Math.max(1, expanded.length), us: median(micros) };
  }
  for (const [a, b] of pairs) {
    const d = findRoute(nav, a, b, { algorithm: 'dijkstra', mode });
    const x = findRoute(nav, a, b, { algorithm: 'astar', mode });
    if (!d) out.unreachable++;
    else out.routes++;
    if (!!d !== !!x || (d && Math.abs(d.cost - x.cost) > 1e-6)) out.mismatches++;
  }
  return {
    ...out,
    dijkstra: stats.dijkstra,
    astar: stats.astar,
    expandedSaving: 1 - stats.astar.meanExpanded / stats.dijkstra.meanExpanded,
    speedup: stats.dijkstra.us / stats.astar.us,
  };
}

const networks = [['City (Phase 6 map)', navFor(createCityGraph())]];
for (const size of [10, 20, 30, 40]) networks.push([`Grid ${size}×${size}`, navFor(grid(size))]);

const results = [];
for (const [name, nav] of networks) for (const mode of ['shortest', 'fastest']) results.push(bench(name, nav, mode));

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const f = (n, d = 0) => n.toFixed(d);
  console.log(`${QUERIES} random routes per row; median per query; Node ${process.version}\n`);
  console.log('| Network | Directed edges | Cost | Dijkstra expanded | A* expanded | Fewer edges | Dijkstra time | A* time | Speed-up | Same cost |');
  console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |');
  for (const r of results) {
    console.log(
      `| ${r.network} | ${r.edges} | ${r.mode} | ${f(r.dijkstra.expanded)} | ${f(r.astar.expanded)} | ${f(r.expandedSaving * 100)}% | ${f(r.dijkstra.us, 1)} µs | ${f(r.astar.us, 1)} µs | ${f(r.speedup, 1)}× | ${r.mismatches === 0 ? `✓ ${r.routes}/${r.routes}` : `✗ ${r.mismatches}`} |`,
    );
  }
}
process.exit(results.every((r) => r.mismatches === 0) ? 0 : 1);
