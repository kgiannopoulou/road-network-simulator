import { m } from '../car/units.js';
import { createRng, randomBetween } from '../math/random.js';
import { Point } from '../primitives/point.js';
import { FailureMode, PERFECT } from './imperfections.js';

export const SensorStatus = { OK: 'ok', OFF: 'off', FAILED: 'failed', STUCK: 'stuck' };

/**
 * Week 11: one standardised sensor API.
 *
 * Every sensor samples the world at its own rate and delivers measurements in
 * the same envelope:
 *
 *   { sensor, type, time, receivedAt, data }      from read(now) also: age
 *
 * `time` is when the world was sampled and `receivedAt` when the reading
 * arrives (time + latency). Consumers only ever see delivered readings, so
 * latency, dropouts and failures look exactly like they would on a real car:
 * a dead sensor simply stops producing data and its last reading grows old.
 *
 * Subclasses implement:
 *   measure(env)            ideal reading from ground truth
 *   degrade(data, imp, env) the same reading with noise, range limit, drops
 *   draw(ctx, reading, px)  optional world-space visualisation
 *
 * All data is metric: metres, m/s, m/s², radians (0 = +x, clockwise on screen).
 */
export class Sensor {
  constructor({ name, type, rate = 10, range = Infinity, mount = {}, spec = {}, imperfections = {}, seed = 1 }) {
    this.name = name;
    this.type = type;
    this.rate = rate; // Hz
    this.range = range; // m
    this.mount = { forward: 0, right: 0, angle: 0, ...mount }; // m, m, rad in the car frame
    this.spec = { latency: 0, dropRate: 0, ...spec };
    this.imperfections = { ...PERFECT, ...imperfections };
    this.rng = createRng(seed);

    this.enabled = true;
    this.status = SensorStatus.OK;
    this.latest = null;
    this.pending = [];
    this.nextSample = 0;
    this.lastSampleTime = null;
    this.failedUntil = -Infinity;
    this.stuckData = null;
    this.stats = { samples: 0, delivered: 0, dropped: 0 };
  }

  /** Reach after imperfections, in metres. */
  get effectiveRange() {
    return this.range * this.imperfections.rangeScale;
  }

  configure(imperfections) {
    const previous = this.imperfections.failure;
    this.imperfections = { ...this.imperfections, ...imperfections };
    if (this.imperfections.failure !== previous) {
      this.failedUntil = -Infinity;
      this.stuckData = null;
      if (this.status === SensorStatus.FAILED || this.status === SensorStatus.STUCK) this.status = SensorStatus.OK;
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.latest = null;
      this.pending = [];
    }
  }

  /** World pose of the sensor (world units) for a car. */
  pose(car) {
    const f = Point.fromAngle(car.state.angle);
    const r = f.perpendicular();
    const origin = car.position.add(f.scale(m(this.mount.forward))).add(r.scale(m(this.mount.right)));
    return { origin, angle: car.state.angle + this.mount.angle };
  }

  /** Latest delivered reading plus its age, or null. */
  read(now) {
    if (!this.latest) return null;
    return { ...this.latest, age: now - this.latest.time };
  }

  update(env) {
    if (!this.enabled) {
      this.status = SensorStatus.OFF;
      return;
    }
    this.#updateFailure(env.time, env.dt);

    if (env.time + 1e-9 >= this.nextSample) {
      this.nextSample += 1 / this.rate;
      if (this.nextSample <= env.time) this.nextSample = env.time + 1 / this.rate;
      const reading = this.#sample(env);
      this.lastSampleTime = env.time;
      if (reading) this.pending.push(reading);
    }

    while (this.pending.length > 0 && this.pending[0].receivedAt <= env.time + 1e-9) {
      const reading = this.pending.shift();
      this.latest = this.deliver(reading);
      this.stats.delivered++;
    }
  }

  /** Hook for sensors that assemble readings (the LiDAR builds full scans). */
  deliver(reading) {
    return reading;
  }

  /** True for sensors that drop individual rays/points/targets instead of whole readings. */
  get dropsParts() {
    return false;
  }

  #sample(env) {
    this.stats.samples++;
    if (this.status === SensorStatus.FAILED) return null;

    const imp = this.imperfections;
    let data;
    if (this.status === SensorStatus.STUCK) {
      // Frozen output: keeps arriving with fresh timestamps, so it *looks* valid.
      if (!this.stuckData) this.stuckData = this.latest?.data ?? this.degrade(this.measure(env), imp, env);
      data = this.stuckData;
    } else {
      if (!this.dropsParts && imp.dropRate > 0 && this.rng() < imp.dropRate) {
        this.stats.dropped++;
        return null;
      }
      data = this.degrade(this.measure(env), imp, env);
    }
    return { sensor: this.name, type: this.type, time: env.time, receivedAt: env.time + imp.latency, data };
  }

  #updateFailure(time, dt) {
    const imp = this.imperfections;
    if (imp.failure === FailureMode.DEAD) {
      this.status = SensorStatus.FAILED;
      return;
    }
    if (imp.failure === FailureMode.STUCK) {
      this.status = SensorStatus.STUCK;
      return;
    }
    if (this.status === SensorStatus.FAILED && time < this.failedUntil) return;

    // Random dead spells: short and frequent when intermittent, rare otherwise.
    const intermittent = imp.failure === FailureMode.INTERMITTENT;
    const perMinute = intermittent ? 20 : imp.failureRate;
    if (perMinute > 0 && this.rng() < (perMinute / 60) * dt) {
      this.status = SensorStatus.FAILED;
      this.failedUntil = time + (intermittent ? randomBetween(this.rng, 0.3, 1.2) : randomBetween(this.rng, 1, 4));
      return;
    }
    this.status = SensorStatus.OK;
  }

  // ---- for subclasses -------------------------------------------------------

  measure() {
    throw new Error(`${this.constructor.name} must implement measure()`);
  }

  degrade(data) {
    return data;
  }

  draw() {}

  /** One-line summary for the sensor panel. */
  describe() {
    return '';
  }
}
