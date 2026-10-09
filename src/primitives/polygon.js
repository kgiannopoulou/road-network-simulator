import { boxesOverlap, getIntersection } from '../math/utils.js';
import { Point } from './point.js';
import { Segment } from './segment.js';

const BREAK_EPSILON = 1e-6;

export class Polygon {
  constructor(points) {
    this.points = points;
    this.segments = [];
    for (let i = 0; i < points.length; i++) {
      this.segments.push(new Segment(points[i], points[(i + 1) % points.length]));
    }
    this.box = Polygon.boundingBox(points);
  }

  static boundingBox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  /**
   * Outline of the union of several polygons, as a list of segments.
   * Every edge is split where it crosses another polygon, then only the pieces
   * that are not inside any other polygon are kept. Mutates the polygons'
   * `segments` arrays (their `points` stay untouched).
   */
  static union(polygons) {
    Polygon.multiBreak(polygons);
    const kept = [];
    for (let i = 0; i < polygons.length; i++) {
      for (const seg of polygons[i].segments) {
        let keep = true;
        for (let j = 0; j < polygons.length; j++) {
          if (i === j || !boxesOverlap(polygons[i].box, polygons[j].box)) continue;
          if (polygons[j].containsSegment(seg)) {
            keep = false;
            break;
          }
        }
        if (keep) kept.push(seg);
      }
    }
    return kept;
  }

  static multiBreak(polygons) {
    for (let i = 0; i < polygons.length - 1; i++) {
      for (let j = i + 1; j < polygons.length; j++) {
        if (boxesOverlap(polygons[i].box, polygons[j].box)) {
          Polygon.break(polygons[i], polygons[j]);
        }
      }
    }
  }

  /** Split the edges of both polygons at every point where they cross. */
  static break(poly1, poly2) {
    const segs1 = poly1.segments;
    const segs2 = poly2.segments;
    for (let i = 0; i < segs1.length; i++) {
      for (let j = 0; j < segs2.length; j++) {
        const hit = getIntersection(segs1[i].p1, segs1[i].p2, segs2[j].p1, segs2[j].p2);
        if (
          hit &&
          hit.offset > BREAK_EPSILON &&
          hit.offset < 1 - BREAK_EPSILON &&
          hit.u > BREAK_EPSILON &&
          hit.u < 1 - BREAK_EPSILON
        ) {
          const point = new Point(hit.x, hit.y);
          let tail = segs1[i].p2;
          segs1[i].p2 = point;
          segs1.splice(i + 1, 0, new Segment(point, tail));
          tail = segs2[j].p2;
          segs2[j].p2 = point;
          segs2.splice(j + 1, 0, new Segment(point, tail));
        }
      }
    }
  }

  /** Even–odd ray casting test. */
  containsPoint(point) {
    const pts = this.points;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > point.y !== b.y > point.y) {
        const xCross = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (point.x < xCross) inside = !inside;
      }
    }
    return inside;
  }

  containsSegment(seg) {
    return this.containsPoint(seg.midpoint());
  }

  /** True if the outlines cross or one polygon lies fully inside the other. */
  intersectsPolygon(poly) {
    if (!boxesOverlap(this.box, poly.box)) return false;
    for (const s1 of this.segments) {
      for (const s2 of poly.segments) {
        if (s1.intersection(s2)) return true;
      }
    }
    return this.containsPoint(poly.points[0]) || poly.containsPoint(this.points[0]);
  }

  distanceToPoint(point) {
    return Math.min(...this.segments.map((s) => s.distanceToPoint(point)));
  }

  /** Shoelace area; positive when points wind clockwise on screen (y down). */
  signedArea() {
    let sum = 0;
    for (let i = 0; i < this.points.length; i++) {
      const a = this.points[i];
      const b = this.points[(i + 1) % this.points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  }

  area() {
    return Math.abs(this.signedArea());
  }

  /** Vertex average — good enough for convex shapes and labels. */
  centroid() {
    const sum = this.points.reduce((acc, p) => acc.add(p), new Point(0, 0));
    return sum.scale(1 / this.points.length);
  }

  transform(matrix) {
    return new Polygon(matrix.applyAll(this.points));
  }

  draw(
    ctx,
    { stroke = '#4aa3ff', lineWidth = 2, fill = 'rgba(74, 163, 255, 0.3)', join = 'miter' } = {},
  ) {
    if (this.points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = join;
      ctx.stroke();
    }
  }
}
