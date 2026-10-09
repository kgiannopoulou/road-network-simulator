import { fromKmh, m } from '../car/units.js';
import { Graph } from '../graph/graph.js';
import { Point } from '../primitives/point.js';
import { Segment } from '../primitives/segment.js';

/**
 * Week 18: the training curriculum, from easy to hard.
 *
 *   Straight → Curves → Sharp turns → Obstacles → Traffic → Intersections
 *
 * A course is a small road graph plus a route through it (a list of node
 * indices), optional parked obstacles along the route, optional traffic, a
 * speed limit and a time limit. Right-angle turns are only drivable from a
 * 3.3 m lane because junction corners have kerb radii (RoadNetwork fillets). Everything is deterministic, so the main
 * thread and a training worker build exactly the same course from its id.
 */
export const CURRICULUM = ['straight', 'curves', 'sharp', 'obstacles', 'traffic', 'intersections'];

export function buildCourse(id) {
  const builder = BUILDERS[id];
  if (!builder) throw new Error(`Unknown course "${id}"`);
  return { id, ...builder() };
}

export function courseInfo(id) {
  const c = BUILDERS[id] && buildCourse(id);
  return c ? { id, name: c.name, short: c.short, description: c.description } : null;
}

/** Helper: a graph from a node list and a chain/edge list. */
function graphFrom(points, edges, attributes = {}) {
  const graph = new Graph();
  const nodes = points.map(([x, y]) => graph.addPoint(new Point(m(x), m(y))));
  for (const [a, b, attrs] of edges) graph.addSegment(new Segment(nodes[a], nodes[b], { lanes: 2, ...attributes, ...attrs }));
  return graph;
}

const chain = (n, attrs) => Array.from({ length: n - 1 }, (_, i) => [i, i + 1, attrs]);
const indices = (n) => Array.from({ length: n }, (_, i) => i);

const BUILDERS = {
  straight: () => {
    const points = [
      [0, 0],
      [260, 0],
    ];
    return {
      name: 'Straight',
      short: 'straight',
      description: 'One long two-lane road. Learn to accelerate and stay in lane.',
      graph: graphFrom(points, chain(2)),
      route: [0, 1],
      speedLimit: fromKmh(60),
      timeLimit: 30,
    };
  },

  curves: () => {
    // Gentle S-bends: a sine wave sampled every 25 m.
    const points = Array.from({ length: 15 }, (_, i) => [i * 25, Math.sin(i * 0.55) * 28]);
    return {
      name: 'Curves',
      short: 'curves',
      description: 'Gentle S-bends. Learn to steer smoothly and follow the lane.',
      graph: graphFrom(points, chain(points.length)),
      route: indices(points.length),
      speedLimit: fromKmh(50),
      timeLimit: 40,
    };
  },

  sharp: () => {
    // Right angles and a tighter hairpin-like double turn.
    const points = [
      [0, 0],
      [70, 0],
      [70, 50],
      [130, 50],
      [130, -10],
      [170, -10],
      [190, 30],
      [250, 30],
    ];
    return {
      name: 'Sharp turns',
      short: 'sharp',
      description: '90° corners and a tight double bend. Learn to slow down before turning.',
      graph: graphFrom(points, chain(points.length)),
      route: indices(points.length),
      speedLimit: fromKmh(40),
      timeLimit: 50,
    };
  },

  obstacles: () => {
    // A two-lane one-way street with parked cars blocking alternate lanes.
    const points = [
      [0, 0],
      [120, 0],
      [200, 25],
      [300, 25],
    ];
    return {
      name: 'Obstacles',
      short: 'obstacles',
      description: 'A two-lane one-way street with parked cars in alternating lanes. Learn to change lanes.',
      graph: graphFrom(points, chain(points.length, { lanes: 2, oneWay: true })),
      route: indices(points.length),
      obstacles: [
        { s: 45, lane: 0 },
        { s: 85, lane: 1 },
        { s: 135, lane: 0 },
        { s: 190, lane: 1 },
        { s: 240, lane: 0 },
      ],
      speedLimit: fromKmh(40),
      timeLimit: 45,
    };
  },

  traffic: () => {
    // A four-lane road with bends, busy in both directions.
    const points = Array.from({ length: 11 }, (_, i) => [i * 40, Math.sin(i * 0.5) * 20]);
    return {
      name: 'Traffic',
      short: 'traffic',
      description: 'A busy four-lane road. Learn to keep a safe distance or overtake.',
      graph: graphFrom(points, chain(points.length, { lanes: 4 })),
      route: indices(points.length),
      traffic: 10,
      speedLimit: fromKmh(50),
      timeLimit: 55,
    };
  },

  intersections: () => {
    // A 3 × 3 grid; the route turns right, left and goes straight across.
    const g = 90;
    const points = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) points.push([col * g, row * g]);
    const id = (row, col) => row * 3 + col;
    const edges = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 2; col++) edges.push([id(row, col), id(row, col + 1)]);
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) edges.push([id(row, col), id(row + 1, col)]);
    return {
      name: 'Intersections',
      short: 'junctions',
      description: 'A grid of junctions. Follow the route: turn right, turn left, go straight on.',
      graph: graphFrom(points, edges),
      route: [id(0, 0), id(0, 1), id(1, 1), id(1, 2), id(2, 2), id(2, 1), id(2, 0)],
      traffic: 6,
      speedLimit: fromKmh(40),
      timeLimit: 70,
    };
  },
};
