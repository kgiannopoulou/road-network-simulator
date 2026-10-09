import { Car } from '../car/car.js';
import { fromKmh, m } from '../car/units.js';
import { CollisionWorld } from '../collision/collisionWorld.js';
import { Graph } from '../graph/graph.js';
import { createRng } from '../math/random.js';
import { RoadNetwork } from '../road/roadNetwork.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { TrafficManager } from '../traffic/trafficManager.js';
import { buildCourse } from './courses.js';
import { Navigator, planRouteFrom } from './navigator.js';
import { Trainer } from '../ai/trainer.js';

/**
 * A self-contained world to train in: road network, collision geometry, the
 * route from start to destination, parked obstacles and traffic.
 *
 * Built either from a curriculum course id or from the user's own map (a
 * graph JSON, with a seeded random route from the usual start position).
 */
export class TrainingWorld {
  constructor(source, { seed = 1 } = {}) {
    let course;
    if (source.map) {
      const graph = Graph.fromJSON(source.map);
      course = {
        id: 'map',
        name: 'Your map',
        short: 'map',
        description: 'Your own road network, along a random route.',
        graph,
        speedLimit: fromKmh(50),
        timeLimit: 60,
        traffic: source.traffic ?? 0,
      };
    } else {
      course = buildCourse(source.course);
    }
    this.course = course;
    this.network = new RoadNetwork(course.graph, course.kerbRadius !== undefined ? { kerbRadius: course.kerbRadius } : {});
    this.network.update();
    this.roads = this.network.roads;
    this.world = new CollisionWorld();
    this.world.setRoads(this.network.surfaces(), this.network.borders);
    this.planner = new RoutePlanner(this.roads);
    this.steps = course.route ? this.#stepsFromNodes(course.route) : this.#randomRoute(seed);

    const nav = this.createNavigator();
    this.path = nav.path;
    this.stepStarts = nav.stepStarts;
    this.laneCounts = nav.laneCounts;
    const start = this.path.pointAt(m(4));
    this.spawn = { x: start.x, y: start.y, angle: this.path.tangentAt(m(4)).angle() };
    this.destination = this.path.pointAt(this.path.length);

    this.parked = (course.obstacles ?? []).map((o) => this.#parkedCar(o));
    this.traffic = null;
    if (course.traffic) {
      this.traffic = new TrafficManager({ count: course.traffic, seed: 99 });
      this.resetTraffic();
    }
  }

  get speedLimit() {
    return this.course.speedLimit;
  }

  get timeLimit() {
    return this.course.timeLimit;
  }

  createNavigator() {
    return Navigator.forRoute(this.planner, this.steps);
  }

  /** Same traffic every generation, so every brain faces the same situation. */
  resetTraffic() {
    if (!this.traffic) return;
    const blocker = new Car({ x: this.spawn.x, y: this.spawn.y, angle: this.spawn.angle });
    blocker.params = { ...blocker.params, length: m(30) }; // keep the start area clear
    this.traffic.setRoads(this.roads, [blocker, ...this.parked]);
    for (const car of this.traffic.cars) car.alpha = 1;
  }

  /** Cars the agents can crash into. */
  obstacles() {
    return this.traffic ? [...this.parked, ...this.traffic.cars] : this.parked;
  }

  step(dt) {
    if (!this.traffic) return;
    const cars = [...this.traffic.cars, ...this.parked];
    this.traffic.update(dt, cars);
    for (const car of this.traffic.cars) car.step(dt, 'realistic');
  }

  #stepsFromNodes(route) {
    const nodes = route.map((i) => this.course.graph.points[i]);
    const steps = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const step = this.planner.exits(nodes[i]).find((s) => RoutePlanner.end(s) === nodes[i + 1]);
      if (!step) throw new Error(`Course ${this.course.id}: no road from node ${route[i]} to ${route[i + 1]}`);
      steps.push(step);
    }
    return steps;
  }

  #randomRoute(seed) {
    const spawn = Trainer.chooseSpawn(this.roads);
    if (!spawn) throw new Error('The map has no roads');
    return planRouteFrom(this.planner, this.roads, spawn, createRng(seed), 10);
  }

  #parkedCar({ s, lane }) {
    const at = m(s);
    const p = this.path.pointAt(at);
    const t = this.path.tangentAt(at);
    const offset = t.perpendicular().scale(-lane * this.steps[0].road.laneWidth);
    const car = new Car({ x: p.x + offset.x, y: p.y + offset.y, angle: t.angle(), color: '#8e8e93', kind: 'parked' });
    return car;
  }
}
