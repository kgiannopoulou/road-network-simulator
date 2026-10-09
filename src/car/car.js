import { Point } from '../primitives/point.js';
import { Polygon } from '../primitives/polygon.js';
import { createCarParams, createCarState, NO_INPUT, step, SURFACES } from './physics.js';

let nextId = 1;

/**
 * A vehicle: physics state + parameters + the input it is currently given.
 * Whoever drives it (keyboard, traffic driver, later an AI) only writes
 * `car.input`; the simulation calls `step()`.
 */
export class Car {
  constructor({ x = 0, y = 0, angle = 0, params = createCarParams(), color = '#e8453c', kind = 'traffic' } = {}) {
    this.id = nextId++;
    this.kind = kind;
    this.params = params;
    this.color = color;
    this.state = createCarState({ x, y, angle });
    this.input = { ...NO_INPUT };
    this.surface = SURFACES.dry;
    this.driver = null;
    this.alpha = 1; // drawing opacity (traffic fades in and out)

    // Collision bookkeeping, refreshed by the simulation every frame.
    this.colliding = false;
    this.contacts = [];
    this.collisionCount = 0;

    this.#polyKey = '';
    this.#poly = null;
  }

  #polyKey;
  #poly;

  get length() {
    return this.params.length;
  }

  get width() {
    return this.params.width;
  }

  get speed() {
    return this.state.speed;
  }

  get position() {
    return new Point(this.state.x, this.state.y);
  }

  get forward() {
    return Point.fromAngle(this.state.angle);
  }

  get velocity() {
    return Point.fromAngle(this.state.angle, this.state.speed);
  }

  /** Radius of the circle that encloses the car (cheap broad phase). */
  get radius() {
    return Math.hypot(this.params.length, this.params.width) / 2;
  }

  step(dt, model) {
    step(model, this.state, this.input, this.params, this.surface, dt);
  }

  /** Place the car and bring it to rest. */
  teleport(x, y, angle) {
    Object.assign(this.state, createCarState({ x, y, angle }));
    this.contacts = [];
    this.colliding = false;
  }

  /** The car body as a rectangle polygon, cached until the car moves. */
  polygon() {
    const { x, y, angle } = this.state;
    const key = `${x},${y},${angle}`;
    if (key === this.#polyKey) return this.#poly;
    const hl = this.params.length / 2;
    const hw = this.params.width / 2;
    const f = Point.fromAngle(angle);
    const r = f.perpendicular();
    const c = new Point(x, y);
    const corner = (a, b) => c.add(f.scale(a)).add(r.scale(b));
    this.#poly = new Polygon([corner(hl, -hw), corner(hl, hw), corner(-hl, hw), corner(-hl, -hw)]);
    this.#polyKey = key;
    return this.#poly;
  }

  /** World positions of the rear wheels (for skid marks). */
  rearWheels() {
    const { x, y, angle } = this.state;
    const f = Point.fromAngle(angle);
    const r = f.perpendicular();
    const back = new Point(x, y).add(f.scale(-this.params.wheelbase / 2));
    const off = this.params.width / 2 - 1.6;
    return [back.add(r.scale(-off)), back.add(r.scale(off))];
  }

  draw(ctx, { highlight = null } = {}) {
    const { x, y, angle, steer, braking, reversing } = this.state;
    const L = this.params.length;
    const W = this.params.width;
    const wb = this.params.wheelbase;

    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Shadow.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    roundRect(ctx, -L / 2 + 1.2, -W / 2 + 1.2, L, W, 3.5);
    ctx.fill();

    // Wheels: the front pair turns with the steering angle.
    ctx.fillStyle = '#111';
    const wl = 5.4;
    const ww = 2.2;
    for (const side of [-1, 1]) {
      const wy = side * (W / 2 - 0.9);
      ctx.fillRect(-wb / 2 - wl / 2, wy - ww / 2, wl, ww);
      ctx.save();
      ctx.translate(wb / 2, wy);
      ctx.rotate(steer);
      ctx.fillRect(-wl / 2, -ww / 2, wl, ww);
      ctx.restore();
    }

    // Body.
    ctx.fillStyle = this.color;
    roundRect(ctx, -L / 2, -W / 2 + 0.6, L, W - 1.2, 3.5);
    ctx.fill();

    // Glass and roof.
    ctx.fillStyle = 'rgba(15, 25, 35, 0.85)';
    ctx.beginPath();
    ctx.moveTo(L * 0.08, -W / 2 + 1.8);
    ctx.lineTo(L * 0.25, -W / 2 + 2.4);
    ctx.lineTo(L * 0.25, W / 2 - 2.4);
    ctx.lineTo(L * 0.08, W / 2 - 1.8);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-L * 0.33, -W / 2 + 2.2, L * 0.09, W - 4.4);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(-L * 0.24, -W / 2 + 2, L * 0.32, W - 4);

    // Lights.
    ctx.fillStyle = '#fff6c2';
    ctx.fillRect(L / 2 - 1.4, -W / 2 + 1.2, 1.4, 2.4);
    ctx.fillRect(L / 2 - 1.4, W / 2 - 3.6, 1.4, 2.4);
    ctx.fillStyle = braking ? '#ff2a1f' : '#7a1d18';
    ctx.fillRect(-L / 2, -W / 2 + 1.2, 1.4, 2.4);
    ctx.fillRect(-L / 2, W / 2 - 3.6, 1.4, 2.4);
    if (reversing) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-L / 2, -1, 1.2, 2);
    }
    if (braking) {
      ctx.fillStyle = 'rgba(255, 40, 30, 0.25)';
      ctx.beginPath();
      ctx.arc(-L / 2, 0, W * 0.6, Math.PI / 2, (Math.PI * 3) / 2);
      ctx.fill();
    }

    ctx.restore();

    if (highlight) {
      this.polygon().draw(ctx, { fill: null, stroke: highlight, lineWidth: 1.2 });
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
