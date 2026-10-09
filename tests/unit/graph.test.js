import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Graph } from '../../src/graph/graph.js';
import { Point } from '../../src/primitives/point.js';
import { Segment } from '../../src/primitives/segment.js';

function triangle() {
  const a = new Point(0, 0);
  const b = new Point(100, 0);
  const c = new Point(50, 80);
  const graph = new Graph([a, b, c], [new Segment(a, b), new Segment(b, c, { lanes: 3 }), new Segment(c, a)]);
  return { graph, a, b, c };
}

describe('Graph', () => {
  it('rejects duplicate points and edges (in either direction)', () => {
    const { graph, a, b } = triangle();
    assert.equal(graph.tryAddPoint(new Point(0, 0)), null);
    assert.equal(graph.tryAddSegment(new Segment(b, a)), null);
    assert.equal(graph.tryAddSegment(new Segment(a, a)), null);
    assert.equal(graph.segments.length, 3);
  });

  it('removing a node removes its edges', () => {
    const { graph, a } = triangle();
    graph.removePoint(a);
    assert.equal(graph.points.length, 2);
    assert.equal(graph.segments.length, 1);
    assert.equal(graph.getSegmentsWithPoint(a).length, 0);
  });

  it('moving a node moves every connected edge', () => {
    const { graph, a } = triangle();
    graph.movePoint(a, -10, -10);
    for (const s of graph.getSegmentsWithPoint(a)) assert.ok(s.includes(new Point(-10, -10)));
  });

  it('bumps the version on every change', () => {
    const { graph, a } = triangle();
    const v0 = graph.version;
    graph.movePoint(a, 1, 1);
    const v1 = graph.version;
    graph.movePoint(a, 1, 1); // no-op
    assert.ok(v1 > v0);
    assert.equal(graph.version, v1);
  });

  it('splits an edge, keeping its attributes', () => {
    const { graph, b, c } = triangle();
    const seg = graph.segments[1];
    const node = graph.splitSegment(seg, new Point(80, 30));
    assert.equal(graph.points.length, 4);
    assert.equal(graph.segments.length, 4);
    assert.equal(graph.degree(node), 2);
    assert.ok(seg.distanceToPoint(node) < 1e-9);
    for (const s of graph.getSegmentsWithPoint(node)) assert.equal(s.lanes, 3);
    assert.ok(graph.getSegmentsWithPoint(b).some((s) => s.otherEnd(b) === node));
    assert.ok(graph.getSegmentsWithPoint(c).some((s) => s.otherEnd(c) === node));
  });

  it('finds the nearest node / edge within a radius', () => {
    const { graph, b } = triangle();
    assert.equal(graph.getNearestPoint(new Point(98, 3), 10), b);
    assert.equal(graph.getNearestPoint(new Point(200, 200), 10), null);
    assert.equal(graph.getNearestSegment(new Point(50, -4), 10), graph.segments[0]);
  });

  it('round-trips through JSON with shared node identity', () => {
    const { graph } = triangle();
    graph.segments[0].oneWay = true;
    const copy = Graph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
    assert.equal(copy.points.length, 3);
    assert.equal(copy.segments.length, 3);
    assert.equal(copy.segments[0].oneWay, true);
    assert.equal(copy.segments[1].lanes, 3);
    // Edges must reference the same Point instances as the node list.
    for (const s of copy.segments) {
      assert.ok(copy.points.includes(s.p1));
      assert.ok(copy.points.includes(s.p2));
    }
  });
});
