import { m, toMeters } from '../car/units.js';
import { degToRad, radToDeg } from '../math/utils.js';
import { gaussian } from './noise.js';
import { Sensor } from './sensor.js';

/**
 * Week 11: inertial measurement unit (accelerometer + gyroscope).
 *
 * Measures acceleration in the car frame (forward and to the right) and the
 * yaw rate. Each axis has white noise plus a constant bias drawn at power-on,
 * which is what makes integrating an IMU drift over time.
 *
 * data: { ax, ay, yawRate }  (m/s², m/s², rad/s clockwise)
 */
export class Imu extends Sensor {
  constructor({ rate = 100, ...options } = {}) {
    super({
      type: 'imu',
      rate,
      mount: { forward: 0 },
      spec: { latency: 0.005, dropRate: 0, accelSigma: 0.15, gyroSigma: degToRad(0.6), accelBias: 0.08, gyroBias: degToRad(0.3) },
      ...options,
    });
    const s = this.spec;
    this.bias = {
      ax: gaussian(this.rng) * s.accelBias,
      ay: gaussian(this.rng) * s.accelBias,
      yawRate: gaussian(this.rng) * s.gyroBias,
    };
  }

  measure(env) {
    const s = env.car.state;
    return { ax: toMeters(s.accel), ay: toMeters(s.lateralAccel), yawRate: s.yawRate };
  }

  degrade(data, imp) {
    if (imp.noise === 0) return data;
    const s = this.spec;
    const k = imp.noise;
    return {
      ax: data.ax + (this.bias.ax + gaussian(this.rng) * s.accelSigma) * k,
      ay: data.ay + (this.bias.ay + gaussian(this.rng) * s.accelSigma) * k,
      yawRate: data.yawRate + (this.bias.yawRate + gaussian(this.rng) * s.gyroSigma) * k,
    };
  }

  describe(reading) {
    const d = reading.data;
    return `ax ${d.ax.toFixed(2)} · ay ${d.ay.toFixed(2)} m/s² · ${radToDeg(d.yawRate).toFixed(1)}°/s`;
  }

  /** Acceleration vector from the car's centre (1 m/s² ≈ 2 m on screen). */
  draw(ctx, reading, px, car) {
    if (!car) return;
    const { ax, ay } = reading.data;
    const f = car.forward;
    const r = f.perpendicular();
    const c = car.position;
    const tip = c.add(f.scale(m(ax * 2))).add(r.scale(m(ay * 2)));
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = '#64d2ff';
    ctx.lineWidth = 2.5 * px;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 3 * px, 0, Math.PI * 2);
    ctx.fillStyle = '#64d2ff';
    ctx.fill();
  }
}
