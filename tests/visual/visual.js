import { getLineIntersection, lerp } from '../../src/math/utils.js';
import { Matrix } from '../../src/math/matrix.js';
import { Envelope } from '../../src/primitives/envelope.js';
import { Point } from '../../src/primitives/point.js';
import { Polygon } from '../../src/primitives/polygon.js';
import { Segment } from '../../src/primitives/segment.js';

const C = {
  a: '#78c8ff',
  b: '#ff9f6b',
  ok: '#7bd88f',
  bad: '#ff6b6b',
  accent: '#ffd54a',
  dim: 'rgba(255,255,255,0.25)',
  text: '#e6e9ec',
};

// Each test draws into a canvas with (0,0) at the top-left, given the mouse
// position, time in seconds and canvas size. It returns { text, ok }.
const tests = [
  {
    title: 'lerp() / Point.lerp()',
    description: 'Points at t = 0, 0.1 … 1 and an animated t. Mouse moves B.',
    draw(ctx, { mouse, time, w, h }) {
      const A = new Point(w * 0.15, h * 0.75);
      const B = mouse;
      new Segment(A, B).draw(ctx, { color: C.dim, width: 1 });
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const color = `hsl(${lerp(200, 20, t)}, 80%, 65%)`;
        Point.lerp(A, B, t).draw(ctx, { size: 7, color });
      }
      const t = (Math.sin(time * 1.5) + 1) / 2;
      const P = Point.lerp(A, B, t);
      P.draw(ctx, { size: 16, color: C.accent, outline: '#000' });
      label(ctx, 'A', A, C.a);
      label(ctx, 'B', B, C.b);
      const expected = A.distanceTo(B) * t;
      const ok = Math.abs(A.distanceTo(P) - expected) < 1e-6;
      return { ok, text: `t = ${t.toFixed(3)}\n|AP| = ${A.distanceTo(P).toFixed(2)}   t·|AB| = ${expected.toFixed(2)}` };
    },
  },
  {
    title: 'Projection & distance to segment',
    description: 'Closest point on the segment to the mouse; offset t is clamped to [0, 1].',
    draw(ctx, { mouse, w, h }) {
      const seg = new Segment(new Point(w * 0.15, h * 0.65), new Point(w * 0.85, h * 0.35));
      seg.draw(ctx, { color: C.a, width: 3, cap: 'round' });
      const { offset } = seg.projectPoint(mouse);
      const t = Math.min(1, Math.max(0, offset));
      const closest = seg.pointAt(t);
      new Segment(mouse, closest).draw(ctx, { color: C.accent, dash: [5, 4] });
      closest.draw(ctx, { size: 10, color: C.accent });
      mouse.draw(ctx, { size: 10, color: C.b });
      const d = seg.distanceToPoint(mouse);
      // Invariant: no sampled point on the segment is closer than the reported distance.
      let ok = true;
      for (let i = 0; i <= 200; i++) if (seg.pointAt(i / 200).distanceTo(mouse) < d - 1e-6) ok = false;
      return { ok, text: `offset t = ${offset.toFixed(3)}\ndistance = ${d.toFixed(2)}` };
    },
  },
  {
    title: 'Segment & line intersection',
    description: 'AB is fixed, CD ends at the mouse. Hollow dot: where the infinite lines meet.',
    draw(ctx, { mouse, w, h }) {
      const A = new Point(w * 0.1, h * 0.3);
      const B = new Point(w * 0.9, h * 0.7);
      const Cp = new Point(w * 0.2, h * 0.85);
      const s1 = new Segment(A, B);
      const s2 = new Segment(Cp, mouse);
      const hit = s1.intersection(s2);
      const line = getLineIntersection(A, B, Cp, mouse);
      s1.draw(ctx, { color: C.a, width: 3, cap: 'round' });
      s2.draw(ctx, { color: C.b, width: 3, cap: 'round' });
      if (line && !hit) {
        ctx.beginPath();
        ctx.strokeStyle = C.dim;
        ctx.lineWidth = 2;
        ctx.arc(line.x, line.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      let ok = true;
      if (hit) {
        const P = new Point(hit.x, hit.y);
        P.draw(ctx, { size: 14, color: hit ? C.ok : C.bad });
        ok = s1.distanceToPoint(P) < 1e-6 && s2.distanceToPoint(P) < 1e-6;
      }
      return {
        ok,
        text: hit
          ? `hit at (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)})\noffset AB = ${hit.offset.toFixed(3)}  CD = ${hit.u.toFixed(3)}`
          : `no segment hit${line ? `\nlines meet at t = ${line.offset.toFixed(2)}` : '\nparallel'}`,
      };
    },
  },
  {
    title: 'Point in polygon',
    description: 'Even–odd ray casting on a concave polygon.',
    draw(ctx, { mouse, w, h }) {
      const poly = concaveShape(w / 2, h / 2, Math.min(w, h) * 0.38);
      const inside = poly.containsPoint(mouse);
      poly.draw(ctx, { stroke: C.a, fill: inside ? 'rgba(123,216,143,0.25)' : 'rgba(120,200,255,0.1)' });
      mouse.draw(ctx, { size: 12, color: inside ? C.ok : C.bad });
      // Invariant: winding-number test agrees with ray casting.
      const ok = inside === (Math.abs(windingNumber(poly, mouse)) % 2 === 1);
      return { ok, text: `inside = ${inside}\narea = ${poly.area().toFixed(0)} px²` };
    },
  },
  {
    title: 'Polygon intersection',
    description: 'A rotating triangle follows the mouse; red when it touches the shape.',
    draw(ctx, { mouse, time, w, h }) {
      const poly = concaveShape(w / 2, h / 2, Math.min(w, h) * 0.34);
      const tri = new Polygon([new Point(0, -26), new Point(24, 18), new Point(-24, 18)]).transform(
        Matrix.translation(mouse.x, mouse.y).rotate(time),
      );
      const hit = poly.intersectsPolygon(tri);
      poly.draw(ctx, { stroke: C.a, fill: 'rgba(120,200,255,0.1)' });
      tri.draw(ctx, { stroke: hit ? C.bad : C.ok, fill: hit ? 'rgba(255,107,107,0.35)' : 'rgba(123,216,143,0.25)' });
      // Invariant: if any vertex of either shape is inside the other, they must intersect.
      const vertexInside =
        tri.points.some((p) => poly.containsPoint(p)) || poly.points.some((p) => tri.containsPoint(p));
      return { ok: !vertexInside || hit, text: `intersects = ${hit}` };
    },
  },
  {
    title: 'Rotation & Matrix transforms',
    description: 'translate → rotate → scale composed into one matrix; ghost shows the original.',
    draw(ctx, { mouse, time, w, h }) {
      const square = new Polygon([
        new Point(-30, -30),
        new Point(30, -30),
        new Point(30, 30),
        new Point(-30, 30),
      ]);
      const origin = new Point(w * 0.25, h * 0.5);
      square.transform(Matrix.translation(origin.x, origin.y)).draw(ctx, { stroke: C.dim, fill: null });
      const angle = time * 0.8;
      const s = 1 + 0.25 * Math.sin(time * 2);
      const m = Matrix.translation(mouse.x, mouse.y).rotate(angle).scale(s);
      const moved = square.transform(m);
      moved.draw(ctx, { stroke: C.accent, fill: 'rgba(255,213,74,0.15)' });
      moved.points[0].draw(ctx, { size: 8, color: C.b });

      // Point.rotate around a pivot must match Matrix.rotateAround.
      const p = new Point(origin.x + 40, origin.y);
      const viaPoint = p.rotate(angle, origin);
      const viaMatrix = Matrix.identity().rotateAround(angle, origin).apply(p);
      viaPoint.draw(ctx, { size: 8, color: C.a });
      new Segment(origin, viaPoint).draw(ctx, { color: C.a });
      const roundTrip = m.invert().apply(m.apply(new Point(13, -7)));
      const ok = viaPoint.equals(viaMatrix, 1e-9) && roundTrip.equals(new Point(13, -7), 1e-9);
      return {
        ok,
        text: `[${f(m.a)} ${f(m.c)} ${f(m.e)}]\n[${f(m.b)} ${f(m.d)} ${f(m.f)}]  det = ${f(m.determinant())}`,
      };
    },
  },
  {
    title: 'Envelope & polygon union',
    description: 'Road-shaped envelopes; the outline of their union becomes the road border.',
    draw(ctx, { mouse, w, h }) {
      const hub = new Point(w * 0.45, h * 0.55);
      const skeletons = [
        new Segment(new Point(w * 0.08, h * 0.55), hub),
        new Segment(hub, new Point(w * 0.6, h * 0.12)),
        new Segment(hub, mouse),
      ];
      const envelopes = skeletons.map((s) => new Envelope(s, 34, 10));
      for (const e of envelopes) e.poly.draw(ctx, { stroke: null, fill: '#3b4047' });
      const border = Polygon.union(envelopes.map((e) => e.poly));
      for (const seg of border) seg.draw(ctx, { color: '#ececec', width: 2, cap: 'round' });
      for (const s of skeletons) s.draw(ctx, { color: C.dim, dash: [4, 4] });
      // Invariant: no border piece lies strictly inside any envelope.
      const ok = border.every((seg) => {
        const mid = seg.midpoint();
        return !envelopes.some((e) => e.poly.containsPoint(mid) && e.poly.distanceToPoint(mid) > 1e-6);
      });
      return { ok, text: `${border.length} border segments` };
    },
  },
  {
    title: 'Offset lines (lane boundaries)',
    description: 'Segment.offset() shifts along the right-hand perpendicular — how lane lines are placed.',
    draw(ctx, { mouse, w, h }) {
      const seg = new Segment(new Point(w * 0.2, h * 0.5), mouse);
      const laneWidth = 22;
      for (let k = -2; k <= 2; k++) {
        const line = seg.offset(k * laneWidth);
        const edge = Math.abs(k) === 2;
        line.draw(ctx, {
          color: k === 0 ? '#f2c230' : '#f2f2f2',
          width: edge ? 2.5 : 1.5,
          dash: edge || k === 0 ? [] : [10, 8],
        });
      }
      seg.p1.draw(ctx, { size: 10, color: C.ok });
      seg.p2.draw(ctx, { size: 10, color: C.bad });
      const right = seg.offset(laneWidth).midpoint();
      label(ctx, 'right (+)', right.add(seg.direction().perpendicular().scale(30)), C.a);
      const ok = Math.abs(seg.offset(laneWidth).distanceToPoint(seg.midpoint()) - laneWidth) < 1e-6;
      return { ok, text: `angle = ${((seg.angle() * 180) / Math.PI).toFixed(1)}°` };
    },
  },
];

// ---- harness ---------------------------------------------------------------

const container = document.getElementById('cards');
const cards = tests.map((test) => {
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `<h2>${test.title}<span class="badge">✓</span></h2><p>${test.description}</p><canvas></canvas><div class="readout"></div>`;
  container.append(card);
  const canvas = card.querySelector('canvas');
  const state = { test, canvas, ctx: canvas.getContext('2d'), mouse: null, card };
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    state.mouse = new Point(e.clientX - r.left, e.clientY - r.top);
  });
  return state;
});

function frame(now) {
  const time = now / 1000;
  const dpr = window.devicePixelRatio || 1;
  for (const s of cards) {
    const w = s.canvas.clientWidth;
    const h = s.canvas.clientHeight;
    if (s.canvas.width !== Math.round(w * dpr)) {
      s.canvas.width = Math.round(w * dpr);
      s.canvas.height = Math.round(h * dpr);
    }
    // Before the user hovers, the "mouse" wanders on its own.
    const mouse = s.mouse ?? new Point(w * (0.6 + 0.25 * Math.cos(time * 0.7)), h * (0.5 + 0.3 * Math.sin(time)));
    s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.ctx.clearRect(0, 0, w, h);
    const { ok, text } = s.test.draw(s.ctx, { mouse, time, w, h });
    s.card.querySelector('.readout').textContent = text;
    const badge = s.card.querySelector('.badge');
    badge.textContent = ok ? '✓ pass' : '✗ fail';
    badge.classList.toggle('fail', !ok);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- helpers -----------------------------------------------------------------

function concaveShape(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.45;
    pts.push(new Point(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius));
  }
  return new Polygon(pts);
}

function windingNumber(poly, p) {
  let wn = 0;
  const pts = poly.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const side = b.subtract(a).cross(p.subtract(a));
    if (a.y <= p.y) {
      if (b.y > p.y && side > 0) wn++;
    } else if (b.y <= p.y && side < 0) wn--;
  }
  return wn;
}

function label(ctx, text, p, color = C.text) {
  ctx.fillStyle = color;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(text, p.x + 8, p.y - 8);
}

function f(n) {
  return n.toFixed(2).padStart(7);
}
