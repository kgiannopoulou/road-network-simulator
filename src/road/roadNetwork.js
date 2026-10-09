import { boxesOverlap, getIntersection, getLineIntersection } from '../math/utils.js';
import { Matrix } from '../math/matrix.js';
import { Point } from '../primitives/point.js';
import { Polygon } from '../primitives/polygon.js';
import { Segment } from '../primitives/segment.js';
import { Road } from './road.js';

export const ROAD_DEFAULTS = {
  laneWidth: 22,
  roundness: 12,
  surfaceColor: '#3b4047',
  borderColor: '#ececec',
  borderWidth: 2.5,
  laneColor: '#f2f2f2',
  laneDash: [12, 12],
  markingWidth: 1.6,
  centerColor: '#f2c230',
  centerGap: 1.8,
  arrowColor: 'rgba(255, 255, 255, 0.5)',
  arrowSpacing: 240,
};

// Lane arrow pointing along +x, centred on the origin, sized for a 22-unit lane.
const ARROW_TEMPLATE = new Polygon(
  [
    [-9, -1.6],
    [3, -1.6],
    [3, -5],
    [10, 0],
    [3, 5],
    [3, 1.6],
    [-9, 1.6],
  ].map(([x, y]) => new Point(x, y)),
);

/**
 * Turns the road graph into drawable road geometry:
 *   - a surface polygon (envelope) per edge, sized by lane count;
 *   - borders: the outline of the union of all envelopes, so connected roads
 *     merge into one surface with no internal edges;
 *   - lane markings (centre lines + dashed lane lines) clipped where another
 *     road joins, and mitred across simple bends;
 *   - direction arrows per lane.
 *
 * Geometry is rebuilt only when the graph's version changes.
 */
export class RoadNetwork {
  constructor(graph, options = {}) {
    this.graph = graph;
    this.options = { ...ROAD_DEFAULTS, ...options };
    this.roads = [];
    this.borders = [];
    this.builtVersion = -1;
    this.buildMs = 0;
  }

  /** Rebuild if the graph changed. Returns true when a rebuild happened. */
  update() {
    if (this.graph.version === this.builtVersion) return false;
    this.rebuild();
    return true;
  }

  rebuild() {
    const start = performance.now();
    const { laneWidth, roundness } = this.options;

    this.roads = this.graph.segments.map((s) => new Road(s, { laneWidth, roundness }));
    this.borders = Polygon.union(this.roads.map((r) => r.poly));

    const roadsAtNode = new Map();
    for (const road of this.roads) {
      for (const p of [road.segment.p1, road.segment.p2]) {
        if (!roadsAtNode.has(p)) roadsAtNode.set(p, []);
        roadsAtNode.get(p).push(road);
      }
    }
    for (const road of this.roads) this.#buildMarkings(road, roadsAtNode);

    this.builtVersion = this.graph.version;
    this.buildMs = performance.now() - start;
  }

  stats() {
    let markings = 0;
    let arrows = 0;
    for (const r of this.roads) {
      markings += r.markings.length;
      arrows += r.arrows.length;
    }
    return { roads: this.roads.length, borders: this.borders.length, markings, arrows };
  }

  // ---- marking generation ---------------------------------------------------

  #buildMarkings(road, roadsAtNode) {
    const seg = road.segment;
    road.markings = [];
    road.arrows = [];

    // A neighbour that simply continues this road through a degree-2 node with
    // the same lane layout doesn't interrupt the markings — they are mitred
    // instead. Every other overlapping road clips them.
    const continuation = {
      p1: this.#continuationAt(road, seg.p1, roadsAtNode),
      p2: this.#continuationAt(road, seg.p2, roadsAtNode),
    };
    const blockers = this.roads
      .filter(
        (other) =>
          other !== road &&
          other !== continuation.p1?.road &&
          other !== continuation.p2?.road &&
          boxesOverlap(other.poly.box, road.poly.box),
      )
      .map((other) => other.poly);

    for (const boundary of road.boundaries()) {
      const line = seg.offset(boundary.offset);
      for (const end of ['p1', 'p2']) {
        const next = continuation[end];
        if (!next) continue;
        const nextLine = next.road.segment.offset(next.sameDirection ? boundary.offset : -boundary.offset);
        const hit = getLineIntersection(line.p1, line.p2, nextLine.p1, nextLine.p2);
        if (hit && line[end].distanceTo(hit) < road.width * 2) line[end] = new Point(hit.x, hit.y);
      }
      for (const piece of clipOutside(line, blockers)) {
        road.markings.push({ type: boundary.type, segment: piece });
      }
    }

    this.#buildArrows(road, blockers);
  }

  #continuationAt(road, node, roadsAtNode) {
    const here = roadsAtNode.get(node) ?? [];
    if (here.length !== 2) return null;
    const other = here[0] === road ? here[1] : here[0];
    const a = road.segment;
    const b = other.segment;
    const sameDirection = a.p2 === b.p1 || a.p1 === b.p2;
    const compatible =
      other.laneCount === road.laneCount &&
      other.oneWay === road.oneWay &&
      // Flipping a two-way road mirrors its lanes, which only lines up when
      // the lane count is even; a one-way road must keep its direction.
      (sameDirection || (!road.oneWay && road.laneCount % 2 === 0));
    return compatible ? { road: other, sameDirection } : null;
  }

  #buildArrows(road, blockers) {
    const seg = road.segment;
    const length = seg.length();
    if (length < road.width * 1.5) return;

    const count = Math.max(1, Math.floor(length / this.options.arrowSpacing));
    const right = seg.direction().perpendicular();
    const scale = road.laneWidth / 22;

    for (let i = 0; i < count; i++) {
      const base = seg.pointAt((i + 0.5) / count);
      for (const lane of road.lanes()) {
        const center = base.add(right.scale(lane.offset));
        if (blockers.some((poly) => poly.containsPoint(center))) continue;
        const angle = seg.angle() + (lane.direction < 0 ? Math.PI : 0);
        const transform = Matrix.translation(center.x, center.y).rotate(angle).scale(scale);
        road.arrows.push(ARROW_TEMPLATE.transform(transform));
      }
    }
  }

  // ---- drawing -----------------------------------------------------------

  draw(ctx, { debug = false } = {}) {
    const o = this.options;

    for (const road of this.roads) {
      road.poly.draw(ctx, { fill: o.surfaceColor, stroke: o.surfaceColor, lineWidth: 1, join: 'round' });
    }

    for (const road of this.roads) {
      for (const arrow of road.arrows) arrow.draw(ctx, { fill: o.arrowColor, stroke: null });
      for (const { type, segment } of road.markings) {
        if (type === 'center') {
          segment.offset(-o.centerGap).draw(ctx, { width: o.markingWidth, color: o.centerColor });
          segment.offset(o.centerGap).draw(ctx, { width: o.markingWidth, color: o.centerColor });
        } else {
          segment.draw(ctx, { width: o.markingWidth, color: o.laneColor, dash: o.laneDash });
        }
      }
    }

    for (const border of this.borders) {
      border.draw(ctx, { width: o.borderWidth, color: o.borderColor, cap: 'round' });
    }

    if (debug) this.#drawDebug(ctx);
  }

  #drawDebug(ctx) {
    for (const road of this.roads) {
      road.poly.draw(ctx, { fill: null, stroke: 'rgba(255, 0, 200, 0.6)', lineWidth: 1 });
      for (const p of road.poly.points) p.draw(ctx, { size: 3, color: 'rgba(255, 0, 200, 0.8)' });
      const { minX, minY, maxX, maxY } = road.poly.box;
      ctx.strokeStyle = 'rgba(0, 255, 200, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    }
    for (const border of this.borders) {
      border.p1.draw(ctx, { size: 4, color: '#00e5ff' });
    }
  }
}

/**
 * Pieces of `seg` lying outside every polygon in `polys`. The segment is cut at
 * each polygon edge crossing and every piece is classified by its midpoint.
 */
export function clipOutside(seg, polys) {
  if (polys.length === 0) return [seg];
  const box = Polygon.boundingBox([seg.p1, seg.p2]);
  const cuts = [0, 1];
  const relevant = polys.filter((poly) => boxesOverlap(poly.box, box));
  for (const poly of relevant) {
    for (const edge of poly.segments) {
      const hit = getIntersection(seg.p1, seg.p2, edge.p1, edge.p2);
      if (hit) cuts.push(hit.offset);
    }
  }
  cuts.sort((a, b) => a - b);

  const kept = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-6) continue;
    const mid = seg.pointAt((a + b) / 2);
    if (relevant.some((poly) => poly.containsPoint(mid))) continue;
    const last = kept[kept.length - 1];
    if (last && Math.abs(last.end - a) < 1e-6) last.end = b;
    else kept.push({ start: a, end: b });
  }
  return kept.map(({ start, end }) => new Segment(seg.pointAt(start), seg.pointAt(end)));
}
