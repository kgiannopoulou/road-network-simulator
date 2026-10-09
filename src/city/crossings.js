import { m } from '../car/units.js';
import { createRng, randomBetween } from '../math/random.js';

const WALK_SPEED = [1.1, 1.6]; // m/s
const SPAWN_GAP = [5, 14]; // s between pedestrians at each crossing

/**
 * Week 22: a zebra crossing in the middle of a road, with pedestrians who
 * walk across every few seconds. Vehicles must stop for anyone on the
 * crossing (or about to step onto it).
 */
export class Crossing {
  constructor(road, { seed = 1, t = 0.5 } = {}) {
    this.road = road;
    this.t = t;
    const seg = road.segment;
    this.center = seg.pointAt(t);
    this.along = seg.direction(); // p1 → p2
    this.across = this.along.perpendicular();
    this.halfWidth = road.width / 2;
    this.depth = m(3); // stripe length along the road
    this.rng = createRng(seed);
    this.pedestrians = [];
    this.timer = randomBetween(this.rng, 0, SPAWN_GAP[1]);
  }

  /** Distance along the road from its start in a direction (dir 1 = p1→p2) to the crossing. */
  distanceFromStart(dir) {
    const len = this.road.segment.length();
    return dir > 0 ? this.t * len : (1 - this.t) * len;
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = randomBetween(this.rng, ...SPAWN_GAP);
      const side = this.rng() < 0.5 ? -1 : 1;
      this.pedestrians.push({
        offset: side * (this.halfWidth + m(1.2)), // lateral position, starts on the pavement
        dir: -side,
        speed: m(randomBetween(this.rng, ...WALK_SPEED)),
        along: randomBetween(this.rng, -0.3, 0.3) * this.depth,
        phase: this.rng() * Math.PI * 2,
      });
    }
    for (const p of this.pedestrians) {
      p.offset += p.dir * p.speed * dt;
      p.phase += dt * 8;
    }
    this.pedestrians = this.pedestrians.filter((p) => Math.abs(p.offset) < this.halfWidth + m(1.5) || Math.sign(p.offset) !== p.dir);
  }

  /** True while anyone is on the road surface, or about to step onto it. */
  get occupied() {
    return this.pedestrians.some((p) => Math.abs(p.offset) < this.halfWidth + m(0.8));
  }

  position(p) {
    return this.center.add(this.across.scale(p.offset)).add(this.along.scale(p.along));
  }

  draw(ctx, px) {
    // Zebra stripes across the road.
    const stripe = m(0.5);
    const n = Math.floor((this.halfWidth * 2) / (stripe * 2));
    ctx.fillStyle = 'rgba(240, 240, 240, 0.85)';
    for (let k = 0; k < n; k++) {
      const off = -this.halfWidth + stripe * (2 * k + 0.5);
      const c = this.center.add(this.across.scale(off + stripe / 2));
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(this.along.angle());
      ctx.fillRect(-this.depth / 2, -stripe / 2, this.depth, stripe);
      ctx.restore();
    }
    for (const p of this.pedestrians) {
      const pos = this.position(p);
      const swing = Math.sin(p.phase) * m(0.15);
      ctx.beginPath();
      ctx.arc(pos.x + swing * this.along.x, pos.y + swing * this.along.y, m(0.32), 0, Math.PI * 2);
      ctx.fillStyle = '#ff9f0a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, m(0.2), 0, Math.PI * 2);
      ctx.fillStyle = '#3a2a1a';
      ctx.fill();
    }
  }
}
