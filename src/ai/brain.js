import { fromKmh } from '../car/units.js';
import { clamp, degToRad } from '../math/utils.js';
import { NeuralNetwork } from './network.js';

/** The ray sensor a brain is trained with (it only makes sense with the same layout). */
export const DEFAULT_BRAIN_SENSOR = { rayCount: 7, spread: degToRad(150), range: 20 };
export const OUTPUT_LABELS = ['throttle', 'brake', 'steer'];
export const NAVIGATION_LABELS = ['route', 'lane'];
const SPEED_SCALE = fromKmh(60);

/**
 * Week 14: connects a neural network to a car.
 *
 *   inputs   one per ray: 0 = nothing within range, → 1 = obstacle touching,
 *            plus the car's own speed (wheel odometry), scaled to about ±1,
 *            plus, for navigating brains (Phase 5), two route inputs from a
 *            Navigator: the bearing to the route ahead and the offset from
 *            the nearest lane centre
 *   outputs  tanh values in (−1, 1):
 *              throttle = max(0, out0)   brake = max(0, out1)   steer = out2
 *
 * The brain only ever sees standard sensor readings (Phase 3 API), so the
 * same brain drives a training car with a perfect sensor or the player's car
 * with a noisy, laggy, failing one.
 */
export class Brain {
  constructor({
    network = null,
    sensor = DEFAULT_BRAIN_SENSOR,
    hidden = [8],
    navigation = false,
    allowReverse = false,
    rng = Math.random,
  } = {}) {
    this.sensor = { ...sensor };
    this.navigation = navigation;
    this.allowReverse = allowReverse;
    const inputs = Brain.inputCount(this.sensor, navigation);
    this.network = network ?? new NeuralNetwork([inputs, ...hidden, OUTPUT_LABELS.length], { rng });
    if (this.network.inputCount !== inputs) {
      throw new Error(`Network takes ${this.network.inputCount} inputs, brain provides ${inputs}`);
    }
    this.lastInputs = new Array(inputs).fill(0);
    this.lastOutputs = new Array(this.network.outputCount).fill(0);
  }

  static inputCount(sensor, navigation) {
    return sensor.rayCount + 1 + (navigation ? NAVIGATION_LABELS.length : 0);
  }

  get inputLabels() {
    return [
      ...Array.from({ length: this.sensor.rayCount }, (_, i) => `ray ${i + 1}`),
      'speed',
      ...(this.navigation ? NAVIGATION_LABELS : []),
    ];
  }

  /**
   * Sensor reading + own speed (+ navigation inputs) → network inputs.
   * A missing reading is treated as "see nothing", missing navigation as 0.
   */
  encode(raysReading, car, navigation = null) {
    const n = this.sensor.rayCount;
    const inputs = new Array(this.network.inputCount).fill(0);
    const rays = raysReading?.data?.rays;
    if (rays && rays.length === n) {
      const range = raysReading.data.range || this.sensor.range;
      for (let i = 0; i < n; i++) {
        const d = rays[i].distance;
        inputs[i] = d === null ? 0 : clamp(1 - d / range, 0, 1);
      }
    }
    inputs[n] = clamp(car.speed / SPEED_SCALE, -1, 1);
    if (this.navigation && navigation) {
      for (let i = 0; i < NAVIGATION_LABELS.length; i++) inputs[n + 1 + i] = clamp(navigation[i] ?? 0, -1, 1);
    }
    return inputs;
  }

  /** Network outputs → car input. Unless allowed, "back" is a pure brake. */
  decode(outputs) {
    return {
      forward: Math.max(0, outputs[0]),
      back: Math.max(0, outputs[1]),
      steer: clamp(outputs[2], -1, 1),
      handbrake: false,
      allowReverse: this.allowReverse,
    };
  }

  drive(raysReading, car, navigation = null) {
    this.lastInputs = this.encode(raysReading, car, navigation);
    this.lastOutputs = this.network.feedForward(this.lastInputs);
    return this.decode(this.lastOutputs);
  }

  toJSON() {
    return {
      version: 2,
      sensor: this.sensor,
      navigation: this.navigation,
      allowReverse: this.allowReverse,
      network: this.network.toJSON(),
    };
  }

  static fromJSON(data) {
    return new Brain({
      sensor: data.sensor,
      navigation: !!data.navigation,
      allowReverse: !!data.allowReverse,
      network: NeuralNetwork.fromJSON(data.network),
    });
  }
}
