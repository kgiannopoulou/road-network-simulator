import { fromKmh } from '../car/units.js';
import { clamp, degToRad } from '../math/utils.js';
import { NeuralNetwork } from './network.js';

/** The ray sensor a brain is trained with (it only makes sense with the same layout). */
export const DEFAULT_BRAIN_SENSOR = { rayCount: 7, spread: degToRad(150), range: 20 };
export const OUTPUT_LABELS = ['throttle', 'brake', 'steer'];
const SPEED_SCALE = fromKmh(60);

/**
 * Week 14: connects a neural network to a car.
 *
 *   inputs   one per ray: 0 = nothing within range, → 1 = obstacle touching,
 *            plus the car's own speed (wheel odometry), scaled to about ±1
 *   outputs  tanh values in (−1, 1):
 *              throttle = max(0, out0)   brake = max(0, out1)   steer = out2
 *
 * The brain only ever sees a standard sensor reading (Phase 3 API), so the
 * same brain drives a training car with a perfect sensor or the player's car
 * with a noisy, laggy, failing one.
 */
export class Brain {
  constructor({ network = null, sensor = DEFAULT_BRAIN_SENSOR, hidden = [8], rng = Math.random } = {}) {
    this.sensor = { ...sensor };
    this.network = network ?? new NeuralNetwork([this.sensor.rayCount + 1, ...hidden, OUTPUT_LABELS.length], { rng });
    this.lastInputs = new Array(this.network.inputCount).fill(0);
    this.lastOutputs = new Array(this.network.outputCount).fill(0);
  }

  get inputLabels() {
    return [...Array.from({ length: this.sensor.rayCount }, (_, i) => `ray ${i + 1}`), 'speed'];
  }

  /** Sensor reading + own speed → network inputs. A missing reading is treated as "see nothing". */
  encode(raysReading, car) {
    const n = this.sensor.rayCount;
    const inputs = new Array(n + 1).fill(0);
    const rays = raysReading?.data?.rays;
    if (rays && rays.length === n) {
      const range = raysReading.data.range || this.sensor.range;
      for (let i = 0; i < n; i++) {
        const d = rays[i].distance;
        inputs[i] = d === null ? 0 : clamp(1 - d / range, 0, 1);
      }
    }
    inputs[n] = clamp(car.speed / SPEED_SCALE, -1, 1);
    return inputs;
  }

  /** Network outputs → car input. Reverse is disabled: "back" is a pure brake. */
  decode(outputs) {
    return {
      forward: Math.max(0, outputs[0]),
      back: Math.max(0, outputs[1]),
      steer: clamp(outputs[2], -1, 1),
      handbrake: false,
      allowReverse: false,
    };
  }

  drive(raysReading, car) {
    this.lastInputs = this.encode(raysReading, car);
    this.lastOutputs = this.network.feedForward(this.lastInputs);
    return this.decode(this.lastOutputs);
  }

  toJSON() {
    return { version: 1, sensor: this.sensor, network: this.network.toJSON() };
  }

  static fromJSON(data) {
    return new Brain({ sensor: data.sensor, network: NeuralNetwork.fromJSON(data.network) });
  }
}
