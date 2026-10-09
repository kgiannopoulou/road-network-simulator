import { Graph } from '../graph/graph.js';
import { Point } from '../primitives/point.js';
import { Segment } from '../primitives/segment.js';

/**
 * A small sample network that exercises every road feature: a four-lane
 * avenue, crossroads, a T-junction, a one-way street, an odd lane count and a
 * curved road built from a chain of short segments.
 */
export function createDemoGraph() {
  const graph = new Graph();
  const nodes = {};
  const node = (name, x, y) => (nodes[name] = graph.addPoint(new Point(x, y)));
  const road = (a, b, attrs = {}) => graph.addSegment(new Segment(nodes[a], nodes[b], attrs));

  node('west', -650, 0);
  node('cross', -200, 0);
  node('tee', 200, 0);
  node('east', 600, 0);
  node('north', -200, -360);
  node('south', -200, 360);
  node('northEast', 200, -360);
  node('southEast', 260, 330);
  node('c1', 760, -70);
  node('c2', 850, -210);
  node('c3', 860, -360);
  node('c4', 800, -500);

  const avenue = { lanes: 4 };
  road('west', 'cross', avenue);
  road('cross', 'tee', avenue);
  road('tee', 'east', avenue);

  road('north', 'cross');
  road('cross', 'south');
  road('north', 'northEast');

  // One-way street heading north from the T-junction.
  road('tee', 'northEast', { lanes: 2, oneWay: true });

  // Three lanes: two eastbound, one westbound.
  road('south', 'southEast', { lanes: 3 });

  // Curve: a chain of edges joined at degree-2 nodes keeps continuous markings.
  road('east', 'c1');
  road('c1', 'c2');
  road('c2', 'c3');
  road('c3', 'c4');

  return graph;
}
