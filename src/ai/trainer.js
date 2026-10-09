import { Car } from '../car/car.js';
import { PhysicsModel, SURFACES } from '../car/physics.js';
import { m } from '../car/units.js';
import { satCollision } from '../collision/sat.js';
import { createRng } from '../math/random.js';
import { Point } from '../primitives/point.js';
import { imperfectionsFor, PRESETS } from '../sensors/imperfections.js';
import { RayCaster } from '../sensors/raycast.js';
import { RaySensor } from '../sensors/raySensor.js';
import { RoutePlanner } from '../traffic/routePlanner.js';
import { Brain, DEFAULT_BRAIN_SENSOR } from './brain.js';
import { RoadCoverage } from './coverage.js';
import { GA_DEFAULTS, mutate, nextGeneration } from './genetics.js';
import { NeuralNetwork } from './network.js';

export const TRAINER_DEFAULTS = {
  populationSize: 150,
  hidden: [8],
  sensor: DEFAULT_BRAIN_SENSOR,
  generationTime: 40, // s of simulated time per generation
  stallTime: 4, // s without reaching new road before a car is removed
  sensorNoise: false, // train with the 'realistic' sensor preset
  seed: 1,
  ...GA_DEFAULTS,
};

/**
 * Weeks 15–16: population training.
 *
 * Every generation spawns `populationSize` cars at the same spot, each with
 * its own brain and ray sensor. The cars are ghosts to each other but crash
 * into road borders and traffic. A car is removed when it crashes or stalls
 * (no new road for `stallTime` seconds); the generation ends when every car
 * is out or time runs out.
 *
 * Fitness = metres of distinct road driven (RoadCoverage). The next
 * generation comes from the genetic algorithm, and the best brain ever seen
 * is kept as the champion.
 */
export class Trainer {
  constructor(roads, world, options = {}) {
    this.options = { ...TRAINER_DEFAULTS, ...options };
    this.roads = roads;
    this.world = world;
    this.rng = createRng(this.options.seed);
    this.coverage = new RoadCoverage(roads);
    this.caster = new RayCaster(world);
    this.spawn = this.options.spawn ?? Trainer.chooseSpawn(roads);

    this.generation = 0;
    this.time = 0;
    this.agents = [];
    this.history = []; // [{ generation, best, average, champion }]
    this.champion = options.champion ?? null; // { brain (JSON), fitness, generation }
    this.championChanged = false;
  }

  /**
   * Default start: the right-hand lane at the beginning of the longest run of
   * road without sharp turns, so the first lesson is plain road following.
   * Ties go to the start with the most road reachable beyond it.
   */
  static chooseSpawn(roads) {
    if (roads.length === 0) return null;
    const planner = new RoutePlanner(roads);
    const heading = (step) => {
      const { a, b } = RoutePlanner.laneLine(step, 0);
      return b.subtract(a).angle();
    };
    const straightRun = (start) => {
      const seen = new Set([start.road]);
      let step = start;
      let total = start.road.segment.length();
      for (;;) {
        let next = null;
        let bestTurn = Math.PI / 5; // 36°: anything sharper ends the run
        for (const option of planner.nextOptions(step)) {
          const turn = Math.abs(Math.atan2(Math.sin(heading(option) - heading(step)), Math.cos(heading(option) - heading(step))));
          if (turn < bestTurn && !seen.has(option.road)) {
            bestTurn = turn;
            next = option;
          }
        }
        if (!next) return total;
        seen.add(next.road);
        total += next.road.segment.length();
        step = next;
      }
    };
    const reach = (start) => {
      const seen = new Set([start.road]);
      const queue = [start];
      let total = 0;
      while (queue.length) {
        const step = queue.shift();
        total += step.road.segment.length();
        for (const next of planner.nextOptions(step)) {
          if (!seen.has(next.road)) {
            seen.add(next.road);
            queue.push(next);
          }
        }
      }
      return total;
    };
    let best = null;
    for (const step of planner.allSteps()) {
      const score = straightRun(step) + reach(step) * 0.1;
      if (!best || score > best.score) best = { step, score };
    }
    const { a, b } = RoutePlanner.laneLine(best.step, 0);
    const p = Point.lerp(a, b, Math.min(0.15, m(6) / a.distanceTo(b)));
    return { x: p.x, y: p.y, angle: b.subtract(a).angle() };
  }

  get alive() {
    return this.agents.filter((a) => a.alive);
  }

  /** The car to watch: best alive driver, or the best of the generation. */
  get leader() {
    let best = null;
    for (const a of this.agents) {
      if (!best || (a.alive && !best.alive) || (a.alive === best.alive && a.fitness > best.fitness)) best = a;
    }
    return best;
  }

  /** Start generation 0: fresh random brains, or the champion and its mutants. */
  start() {
    const { populationSize } = this.options;
    const genomes = [];
    if (this.champion) {
      const base = this.#networkFrom(this.champion.brain).toGenome();
      genomes.push(base);
      while (genomes.length < populationSize) {
        genomes.push(mutate(base, { rate: this.options.mutationRate * 2, amount: this.options.mutationAmount }, this.rng));
      }
    } else {
      const template = this.#newNetwork();
      for (let i = 0; i < populationSize; i++) genomes.push(template.randomize(this.rng).toGenome());
    }
    this.generation = 0;
    this.history = [];
    this.#spawnGeneration(genomes);
  }

  #newNetwork() {
    const { sensor, hidden } = this.options;
    return new NeuralNetwork([sensor.rayCount + 1, ...hidden, 3]);
  }

  /** A champion trained with a different layout can't seed this run. */
  #networkFrom(brainJson) {
    const network = NeuralNetwork.fromJSON(brainJson.network);
    const expected = this.#newNetwork();
    if (network.sizes.join() !== expected.sizes.join()) {
      throw new Error(`Champion network ${network.sizes.join('-')} doesn't match ${expected.sizes.join('-')}`);
    }
    return network;
  }

  #spawnGeneration(genomes) {
    const { sensor, sensorNoise } = this.options;
    const template = this.#newNetwork();
    this.time = 0;
    this.agents = genomes.map((genome, i) => {
      const car = new Car({ x: this.spawn.x, y: this.spawn.y, angle: this.spawn.angle, color: '#4aa3ff', kind: 'agent' });
      const brain = new Brain({ sensor, network: template.clone().setGenome(genome) });
      const raySensor = new RaySensor({ name: 'rays', ...sensor, seed: this.generation * 1000 + i + 1 });
      if (sensorNoise) raySensor.configure(imperfectionsFor(raySensor.spec, PRESETS.realistic));
      return {
        car,
        brain,
        genome,
        sensor: raySensor,
        tracker: this.coverage.tracker(),
        alive: true,
        fitness: 0,
        lastProgress: 0,
        outcome: null, // 'crashed' | 'stalled' | 'timeout'
        elite: i < Math.min(this.options.elitism, genomes.length) && this.generation > 0,
      };
    });
  }

  /**
   * Advance every live car by dt. `obstacles` are cars the agents can hit
   * (traffic); `surface` and `model` match the main simulation.
   */
  update(dt, { obstacles = [], surface = SURFACES.dry, model = PhysicsModel.REALISTIC } = {}) {
    if (this.agents.length === 0) return;
    this.time += dt;
    const env = { time: this.time, dt, cars: obstacles, caster: this.caster };

    for (const agent of this.agents) {
      if (!agent.alive) continue;
      const { car } = agent;
      agent.sensor.update({ ...env, car });
      car.input = agent.brain.drive(agent.sensor.read(this.time), car);
      car.surface = surface;
      car.step(dt, model);

      if (this.#crashed(car, obstacles)) {
        this.#retire(agent, 'crashed');
        continue;
      }
      if (agent.tracker.visit(car.position)) {
        agent.lastProgress = this.time;
        agent.fitness = agent.tracker.metres;
      }
      if (this.time - agent.lastProgress > this.options.stallTime) this.#retire(agent, 'stalled');
    }

    if (this.time >= this.options.generationTime) {
      for (const agent of this.agents) if (agent.alive) this.#retire(agent, 'timeout');
    }
    if (this.agents.every((a) => !a.alive)) this.nextGeneration();
  }

  #crashed(car, obstacles) {
    if (this.world.touchesRoadEdge(car)) return true;
    const poly = car.polygon();
    for (const other of obstacles) {
      const reach = car.radius + other.radius;
      if (Math.abs(other.state.x - car.state.x) > reach || Math.abs(other.state.y - car.state.y) > reach) continue;
      if (satCollision(poly.points, other.polygon().points)) return true;
    }
    return false;
  }

  #retire(agent, outcome) {
    agent.alive = false;
    agent.outcome = outcome;
    agent.car.input = { forward: 0, back: 0, steer: 0 };
  }

  /** Score the generation, update the champion and breed the next one. */
  nextGeneration() {
    if (this.agents.length === 0) return;
    const scored = this.agents.map((a) => ({ genome: a.genome, fitness: a.fitness, agent: a }));
    const best = scored.reduce((x, y) => (y.fitness > x.fitness ? y : x));
    const average = scored.reduce((sum, s) => sum + s.fitness, 0) / scored.length;

    if (!this.champion || best.fitness > this.champion.fitness) {
      this.champion = { brain: best.agent.brain.toJSON(), fitness: best.fitness, generation: this.generation };
      this.championChanged = true;
    }
    this.history.push({ generation: this.generation, best: best.fitness, average, champion: this.champion.fitness });

    const genomes = nextGeneration(scored, this.options.populationSize, this.options, this.rng);
    this.generation++;
    this.#spawnGeneration(genomes);
  }

  stats() {
    const alive = this.alive.length;
    const leader = this.leader;
    return {
      generation: this.generation,
      time: this.time,
      alive,
      total: this.agents.length,
      leaderFitness: leader?.fitness ?? 0,
      champion: this.champion?.fitness ?? 0,
      crashed: this.agents.filter((a) => a.outcome === 'crashed').length,
      stalled: this.agents.filter((a) => a.outcome === 'stalled').length,
    };
  }

  // ---- drawing --------------------------------------------------------------

  draw(ctx, px) {
    const leader = this.leader;
    for (const agent of this.agents) {
      if (!agent.alive || agent === leader) continue;
      agent.car.alpha = 0.3;
      agent.car.draw(ctx);
    }
    if (!leader) return;
    const reading = leader.sensor.read(this.time);
    if (reading) leader.sensor.draw(ctx, reading, px);
    leader.car.alpha = 1;
    leader.car.color = '#30d158';
    leader.car.draw(ctx, { highlight: leader.alive ? null : '#ff3b30' });
    leader.car.color = '#4aa3ff';
  }

  /** Spawn marker so it's clear where every generation starts. */
  drawSpawn(ctx, px) {
    if (!this.spawn) return;
    const p = new Point(this.spawn.x, this.spawn.y);
    const f = Point.fromAngle(this.spawn.angle).scale(m(3));
    ctx.beginPath();
    ctx.arc(p.x, p.y, m(1.2), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(48, 209, 88, 0.8)';
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + f.x, p.y + f.y);
    ctx.stroke();
  }
}
