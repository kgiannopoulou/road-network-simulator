import { Car } from '../car/car.js';
import { NO_INPUT, PhysicsModel, SURFACES } from '../car/physics.js';
import { SkidMarks } from '../car/skidMarks.js';
import { m } from '../car/units.js';
import { CollisionWorld } from '../collision/collisionWorld.js';
import { clamp } from '../math/utils.js';
import { SensorSuite } from '../sensors/sensorSuite.js';
import { Point } from '../primitives/point.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { TrafficManager } from '../traffic/trafficManager.js';

const MAX_SUBSTEP_TRAVEL = m(0.5); // no car moves further than this per physics substep
const MAX_SUBSTEPS = 12;
const COLLISION_DEBOUNCE = 0.4; // s without contact before a new collision is counted
const CONTACT_MEMORY = 0.6; // s a contact stays visible in the debug view
export const WEATHER = ['dry', 'wet', 'icy'];

/**
 * Owns everything that moves: the player's car, traffic, collisions and tyre
 * marks. DOM-free, so the whole simulation can run headless in tests.
 *
 * Each frame: traffic drivers decide their inputs once, then physics runs in
 * substeps small enough that a fast car can't tunnel through a road border.
 * After every substep collisions are resolved.
 */
export class Simulation {
  constructor(network, { trafficCount = 12, seed = 7 } = {}) {
    this.network = network;
    this.world = new CollisionWorld();
    this.traffic = new TrafficManager({ count: trafficCount, seed });
    this.player = new Car({ kind: 'player', color: '#ffd54a' });
    this.skids = new SkidMarks();
    this.sensors = new SensorSuite(this.player, this.world);

    this.model = PhysicsModel.REALISTIC;
    this.weather = 'dry';
    this.paused = false;
    this.ghost = false; // player ignores collisions
    // Traffic follows lane paths, which on narrow roads can't always keep a
    // whole car body inside the border at tight corners; by default only the
    // player is blocked by borders. Traffic still collides with cars.
    this.trafficRoadCollisions = false;
    this.trafficEnabled = trafficCount > 0;
    this.savedTrafficCount = trafficCount || 12;

    this.builtVersion = -1;
    this.carPairs = [];
    this.recentContacts = []; // { kind, point, normal, segment?, time } for debug drawing
    this.substeps = 1;
    this.stepMs = 0;
    this.time = 0;
  }

  get cars() {
    return [this.player, ...this.traffic.cars];
  }

  get roadSurface() {
    return SURFACES[this.weather];
  }

  needsSync() {
    return this.network.builtVersion !== this.builtVersion;
  }

  /** Pick up a rebuilt road network: collision geometry, routes and traffic. */
  syncRoads() {
    const first = this.builtVersion === -1;
    const { roads, borders } = this.network;
    this.world.setRoads(
      roads.map((r) => r.poly),
      borders,
    );
    this.traffic.setRoads(roads, [this.player]);
    this.builtVersion = this.network.builtVersion;
    if (first) this.resetPlayer();
  }

  /** Put the player at the start of the longest road, in its right-hand lane. */
  resetPlayer() {
    const planner = this.traffic.planner;
    const steps = planner ? planner.allSteps().filter((s) => s.dir > 0) : [];
    if (steps.length === 0) {
      this.player.teleport(0, 0, 0);
      return;
    }
    const step = steps.reduce((a, b) => (b.road.segment.length() > a.road.segment.length() ? b : a));
    const { a, b } = RoutePlanner.laneLine(step, 0);
    const p = Point.lerp(a, b, 0.2);
    this.player.teleport(p.x, p.y, b.subtract(a).angle());
    this.player.collisionCount = 0;
    this.skids.clear();
    this.sensors.reset();
  }

  setTrafficEnabled(enabled) {
    this.trafficEnabled = enabled;
    this.traffic.setCount(enabled ? this.savedTrafficCount : 0, [this.player]);
  }

  setTrafficCount(count) {
    this.savedTrafficCount = clamp(count, 0, 60);
    this.trafficEnabled = this.savedTrafficCount > 0;
    this.traffic.setCount(this.savedTrafficCount, [this.player]);
  }

  respawnTraffic() {
    this.traffic.setRoads(this.network.roads, [this.player]);
  }

  cycleWeather() {
    this.weather = WEATHER[(WEATHER.indexOf(this.weather) + 1) % WEATHER.length];
  }

  toggleModel() {
    this.model = this.model === PhysicsModel.REALISTIC ? PhysicsModel.BASIC : PhysicsModel.REALISTIC;
  }

  update(dt, playerInput = NO_INPUT) {
    if (this.paused || dt <= 0) return;
    const start = performance.now();

    this.player.input = { ...NO_INPUT, ...playerInput };
    this.traffic.update(dt, this.cars);

    const cars = this.cars;
    const fastest = cars.reduce((max, c) => Math.max(max, Math.abs(c.speed)), 0);
    const n = clamp(Math.ceil((fastest * dt) / MAX_SUBSTEP_TRAVEL), 1, MAX_SUBSTEPS);
    const h = dt / n;

    for (const car of cars) {
      car.wasColliding = car.colliding;
      car.colliding = false;
      car.contacts = [];
    }
    this.carPairs = [];
    const solid = this.ghost ? cars.filter((c) => c !== this.player) : cars;

    for (let k = 0; k < n; k++) {
      for (const car of cars) {
        car.surface = this.world.isOnRoad(car.position) ? this.roadSurface : SURFACES.grass;
        car.step(h, this.model);
      }
      for (const car of solid) {
        if (car !== this.player && !this.trafficRoadCollisions) continue;
        const contacts = this.world.resolveRoad(car);
        if (contacts.length > 0) {
          car.contacts.push(...contacts);
          car.colliding = true;
        }
      }
      for (const pair of this.world.resolveCars(solid)) {
        pair.a.colliding = true;
        pair.b.colliding = true;
        this.carPairs.push(pair);
      }
    }

    for (const car of cars) {
      // One scrape along a wall counts once, even if contact flickers.
      if (car.colliding) {
        if (this.time - (car.lastContactTime ?? -Infinity) > COLLISION_DEBOUNCE) car.collisionCount++;
        car.lastContactTime = this.time;
      }
      this.skids.record(car);
      for (const c of car.contacts) {
        this.recentContacts.push({ kind: 'road', point: c.point, normal: c.normal, segment: c.segment, time: this.time });
      }
    }
    for (const pair of this.carPairs) {
      this.recentContacts.push({ kind: 'car', point: pair.point, normal: pair.normal, time: this.time });
    }
    this.recentContacts = this.recentContacts.filter((c) => this.time - c.time < CONTACT_MEMORY).slice(-200);

    this.substeps = n;
    this.time += dt;
    this.sensors.update(this.time, dt, this.cars);
    this.stepMs = performance.now() - start;
  }

  // ---- drawing --------------------------------------------------------------

  draw(ctx, { collisionDebug = false, trafficDebug = false, showSensors = false, pixel = 1 } = {}) {
    this.skids.draw(ctx);
    if (trafficDebug) this.#drawTrafficDebug(ctx, pixel);
    for (const car of this.cars) {
      const hitRecently = this.time - (car.lastContactTime ?? -Infinity) < 0.25;
      const highlight = collisionDebug ? (hitRecently ? '#ff3b30' : 'rgba(80, 255, 140, 0.9)') : null;
      car.draw(ctx, { highlight });
    }
    if (showSensors) this.sensors.draw(ctx, pixel);
    if (this.ghost) {
      this.player.polygon().draw(ctx, { fill: 'rgba(255,255,255,0.15)', stroke: '#ffffff', lineWidth: pixel });
    }
    if (collisionDebug) this.#drawCollisionDebug(ctx, pixel);
  }

  #drawCollisionDebug(ctx, px) {
    // Spatial hash cells and border segments the player is tested against.
    const box = this.player.polygon().box;
    const pad = { minX: box.minX - 4, minY: box.minY - 4, maxX: box.maxX + 4, maxY: box.maxY + 4 };
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
    ctx.lineWidth = px;
    for (const c of this.world.borderHash.cellBounds(pad)) {
      ctx.strokeRect(c.minX, c.minY, c.maxX - c.minX, c.maxY - c.minY);
    }
    for (const seg of this.world.bordersNear(pad)) {
      seg.draw(ctx, { width: 3 * px, color: 'rgba(0, 229, 255, 0.9)' });
    }

    // Recent contacts fade out so one-frame hits are still visible.
    for (const c of this.recentContacts) {
      ctx.globalAlpha = 1 - (this.time - c.time) / CONTACT_MEMORY;
      if (c.kind === 'road') {
        c.segment.draw(ctx, { width: 4 * px, color: '#ff3b30', cap: 'round' });
        drawArrow(ctx, c.point, c.normal, 18, '#ff3b30', px);
      } else {
        drawArrow(ctx, c.point, c.normal, 18, '#ff9f0a', px);
        drawArrow(ctx, c.point, c.normal.scale(-1), 18, '#ff9f0a', px);
      }
    }
    ctx.globalAlpha = 1;
  }

  #drawTrafficDebug(ctx, px) {
    for (const car of this.traffic.cars) {
      const d = car.driver;
      d.path.draw(ctx, { color: 'rgba(120, 200, 255, 0.35)', width: 1.5 * px });
      if (d.target) {
        new Point(d.target.x, d.target.y).draw(ctx, { size: 5 * px, color: '#78c8ff' });
        ctx.beginPath();
        ctx.moveTo(car.state.x, car.state.y);
        ctx.lineTo(d.target.x, d.target.y);
        ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
        ctx.lineWidth = px;
        ctx.stroke();
      }
      if (d.leader) {
        ctx.beginPath();
        ctx.moveTo(car.state.x, car.state.y);
        ctx.lineTo(d.leader.car.state.x, d.leader.car.state.y);
        ctx.strokeStyle = d.leader.predicted ? 'rgba(255, 159, 10, 0.9)' : 'rgba(255, 59, 48, 0.9)';
        ctx.setLineDash(d.leader.predicted ? [4 * px, 4 * px] : []);
        ctx.lineWidth = 1.5 * px;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (d.pendingLane !== null) {
        new Point(car.state.x, car.state.y).draw(ctx, { size: 6 * px, color: '#bf5af2' });
      }
    }
  }
}

function drawArrow(ctx, from, dir, length, color, px) {
  const to = from.add(dir.scale(length));
  const back = dir.scale(-5);
  const side = dir.perpendicular().scale(3);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.moveTo(to.x + back.x + side.x, to.y + back.y + side.y);
  ctx.lineTo(to.x, to.y);
  ctx.lineTo(to.x + back.x - side.x, to.y + back.y - side.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * px;
  ctx.stroke();
}
