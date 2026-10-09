import { boxesOverlap } from '../math/utils.js';
import { Point } from '../primitives/point.js';
import { Polygon } from '../primitives/polygon.js';
import { satCollision } from './sat.js';
import { SpatialHash } from './spatialHash.js';

/**
 * Car–road and car–car collisions.
 *
 * Road borders (the outline of the merged road surface) are line segments in
 * a spatial hash. Every car is a rectangle polygon. Overlaps are found with
 * SAT, then resolved by pushing the car out along the minimum translation
 * vector and removing the part of its velocity that points into the obstacle,
 * so cars slide along walls instead of sticking or passing through.
 */
export class CollisionWorld {
  constructor({ cellSize = 80, restitution = 0.2, wallFriction = 0.3, carRestitution = 0.3 } = {}) {
    this.borderHash = new SpatialHash(cellSize);
    this.roadHash = new SpatialHash(cellSize * 2);
    this.restitution = restitution;
    this.wallFriction = wallFriction;
    this.carRestitution = carRestitution;
    this.borders = [];
  }

  setRoads(roadPolygons, borders) {
    this.borders = borders;
    this.borderHash.clear();
    for (const seg of borders) this.borderHash.insert(seg, Polygon.boundingBox([seg.p1, seg.p2]));
    this.roadHash.clear();
    for (const poly of roadPolygons) this.roadHash.insert(poly, poly.box);
  }

  bordersNear(box) {
    return this.borderHash.query(box);
  }

  isOnRoad(point) {
    const box = { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
    return this.roadHash.query(box).some((poly) => poly.containsPoint(point));
  }

  /**
   * Push `car` out of every road border it overlaps. Returns the contacts
   * that were resolved: { segment, normal, depth, point, impact }.
   */
  resolveRoad(car, maxIterations = 4) {
    const contacts = [];
    for (let i = 0; i < maxIterations; i++) {
      const poly = car.polygon();
      let deepest = null;
      for (const segment of this.bordersNear(poly.box)) {
        const hit = satCollision(poly.points, [segment.p1, segment.p2]);
        if (hit && (!deepest || hit.depth > deepest.depth)) deepest = { ...hit, segment };
      }
      if (!deepest) break;

      car.state.x += deepest.normal.x * (deepest.depth + 0.01);
      car.state.y += deepest.normal.y * (deepest.depth + 0.01);
      deepest.impact = bounceOffWall(car, deepest.normal, this.restitution, this.wallFriction);
      deepest.point = closestPointOnSegment(deepest.segment, car.position);
      contacts.push(deepest);
    }
    return contacts;
  }

  /** Separate overlapping cars and exchange momentum (equal masses). */
  resolveCars(cars) {
    const pairs = [];
    for (let i = 0; i < cars.length - 1; i++) {
      const a = cars[i];
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        const reach = a.radius + b.radius;
        if (Math.abs(a.state.x - b.state.x) > reach || Math.abs(a.state.y - b.state.y) > reach) continue;
        const pa = a.polygon();
        const pb = b.polygon();
        if (!boxesOverlap(pa.box, pb.box)) continue;
        const hit = satCollision(pa.points, pb.points);
        if (!hit) continue;

        const half = (hit.depth + 0.01) / 2;
        a.state.x += hit.normal.x * half;
        a.state.y += hit.normal.y * half;
        b.state.x -= hit.normal.x * half;
        b.state.y -= hit.normal.y * half;
        const impact = exchangeMomentum(a, b, hit.normal, this.carRestitution);
        pairs.push({ a, b, normal: hit.normal, depth: hit.depth, impact, point: Point.average(a.position, b.position) });
      }
    }
    return pairs;
  }

  /** True if the car's rectangle overlaps any border (no resolution). */
  touchesRoadEdge(car) {
    const poly = car.polygon();
    return this.bordersNear(poly.box).some((s) => satCollision(poly.points, [s.p1, s.p2]));
  }
}

const MAX_ALIGN = 0.04; // rad per contact

/**
 * Reflect the velocity component that points into the wall (normal points
 * away from the wall) and apply Coulomb friction to the sliding part. Cars
 * only move along their heading, so the car is also turned a little towards
 * the direction it is being deflected in; that lets it scrape along a wall
 * instead of grinding to a halt against it. Returns the impact speed.
 */
export function bounceOffWall(car, normal, restitution, friction) {
  const heading = car.forward;
  const velocity = heading.scale(car.state.speed);
  const vn = velocity.dot(normal);
  if (vn >= 0) return 0;
  const tangent = normal.perpendicular();
  const vt = velocity.dot(tangent);
  const slide = Math.sign(vt) * Math.max(0, Math.abs(vt) - friction * (1 + restitution) * -vn);
  const out = tangent.scale(slide).add(normal.scale(-vn * restitution));

  if (Math.abs(slide) > 1e-6) {
    const travel = car.state.speed >= 0 ? heading : heading.scale(-1);
    const along = tangent.scale(Math.sign(slide));
    const turn = Math.atan2(travel.cross(along), travel.dot(along));
    car.state.angle += Math.max(-MAX_ALIGN, Math.min(MAX_ALIGN, turn));
  }
  car.state.speed = out.dot(car.forward);
  return -vn;
}

/** Inelastic impulse between two equal-mass cars; normal points from b to a. */
export function exchangeMomentum(a, b, normal, restitution) {
  const va = a.velocity;
  const vb = b.velocity;
  const closing = va.subtract(vb).dot(normal);
  if (closing >= 0) return 0;
  const j = (-(1 + restitution) * closing) / 2;
  a.state.speed = va.add(normal.scale(j)).dot(a.forward);
  b.state.speed = vb.subtract(normal.scale(j)).dot(b.forward);
  return -closing;
}

function closestPointOnSegment(seg, p) {
  const { offset } = seg.projectPoint(p);
  return seg.pointAt(Math.min(1, Math.max(0, offset)));
}
