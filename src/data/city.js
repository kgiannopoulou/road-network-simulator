import { m } from '../car/units.js';
import { Graph } from '../graph/graph.js';
import { Point } from '../primitives/point.js';
import { Segment } from '../primitives/segment.js';

/**
 * Phase 6 demo: a small city (coordinates in metres).
 *
 *   - a grid of two-lane streets and four-lane avenues, with signalised
 *     crossroads, all-way stops, stop/yield-controlled T-junctions and one
 *     junction with priority to the right
 *   - a one-way street, a 30 km/h zone, zebra crossings with pedestrians
 *   - a highway (two carriageways, 110 km/h) with exits, on-ramps and an
 *     acceleration lane that ends, so merging traffic has to find a gap
 *   - a frontage road so the westbound ramps don't cross the highway
 */
export function createCityGraph() {
  const graph = new Graph();
  const nodes = new Map();
  const node = (x, y) => {
    const key = `${x},${y}`;
    if (!nodes.has(key)) nodes.set(key, graph.addPoint(new Point(m(x), m(y))));
    return nodes.get(key);
  };
  const road = (a, b, attrs = {}) => graph.addSegment(new Segment(node(...a), node(...b), { lanes: 2, ...attrs }));
  const chain = (points, attrs) => {
    for (let i = 0; i < points.length - 1; i++) road(points[i], points[i + 1], attrs);
  };

  const avenue = { lanes: 4 };
  // Avenues.
  chain([[-160, 0], [0, 0], [150, 0], [300, 0], [450, 0], [600, 0], [760, 0]], avenue);
  chain([[0, 300], [150, 300], [300, 300], [450, 300], [600, 300]], avenue);
  chain([[300, -40], [300, 0], [300, 150], [300, 300]], avenue);

  // Streets.
  road([0, 150], [150, 150], { speedLimit: 30, crossing: true }); // school zone
  chain([[150, 150], [300, 150], [450, 150], [600, 150]]);
  chain([[0, 0], [0, 150], [0, 300]]);
  chain([[150, 0], [150, 150], [150, 300]], { lanes: 2, oneWay: true }); // one-way, southbound
  road([450, 0], [450, 150], { crossing: true });
  road([450, 150], [450, 300]);
  chain([[600, 0], [600, 150], [600, 300]]);

  // Frontage road north of the highway, joined to the city around its ends.
  chain([[-160, 0], [-160, -210]]);
  chain([[760, 0], [760, -210]]);
  chain([[-160, -210], [380, -210], [430, -210], [760, -210]], { speedLimit: 70 });

  // Highway, eastbound carriageway (south side): exit to the avenue, on-ramp
  // back, then an acceleration lane that ends.
  const highway = { type: 'highway', oneWay: true, lanes: 2 };
  const ramp = { type: 'ramp', oneWay: true, lanes: 1 };
  road([-100, -105], [160, -105], highway);
  road([160, -105], [440, -105], highway);
  road([440, -105], [560, -105], { ...highway, lanes: 3 }); // acceleration lane
  road([560, -105], [700, -105], highway);
  road([160, -105], [300, -40], ramp); // exit
  road([300, -40], [440, -105], ramp); // on-ramp

  // Westbound carriageway (north side), ramps to the frontage road.
  road([700, -125], [560, -125], highway);
  road([560, -125], [240, -125], highway);
  road([240, -125], [120, -125], { ...highway, lanes: 3 }); // acceleration lane
  road([120, -125], [-100, -125], highway);
  road([560, -125], [430, -210], ramp); // exit
  road([380, -210], [240, -125], ramp); // on-ramp

  // A few explicit junction controls (the rest are chosen automatically).
  graph.controls.set(node(300, -40), 'signals'); // ramps meet the avenue
  graph.controls.set(node(450, 150), 'uncontrolled'); // priority to the right
  graph.controls.set(node(380, -210), 'yield');
  graph.controls.set(node(430, -210), 'yield');
  return graph;
}
