import { maxSteerAt } from '../car/physics.js';
import { m } from '../car/units.js';
import { clamp } from '../math/utils.js';

const STANLEY_GAIN = 2.5;
const SPEED_GAIN = 1.2; // 1/s

/**
 * The driving controller: follows the chosen trajectory with the car's
 * actual controls. Steering is a Stanley controller on the trajectory's
 * path; speed tracks the trajectory's speed a moment ahead, with its
 * acceleration as feed-forward.
 */
export class TrajectoryController {
  constructor() {
    this.output = { steer: 0, forward: 0, back: 0 };
  }

  /**
   * `path` is the route's reference path and `sHint` the car's position on
   * it: steering tracks that dense path, offset by the lateral position the
   * trajectory plans for this moment (a coarse polyline of trajectory samples
   * would get curvature wrong in tight turns).
   */
  update(car, trajectory, since, path, sHint) {
    const samples = trajectory?.samples;
    if (!samples || samples.length < 2) return this.#hold();

    const p = car.params;
    const v = car.speed;
    const front = car.position.add(car.forward.scale(p.wheelbase / 2));
    const proj = path.project(front, sHint - m(4), sHint + m(12)) ?? path.project(front);
    const step = samples[1].t - samples[0].t;
    const sample = (time) => samples[Math.min(samples.length - 1, Math.max(0, Math.round(time / step)))];
    const now = sample(since + 0.1);
    const next = sample(since + 0.1 + step);
    const dRef = now.d;
    const dRate = (next.d - now.d) / step; // planned lateral speed
    const preview = Math.min(proj.s + Math.abs(v) * 0.15, path.length);
    const lateralHeading = Math.atan2(dRate, Math.max(Math.abs(v), m(1)));
    const headingError = wrap(path.tangentAt(preview).angle() + lateralHeading - car.state.angle);
    const correction = Math.atan2(-STANLEY_GAIN * (proj.lateral - dRef), Math.abs(v) + m(1));
    const feedForward = Math.atan(p.wheelbase * path.curvatureAt(proj.s));
    const steer = clamp((headingError + correction + feedForward) / maxSteerAt(p, v), -1, 1);

    // Speed: the trajectory's speed and acceleration a little ahead in time.
    const dt = samples[1].t - samples[0].t;
    const at = (time) => samples[Math.min(samples.length - 1, Math.max(0, Math.round(time / dt)))];
    // At low speed look further ahead: a plan that starts from rest begins very gently.
    const ref = at(since + (v < m(2) ? 0.9 : 0.4));
    const accel = ref.a + SPEED_GAIN * (ref.v - v);
    // Hold the brake at a standstill only if the plan stays (nearly) stopped.
    const ahead = samples.filter((p) => p.t >= since && p.t <= since + 3);
    const staysStopped = ahead.length > 1 && ahead[ahead.length - 1].s - ahead[0].s < m(0.3);
    let forward = 0;
    let back = 0;
    if (staysStopped && v < m(0.5)) back = 1;
    else if (accel >= 0) {
      forward = clamp(accel / (p.engineAccel * Math.max(0.1, 1 - (v / p.maxSpeed) ** 3)), 0, 1);
      if (v < m(0.5)) forward = Math.max(forward, 0.15); // enough to get rolling
    }
    else back = clamp(-accel / p.brakeDecel, 0, 1);
    this.output = { steer, forward, back, refSpeed: ref.v };
    return { forward, back, steer, handbrake: false, allowReverse: false };
  }

  #hold() {
    this.output = { steer: 0, forward: 0, back: 1 };
    return { forward: 0, back: 1, steer: 0, handbrake: false, allowReverse: false };
  }
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
