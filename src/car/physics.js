import { clamp, degToRad } from '../math/utils.js';
import { fromKmh, GRAVITY, m, UNITS_PER_METER } from './units.js';

/**
 * Car physics, kept free of drawing and DOM code so it can be unit tested.
 *
 * Two models share one state object:
 *   BASIC      Week 5. Speed, acceleration, braking, reverse, friction and a
 *              constant turn rate. Simple, but the car pivots like a rectangle
 *              (it can even spin while barely moving).
 *   REALISTIC  Week 6. Kinematic bicycle model: a wheelbase, a steering angle
 *              that moves at a limited rate and shrinks with speed, turning
 *              radius R = L / tan(δ), separate engine / brake / reverse
 *              strengths, rolling resistance and drag, and a tyre grip limit
 *              from the road surface's friction coefficient.
 *
 * Angles are radians, clockwise on screen (y points down). Positive steering
 * turns right.
 */

export const PhysicsModel = { BASIC: 'basic', REALISTIC: 'realistic' };

/** Road surfaces: tyre grip coefficient μ and rolling resistance (units/s²). */
export const SURFACES = {
  dry: { key: 'dry', name: 'Dry asphalt', grip: 0.9, rolling: m(0.15) },
  wet: { key: 'wet', name: 'Wet asphalt', grip: 0.55, rolling: m(0.2) },
  icy: { key: 'icy', name: 'Icy asphalt', grip: 0.15, rolling: m(0.08) },
  grass: { key: 'grass', name: 'Grass', grip: 0.45, rolling: m(1.8) },
};

/** A mid-size hatchback, in metric units. */
export const CAR_SPEC = {
  length: 4.4, // m
  width: 1.8, // m
  wheelbase: 2.7, // m
  maxSteerDeg: 35, // front wheel lock at standstill
  steerRateDeg: 110, // how fast the wheels turn towards the target (°/s)
  steerReturnDeg: 220, // self-centring is quicker
  steerFalloff: 15, // m/s at which the steering lock has halved
  engineAccel: 3.5, // m/s² at low speed
  maxSpeedKmh: 120,
  reverseAccel: 2.5, // m/s²
  maxReverseKmh: 20,
  brakeDecel: 9, // m/s², capped by grip
  handbrakeDecel: 4, // m/s²
  drag: 0.0004, // aerodynamic drag: a = drag · v² (1/m)
  basicTurnRate: 2.4, // rad/s, BASIC model only
  basicFriction: 1.5, // m/s², BASIC model only
};

const STOP_SPEED = m(0.15); // below this a car counts as stationary

export function createCarParams(overrides = {}) {
  const s = { ...CAR_SPEC, ...overrides };
  return {
    length: m(s.length),
    width: m(s.width),
    wheelbase: m(s.wheelbase),
    maxSteer: degToRad(s.maxSteerDeg),
    steerRate: degToRad(s.steerRateDeg),
    steerReturnRate: degToRad(s.steerReturnDeg),
    steerFalloff: m(s.steerFalloff),
    engineAccel: m(s.engineAccel),
    maxSpeed: fromKmh(s.maxSpeedKmh),
    reverseAccel: m(s.reverseAccel),
    maxReverse: fromKmh(s.maxReverseKmh),
    brakeDecel: m(s.brakeDecel),
    handbrakeDecel: m(s.handbrakeDecel),
    drag: s.drag / UNITS_PER_METER,
    basicTurnRate: s.basicTurnRate,
    basicFriction: m(s.basicFriction),
  };
}

export function createCarState({ x = 0, y = 0, angle = 0 } = {}) {
  return {
    x,
    y,
    angle,
    speed: 0, // signed, along the heading
    steer: 0, // front wheel angle
    accel: 0,
    yawRate: 0,
    lateralAccel: 0,
    braking: false,
    reversing: false,
    sliding: false,
  };
}

/**
 * Driver input. `forward` / `back` are pedals in [0, 1]: `back` brakes while
 * moving forward and reverses once stopped (and `forward` brakes while
 * reversing). Set `allowReverse: false` to make `back` a pure brake.
 */
export const NO_INPUT = Object.freeze({ forward: 0, back: 0, steer: 0, handbrake: false, allowReverse: true });

/** Steering lock at a given speed: full lock when parking, much less on the motorway. */
export function maxSteerAt(params, speed) {
  return params.maxSteer / (1 + Math.abs(speed) / params.steerFalloff);
}

/** Radius of the circle the rear axle follows for a front wheel angle. */
export function turningRadius(params, steer) {
  const t = Math.abs(Math.tan(steer));
  return t < 1e-9 ? Infinity : params.wheelbase / t;
}

/** Stopping distance from `speed` with full braking on `surface` (ignores drag). */
export function brakingDistance(params, speed, surface = SURFACES.dry) {
  const decel = Math.min(params.brakeDecel, surface.grip * GRAVITY) + surface.rolling;
  return (speed * speed) / (2 * decel);
}

export function step(model, state, input, params, surface, dt) {
  if (model === PhysicsModel.BASIC) stepBasic(state, input, params, dt);
  else stepRealistic(state, input, params, surface, dt);
}

/** Week 5: the simple model. */
export function stepBasic(state, input, params, dt) {
  const forward = clamp(input.forward ?? 0, 0, 1);
  const back = clamp(input.back ?? 0, 0, 1);
  const steer = clamp(input.steer ?? 0, -1, 1);
  const v0 = state.speed;

  let v = v0 + (forward - back) * params.engineAccel * dt;
  v = clamp(v, input.allowReverse === false ? 0 : -params.maxReverse, params.maxSpeed);
  v = approach(v, 0, params.basicFriction * dt);

  // Any non-zero speed turns at the same rate: no wheelbase, no turning radius.
  const yawRate = v === 0 ? 0 : steer * params.basicTurnRate * Math.sign(v);
  state.angle += yawRate * dt;
  state.x += Math.cos(state.angle) * v * dt;
  state.y += Math.sin(state.angle) * v * dt;

  state.steer = steer * params.maxSteer;
  state.accel = (v - v0) / dt;
  state.speed = v;
  state.yawRate = yawRate;
  state.lateralAccel = v * yawRate;
  state.braking = (back > 0 && v0 > STOP_SPEED) || (forward > 0 && v0 < -STOP_SPEED);
  state.reversing = v < -STOP_SPEED;
  state.sliding = false;
}

/** Week 6: kinematic bicycle model with steering and grip limits. */
export function stepRealistic(state, input, params, surface, dt) {
  const forward = clamp(input.forward ?? 0, 0, 1);
  const back = clamp(input.back ?? 0, 0, 1);
  const grip = surface.grip * GRAVITY; // the most acceleration the tyres can transmit
  const v0 = state.speed;

  // Steering: the wheels move towards the target at a limited rate, and the
  // lock shrinks with speed so the car stays stable when going fast.
  const limit = maxSteerAt(params, v0);
  const target = clamp(input.steer ?? 0, -1, 1) * limit;
  const centring = Math.abs(target) < Math.abs(state.steer) || target * state.steer < 0;
  state.steer = approach(state.steer, target, (centring ? params.steerReturnRate : params.steerRate) * dt);

  // Longitudinal forces.
  let drive = 0;
  let brake = 0;
  if (forward > 0) {
    if (v0 < -STOP_SPEED) brake += forward * params.brakeDecel;
    else drive += forward * params.engineAccel * Math.max(0, 1 - (v0 / params.maxSpeed) ** 3);
  }
  if (back > 0) {
    if (v0 > STOP_SPEED || input.allowReverse === false) brake += back * params.brakeDecel;
    else drive -= back * params.reverseAccel * Math.max(0, 1 - (Math.min(0, v0) / params.maxReverse) ** 2);
  }
  if (input.handbrake) brake += params.handbrakeDecel;

  drive = clamp(drive, -grip, grip); // wheelspin: the engine can't beat the tyres
  brake = Math.min(brake, grip); // and neither can the brakes
  const resistance = surface.rolling + params.drag * v0 * v0;

  let v = v0 + drive * dt;
  v = approach(v, 0, (brake + resistance) * dt); // friction never reverses the car

  // Yaw from the bicycle model, measured at the centre of the car (rear
  // overhang equal to front: lr = L / 2).
  const tanSteer = Math.tan(state.steer);
  const slip = Math.atan(0.5 * tanSteer);
  let yawRate = (v * Math.cos(slip) * tanSteer) / params.wheelbase;

  // Grip limit: lateral acceleration v·ω can't exceed μg. Past it the car
  // understeers: it turns as tightly as the tyres allow and no more.
  const maxYaw = grip / Math.max(Math.abs(v), 1e-3);
  let sliding = false;
  if (Math.abs(yawRate) > maxYaw) {
    yawRate = Math.sign(yawRate) * maxYaw;
    sliding = true;
  }
  if (input.handbrake && Math.abs(v) > m(3)) {
    // Locked rear wheels let the back step out a little.
    yawRate *= 1.3;
    sliding = true;
  }

  state.angle += yawRate * dt;
  const heading = state.angle + slip;
  state.x += Math.cos(heading) * v * dt;
  state.y += Math.sin(heading) * v * dt;

  state.accel = (v - v0) / dt;
  state.speed = v;
  state.yawRate = yawRate;
  state.lateralAccel = v * yawRate;
  state.braking = brake > 0 && Math.abs(v0) > STOP_SPEED;
  state.reversing = v < -STOP_SPEED || drive < 0;
  state.sliding = sliding;
}

/** Move `value` towards `target` by at most `maxDelta`. */
export function approach(value, target, maxDelta) {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}
