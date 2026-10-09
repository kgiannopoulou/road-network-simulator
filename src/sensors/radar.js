import { m, toMeters } from '../car/units.js';
import { degToRad, radToDeg } from '../math/utils.js';
import { Point } from '../primitives/point.js';
import { gaussian, wrapAngle } from './noise.js';
import { Sensor } from './sensor.js';

/**
 * Week 11: forward radar.
 *
 * Reports vehicles inside its field of view as targets with range, bearing
 * and range rate (the relative speed along the line of sight; negative =
 * closing in). Like a real automotive radar it sees vehicles, not kerbs, and
 * a vehicle hidden behind another vehicle or a road edge isn't reported.
 *
 * data: { origin, heading, fov, range, targets: [{ id, range, bearing, rangeRate, x, y }] }
 */
export class Radar extends Sensor {
  constructor({ fov = degToRad(40), range = 80, rate = 20, ...options } = {}) {
    super({
      type: 'radar',
      rate,
      range,
      mount: { forward: 2.2 },
      spec: { latency: 0.05, dropRate: 0.05, rangeSigma: 0.25, bearingSigma: degToRad(0.5), rateSigma: 0.1 },
      ...options,
    });
    this.fov = fov;
  }

  get dropsParts() {
    return true;
  }

  measure(env) {
    const { origin, angle } = this.pose(env.car);
    const range = m(this.range);
    env.caster.prepare(origin, range, env.cars, env.car);
    const ownVelocity = env.car.velocity;
    const targets = [];

    for (const shape of env.caster.cars) {
      const car = shape.car;
      const nearest = nearestPoint(shape.segments, origin);
      const offset = nearest.subtract(origin);
      const distance = offset.length();
      if (distance > range || distance < 1e-6) continue;
      const bearing = wrapAngle(offset.angle() - angle);
      if (Math.abs(bearing) > this.fov / 2) continue;

      // Line of sight: the first thing a ray towards the target hits must be the target.
      const hit = env.caster.cast(origin, offset.angle(), distance + m(0.5));
      if (hit && hit.car !== car && hit.distance < distance - m(0.3)) continue;

      const los = offset.scale(1 / distance);
      const rangeRate = toMeters(car.velocity.subtract(ownVelocity).dot(los));
      targets.push({
        id: car.id,
        range: toMeters(distance),
        bearing,
        rangeRate,
        x: toMeters(nearest.x),
        y: toMeters(nearest.y),
      });
    }
    targets.sort((a, b) => a.range - b.range);
    return { origin: { x: toMeters(origin.x), y: toMeters(origin.y) }, heading: angle, fov: this.fov, range: this.range, targets };
  }

  degrade(data, imp) {
    const limit = this.effectiveRange;
    const s = this.spec;
    const targets = [];
    for (const t of data.targets) {
      if (t.range > limit) continue;
      if (imp.dropRate > 0 && this.rng() < imp.dropRate) {
        this.stats.dropped++;
        continue;
      }
      if (imp.noise === 0) {
        targets.push(t);
        continue;
      }
      const range = Math.max(0, t.range + gaussian(this.rng) * s.rangeSigma * imp.noise);
      const bearing = t.bearing + gaussian(this.rng) * s.bearingSigma * imp.noise;
      const a = data.heading + bearing;
      targets.push({
        ...t,
        range,
        bearing,
        rangeRate: t.rangeRate + gaussian(this.rng) * s.rateSigma * imp.noise,
        x: data.origin.x + Math.cos(a) * range,
        y: data.origin.y + Math.sin(a) * range,
      });
    }
    return { ...data, range: limit, targets };
  }

  describe(reading) {
    const t = reading.data.targets[0];
    if (!t) return 'no targets';
    return `${reading.data.targets.length} target${reading.data.targets.length > 1 ? 's' : ''} · nearest ${t.range.toFixed(1)} m, ${t.rangeRate >= 0 ? '+' : ''}${t.rangeRate.toFixed(1)} m/s @ ${radToDeg(t.bearing).toFixed(0)}°`;
  }

  draw(ctx, reading, px) {
    const { origin, heading, fov, range, targets } = reading.data;
    const o = { x: m(origin.x), y: m(origin.y) };
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.arc(o.x, o.y, m(range), heading - fov / 2, heading + fov / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(191, 90, 242, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(191, 90, 242, 0.45)';
    ctx.lineWidth = px;
    ctx.stroke();

    for (const t of targets) {
      const p = { x: m(t.x), y: m(t.y) };
      const s = 5 * px;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - s);
      ctx.lineTo(p.x + s, p.y);
      ctx.lineTo(p.x, p.y + s);
      ctx.lineTo(p.x - s, p.y);
      ctx.closePath();
      ctx.strokeStyle = '#bf5af2';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
      // Range rate along the line of sight: red closing in, green moving away.
      const los = Point.fromAngle(heading + t.bearing);
      const tip = { x: p.x + los.x * m(t.rangeRate) * 0.5, y: p.y + los.y * m(t.rangeRate) * 0.5 };
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.strokeStyle = t.rangeRate < 0 ? '#ff453a' : '#32d74b';
      ctx.stroke();
    }
  }
}

function nearestPoint(segments, p) {
  let best = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    const { offset } = seg.projectPoint(p);
    const q = seg.pointAt(Math.min(1, Math.max(0, offset)));
    const d = q.distanceTo(p);
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}
