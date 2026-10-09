import { m, toMeters } from '../car/units.js';
import { degToRad, lerp } from '../math/utils.js';
import { gaussian } from './noise.js';
import { Sensor } from './sensor.js';

/**
 * Week 9: configurable ray sensor.
 *
 *       \  |  /
 *        \ | /
 *         CAR
 *
 * `rayCount` rays fanned over `spread` around the sensor's heading, each
 * reporting the distance to the first road border or vehicle it meets.
 *
 * data: { origin: {x, y}, heading, range, rays: [{ angle, distance, kind, x, y }] }
 * `angle` is relative to the heading; `distance`/`kind`/`x`/`y` are null when
 * the ray returns nothing.
 */
export class RaySensor extends Sensor {
  constructor({ rayCount = 9, spread = degToRad(140), range = 25, rate = 30, ...options } = {}) {
    super({
      type: 'rays',
      rate,
      range,
      mount: { forward: 1.6 },
      spec: { latency: 0.02, dropRate: 0.01, sigma: 0.05 },
      ...options,
    });
    this.rayCount = rayCount;
    this.spread = spread;
  }

  get dropsParts() {
    return true;
  }

  /** Ray directions relative to the heading. A 360° fan doesn't repeat its first ray. */
  rayAngles() {
    const n = this.rayCount;
    if (n <= 1) return [0];
    const full = this.spread >= Math.PI * 2 - 1e-6;
    return Array.from({ length: n }, (_, i) =>
      full ? -Math.PI + (i / n) * Math.PI * 2 : lerp(-this.spread / 2, this.spread / 2, i / (n - 1)),
    );
  }

  measure(env) {
    const { origin, angle } = this.pose(env.car);
    const range = m(this.range);
    env.caster.prepare(origin, range, env.cars, env.car);
    const rays = this.rayAngles().map((offset) => castReturn(env.caster, origin, angle, offset, range));
    return { origin: metric(origin), heading: angle, range: this.range, rays };
  }

  degrade(data, imp) {
    const limit = this.effectiveRange;
    const rays = data.rays.map((ray) => degradeReturn(ray, data, imp, this.spec.sigma, limit, this.rng, this.stats));
    return { ...data, range: limit, rays };
  }

  describe(reading) {
    const hits = reading.data.rays.filter((r) => r.distance !== null);
    const nearest = hits.length ? Math.min(...hits.map((r) => r.distance)) : null;
    return `${hits.length}/${reading.data.rays.length} hits${nearest !== null ? ` · nearest ${nearest.toFixed(1)} m` : ''}`;
  }

  draw(ctx, reading, px) {
    const { origin, heading, range, rays } = reading.data;
    const o = { x: m(origin.x), y: m(origin.y) };
    ctx.lineWidth = 1.5 * px;
    for (const ray of rays) {
      const a = heading + ray.angle;
      const far = { x: o.x + Math.cos(a) * m(range), y: o.y + Math.sin(a) * m(range) };
      const hit = ray.distance !== null ? { x: m(ray.x), y: m(ray.y) } : far;
      line(ctx, o, hit, ray.distance !== null ? 'rgba(255, 214, 10, 0.95)' : 'rgba(255, 214, 10, 0.55)');
      if (ray.distance !== null) {
        line(ctx, hit, far, 'rgba(0, 0, 0, 0.45)');
        ctx.beginPath();
        ctx.arc(hit.x, hit.y, 2.5 * px, 0, Math.PI * 2);
        ctx.fillStyle = ray.kind === 'car' ? '#ff3b30' : '#ff9f0a';
        ctx.fill();
      }
    }
  }
}

// ---- shared by the ray sensor and the LiDAR -------------------------------

export function metric(p) {
  return { x: toMeters(p.x), y: toMeters(p.y) };
}

/** One ray, in metric units: { angle, distance, kind, x, y }. */
export function castReturn(caster, origin, heading, offset, range) {
  const hit = caster.cast(origin, heading + offset, range);
  if (!hit) return { angle: offset, distance: null, kind: null, x: null, y: null };
  return { angle: offset, distance: toMeters(hit.distance), kind: hit.kind, x: toMeters(hit.point.x), y: toMeters(hit.point.y) };
}

/** Range limit, dropout and range noise for one return. */
export function degradeReturn(ray, data, imp, sigma, limit, rng, stats) {
  if (ray.distance === null) return ray;
  const none = { angle: ray.angle, distance: null, kind: null, x: null, y: null };
  if (ray.distance > limit) return none;
  if (imp.dropRate > 0 && rng() < imp.dropRate) {
    stats.dropped++;
    return none;
  }
  if (imp.noise === 0) return ray;
  const distance = Math.max(0, ray.distance + gaussian(rng) * sigma * imp.noise);
  const a = data.heading + ray.angle;
  return {
    ...ray,
    distance,
    x: data.origin.x + Math.cos(a) * distance,
    y: data.origin.y + Math.sin(a) * distance,
  };
}

function line(ctx, a, b, color) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.stroke();
}
