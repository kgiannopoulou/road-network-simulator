import { Point } from '../primitives/point.js';
import { Segment } from '../primitives/segment.js';

/**
 * Road graph: nodes are Points, edges are Segments that reference those exact
 * Point instances. Moving a node therefore moves every connected edge.
 *
 * `version` increases on every change so consumers (road generator, autosave)
 * can cheaply detect when they need to rebuild.
 */
export class Graph {
  constructor(points = [], segments = []) {
    this.points = points;
    this.segments = segments;
    this.version = 0;
  }

  static fromJSON(data) {
    const points = (data.points ?? []).map(([x, y]) => new Point(x, y));
    const segments = (data.segments ?? [])
      .filter((s) => points[s.a] && points[s.b] && s.a !== s.b)
      .map((s) => new Segment(points[s.a], points[s.b], { lanes: s.lanes ?? 2, oneWay: !!s.oneWay }));
    return new Graph(points, segments);
  }

  toJSON() {
    const index = new Map(this.points.map((p, i) => [p, i]));
    return {
      version: 1,
      points: this.points.map((p) => [round(p.x), round(p.y)]),
      segments: this.segments.map((s) => ({
        a: index.get(s.p1),
        b: index.get(s.p2),
        lanes: s.lanes,
        oneWay: s.oneWay,
      })),
    };
  }

  /** Replace the contents with another graph's (keeps this instance & bumps version). */
  load(other) {
    this.points = other.points;
    this.segments = other.segments;
    this.touch();
  }

  touch() {
    this.version++;
  }

  // ---- nodes -------------------------------------------------------------

  addPoint(point) {
    this.points.push(point);
    this.touch();
    return point;
  }

  containsPoint(point) {
    return this.points.find((p) => p.equals(point));
  }

  tryAddPoint(point) {
    if (this.containsPoint(point)) return null;
    return this.addPoint(point);
  }

  /** Remove a node and every edge connected to it. */
  removePoint(point) {
    for (const seg of this.getSegmentsWithPoint(point)) this.removeSegment(seg);
    const i = this.points.indexOf(point);
    if (i >= 0) this.points.splice(i, 1);
    this.touch();
  }

  movePoint(point, x, y) {
    if (point.x === x && point.y === y) return;
    point.set(x, y);
    this.touch();
  }

  degree(point) {
    return this.getSegmentsWithPoint(point).length;
  }

  getNearestPoint(location, maxDistance = Infinity) {
    let best = null;
    let bestDist = maxDistance;
    for (const p of this.points) {
      const d = p.distanceTo(location);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
  }

  // ---- edges -------------------------------------------------------------

  addSegment(segment) {
    this.segments.push(segment);
    this.touch();
    return segment;
  }

  containsSegment(segment) {
    return this.segments.find((s) => s.equals(segment));
  }

  /** Adds the edge unless it is degenerate or already exists (in either direction). */
  tryAddSegment(segment) {
    if (segment.p1.equals(segment.p2) || this.containsSegment(segment)) return null;
    return this.addSegment(segment);
  }

  removeSegment(segment) {
    const i = this.segments.indexOf(segment);
    if (i >= 0) this.segments.splice(i, 1);
    this.touch();
  }

  getSegmentsWithPoint(point) {
    return this.segments.filter((s) => s.p1 === point || s.p2 === point);
  }

  getNearestSegment(location, maxDistance = Infinity) {
    let best = null;
    let bestDist = maxDistance;
    for (const s of this.segments) {
      const d = s.distanceToPoint(location);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Insert a new node at `location` (projected onto `segment`) and replace the
   * edge with two edges that keep its road attributes. Returns the new node.
   */
  splitSegment(segment, location) {
    const { point } = segment.projectPoint(location);
    const node = this.addPoint(point);
    const { p1, p2 } = segment;
    this.removeSegment(segment);
    this.addSegment(new Segment(p1, node, segment.attributes));
    this.addSegment(new Segment(node, p2, segment.attributes));
    return node;
  }

  boundingBox() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  clear() {
    this.points = [];
    this.segments = [];
    this.touch();
  }

  draw(ctx, { pointSize = 14, segmentWidth = 2, color = '#e8e8e8' } = {}) {
    for (const seg of this.segments) seg.draw(ctx, { width: segmentWidth, color });
    for (const p of this.points) p.draw(ctx, { size: pointSize, color });
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}
