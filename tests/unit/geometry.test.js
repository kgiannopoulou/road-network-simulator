import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clamp, getIntersection, getLineIntersection, inverseLerp, lerp } from '../../src/math/utils.js';
import { Matrix } from '../../src/math/matrix.js';
import { Envelope } from '../../src/primitives/envelope.js';
import { Point } from '../../src/primitives/point.js';
import { Polygon } from '../../src/primitives/polygon.js';
import { Segment } from '../../src/primitives/segment.js';

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
const closePoint = (p, x, y, eps = 1e-9) => {
  close(p.x, x, eps);
  close(p.y, y, eps);
};
const square = (x, y, size) =>
  new Polygon([new Point(x, y), new Point(x + size, y), new Point(x + size, y + size), new Point(x, y + size)]);

describe('scalar helpers', () => {
  it('lerp / inverseLerp are inverses', () => {
    assert.equal(lerp(10, 20, 0.25), 12.5);
    assert.equal(inverseLerp(10, 20, 12.5), 0.25);
    assert.equal(inverseLerp(5, 5, 5), 0);
  });

  it('clamp', () => {
    assert.equal(clamp(-1, 0, 1), 0);
    assert.equal(clamp(2, 0, 1), 1);
    assert.equal(clamp(0.5, 0, 1), 0.5);
  });
});

describe('getIntersection', () => {
  it('finds crossing segments with both offsets', () => {
    const hit = getIntersection(new Point(0, 0), new Point(10, 10), new Point(0, 10), new Point(10, 0));
    close(hit.x, 5);
    close(hit.y, 5);
    close(hit.offset, 0.5);
    close(hit.u, 0.5);
  });

  it('returns null for parallel or non-touching segments', () => {
    assert.equal(getIntersection(new Point(0, 0), new Point(10, 0), new Point(0, 5), new Point(10, 5)), null);
    assert.equal(getIntersection(new Point(0, 0), new Point(1, 1), new Point(5, 0), new Point(6, -5)), null);
  });

  it('counts touching endpoints as an intersection', () => {
    const hit = getIntersection(new Point(0, 0), new Point(10, 0), new Point(10, 0), new Point(10, 10));
    close(hit.offset, 1);
    close(hit.u, 0);
  });

  it('getLineIntersection extends beyond the segments', () => {
    const hit = getLineIntersection(new Point(0, 0), new Point(1, 0), new Point(5, 1), new Point(5, 2));
    close(hit.x, 5);
    close(hit.offset, 5);
    assert.equal(getLineIntersection(new Point(0, 0), new Point(1, 0), new Point(0, 1), new Point(1, 1)), null);
  });
});

describe('Point', () => {
  it('vector arithmetic', () => {
    const a = new Point(3, 4);
    assert.equal(a.length(), 5);
    closePoint(a.normalize(), 0.6, 0.8);
    assert.equal(a.dot(new Point(1, 0)), 3);
    assert.equal(new Point(1, 0).cross(new Point(0, 1)), 1);
    assert.deepEqual(a.add(new Point(1, 1)), new Point(4, 5));
    assert.deepEqual(a.subtract(new Point(1, 1)), new Point(2, 3));
  });

  it('perpendicular is the right-hand side in screen space', () => {
    // Facing east (+x) in a y-down system, right is south (+y).
    closePoint(new Point(1, 0).perpendicular(), 0, 1);
  });

  it('rotates around the origin and around a pivot', () => {
    closePoint(new Point(1, 0).rotate(Math.PI / 2), 0, 1);
    closePoint(new Point(2, 1).rotate(Math.PI, new Point(1, 1)), 0, 1);
  });

  it('does not mutate on arithmetic', () => {
    const a = new Point(1, 2);
    a.add(new Point(5, 5));
    a.scale(3);
    assert.deepEqual(a, new Point(1, 2));
  });

  it('lerp, distance and translate', () => {
    closePoint(Point.lerp(new Point(0, 0), new Point(10, 20), 0.5), 5, 10);
    assert.equal(new Point(0, 0).distanceTo(new Point(6, 8)), 10);
    closePoint(new Point(0, 0).translate(Math.PI / 2, 3), 0, 3);
  });
});

describe('Segment', () => {
  const seg = new Segment(new Point(0, 0), new Point(10, 0));

  it('equality is undirected', () => {
    assert.ok(seg.equals(new Segment(new Point(10, 0), new Point(0, 0))));
    assert.ok(!seg.equals(new Segment(new Point(0, 0), new Point(10, 1))));
  });

  it('projects points and measures distance to the finite segment', () => {
    const { point, offset } = seg.projectPoint(new Point(4, 7));
    closePoint(point, 4, 0);
    close(offset, 0.4);
    assert.equal(seg.distanceToPoint(new Point(4, 7)), 7);
    assert.equal(seg.distanceToPoint(new Point(13, 4)), 5); // beyond p2
  });

  it('offset() moves the copy to the right of travel', () => {
    const shifted = seg.offset(5);
    closePoint(shifted.p1, 0, 5);
    closePoint(shifted.p2, 10, 5);
    assert.equal(shifted.lanes, seg.lanes);
  });
});

describe('Polygon', () => {
  it('point containment (convex and concave)', () => {
    const sq = square(0, 0, 10);
    assert.ok(sq.containsPoint(new Point(5, 5)));
    assert.ok(!sq.containsPoint(new Point(15, 5)));

    const u = new Polygon(
      [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]].map(([x, y]) => new Point(x, y)),
    );
    assert.ok(u.containsPoint(new Point(5, 20)));
    assert.ok(!u.containsPoint(new Point(15, 20))); // inside the notch
  });

  it('intersects overlapping and nested polygons but not distant ones', () => {
    const a = square(0, 0, 10);
    assert.ok(a.intersectsPolygon(square(5, 5, 10)));
    assert.ok(a.intersectsPolygon(square(2, 2, 2))); // fully inside
    assert.ok(!a.intersectsPolygon(square(20, 20, 5)));
  });

  it('area and centroid', () => {
    const sq = square(0, 0, 10);
    assert.equal(sq.area(), 100);
    closePoint(sq.centroid(), 5, 5);
  });

  it('union outline of two overlapping squares has the right perimeter', () => {
    const outline = Polygon.union([square(0, 0, 10), square(5, 5, 10)]);
    const perimeter = outline.reduce((sum, s) => sum + s.length(), 0);
    close(perimeter, 60, 1e-6);
  });

  it('union of disjoint squares keeps every edge', () => {
    const outline = Polygon.union([square(0, 0, 10), square(50, 0, 10)]);
    assert.equal(outline.length, 8);
  });
});

describe('Matrix', () => {
  it('composes translate · rotate · scale in the right order', () => {
    const m = Matrix.translation(10, 0).rotate(Math.PI / 2).scale(2);
    // (1, 0) → scale (2, 0) → rotate (0, 2) → translate (10, 2)
    closePoint(m.apply(new Point(1, 0)), 10, 2);
  });

  it('inverts', () => {
    const m = Matrix.translation(3, -4).rotate(0.7).scale(1.5, 0.5);
    const p = new Point(12, 34);
    closePoint(m.invert().apply(m.apply(p)), 12, 34, 1e-9);
    closePoint(m.multiply(m.invert()).apply(p), 12, 34, 1e-9);
  });

  it('rotateAround matches Point.rotate', () => {
    const pivot = new Point(5, 5);
    const p = new Point(9, 2);
    const a = Matrix.identity().rotateAround(1.1, pivot).apply(p);
    const b = p.rotate(1.1, pivot);
    closePoint(a, b.x, b.y);
  });

  it('refuses to invert a singular matrix', () => {
    assert.throws(() => Matrix.scaling(0).invert());
  });
});

describe('Envelope', () => {
  const skeleton = new Segment(new Point(0, 0), new Point(100, 0));
  const env = new Envelope(skeleton, 40, 8);

  it('covers the skeleton and its rounded caps', () => {
    assert.ok(env.poly.containsPoint(new Point(50, 0)));
    assert.ok(env.poly.containsPoint(new Point(50, 19)));
    assert.ok(env.poly.containsPoint(new Point(-15, 0))); // inside the p1 cap
    assert.ok(!env.poly.containsPoint(new Point(50, 21)));
    assert.ok(!env.poly.containsPoint(new Point(125, 0)));
  });

  it('has 2 × (roundness + 1) vertices, all at half-width from the skeleton', () => {
    assert.equal(env.poly.points.length, 18);
    for (const p of env.poly.points) close(skeleton.distanceToPoint(p), 20, 1e-9);
  });
});
