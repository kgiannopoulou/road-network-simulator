import { m } from '../car/units.js';
import { castReturn, degradeReturn, metric } from './raySensor.js';
import { Sensor } from './sensor.js';

/**
 * Week 10: simulated spinning LiDAR.
 *
 * A single beam rotates `rotationHz` times per second and fires
 * `raysPerRevolution` times per turn. Like a real unit it streams small
 * packets (a slice of the turn each) rather than whole frames, so a scan is
 * smeared over the rotation: points from the start of a turn were measured
 * up to 1 / rotationHz seconds before the last ones.
 *
 * Packet data: { origin, heading, points: [{ angle, distance, kind, x, y }] }
 * Delivered reading (assembled): { points: last full revolution, packetPoints,
 *   raysPerRevolution, rotationHz, beam }  with `angle` in the car frame.
 */
export class Lidar extends Sensor {
  constructor({ raysPerRevolution = 360, rotationHz = 10, range = 50, packetRate = 40, ...options } = {}) {
    super({
      type: 'lidar',
      rate: packetRate,
      range,
      mount: { forward: 0.2 },
      spec: { latency: 0.05, dropRate: 0.03, sigma: 0.03 },
      ...options,
    });
    this.raysPerRevolution = raysPerRevolution;
    this.rotationHz = rotationHz;
    this.beam = 0; // current beam angle in the car frame
    this.window = []; // points of the last full revolution, oldest first
  }

  get dropsParts() {
    return true;
  }

  setResolution({ raysPerRevolution = this.raysPerRevolution, rotationHz = this.rotationHz }) {
    this.raysPerRevolution = raysPerRevolution;
    this.rotationHz = rotationHz;
    this.window = [];
  }

  measure(env) {
    const { origin, angle } = this.pose(env.car);
    const range = m(this.range);
    env.caster.prepare(origin, range, env.cars, env.car);

    // Rays covered since the previous packet (by elapsed time, so a slow
    // frame rate doesn't slow the rotation down).
    const elapsed = this.lastSampleTime === null ? 1 / this.rate : env.time - this.lastSampleTime;
    const step = (Math.PI * 2) / this.raysPerRevolution;
    const count = Math.min(this.raysPerRevolution, Math.max(1, Math.round((elapsed * this.rotationHz * Math.PI * 2) / step)));
    const points = [];
    for (let i = 0; i < count; i++) {
      this.beam = (this.beam + step) % (Math.PI * 2);
      points.push(castReturn(env.caster, origin, angle, this.beam, range));
    }
    return { origin: metric(origin), heading: angle, points };
  }

  degrade(data, imp) {
    const limit = this.effectiveRange;
    return { ...data, points: data.points.map((p) => degradeReturn(p, data, imp, this.spec.sigma, limit, this.rng, this.stats)) };
  }

  deliver(packet) {
    this.window.push(...packet.data.points);
    if (this.window.length > this.raysPerRevolution) this.window.splice(0, this.window.length - this.raysPerRevolution);
    return {
      ...packet,
      data: {
        points: this.window.slice(),
        packetPoints: packet.data.points.length,
        raysPerRevolution: this.raysPerRevolution,
        rotationHz: this.rotationHz,
        beam: this.beam,
        origin: packet.data.origin,
        heading: packet.data.heading,
      },
    };
  }

  describe(reading) {
    const returns = reading.data.points.filter((p) => p.distance !== null);
    const nearest = returns.length ? Math.min(...returns.map((p) => p.distance)) : null;
    return `${returns.length} pts · ${this.raysPerRevolution}/rev @ ${this.rotationHz} Hz${nearest !== null ? ` · nearest ${nearest.toFixed(1)} m` : ''}`;
  }

  /** Point cloud coloured by distance; older points of the turn are fainter. */
  draw(ctx, reading, px) {
    const { points, origin, heading, beam } = reading.data;
    const size = 2.2 * px;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (p.distance === null) continue;
      ctx.globalAlpha = 0.35 + 0.65 * (i / n);
      ctx.fillStyle = distanceColor(p.distance / this.range);
      ctx.fillRect(m(p.x) - size / 2, m(p.y) - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
    // The beam.
    const o = { x: m(origin.x), y: m(origin.y) };
    const a = heading + beam;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x + Math.cos(a) * m(this.effectiveRange), o.y + Math.sin(a) * m(this.effectiveRange));
    ctx.strokeStyle = 'rgba(100, 210, 255, 0.35)';
    ctx.lineWidth = px;
    ctx.stroke();
  }
}

/** Near = warm, far = cool (t in [0, 1]). */
export function distanceColor(t) {
  const hue = 10 + Math.min(1, Math.max(0, t)) * 200;
  return `hsl(${hue}, 95%, 60%)`;
}
