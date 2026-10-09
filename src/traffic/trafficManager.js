import { Car } from '../car/car.js';
import { createCarParams } from '../car/physics.js';
import { fromKmh, m } from '../car/units.js';
import { createRng, pick, randomBetween } from '../math/random.js';
import { LaneIndex } from './laneIndex.js';
import { RoutePlanner } from './routePlanner.js';
import { TrafficDriver } from './trafficDriver.js';

const COLORS = ['#4a90d9', '#e8e8e8', '#3c3f45', '#c0392b', '#2e8b57', '#8e5ad7', '#d9822b', '#7f8c8d', '#1f6fb2'];

/**
 * Spawns traffic vehicles on random lanes, gives each a driver and a route,
 * and replaces vehicles that reach the end of a dead-end one-way road.
 *
 * With a City (Phase 6) drivers obey junction controls, crossings and speed
 * limits (each driver aims for 92–108 % of the limit); without one they keep
 * the simpler Phase 2 behaviour (a preferred speed of 38–58 km/h).
 */
export class TrafficManager {
  constructor({ count = 12, seed = 7 } = {}) {
    this.count = count;
    this.seed = seed;
    this.rng = createRng(seed);
    this.planner = null;
    this.city = null;
    this.laneIndex = new LaneIndex();
    this.cars = [];
  }

  /** Use a City's junction rules; call before setRoads(). */
  setCity(city) {
    this.city = city;
  }

  /** Rebuild routes for a new road network and respawn every vehicle. */
  setRoads(roads, others = []) {
    this.rng = createRng(this.seed);
    this.planner = roads.length > 0 ? new RoutePlanner(roads) : null;
    this.laneIndex.setRoads(roads);
    this.cars = [];
    this.fill(others);
  }

  setCount(count, others = []) {
    this.count = Math.max(0, count);
    this.fill(others);
  }

  /** Spawn or remove vehicles until there are `count` of them. */
  fill(others = []) {
    while (this.cars.length > this.count) this.cars.pop();
    while (this.cars.length < this.count) {
      if (!this.spawn(others)) break;
    }
  }

  spawn(others = []) {
    if (!this.planner) return false;
    const rng = this.rng;
    for (let attempt = 0; attempt < 30; attempt++) {
      const step = this.planner.randomStep(rng, m(12));
      if (!step) return false;
      const car = new Car({
        kind: 'traffic',
        color: pick(rng, COLORS),
        params: createCarParams({ length: randomBetween(rng, 4.0, 4.8), width: randomBetween(rng, 1.7, 1.9) }),
      });
      const city = this.city;
      const driver = new TrafficDriver(car, this.planner, {
        rng,
        lane: Math.floor(rng() * RoutePlanner.laneCount(step)),
        city,
        laneIndex: city?.laneIndex ?? this.laneIndex,
        desiredSpeed: city ? fromKmh(200) : fromKmh(randomBetween(rng, 38, 58)),
        speedCompliance: city ? randomBetween(rng, 0.92, 1.08) : 1,
        ...(city ? { maxAccel: m(randomBetween(rng, 1.6, 2.4)) } : {}),
        timeHeadway: randomBetween(rng, 1.1, 1.8),
      });
      driver.begin(step, randomBetween(rng, 0.15, 0.85) * step.road.segment.length());
      const clear = [...others, ...this.cars].every(
        (o) => o.position.distanceTo(car.position) > o.radius + car.radius + m(3),
      );
      if (!clear) continue;
      car.driver = driver;
      this.cars.push(car);
      return true;
    }
    return false;
  }

  update(dt, allCars) {
    // A City rebuilds its own lane index; otherwise keep ours current.
    if (!this.city) this.laneIndex.rebuild(allCars);
    for (const car of this.cars) car.driver?.update(dt, allCars);
    const finished = this.cars.filter((c) => c.driver?.finished);
    if (finished.length === 0) return;
    this.cars = this.cars.filter((c) => !finished.includes(c));
    this.fill(allCars.filter((c) => !finished.includes(c)));
  }
}
