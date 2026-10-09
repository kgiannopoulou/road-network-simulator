import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoGraph } from '../../src/data/demo.js';
import { Graph } from '../../src/graph/graph.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';
import { Road } from '../../src/road/road.js';
import { clipOutside, RoadNetwork } from '../../src/road/roadNetwork.js';
import { Polygon } from '../../src/primitives/polygon.js';

const seg = (x1, y1, x2, y2, attrs) => new Segment(new Point(x1, y1), new Point(x2, y2), attrs);

describe('Road lane layout', () => {
  it('splits two-way lanes, forward lanes on the right', () => {
    const road = new Road(seg(0, 0, 100, 0, { lanes: 4 }), { laneWidth: 20 });
    assert.equal(road.width, 80);
    assert.equal(road.forwardLanes, 2);
    assert.equal(road.backwardLanes, 2);
    const lanes = road.lanes();
    assert.deepEqual(lanes.map((l) => l.direction), [-1, -1, 1, 1]);
    assert.deepEqual(lanes.map((l) => l.offset), [-30, -10, 10, 30]);
    assert.deepEqual(road.boundaries(), [
      { offset: -20, type: 'lane' },
      { offset: 0, type: 'center' },
      { offset: 20, type: 'lane' },
    ]);
  });

  it('gives the extra lane of an odd two-way road to the forward direction', () => {
    const road = new Road(seg(0, 0, 100, 0, { lanes: 3 }), { laneWidth: 20 });
    assert.equal(road.forwardLanes, 2);
    assert.equal(road.backwardLanes, 1);
    assert.equal(road.boundaries().find((b) => b.type === 'center').offset, -10);
  });

  it('one-way roads have no centre line and all lanes go forward', () => {
    const road = new Road(seg(0, 0, 100, 0, { lanes: 3, oneWay: true }), { laneWidth: 20 });
    assert.ok(road.lanes().every((l) => l.direction === 1));
    assert.ok(road.boundaries().every((b) => b.type === 'lane'));
  });

  it('a two-way road always has at least two lanes', () => {
    assert.equal(new Road(seg(0, 0, 100, 0, { lanes: 1 })).laneCount, 2);
    assert.equal(new Road(seg(0, 0, 100, 0, { lanes: 1, oneWay: true })).laneCount, 1);
  });
});

describe('clipOutside', () => {
  it('removes the part of a line inside a polygon', () => {
    const box = new Polygon([new Point(40, -10), new Point(60, -10), new Point(60, 10), new Point(40, 10)]);
    const pieces = clipOutside(seg(0, 0, 100, 0), [box]);
    assert.equal(pieces.length, 2);
    assert.ok(Math.abs(pieces[0].p2.x - 40) < 1e-9);
    assert.ok(Math.abs(pieces[1].p1.x - 60) < 1e-9);
  });

  it('keeps the whole line when nothing overlaps', () => {
    const far = new Polygon([new Point(0, 50), new Point(10, 50), new Point(10, 60)]);
    assert.equal(clipOutside(seg(0, 0, 100, 0), [far]).length, 1);
  });
});

describe('RoadNetwork', () => {
  it('rebuilds only when the graph changes', () => {
    const graph = createDemoGraph();
    const network = new RoadNetwork(graph);
    assert.equal(network.update(), true);
    assert.equal(network.update(), false);
    graph.movePoint(graph.points[0], -700, 10);
    assert.equal(network.update(), true);
    assert.equal(network.roads.length, graph.segments.length);
  });

  it('clips markings where roads meet at a junction', () => {
    // A T-junction: a horizontal road and a vertical road ending on it.
    const a = new Point(-200, 0);
    const b = new Point(0, 0);
    const c = new Point(200, 0);
    const d = new Point(0, 200);
    const graph = new Graph([a, b, c, d], [new Segment(a, b), new Segment(b, c), new Segment(b, d)]);
    const network = new RoadNetwork(graph);
    network.rebuild();

    for (const road of network.roads) {
      const others = network.roads.filter((r) => r !== road).map((r) => r.poly);
      for (const { segment } of road.markings) {
        // No marking may continue into another road's surface.
        assert.ok(!others.some((poly) => poly.containsPoint(segment.midpoint())));
      }
      assert.ok(road.markings.length > 0);
    }
  });

  it('keeps markings continuous through a simple bend', () => {
    const a = new Point(0, 0);
    const b = new Point(200, 0);
    const c = new Point(300, 150);
    const graph = new Graph([a, b, c], [new Segment(a, b), new Segment(b, c)]);
    const network = new RoadNetwork(graph);
    network.rebuild();
    const [first, second] = network.roads.map((r) => r.markings.find((m) => m.type === 'center').segment);
    // Mitred: the first road's centre line ends exactly where the second begins.
    assert.ok(first.p2.equals(second.p1, 1e-6));
  });

  it('merges connected roads into one outline', () => {
    const a = new Point(0, 0);
    const b = new Point(200, 0);
    const c = new Point(400, 0);
    const graph = new Graph([a, b, c], [new Segment(a, b), new Segment(b, c)]);
    const network = new RoadNetwork(graph);
    network.rebuild();
    // No border piece may lie strictly inside a road surface (lying on the
    // boundary of its own envelope is expected).
    for (const border of network.borders) {
      const mid = border.midpoint();
      const strictlyInside = network.roads.some(
        (r) => r.poly.containsPoint(mid) && r.poly.distanceToPoint(mid) > 1e-6,
      );
      assert.ok(!strictlyInside);
    }
    const top = network.borders.filter((s) => s.p1.y < -1 && s.p2.y < -1 && Math.abs(s.p1.y - s.p2.y) < 1e-6);
    const covered = top.reduce((sum, s) => sum + s.length(), 0);
    assert.ok(Math.abs(covered - 400) < 1e-6, `top edge should span 400, got ${covered}`);
  });

  it('places one arrow per lane per stretch, pointing in the travel direction', () => {
    const graph = new Graph();
    const p1 = graph.addPoint(new Point(0, 0));
    const p2 = graph.addPoint(new Point(200, 0));
    graph.addSegment(new Segment(p1, p2, { lanes: 2 }));
    const network = new RoadNetwork(graph);
    network.rebuild();
    const [road] = network.roads;
    assert.equal(road.arrows.length, 2);
    // Arrow tip is the vertex with the largest |x - centre|; check its side.
    for (const arrow of road.arrows) {
      const c = arrow.centroid();
      const tip = arrow.points[3];
      const forward = c.y > 0; // right-hand lane
      assert.equal(tip.x > c.x, forward);
    }
  });
});
