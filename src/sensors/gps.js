import { m, toMeters } from '../car/units.js';
import { degToRad, radToDeg } from '../math/utils.js';
import { GaussMarkov, gaussian, wrapAngle } from './noise.js';
import { Sensor } from './sensor.js';

const MIN_COURSE_SPEED = 1; // m/s: below this a GPS can't tell which way you're heading

/**
 * Week 11: GPS receiver.
 *
 * Position error = slowly drifting bias (Gauss–Markov, ~30 s correlation)
 * + white noise, the way a real receiver's fix wanders around the truth
 * instead of jittering independently every sample. Heading is course over
 * ground, so it's only available while moving.
 *
 * data: { x, y, heading (null when slow), speed, accuracy }  (m, rad, m/s, 1σ m)
 */
export class Gps extends Sensor {
  constructor({ rate = 5, ...options } = {}) {
    super({
      type: 'gps',
      rate,
      spec: { latency: 0.15, dropRate: 0.03, sigma: 1.0, driftSigma: 1.2, driftTau: 30, headingSigma: degToRad(2), speedSigma: 0.15 },
      ...options,
    });
    this.driftX = new GaussMarkov(this.spec.driftSigma, this.spec.driftTau, this.rng);
    this.driftY = new GaussMarkov(this.spec.driftSigma, this.spec.driftTau, this.rng);
    this.history = []; // recent delivered fixes, for the trail
  }

  measure(env) {
    const s = env.car.state;
    const speed = toMeters(Math.abs(s.speed));
    const course = s.speed >= 0 ? s.angle : s.angle + Math.PI;
    return {
      x: toMeters(s.x),
      y: toMeters(s.y),
      heading: speed >= MIN_COURSE_SPEED ? wrapAngle(course) : null,
      speed,
      accuracy: 0,
    };
  }

  degrade(data, imp, env) {
    const s = this.spec;
    const dt = this.lastSampleTime === null ? 1 / this.rate : env.time - this.lastSampleTime;
    const dx = this.driftX.step(dt, imp.noise);
    const dy = this.driftY.step(dt, imp.noise);
    if (imp.noise === 0) return data;
    return {
      x: data.x + dx + gaussian(this.rng) * s.sigma * imp.noise,
      y: data.y + dy + gaussian(this.rng) * s.sigma * imp.noise,
      heading: data.heading === null ? null : wrapAngle(data.heading + gaussian(this.rng) * s.headingSigma * imp.noise),
      speed: Math.max(0, data.speed + gaussian(this.rng) * s.speedSigma * imp.noise),
      accuracy: Math.hypot(s.sigma, s.driftSigma) * imp.noise,
    };
  }

  deliver(reading) {
    this.history.push({ x: reading.data.x, y: reading.data.y });
    if (this.history.length > 40) this.history.shift();
    return reading;
  }

  describe(reading) {
    const d = reading.data;
    const heading = d.heading === null ? '—' : `${radToDeg(d.heading).toFixed(0)}°`;
    return `${d.x.toFixed(1)}, ${d.y.toFixed(1)} m ±${d.accuracy.toFixed(1)} · hdg ${heading} · ${d.speed.toFixed(1)} m/s`;
  }

  draw(ctx, reading, px) {
    ctx.fillStyle = 'rgba(48, 209, 88, 0.5)';
    for (const p of this.history) ctx.fillRect(m(p.x) - 1.5 * px, m(p.y) - 1.5 * px, 3 * px, 3 * px);
    const d = reading.data;
    const p = { x: m(d.x), y: m(d.y) };
    if (d.accuracy > 0) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, m(d.accuracy * 2), 0, Math.PI * 2); // 95 % circle
      ctx.fillStyle = 'rgba(48, 209, 88, 0.1)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(48, 209, 88, 0.6)';
      ctx.lineWidth = px;
      ctx.stroke();
    }
    const s = 6 * px;
    ctx.beginPath();
    ctx.moveTo(p.x - s, p.y);
    ctx.lineTo(p.x + s, p.y);
    ctx.moveTo(p.x, p.y - s);
    ctx.lineTo(p.x, p.y + s);
    ctx.strokeStyle = '#30d158';
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    if (d.heading !== null) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(d.heading) * 18 * px, p.y + Math.sin(d.heading) * 18 * px);
      ctx.stroke();
    }
  }
}
