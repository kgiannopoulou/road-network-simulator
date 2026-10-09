import { Gps } from './gps.js';
import { FailureMode, imperfectionsFor, PRESETS } from './imperfections.js';
import { Imu } from './imu.js';
import { Lidar } from './lidar.js';
import { Radar } from './radar.js';
import { RayCaster } from './raycast.js';
import { RaySensor } from './raySensor.js';

/**
 * All sensors mounted on one car, behind a single API:
 *
 *   suite.update(time, dt, cars)   sample everything that is due
 *   suite.read('radar')            latest delivered reading (or null)
 *   suite.readAll()                { rays, lidar, radar, gps, imu }
 *
 * Imperfections are set with a preset ('perfect' | 'realistic' | 'degraded')
 * and/or the global knobs, plus a failure mode per sensor.
 */
export class SensorSuite {
  constructor(car, world, { seed = 11 } = {}) {
    this.car = car;
    this.caster = new RayCaster(world);
    this.sensors = [
      new RaySensor({ name: 'rays', seed: seed + 1 }),
      new Lidar({ name: 'lidar', seed: seed + 2 }),
      new Radar({ name: 'radar', seed: seed + 3 }),
      new Gps({ name: 'gps', seed: seed + 4 }),
      new Imu({ name: 'imu', seed: seed + 5 }),
    ];
    this.time = 0;
    this.preset = 'perfect';
    this.knobs = { ...PRESETS.perfect };
    this.failures = {};
    this.visible = Object.fromEntries(this.sensors.map((s) => [s.name, true]));
    this.#apply();
  }

  get(name) {
    return this.sensors.find((s) => s.name === name);
  }

  update(time, dt, cars) {
    this.time = time;
    const env = { time, dt, car: this.car, cars, caster: this.caster };
    for (const sensor of this.sensors) sensor.update(env);
  }

  read(name) {
    return this.get(name)?.read(this.time) ?? null;
  }

  readAll() {
    return Object.fromEntries(this.sensors.map((s) => [s.name, s.read(this.time)]));
  }

  // ---- imperfections ----------------------------------------------------------

  setPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    this.preset = name;
    const { failures, ...knobs } = preset;
    this.knobs = { ...knobs };
    this.failures = { ...failures };
    this.#apply();
  }

  /** Change global knobs: { noise, latency, drop, range, failureRate }. */
  setKnobs(knobs) {
    this.knobs = { ...this.knobs, ...knobs };
    this.preset = 'custom';
    this.#apply();
  }

  setFailure(name, mode) {
    this.failures[name] = mode;
    this.#apply();
  }

  /** Forget every reading (e.g. after the car is teleported). */
  reset() {
    for (const s of this.sensors) {
      s.latest = null;
      s.pending = [];
      if (s.history) s.history = [];
      if (s.window) s.window = [];
    }
  }

  #apply() {
    for (const s of this.sensors) {
      s.configure(imperfectionsFor(s.spec, this.knobs, this.failures[s.name] ?? FailureMode.NONE));
    }
  }

  // ---- drawing --------------------------------------------------------------

  draw(ctx, px) {
    for (const s of this.sensors) {
      if (!this.visible[s.name] || !s.enabled) continue;
      const reading = s.read(this.time);
      if (reading) s.draw(ctx, reading, px, this.car);
    }
  }
}
