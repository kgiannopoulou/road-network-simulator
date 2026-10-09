import { m, toMeters } from '../car/units.js';

/**
 * Week 17: a richer fitness function.
 *
 * Rewards                                      Penalties
 *   road progress   +progress per metre          crash              −crash once
 *   lane position   −lane per m·s off centre     leaving the lanes  −leaveLane per s
 *   smooth steering −steering per unit Δsteer    unnecessary reverse −reverse per s
 *   safe speed      −speed per (m/s)·s too fast  danger (< 1.5 m or
 *   destination     +destination + timeBonus·s     TTC < 1 s)       −danger per s
 *                    left on the clock             stalled or lost    −stall once
 *
 * Every term is kept separately so the dashboard can show where a driver's
 * score comes from, and weights can be changed between runs.
 */
export const FITNESS_WEIGHTS = {
  progress: 1, // per metre along the route
  destination: 150, // reaching the end of the route
  timeBonus: 2, // per second left when arriving
  lane: 2, // per metre·second away from a lane centre (beyond 0.3 m)
  leaveLane: 6, // per second outside the lanes going our way
  steering: 0.4, // per unit of steering change (−1…1 scale)
  speed: 3, // per (m/s)·second above the speed limit
  reverse: 5, // per second reversing with nothing close ahead
  danger: 4, // per second closer than 1.5 m, or < 1 s to impact
  crash: 30, // once
  stall: 20, // once: stopping for good, or getting lost, is not a safe way out
};

export const FITNESS_LABELS = {
  progress: 'Progress',
  destination: 'Destination',
  lane: 'Lane position',
  leaveLane: 'Leaving lanes',
  steering: 'Steering',
  speed: 'Speeding',
  reverse: 'Reversing',
  danger: 'Danger',
  crash: 'Crash',
  stall: 'Stalled / lost',
};

const LANE_TOLERANCE = 0.3; // m
const DANGER_DISTANCE = 1.5; // m
const DANGER_TTC = 1; // s
const STALL_TIME = 5; // s without progress
const LOST_DISTANCE = 2.5; // lane widths away from the route

export class FitnessEvaluator {
  constructor(navigator, { weights = FITNESS_WEIGHTS, speedLimit, timeLimit }) {
    this.nav = navigator;
    this.w = { ...FITNESS_WEIGHTS, ...weights };
    this.speedLimit = toMeters(speedLimit);
    this.timeLimit = timeLimit;
    this.time = 0;
    this.best = 0; // furthest progress (m)
    this.lastProgressTime = 0;
    this.prevSteer = 0;
    this.reached = false;
    this.parts = { progress: 0, destination: 0, lane: 0, leaveLane: 0, steering: 0, speed: 0, reverse: 0, danger: 0, crash: 0, stall: 0 };
  }

  get fitness() {
    let total = 0;
    for (const v of Object.values(this.parts)) total += v;
    return total;
  }

  /** Called every step after physics. Returns an outcome to end the run, or null. */
  update(car, dt, reading) {
    const w = this.w;
    const nav = this.nav;
    this.time += dt;
    nav.update(car.position, car.state.angle);

    const progress = toMeters(nav.s);
    if (progress > this.best + 0.05) {
      this.best = progress;
      this.lastProgressTime = this.time;
    }
    this.parts.progress = w.progress * this.best;

    const laneError = toMeters(nav.laneError);
    this.parts.lane -= w.lane * Math.max(0, laneError - LANE_TOLERANCE) * dt;
    if (nav.outside) this.parts.leaveLane -= w.leaveLane * dt;

    const steer = car.input.steer ?? 0;
    this.parts.steering -= w.steering * Math.abs(steer - this.prevSteer);
    this.prevSteer = steer;

    const speed = toMeters(car.speed);
    if (speed > this.speedLimit) this.parts.speed -= w.speed * (speed - this.speedLimit) * dt;

    const ahead = frontDistance(reading);
    if (speed < -0.3 && (ahead === null || ahead > 2)) this.parts.reverse -= w.reverse * dt;
    const nearest = nearestDistance(reading);
    const ttc = ahead !== null && speed > 0.5 ? ahead / speed : Infinity;
    if ((nearest !== null && nearest < DANGER_DISTANCE) || ttc < DANGER_TTC) this.parts.danger -= w.danger * dt;

    if (nav.remaining < m(6)) {
      this.reached = true;
      this.parts.destination = w.destination + w.timeBonus * Math.max(0, this.timeLimit - this.time);
      return 'finished';
    }
    if (nav.distance > nav.laneWidth * (nav.lanesAt(nav.s) + LOST_DISTANCE)) return this.#stop('lost');
    if (this.time - this.lastProgressTime > STALL_TIME) return this.#stop('stalled');
    return null;
  }

  #stop(outcome) {
    this.parts.stall = -this.w.stall;
    return outcome;
  }

  crash() {
    this.parts.crash = -this.w.crash;
  }
}

/** Shortest distance among the rays within ±20° of straight ahead (m), or null. */
function frontDistance(reading) {
  let best = null;
  for (const ray of reading?.data?.rays ?? []) {
    if (ray.distance === null || Math.abs(ray.angle) > 0.35) continue;
    if (best === null || ray.distance < best) best = ray.distance;
  }
  return best;
}

function nearestDistance(reading) {
  let best = null;
  for (const ray of reading?.data?.rays ?? []) {
    if (ray.distance !== null && (best === null || ray.distance < best)) best = ray.distance;
  }
  return best;
}
