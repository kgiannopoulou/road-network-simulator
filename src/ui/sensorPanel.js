import { m } from '../car/units.js';
import { degToRad, radToDeg } from '../math/utils.js';
import { FailureMode } from '../sensors/imperfections.js';
import { distanceColor } from '../sensors/lidar.js';
import { SensorStatus } from '../sensors/sensor.js';

const LABELS = { rays: 'Ray sensor', lidar: 'LiDAR', radar: 'Radar', gps: 'GPS', imu: 'IMU' };
const VIEW_RANGE = 50; // metres from the car to the edge of the mini view

/**
 * The sensor panel: a car-centred view of what the sensors report, a status
 * line per sensor, configuration for the ray sensor and LiDAR, and the
 * imperfection controls (preset, global knobs, failure per sensor).
 */
export class SensorPanel {
  constructor(panel, suite, { refreshRate = 10 } = {}) {
    this.panel = panel;
    this.suite = suite;
    this.view = panel.querySelector('#sensor-view');
    this.viewCtx = this.view.getContext('2d');
    this.interval = 1 / refreshRate;
    this.timer = 0;
    this.rows = {};
    this.#buildRows();
    this.#bindConfig();
  }

  get visible() {
    return !this.panel.hidden;
  }

  toggle(force) {
    this.panel.hidden = force === undefined ? !this.panel.hidden : !force;
    document.body.classList.toggle('sensors-open', this.visible);
  }

  #buildRows() {
    const container = this.panel.querySelector('#sensor-rows');
    const failureOptions = Object.values(FailureMode)
      .map((mode) => `<option value="${mode}">${mode === 'none' ? 'working' : mode}</option>`)
      .join('');
    for (const sensor of this.suite.sensors) {
      const row = document.createElement('div');
      row.className = 'sensor-row';
      row.innerHTML = `
        <div class="sensor-head">
          <label><input type="checkbox" data-enable checked /> ${LABELS[sensor.name] ?? sensor.name}</label>
          <span class="badge" data-status></span>
          <button class="eye active" data-eye title="Show on the map">◉</button>
          <select data-failure title="Inject a failure">${failureOptions}</select>
        </div>
        <div class="sensor-line" data-line></div>`;
      row.querySelector('[data-enable]').addEventListener('change', (e) => sensor.setEnabled(e.target.checked));
      row.querySelector('[data-eye]').addEventListener('click', (e) => {
        this.suite.visible[sensor.name] = !this.suite.visible[sensor.name];
        e.currentTarget.classList.toggle('active', this.suite.visible[sensor.name]);
      });
      row.querySelector('[data-failure]').addEventListener('change', (e) => this.suite.setFailure(sensor.name, e.target.value));
      container.append(row);
      this.rows[sensor.name] = {
        status: row.querySelector('[data-status]'),
        line: row.querySelector('[data-line]'),
        failure: row.querySelector('[data-failure]'),
      };
    }
  }

  #bindConfig() {
    const rays = this.suite.get('rays');
    const lidar = this.suite.get('lidar');
    const input = (name) => this.panel.querySelector(`[data-cfg="${name}"]`);
    const out = (name, text) => (this.panel.querySelector(`[data-out="${name}"]`).textContent = text);

    const bindRange = (name, apply, format) => {
      const el = input(name);
      const update = () => {
        apply(Number(el.value));
        out(name, format(Number(el.value)));
      };
      el.addEventListener('input', update);
      update();
    };

    bindRange('rayCount', (v) => (rays.rayCount = v), (v) => String(v));
    bindRange('spread', (v) => (rays.spread = degToRad(v)), (v) => `${v}°`);
    bindRange('rayRange', (v) => (rays.range = v), (v) => `${v} m`);
    input('lidarRays').addEventListener('change', (e) => lidar.setResolution({ raysPerRevolution: Number(e.target.value) }));
    input('lidarHz').addEventListener('change', (e) => lidar.setResolution({ rotationHz: Number(e.target.value) }));

    const knobs = {
      noise: { format: (v) => `×${v.toFixed(1)}` },
      latency: { format: (v) => `×${v.toFixed(1)}` },
      drop: { format: (v) => `×${v.toFixed(1)}` },
      range: { format: (v) => `${Math.round(v * 100)}%` },
      failureRate: { format: (v) => `${v.toFixed(1)}/min` },
    };
    this.knobInputs = {};
    for (const [name, { format }] of Object.entries(knobs)) {
      const el = input(`knob-${name}`);
      this.knobInputs[name] = { el, format };
      el.addEventListener('input', () => {
        this.suite.setKnobs({ [name]: Number(el.value) });
        this.#syncKnobs();
      });
    }
    this.panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => this.setPreset(btn.dataset.preset));
    });
    this.#syncKnobs();
  }

  setPreset(name) {
    this.suite.setPreset(name);
    this.#syncKnobs();
  }

  /** Reflect the suite's knobs, preset and failure modes in the controls. */
  #syncKnobs() {
    for (const [name, { el, format }] of Object.entries(this.knobInputs)) {
      el.value = this.suite.knobs[name];
      this.panel.querySelector(`[data-out="knob-${name}"]`).textContent = format(this.suite.knobs[name]);
    }
    this.panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === this.suite.preset);
    });
    for (const [name, row] of Object.entries(this.rows)) {
      row.failure.value = this.suite.failures[name] ?? FailureMode.NONE;
    }
  }

  // ---- per frame ------------------------------------------------------------

  update(rawDelta) {
    if (!this.visible) return;
    this.#drawView();
    this.timer += rawDelta;
    if (this.timer < this.interval) return;
    this.timer = 0;

    for (const sensor of this.suite.sensors) {
      const row = this.rows[sensor.name];
      const reading = sensor.read(this.suite.time);
      const stale = reading && reading.age > Math.max(0.5, 3 / sensor.rate + sensor.imperfections.latency);
      let status = sensor.status;
      if (status === SensorStatus.OK && (stale || !reading)) status = 'stale';
      row.status.textContent = status;
      row.status.dataset.status = status;
      const age = reading ? ` · age ${(reading.age * 1000).toFixed(0)} ms` : '';
      row.line.textContent = !sensor.enabled ? 'switched off' : reading ? `${sensor.describe(reading)}${age}` : 'no data';
    }
  }

  /** Car-centred, heading-up plot of the latest readings. */
  #drawView() {
    const { viewCtx: ctx, view, suite } = this;
    const w = view.width;
    const h = view.height;
    const scale = (Math.min(w, h) / 2 - 6) / VIEW_RANGE; // px per metre
    const car = suite.car;
    const cx = car.state.x;
    const cy = car.state.y;
    const cos = Math.cos(-car.state.angle);
    const sin = Math.sin(-car.state.angle);
    // World metres → view pixels (forward = up, right = right).
    const toView = (x, y) => {
      const dx = x - cx / m(1);
      const dy = y - cy / m(1);
      const fwd = dx * cos - dy * sin;
      const right = dx * sin + dy * cos;
      return [w / 2 + right * scale, h / 2 - fwd * scale];
    };

    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let r = 10; r <= VIEW_RANGE; r += 10) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    const read = (name) => (suite.get(name).enabled ? suite.read(name) : null);

    const lidar = read('lidar');
    if (lidar) {
      const range = suite.get('lidar').range;
      for (const p of lidar.data.points) {
        if (p.distance === null) continue;
        const [x, y] = toView(p.x, p.y);
        ctx.fillStyle = distanceColor(p.distance / range);
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    const rays = read('rays');
    if (rays) {
      const [ox, oy] = toView(rays.data.origin.x, rays.data.origin.y);
      ctx.strokeStyle = 'rgba(255, 214, 10, 0.5)';
      for (const ray of rays.data.rays) {
        const a = rays.data.heading + ray.angle;
        const d = ray.distance ?? rays.data.range;
        const [x, y] = toView(rays.data.origin.x + Math.cos(a) * d, rays.data.origin.y + Math.sin(a) * d);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }

    const radar = read('radar');
    if (radar) {
      for (const t of radar.data.targets) {
        const [x, y] = toView(t.x, t.y);
        ctx.strokeStyle = '#bf5af2';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = t.rangeRate < 0 ? '#ff453a' : '#32d74b';
        ctx.font = '10px ui-monospace, Consolas, monospace';
        ctx.fillText(`${t.rangeRate >= 0 ? '+' : ''}${t.rangeRate.toFixed(1)}`, x + 6, y + 3);
      }
    }

    // GPS fix relative to the true position: the cross shows the GPS error.
    const gps = read('gps');
    if (gps) {
      const [x, y] = toView(gps.data.x, gps.data.y);
      ctx.strokeStyle = '#30d158';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y);
      ctx.lineTo(x + 5, y);
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x, y + 5);
      ctx.stroke();
    }

    // The car itself.
    const L = car.length / m(1);
    const W = car.width / m(1);
    ctx.fillStyle = '#ffd54a';
    ctx.fillRect(w / 2 - (W * scale) / 2, h / 2 - (L * scale) / 2, W * scale, L * scale);

    // IMU: acceleration as a dot in a small g-circle in the corner.
    const imu = read('imu');
    if (imu) {
      const r = 22;
      const gx = w - r - 6;
      const gy = h - r - 6;
      ctx.strokeStyle = 'rgba(100, 210, 255, 0.4)';
      ctx.beginPath();
      ctx.arc(gx, gy, r, 0, Math.PI * 2);
      ctx.stroke();
      const g = 9.81;
      ctx.fillStyle = '#64d2ff';
      ctx.beginPath();
      ctx.arc(gx + (imu.data.ay / g) * r, gy - (imu.data.ax / g) * r, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText('1 g', gx - 8, gy - r - 3);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillText(`${VIEW_RANGE} m · heading up`, 6, 12);
    ctx.fillText(radToDeg(car.state.angle % (Math.PI * 2)).toFixed(0) + '°', 6, h - 6);
  }
}
