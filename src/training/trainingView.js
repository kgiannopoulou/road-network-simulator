import { Car } from '../car/car.js';
import { createCarParams } from '../car/physics.js';
import { m } from '../car/units.js';
import { RaySensor } from '../sensors/raySensor.js';
import { TrainingWorld } from './trainingWorld.js';

/**
 * Draws a training run from its snapshots, so it looks the same whether the
 * session runs on the main thread or in a worker. The course geometry is
 * rebuilt locally from the course id (courses are deterministic).
 */
export class TrainingView {
  constructor() {
    this.worlds = new Map();
    this.agentCar = new Car({ kind: 'agent' });
    this.otherCar = new Car();
    this.rays = new RaySensor({ name: 'view' });
  }

  /** The TrainingWorld matching a snapshot (cached per course). */
  world(snapshot, config) {
    const key = snapshot.course === 'map' ? `map:${config.trainer?.seed}:${JSON.stringify(config.map).length}` : snapshot.course;
    if (!this.worlds.has(key)) {
      const source = snapshot.course === 'map' ? { map: config.map, traffic: config.mapTraffic } : { course: snapshot.course };
      this.worlds.set(key, new TrainingWorld(source, { seed: config.trainer?.seed }));
    }
    return this.worlds.get(key);
  }

  /** World position of the car the camera should follow. */
  leaderPosition(snapshot) {
    const i = snapshot?.leader?.index;
    if (i === undefined || i < 0) return null;
    const a = snapshot.agents;
    return { x: a[i * 4], y: a[i * 4 + 1], angle: a[i * 4 + 2] };
  }

  bounds(snapshot, config) {
    return this.world(snapshot, config).course.graph.boundingBox();
  }

  draw(ctx, snapshot, config, px) {
    const world = this.world(snapshot, config);
    world.network.draw(ctx);

    // Route, start and destination.
    world.path.draw(ctx, { color: 'rgba(255, 255, 255, 0.35)', width: 2 * px, dash: [10 * px, 8 * px] });
    const s = world.spawn;
    ring(ctx, s.x, s.y, m(1.4), '#30d158', px);
    const d = world.destination;
    ring(ctx, d.x, d.y, m(2), '#ffd54a', px);
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x, d.y - m(4));
    ctx.lineTo(d.x + m(2.5), d.y - m(3.2));
    ctx.lineTo(d.x, d.y - m(2.4));
    ctx.fillStyle = '#ffd54a';
    ctx.fill();

    for (const pose of snapshot.parked) this.#drawCar(ctx, this.otherCar, pose, '#8e8e93', 1);
    for (const pose of snapshot.traffic) this.#drawCar(ctx, this.otherCar, pose, '#c7c7cc', pose[5] ?? 1);

    // Agents: live ones faint, the leader solid green with its rays.
    const a = snapshot.agents;
    const leader = snapshot.leader?.index ?? -1;
    const car = this.agentCar;
    car.params = createCarParams();
    for (let i = 0; i < a.length / 4; i++) {
      if (i === leader || !(a[i * 4 + 3] & 1)) continue;
      this.#drawCar(ctx, car, [a[i * 4], a[i * 4 + 1], a[i * 4 + 2]], '#4aa3ff', 0.28);
    }
    if (leader >= 0) {
      if (snapshot.leader.rays) this.rays.draw(ctx, { data: snapshot.leader.rays }, px);
      const alive = a[leader * 4 + 3] & 1;
      this.#drawCar(ctx, car, [a[leader * 4], a[leader * 4 + 1], a[leader * 4 + 2]], alive ? '#30d158' : '#ff453a', 1);
    }
  }

  #drawCar(ctx, car, [x, y, angle, length, width], color, alpha) {
    if (length) car.params = { ...car.params, length, width };
    car.state.x = x;
    car.state.y = y;
    car.state.angle = angle;
    car.state.steer = 0;
    car.state.braking = false;
    car.state.reversing = false;
    car.color = color;
    car.alpha = alpha;
    car.draw(ctx);
  }
}

function ring(ctx, x, y, r, color, px) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5 * px;
  ctx.stroke();
}

